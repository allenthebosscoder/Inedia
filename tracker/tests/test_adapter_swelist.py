"""Task 11: SWElist / simplify.jobs adapter.

Fixture: tests/fixtures/swelist/simplify_posting.html -- a real trimmed
simplify.jobs posting page (Firmware Engineer Intern @ Vertiv, Summer 2027,
structured Degree chip "Master's, PhD"). See task-11-report.md.

The fixture is rendered with the `chrome_page` fixture + page.set_content();
no browser navigation happens here.
"""
import datetime
from pathlib import Path

from jobscan.adapters.swelist import (
    SELECTORS,
    ResolveError,
    SwelistAdapter,
    _simplify_external_id,
    parse_posting,
)
from jobscan.hardfilter import hardfilter, resolve_term

FX = Path(__file__).parent / "fixtures/swelist"
TODAY = datetime.date(2026, 9, 3)
UUID = "2189b93d-1a82-4620-9a31-8afd50579cae"


def load(chrome_page, name):
    chrome_page.set_content((FX / name).read_text())
    return chrome_page


def _desc_snippet(body: str, degree: str = "") -> str:
    # Mirrors the containers parse_posting reads: the JD body, and (optionally)
    # the structured "Degree" chip (label <p> + value <p>, per SELECTORS["degree"]).
    chip = (
        '<div><div class="flex items-center gap-2"><div>'
        f'<p>Degree</p></div></div><p class="ml-6">{degree}</p></div>'
        if degree else ""
    )
    return (
        f"<html><body>{chip}"
        '<div class="description whitespace-pre-wrap break-words">'
        f"{body}</div></body></html>"
    )


# --- external id ---------------------------------------------------------

def test_simplify_external_id_pulls_uuid_from_slug_and_query():
    assert _simplify_external_id(
        f"https://simplify.jobs/p/{UUID}/Firmware-Engineer-Intern"
    ) == UUID
    assert _simplify_external_id(
        f"https://simplify.jobs/p/{UUID}?utm_source=swelist"
    ) == UUID
    assert _simplify_external_id(UUID) == UUID


# --- real fixture -------------------------------------------------------

def test_parse_posting_extracts_fields(chrome_page):
    p = parse_posting(load(chrome_page, "simplify_posting.html"), UUID)
    assert p.source == "swelist"
    assert p.external_id == UUID
    assert "Vertiv" in p.company
    assert "Firmware Engineer Intern" in p.role
    assert len(p.description) > 200


def test_external_id_uses_uuid_from_resolved_slug_url(chrome_page):
    p = parse_posting(
        load(chrome_page, "simplify_posting.html"),
        f"https://simplify.jobs/p/{UUID}/Firmware-Engineer-Intern?utm_source=swelist",
    )
    assert p.external_id == UUID


def test_real_fixture_trips_degree_hardfilter(chrome_page):
    # The prose says "currently pursuing a Master's or PhD ... is preferred",
    # which no DEGREE_NEGATIVE pattern matches; the structured "Degree" chip
    # ("Master's, PhD", no Bachelor's) is what makes this a hard degree gate.
    p = parse_posting(load(chrome_page, "simplify_posting.html"), UUID)
    assert hardfilter(p, TODAY) == "degree"


def test_real_fixture_resolves_summer_term(chrome_page):
    p = parse_posting(load(chrome_page, "simplify_posting.html"), UUID)
    assert resolve_term(p, TODAY) == "Summer 2027"


def test_page_value_wins_over_hint(chrome_page):
    p = parse_posting(
        load(chrome_page, "simplify_posting.html"), UUID,
        company_hint="WrongCo", role_hint="Wrong Role",
    )
    assert "Vertiv" in p.company
    assert "Firmware Engineer Intern" in p.role


# --- hint fallback ----------------------------------------------------

def test_hint_fills_blank_company_and_role(chrome_page):
    chrome_page.set_content(_desc_snippet(
        "This job description body runs well past two hundred characters so the "
        "container counts as populated. It covers building embedded firmware in "
        "C, bring-up on custom boards, and bench testing across the lab all "
        "summer, but it never names the hiring company or the exact role title."
    ))
    p = parse_posting(
        chrome_page, f"https://simplify.jobs/p/{UUID}",
        company_hint="HintCo", role_hint="Hint Role",
    )
    assert p.company == "HintCo"
    assert p.role == "Hint Role"
    assert len(p.description) > 200


