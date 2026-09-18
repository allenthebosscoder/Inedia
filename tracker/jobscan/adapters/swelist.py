"""SWElist source adapter.

Claude extracts the simplify.jobs posting links from the SWElist digest email
(jobscan/swelist_links.py) and writes them to daily_run/swelist_links.json
with a company_hint / role_hint per link. This adapter resolves each link on
simplify.jobs (which renders the full JD without login) into a JobPosting.

simplify.jobs is a Next.js + Tailwind app with no semantic class names, so
every selector lives in SELECTORS and drift is a one-line fix; re-run
tests/test_adapter_swelist.py against a fresh fixture after any change.

Fixture reality (tests/fixtures/swelist/simplify_posting.html, task-11-report.md):

  * The posting id is the uuid in ``/p/<uuid>``. The resolved ``page.url`` may
    carry a trailing ``/<role-slug>`` and/or a ``?utm_source`` query, so the
    uuid is pulled with a regex (``_simplify_external_id``), not the last path
    segment.
  * Structured fields sit in headings near the top: ``<h1>`` is the role, the
    ``<h2>`` immediately after it is the term ("Summer 2027"), a
    ``/c/<Company>`` logo link carries the company, and a sidebar list holds
    the location, an employment-type chip and a "Degree" chip ("Master's, PhD").
  * The JD is a "Summary" tab (Requirements / Responsibilities / Desired
    Qualifications lists) plus a "Full Job Posting" tab whose body is a
    ``<div class="description">`` that is in the DOM but starts hidden. Both
    live inside one ``<div class="mt-4">`` wrapper, so that wrapper's
    ``text_content()`` is the fullest JD text and is readable even while the
    full-posting tab is collapsed (like jobright's collapsed full-JD region).
  * simplify's structured "Degree" chip is the only place a Master's/PhD gate
    is machine-readable -- the prose says "currently pursuing a Master's or
    PhD ... is preferred", which no ``criteria.DEGREE_NEGATIVE`` pattern
    matches. When the chip lists only graduate degrees, ``parse_posting``
    adds a normalized "a Master's or PhD is required" line to
    ``requirements_text`` (its own ``\n``-delimited line) so ``hardfilter``
    can see the gate.

Deferred to Task 20 (live shakedown): tuning the ``full_jd_toggle`` click and
the post-navigation wait against a real logged-out simplify.jobs page.
"""
from __future__ import annotations

import dataclasses
import re
from urllib.parse import urlsplit

from jobscan.adapters.base import JobPosting, external_id_from_url
from jobscan.detail_fetch import (
    fetch_ats_detail, looks_blocked, posted_at_from_ats_text, simplify_click_url,
    source_jd, strip_tracking,
)

_UUID_RE = re.compile(
    r"/p/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
)
_GRAD_ONLY_RE = re.compile(r"\b(master|phd|ph\.?d|m\.?s\.?|m\.?eng|doctora|graduate)", re.I)
_UNDERGRAD_RE = re.compile(
    r"\b(bachelor|b\.?s\.?|b\.?a\.?|associate|undergrad|high school|any degree)", re.I
)
_EMPLOYMENT_RE = re.compile(
    r"\b(Internship|Co-?op|Apprenticeship|Full[\s-]?Time|Part[\s-]?Time|Contract|Temporary)\b",
    re.I,
)

