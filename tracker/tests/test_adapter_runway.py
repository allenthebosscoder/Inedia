"""Task 10: runway.io (joinrunway.io) adapter.

The real fixtures under tests/fixtures/runway/ were captured from Allen's
logged-in session at https://app.joinrunway.io/explore.

Fixture reality (see task-10-report.md):
  * The feed is one <table> of ~40 data <tr> rows. A row has NO job id / href
    anywhere; the id only exists on the detail page (canonical link
    /explore/job/<cuid>). So JobCard.url == "" from the feed and
    external_id is a deterministic slug of "<company>-<role>". parse_detail
    lifts the real /explore/job/<cuid> URL off the canonical link.
  * The detail page is the explore feed + a right-hand Radix dialog holding
    runway's AI summary (Role Summary / Responsibilities / Qualifications) and
    a collapsed "View full job description" region with the complete JD. In
    these static captures the region body is not yet rendered (Radix lazy),
    but the AI summary alone carries the filter-relevant text for two of the
    three real fixtures:
      - detail_sponsorship (RTX Analog/Power EE Intern): summary says
        "possess or can obtain a U.S. government security clearance"
        -> hardfilter == "clearance".
      - detail_fall_term (AMD "Fall 2027 Masters ... Intern"): the "Fall 2027"
        in the role title -> resolve_term "Off-season" -> hardfilter
        == "term:off-season".
      - detail_clean (V2X SWE Intern): parses clean, no filter tripped.
    Explicit no-sponsorship / degree-required language is still asserted via
    synthetic snippets using SELECTORS["detail_description"].
"""
import datetime
import re
from pathlib import Path

import pytest

from jobscan.adapters.base import JobCard
from jobscan.adapters.runway import (
    SELECTORS,
    ParseError,
    RunwayAdapter,
    _find_row,
    _slug,
    parse_cards,
    parse_detail,
)
import jobscan.adapters.runway as rw

_REAL_APPLY_TARGET_URL_AND_JD = rw._apply_target_url_and_jd  # captured before the
                                                              # autouse monkeypatch below
from jobscan.hardfilter import hardfilter, resolve_term

FX = Path(__file__).parent / "fixtures/runway"
TODAY = datetime.date(2026, 9, 3)


@pytest.fixture(autouse=True)
def _no_real_apply_target(monkeypatch):
    """Fixture tests can't open the real "Apply to Job" popup -- stub the
    resolution so parse_detail exercises runway's own-text fallback. The
    real-JD-path test patches this explicitly."""
    monkeypatch.setattr(rw, "_apply_target_url_and_jd", lambda page, company: (None, ""))
_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def load(chrome_page, name):
    chrome_page.set_content((FX / name).read_text())
    return chrome_page


def _detail_snippet(body: str) -> str:
    # Mirrors the selector the adapter reads for the JD container.
    return f'<html><body><div role="dialog">{body}</div></body></html>'


# --- slug ------------------------------------------------------------------

def test_slug_deterministic():
    assert _slug("General Matter", "Summer 2027 Internship - Embedded SW") == \
        "general-matter-summer-2027-internship-embedded-sw"
    # collapses runs of non-alnum and strips ends
    assert _slug("  Acme, Inc. ", "R&D  Intern!!") == "acme-inc-r-d-intern"
    # location is folded in when given
    assert _slug("Amazon", "SWE Intern", "Austin, TX") == "amazon-swe-intern-austin-tx"


def test_slug_disambiguates_by_location():
    # same title + company, different city -> different external_id / job_key,
    # so the second posting isn't skipped forever as a dupe.
    a = _slug("Amazon", "Software Engineer Intern", "Austin, TX")
    b = _slug("Amazon", "Software Engineer Intern", "San Jose, CA")
    assert a != b


# --- real feed fixture ---------------------------------------------------

def test_parse_cards_returns_jobcards(chrome_page):
    cards = parse_cards(load(chrome_page, "feed.html"))
    assert len(cards) >= 1
    first = cards[0]
    assert first.source == "runway"
    assert first.company and first.role and first.location and first.external_id
    assert first.url == ""
    assert _SLUG_RE.match(first.external_id)
    assert first.posted_at  # raw relative string, left as-is
    assert "ago" in first.posted_at