# --- ResolveError ---------------------------------------------------

def test_missing_jd_container_raises_resolve_error(chrome_page):
    chrome_page.set_content("<html><body>Not found</body></html>")
    try:
        parse_posting(chrome_page, f"https://simplify.jobs/p/{UUID}")
    except ResolveError:
        pass
    else:
        raise AssertionError("expected ResolveError for a page with no JD container")


# --- synthetic drop -----------------------------------------------

def test_grad_only_degree_chip_trips_hardfilter_without_a_term_chip(chrome_page):
    # A grad-only structured Degree chip is a hard gate even when the JD prose
    # only says "preferred" and there is no term chip on the page.
    chrome_page.set_content(_desc_snippet(
        "Responsibilities: model power converters in Simulink and bring up "
        "firmware on DSP targets. A background in digital control systems is "
        "preferred and prior lab experience is a plus for this role.",
        degree="Master's, PhD",
    ))
    p = parse_posting(chrome_page, f"https://simplify.jobs/p/{UUID}")
    assert p.requirements_text and "\n" not in p.requirements_text  # one clean line, no term chip
    assert hardfilter(p, TODAY) == "degree"


def test_bachelors_in_degree_chip_is_not_a_gate(chrome_page):
    chrome_page.set_content(_desc_snippet(
        "Responsibilities: write embedded C and test on hardware benches. This "
        "is a great summer internship for ECE students at any degree level.",
        degree="Bachelor's, Master's, PhD",
    ))
    p = parse_posting(chrome_page, f"https://simplify.jobs/p/{UUID}")
    assert hardfilter(p, TODAY) is None


def test_no_sponsorship_language_trips_hardfilter(chrome_page):
    chrome_page.set_content(_desc_snippet(
        "Responsibilities include building firmware and writing tests. Please "
        "note that we do not sponsor visas for this position now or in the "
        "future; candidates must already be authorized to work in the US."
    ))
    p = parse_posting(chrome_page, f"https://simplify.jobs/p/{UUID}")
    assert hardfilter(p, TODAY) == "no-sponsorship"


# --- SELECTORS / adapter meta ----------------------------------

def test_selectors_populated():
    for key in ("role", "company", "term", "degree", "description", "jd_wrapper"):
        assert SELECTORS.get(key), f"SELECTORS[{key!r}] must be non-empty"


def test_adapter_meta():
    assert SwelistAdapter.source == "swelist"
    assert SwelistAdapter().source == "swelist"


def test_resolve_and_extract_prefers_the_real_posting(monkeypatch):
    # Resolve /jobs/click/{uuid} in the browser, then read the real posting
    # (source_jd). The simplify SPA scrape is never reached.
    import jobscan.adapters.swelist as sw
    monkeypatch.setattr(sw, "source_jd",
                        lambda page, url, company="": "Firmware Intern\n"
                        + "Summer 2027 embedded role. Write bare-metal C. " * 8
                        + "\n\n--- Application questions ---\nGPA\nClearance Eligibility")

    class Page:
        url = "https://jobs.lever.co/acme/abc"          # the resolved real URL
        def goto(self, *a, **k): pass
        def wait_for_timeout(self, *a, **k): pass
        def query_selector(self, sel):
            raise AssertionError("should not scrape the simplify SPA")

    p = SwelistAdapter().resolve_and_extract(
        Page(), "https://simplify.jobs/p/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/x",
        company_hint="Acme", role_hint="Firmware Intern")
    assert p.source == "swelist" and p.company == "Acme"
    assert p.url == "https://jobs.lever.co/acme/abc"
    assert hardfilter(p, today=TODAY) == "clearance"