# Every site-specific selector the adapter uses. Selectors starting with "//"
# are XPath (Playwright auto-detects); the rest are CSS.
SELECTORS = {
    # The role title. A second <h1> further down is a marketing banner;
    # query_selector takes the first.
    "role": "h1",
    # The <h2> immediately after the role <h1> is the term ("Summer 2027").
    "term": "h1 + h2",
    # Company logo link -> /c/<Company>. Its text is empty (img only); _company
    # reads the <img alt>, then a sibling heading, then the href slug.
    "company": 'a[href^="/c/"]',
    "company_heading": 'a[href^="/c/"] ~ div h2',
    # Sidebar "flex flex-col gap-5 text-left ..." block: first bold <p> is the
    # location line ("Delaware, OH, USA"). Best-effort -- not a filter input,
    # and prefilter keeps a blank location.
    "location": '//div[contains(@class,"flex flex-col gap-5 text-left")]'
                '//p[contains(@class,"font-bold")]',
    # Employment-type chip ("Internship") in the sidebar list.
    "employment_type": '//div[contains(@class,"flex flex-col gap-5")]'
                       '//p[contains(@class,"font-bold")]'
                       '[contains(.,"Intern") or contains(.,"Time") or contains(.,"Contract")'
                       ' or contains(.,"Co-op") or contains(.,"Apprentic")]',
    # Structured "Degree" chip: the <p> after the "Degree" label ("Master's, PhD").
    "degree": '//p[normalize-space()="Degree"]/../../following-sibling::p[1]',
    # "Full Job Posting" body. In the DOM but hidden until its tab is clicked;
    # read with text_content().
    "description": ".description",
    # The <div class="mt-4"> wrapping BOTH the visible Summary lists and the
    # hidden full-posting body -> its text_content() is the fullest JD text.
    "jd_wrapper": '//div[normalize-space()="Requirements" or normalize-space()="Responsibilities"'
                  ' or normalize-space()="Qualifications"]'
                  '/ancestor::div[contains(concat(" ",normalize-space(@class)," ")," mt-4 ")][1]',
    # Live-run only (Task 20): the tab button that reveals SELECTORS["description"].
    "full_jd_toggle": 'button:has-text("Full Job Posting")',
}


class ResolveError(RuntimeError):
    pass


def _text(el) -> str:
    """text_content() (not inner_text()) so hidden nodes -- the collapsed
    full-posting body -- still yield their text."""
    if not el:
        return ""
    try:
        return (el.text_content() or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def _q(page, key: str):
    sel = SELECTORS.get(key) or ""
    return page.query_selector(sel) if sel else None


def _simplify_external_id(url: str) -> str:
    """The ``/p/<uuid>`` id. The resolved URL may add a ``/<role-slug>`` segment
    or a ``?utm_source`` query, so match the uuid rather than trust the last
    path segment. Falls back to the last path segment for a bare id."""
    if not url:
        return url
    m = _UUID_RE.search(url)
    if m:
        return m.group(1)
    return external_id_from_url(urlsplit(url).path or url)


def _company(page, hint: str) -> str:
    el = _q(page, "company")
    if el:
        try:
            txt = (el.inner_text() or "").strip()
        except Exception:  # noqa: BLE001
            txt = ""
        if txt:
            return txt
        img = el.query_selector("img")
        alt = (img.get_attribute("alt") or "").strip() if img else ""
        if alt:
            return alt
        slug = (el.get_attribute("href") or "").removeprefix("/c/").strip("/")
        if slug:
            return slug.replace("-", " ").strip()
    return _text(_q(page, "company_heading")) or hint


def _degree_gate_line(page) -> str:
    """simplify's structured Degree chip -> a normalized requirements line when
    it lists only graduate degrees, so hardfilter's DEGREE rules can fire. The
    JD prose ("currently pursuing a Master's or PhD ... is preferred") matches
    no DEGREE_NEGATIVE pattern; the chip is the machine-readable gate. Emitted
    as its own line -- hardfilter clamps its negation window to the line."""
    txt = _text(_q(page, "degree"))
    if not txt:
        return ""
    if _GRAD_ONLY_RE.search(txt) and not _UNDERGRAD_RE.search(txt):
        return (
            "Degree requirement: this posting's structured Degree field lists "
            f"only graduate degrees ({txt}) -- a Master's or PhD is required."
        )
    return ""


def _employment_hint_text(description: str) -> str:
    m = _EMPLOYMENT_RE.search(description)
    return m.group(1) if m else ""


def _employment_hint(page, description: str) -> str:
    chip = _text(_q(page, "employment_type"))
    return chip or _employment_hint_text(description)


def parse_posting(page, url: str, company_hint: str = "", role_hint: str = "") -> JobPosting:
    """Pure DOM parse of the currently-loaded simplify.jobs posting page.

    company / role / location fall back to the digest hints only when the page
    value is blank (page value wins). Raises ResolveError when the page has no
    JD container at all (dead link / removed posting).
    """
    wrapper = _q(page, "jd_wrapper")
    body = _q(page, "description")
    if wrapper is None and body is None:
        raise ResolveError(f"no JD container at {url}")
    description = _text(wrapper) or _text(body)
    if len(description) < 20:
        raise ResolveError(f"empty JD container at {url}")

    extras: list[str] = []
    term = _text(_q(page, "term"))
    if term:
        extras.append(f"Posting term: {term}.")
    gate = _degree_gate_line(page)
    if gate:
        extras.append(gate)

    return JobPosting(
        source="swelist",
        external_id=_simplify_external_id(url),
        url=url,
        company=_company(page, company_hint),
        role=_text(_q(page, "role")) or role_hint,
        location=_text(_q(page, "location")),
        salary_hint="",
        posted_at="",
        description=description,
        employment_type_hint=_employment_hint(page, description),
        requirements_text="\n".join(extras),
    )


# simplify.jobs's /jobs/click/{uuid} page issues its own client-side
# redirect to the real ATS posting. That redirect can complete WHILE our
# page.goto(click) is still waiting for domcontentloaded, so Playwright
# raises "Navigation ... is interrupted by another navigation to
# <real-url>" instead of resolving -- even though the browser has, in
# fact, already landed on the real posting (live shakedown, 2026-09-11
# digest: Toro x2, Evolito, Vishay, RF-SMART, Swarm Aero, Hudl, Waymo,
# Bedrock, Exegy all hit this). Trust page.url over the raised exception
# in that specific case instead of discarding a navigation that actually
# succeeded; re-raise anything else so a genuine failure isn't swallowed.
def _goto_settled(page, url: str, timeout: int = 30000) -> str:
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=timeout)
    except Exception as e:  # noqa: BLE001
        if "interrupted by another navigation" not in str(e):
            return ""
    try:
        page.wait_for_timeout(2500)
        return strip_tracking(page.url)
    except Exception:  # noqa: BLE001
        return ""