def test_parse_cards_finds_known_row(chrome_page):
    cards = parse_cards(load(chrome_page, "feed.html"))
    match = [
        c for c in cards
        if "Embedded Software Engineering" in c.role and c.company == "General Matter"
    ]
    assert len(match) == 1
    assert match[0].external_id == (
        "general-matter-summer-2027-internship-embedded-software-engineering"
        "-los-angeles-california"
    )


def test_find_row_locates_the_clickable_target(chrome_page):
    page = load(chrome_page, "feed.html")
    card = parse_cards(page)[0]
    row = _find_row(page, card)
    assert row is not None
    assert card.role in row.inner_text()


def test_adapter_meta():
    assert RunwayAdapter.source == "runway"
    assert RunwayAdapter().feed_url() == "https://app.joinrunway.io/explore"


# --- real detail fixtures (parse-only) ---------------------------------

def test_parse_detail_prefers_the_real_ats_jd(chrome_page, monkeypatch):
    real = ("Software Engineering Intern\n" + "Build systems. " * 30
            + " We do not sponsor visas for this position.")
    monkeypatch.setattr(rw, "_apply_target_url_and_jd",
                        lambda page, company: ("https://job-boards.greenhouse.io/acme/jobs/123", real))
    card = JobCard("runway", "x", "", "Acme", "Software Engineering Intern", "NYC", "", "")
    posting = parse_detail(load(chrome_page, "detail_clean.html"), card)
    assert posting.url == "https://job-boards.greenhouse.io/acme/jobs/123"
    assert hardfilter(posting, TODAY) == "no-sponsorship"


def test_parse_detail_keeps_real_url_even_when_its_content_is_blocked(chrome_page, monkeypatch):
    # Tighe & Bond / LUZCO / C&S Companies (2026-09-15): the real ATS url
    # resolves fine (the "Apply to Job" popup lands on it), but the popup's
    # content read comes back empty/blocked (e.g. icims.com bot-walling the
    # headless fetch) -- the old code then discarded the known-real url and
    # fell all the way back to the runway.io permalink for the pick's link,
    # even though we'd already proven where the real posting lives. Allen:
    # links must point to the direct posting, never runway/simplify/jobright.
    monkeypatch.setattr(rw, "_apply_target_url_and_jd",
                        lambda page, company: ("https://careers-tighebond.icims.com/jobs/1893/x", ""))
    card = JobCard("runway", "x", "", "Tighe & Bond", "Electrical Systems Design Internship", "MA", "", "")
    posting = parse_detail(load(chrome_page, "detail_clean.html"), card)
    assert posting.url == "https://careers-tighebond.icims.com/jobs/1893/x"


def test_apply_target_url_and_jd_never_navigates_the_shared_feed_page(monkeypatch):
    # Root-cause regression (2026-09-11): reading the real JD must happen on
    # the POPUP page, never on the shared feed `page` -- runway has no
    # per-job URL, so `page` is reused across every card in the walk, and
    # navigating it away breaks _find_row for every card after it.
    monkeypatch.setattr(rw, "fetch_ats_detail", lambda url, company="": None)

    class FeedPage:
        def goto(self, *a, **k):
            raise AssertionError("must not navigate the shared feed page")
        def query_selector(self, sel):
            return _Btn() if "Apply to Job" in sel else None
        context = None  # set below

    class Ctx:
        def __init__(self, popup):
            self._popup = popup
        def expect_page(self, timeout=8000):
            return _PopupCtx(self._popup)

    class _PopupCtx:
        def __init__(self, popup): self._popup = popup
        def __enter__(self): return self
        def __exit__(self, *a): return False
        @property
        def value(self): return self._popup

    class Popup:
        url = "https://job-boards.greenhouse.io/acme/jobs/123?source=jobright"
        def wait_for_load_state(self, *a, **k): pass
        def wait_for_timeout(self, *a, **k): pass
        def query_selector(self, sel):
            return _El("Real posting text. " * 30)
        def close(self): pass

    class _Btn:
        def click(self): pass

    class _El:
        def __init__(self, t): self._t = t
        def inner_text(self): return self._t

    feed = FeedPage()
    feed.context = Ctx(Popup())
    url, jd = _REAL_APPLY_TARGET_URL_AND_JD(feed, "Acme")
    assert url == "https://job-boards.greenhouse.io/acme/jobs/123"  # tracking stripped
    assert "Real posting text." in jd