def test_resolve_and_extract_recovers_from_interrupted_click_navigation(monkeypatch):
    # Live shakedown of the 2026-09-11 swelist digest (Toro, Evolito, Vishay,
    # RF-SMART, Swarm Aero, Hudl, Waymo, Bedrock, Exegy -- 9/19 candidates)
    # hit this: the simplify.jobs /jobs/click/{uuid} page's own client-side
    # redirect to the real ATS completes WHILE our page.goto(click) is still
    # waiting for domcontentloaded, so Playwright raises "Navigation ... is
    # interrupted by another navigation to <real-ats-url>" instead of
    # resolving -- even though the browser has, in fact, already landed on
    # the real posting. The old code treated any exception here as total
    # failure (real = "") and fell through to an UNGUARDED second
    # page.goto(url) on the original simplify link, which itself then hit
    # the same race and raised uncaught, crashing the whole adapter call.
    import jobscan.adapters.swelist as sw
    monkeypatch.setattr(sw, "source_jd",
                        lambda page, url, company="": "Firmware Intern\n"
                        + "Summer 2027 embedded role. Write bare-metal C. " * 8)

    class Page:
        def __init__(self):
            self.calls = 0
            self.url = "https://simplify.jobs/p/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/x"

        def goto(self, url, wait_until=None, timeout=None):
            self.calls += 1
            if self.calls > 1:
                raise AssertionError("must not re-navigate once the redirect already landed")
            self.url = "https://jobs.lever.co/acme/abc"  # browser already landed here
            raise Exception(  # noqa: TRY002 -- mirrors Playwright's real message
                'Page.goto: Navigation to "https://simplify.jobs/jobs/click/'
                'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" is interrupted by '
                'another navigation to "https://jobs.lever.co/acme/abc"')

        def wait_for_timeout(self, *a, **k):
            pass

        def query_selector(self, sel):
            raise AssertionError("should not scrape the simplify SPA")

    p = SwelistAdapter().resolve_and_extract(
        Page(), "https://simplify.jobs/p/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/x",
        company_hint="Acme", role_hint="Firmware Intern")
    assert p.url == "https://jobs.lever.co/acme/abc"
    assert p.company == "Acme"


def test_resolve_and_extract_keeps_real_url_when_ats_content_is_blocked(monkeypatch, chrome_page):
    # 2026-09-11 digest: Garmin's real posting resolves fine (careers.garmin
    # .com via iCIMS) but iCIMS bot-walls our browser fetch, so `jd` comes
    # back empty and the code falls back to scraping simplify's own SPA
    # copy of the JD text for content -- it must still keep the REAL,
    # already-known ATS url rather than reverting the pick's link to the
    # simplify.jobs permalink (Allen: links must point to the direct
    # posting, never simplify/jobright/runway).
    import jobscan.adapters.swelist as sw
    monkeypatch.setattr(sw, "source_jd", lambda page, url, company="": "")
    chrome_page.set_content((FX / "simplify_posting.html").read_text())
    orig_url = "https://simplify.jobs/p/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/x"

    class Page:
        def __init__(self):
            self.calls = 0
            self.url = orig_url

        def goto(self, *a, **k):
            self.calls += 1
            if self.calls == 1:
                self.url = "https://careers.garmin.com/jobs/20135?icims=1"
            else:
                # the fallback SPA-scrape re-navigates to the ORIGINAL
                # simplify link -- page.url reverts, same as a real browser.
                self.url = orig_url

        def wait_for_timeout(self, *a, **k):
            pass

        def query_selector(self, sel):
            return chrome_page.query_selector(sel)

        def query_selector_all(self, sel):
            return chrome_page.query_selector_all(sel)

    p = SwelistAdapter().resolve_and_extract(Page(), orig_url,
                                             company_hint="Garmin", role_hint="R")
    assert p.url == "https://careers.garmin.com/jobs/20135?icims=1"
    assert p.description and len(p.description) > 50


def test_resolve_and_extract_falls_back_to_scrape_for_unknown_ats(monkeypatch, chrome_page):
    import jobscan.adapters.swelist as sw
    monkeypatch.setattr(sw, "fetch_ats_detail", lambda url: None)
    chrome_page.set_content((FX / "simplify_posting.html").read_text())

    class Page:
        def goto(self, *a, **k): pass
        def wait_for_timeout(self, *a, **k): pass
        def query_selector(self, sel): return chrome_page.query_selector(sel)
        def query_selector_all(self, sel): return chrome_page.query_selector_all(sel)
        url = "https://simplify.jobs/p/x/y"

    p = SwelistAdapter().resolve_and_extract(Page(), "https://simplify.jobs/p/x/y",
                                             company_hint="Acme", role_hint="R")
    assert p.description and len(p.description) > 50