class SwelistAdapter:
    source = "swelist"

    def resolve_and_extract(
        self, page, url: str, company_hint: str = "", role_hint: str = ""
    ) -> JobPosting:
        # Resolve the simplify.jobs link to the REAL ATS posting (the
        # `/jobs/click/{uuid}` redirect, followed in a real browser so the
        # `?for=&token=` query survives -- a HEAD request drops it), then read
        # that posting: its JSON API when we have one, else the rendered page.
        # simplify's own SPA scrape is only the last resort. The real JD is
        # where the sponsorship / clearance / term / degree language lives.
        ext = _simplify_external_id(url)
        click = simplify_click_url(url)
        real = ""
        if click:
            real = _goto_settled(page, click)
        is_real = bool(real and real.startswith("http") and "simplify.jobs" not in real)
        if is_real:
            jd = source_jd(page, real, company_hint)
            if jd and not looks_blocked(jd):
                return JobPosting(
                    source="swelist", external_id=ext, url=real,
                    company=company_hint or "", role=role_hint or "", location="",
                    salary_hint="", posted_at=posted_at_from_ats_text(jd),
                    description=jd, employment_type_hint=_employment_hint_text(jd),
                    requirements_text="",
                )

        _goto_settled(page, url)  # lands on the simplify SPA; also settles any redirect
        # Best-effort: reveal the "Full Job Posting" tab so its body is
        # populated. parse_posting already reads it while hidden, but a live
        # page may lazy-load the raw posting on tab open. Tuning -> Task 20.
        try:
            toggle = page.query_selector(SELECTORS["full_jd_toggle"])
            if toggle:
                toggle.click()
                page.wait_for_timeout(500)
        except Exception:  # noqa: BLE001
            pass
        posting = parse_posting(page, page.url or url, company_hint, role_hint)
        if is_real:
            # We know the real ATS url (the click-redirect landed on it) even
            # though its content was unreadable (bot-wall, e.g. iCIMS) --
            # keep it instead of reverting the pick's link to the simplify
            # permalink (Allen: links must point to the direct posting).
            posting = dataclasses.replace(posting, url=real)
        return posting