def test_parse_detail_clean(chrome_page):
    card = JobCard("runway", "v2x-inc-software-engineering-intern-career-fair",
                   "", "V2X Inc",
                   "Software Engineering Intern- Career Fair",
                   "Indianapolis, Indiana", "", "about 22 hours ago")
    posting = parse_detail(load(chrome_page, "detail_clean.html"), card)
    assert len(posting.description) > 300
    assert "Responsibilities" in posting.description
    assert posting.url == "https://app.joinrunway.io/explore/job/cmtl8l9ng000da20ig0a56wsn"
    # V2X SWE intern -- no term in the summary, no sponsorship/clearance/degree
    # language -> parses clean.
    assert resolve_term(posting, TODAY) == "Unknown"
    assert hardfilter(posting, TODAY) is None


def test_parse_detail_sponsorship_trips_clearance(chrome_page):
    card = JobCard("runway", "x", "", "RTX",
                   "Analog and Power Design Electrical Engineering Intern (Summer 2027)",
                   "Marlborough, Massachusetts", "", "")
    posting = parse_detail(load(chrome_page, "detail_sponsorship.html"), card)
    assert len(posting.description) > 300
    assert "security clearance" in posting.description.lower()
    assert hardfilter(posting, TODAY) == "clearance"


def test_parse_detail_fall_term_trips_term(chrome_page):
    card = JobCard("runway", "x", "", "AMD",
                   "Fall 2027 Masters Silicon Design Engineering Intern",
                   "Austin, Texas", "", "")
    posting = parse_detail(load(chrome_page, "detail_fall_term.html"), card)
    assert len(posting.description) > 300
    # "Fall 2027" in the role title -> Off-season term. (This AMD posting is
    # also genuinely grad-only -- "pursuing a graduate degree" -- so
    # hardfilter may report either disqualifier; both are correct.)
    assert resolve_term(posting, TODAY) == "Off-season"
    assert hardfilter(posting, TODAY) in ("term:off-season", "degree")


def test_parse_detail_raises_when_no_dialog(chrome_page):
    # No [role="dialog"] and no full-JD region: description would be "" ->
    # must raise so run.py logs an error instead of caching a candidate.
    card = JobCard("runway", "x", "", "Acme", "SWE Intern", "Austin, TX", "", "")
    chrome_page.set_content("<html><body>nothing here</body></html>")
    with pytest.raises(ParseError):
        parse_detail(chrome_page, card)


# --- drop behaviour via synthetic snippets ----------------------------

def test_parse_detail_feeds_hardfilter_no_sponsorship(chrome_page):
    card = JobCard("runway", "x", "", "Acme", "SWE Intern", "Austin, TX", "", "")
    chrome_page.set_content(_detail_snippet(
        "Responsibilities: build things. Note: we do not sponsor visas for "
        "this position, now or in the future."
    ))
    posting = parse_detail(chrome_page, card)
    assert hardfilter(posting, TODAY) == "no-sponsorship"


def test_parse_detail_feeds_hardfilter_fall_term(chrome_page):
    card = JobCard("runway", "x", "", "Acme", "SWE Intern", "Austin, TX", "", "")
    chrome_page.set_content(_detail_snippet(
        "This is a Fall 2026 co-op. There is no summer option for this role."
    ))
    posting = parse_detail(chrome_page, card)
    assert hardfilter(posting, TODAY) == "term:off-season"


# --- SELECTORS sanity -------------------------------------------------

def test_selectors_populated():
    required = {"card", "card_company", "card_role", "card_location",
                "card_posted", "detail_description"}
    for key in required:
        assert SELECTORS.get(key), f"SELECTORS[{key!r}] must be non-empty"
