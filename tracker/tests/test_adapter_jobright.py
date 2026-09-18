"""Task 9: jobright.ai adapter.

The real fixtures under tests/fixtures/jobright/ were captured from Allen's
logged-in session. Allen's real captures do NOT cleanly contain an explicit
no-sponsorship clause or a Fall-only term, so the drop-behaviour tests build
tiny synthetic snippets that use the SAME selectors the adapter reads
(SELECTORS["detail_description"]) and assert parse_detail feeds hardfilter
correctly. All three real detail fixtures are still exercised for "does it
parse".
"""
from pathlib import Path

import pytest

from jobscan.adapters.base import JobCard
import jobscan.adapters.jobright as jr
from jobscan.adapters.jobright import (
    SELECTORS,
    JobrightAdapter,
    ParseError,
    parse_cards,
    parse_detail,
)
from jobscan.hardfilter import hardfilter

FX = Path(__file__).parent / "fixtures/jobright"
# captured before the autouse fixture below stubs jr._source_jd, so a
# dedicated regression test for _source_jd itself can restore the real
# function instead of asserting against the stub.
_REAL_SOURCE_JD = jr._source_jd


@pytest.fixture(autouse=True)
def _no_real_source_jd(monkeypatch):
    """By default a fixture test can't reach a real ATS -- stub the source-JD
    resolution to "unreachable" so parse_detail exercises the jobright-own
    fallback. Tests for the real-JD path patch this explicitly."""
    monkeypatch.setattr(jr, "_source_jd", lambda page, card: None)


def load(chrome_page, name):
    chrome_page.set_content((FX / name).read_text())
    return chrome_page


def _detail_snippet(body: str) -> str:
    # Mirrors the class the adapter reads for the description container.
    return f'<html><body><div class="index_jobDetailContent__TESTID">{body}</div></body></html>'


# --- real feed fixture -------------------------------------------------------

def test_parse_cards_returns_jobcards(chrome_page):
    cards = parse_cards(load(chrome_page, "feed.html"))
    assert len(cards) >= 1
    for c in cards:
        assert c.source == "jobright"
        assert c.company and c.role and c.url
        assert c.external_id
        assert c.url.startswith("https://jobright.ai/jobs/info/")
        assert c.external_id in c.url


def test_adapter_feed_url():
    assert JobrightAdapter().feed_url() == "https://jobright.ai/jobs"
    assert JobrightAdapter.source == "jobright"


# --- real detail fixtures --------------------------------------------------

def test_parse_detail_clean(chrome_page):
    card = JobCard("jobright", "x", "https://jobright.ai/jobs/info/x",
                   "Arm", "Intern Program - Engineering Pathways", "Chandler, AZ", "", "")
    posting = parse_detail(load(chrome_page, "detail_clean.html"), card)
    assert len(posting.description) > 100
    assert "Responsibilities" in posting.description
    assert hardfilter(posting) is None


def test_parse_detail_sponsorship_fixture_parses(chrome_page):
    card = JobCard("jobright", "x", "u", "Microsoft",
                   "Applied Science: Internship Opportunities - Redmond", "Redmond, WA", "", "")
    posting = parse_detail(load(chrome_page, "detail_sponsorship.html"), card)
    assert len(posting.description) > 100


def test_parse_detail_fall_term_fixture_parses(chrome_page):
    card = JobCard("jobright", "x", "u", "Waymo",
                   "2027 Summer Intern, BS, SysEng Software Engineer", "Mountain View, CA", "", "")
    posting = parse_detail(load(chrome_page, "detail_fall_term.html"), card)
    assert len(posting.description) > 100


def test_parse_detail_raises_when_no_description_container(chrome_page):
    # A dead / stripped detail page: no index_jobDetailContent__ container.
    # Must raise (-> run.py routes to artifact['errors'], no terminal
    # seen_jobs row) rather than return a JobPosting with description="".
    card = JobCard("jobright", "x", "https://jobright.ai/jobs/info/x",
                   "Acme", "SWE Intern", "Austin, TX", "", "")
    chrome_page.set_content("<html><body>nothing here</body></html>")
    with pytest.raises(ParseError):
        parse_detail(chrome_page, card)


# --- drop behaviour via synthetic snippets --------------------------------

def test_parse_detail_feeds_hardfilter_no_sponsorship(chrome_page):
    card = JobCard("jobright", "x", "u", "Acme", "SWE Intern", "Austin, TX", "", "")
    chrome_page.set_content(_detail_snippet(
        "We are hiring a summer intern. Note: we do not sponsor visas for this position."
    ))
    posting = parse_detail(chrome_page, card)
    assert hardfilter(posting) == "no-sponsorship"


def test_parse_detail_feeds_hardfilter_fall_term(chrome_page):
    card = JobCard("jobright", "x", "u", "Acme", "SWE Intern", "Austin, TX", "", "")
    chrome_page.set_content(_detail_snippet(
        "This is a Fall 2026 internship, no summer option."
    ))
    posting = parse_detail(chrome_page, card)
    assert hardfilter(posting) == "term:off-season"


# --- SELECTORS sanity ----------------------------------------------------

def test_selectors_populated():
    required = {"card", "card_company", "card_role", "card_location",
                "card_link", "detail_description"}
    for key in required:
        assert SELECTORS.get(key), f"SELECTORS[{key!r}] must be non-empty"


def test_clean_role_strips_trailing_job_details_and_company():
    from jobscan.adapters.jobright import _clean_role
    assert _clean_role("Software Engineer Intern Job Details | NetApp, Inc.") == "Software Engineer Intern"
    assert _clean_role("Firmware Engineer Intern") == "Firmware Engineer Intern"
    assert _clean_role("SWE Intern\nposted 5 hours ago") == "SWE Intern"


def test_original_job_post_url_from_link_strips_tracking(monkeypatch):
    class El:
        def get_attribute(self, _):
            return ("https://careers.twosigma.com/careers/JobDetail/x/14016"
                    "?source=jobright&jr_id=abc")

    class Page:
        def query_selector(self, sel): return El() if "Original Job Post" in sel else None
        def content(self): return ""
    assert jr.original_job_post_url(Page()) == (
        "https://careers.twosigma.com/careers/JobDetail/x/14016")


def test_original_job_post_url_none_when_only_jobright_links():
    class Page:
        def query_selector(self, sel): return None
        def content(self): return '<a href="https://jobright.ai/x">self</a>'
    assert jr.original_job_post_url(Page()) is None


def test_parse_detail_keeps_real_url_even_when_its_content_is_blocked(chrome_page, monkeypatch):
    # EquipmentShare (2026-09-15): the "Original Job Post" link resolves
    # fine to a real linkedin.com/jobs/view url, but our browser profile
    # has no LinkedIn login so the content read is blocked (the sign-in
    # wall) -- the old code then discarded the known-real url and fell
    # back to the jobright.ai permalink, even though we'd already proven
    # where the real posting lives. Allen: links must point to the direct
    # posting, never runway/simplify/jobright.
    # Exercise the real _source_jd (the autouse fixture above stubs it for
    # every other test in this file) so this test actually proves the fix --
    # mock only the two calls it makes internally.
    monkeypatch.setattr(jr, "_source_jd", _REAL_SOURCE_JD)
    monkeypatch.setattr(jr, "original_job_post_url",
                        lambda page: "https://www.linkedin.com/jobs/view/4467206633")
    monkeypatch.setattr(jr, "source_jd", lambda page, url, company="": "")
    card = JobCard("jobright", "x", "https://jobright.ai/jobs/info/x", "EquipmentShare",
                   "Intern: Engineering (Embedded)", "Columbia, MO", "", "")
    posting = parse_detail(load(chrome_page, "detail_clean.html"), card)
    assert posting.url == "https://www.linkedin.com/jobs/view/4467206633"


def test_parse_detail_prefers_the_real_ats_jd_over_jobrights_scrape(chrome_page, monkeypatch):
    # the real Arm JD carries a no-sponsorship clause jobright's scrape omits
    real = ("Graduate CPU Engineer\n" + "We design CPUs. " * 30
            + " Arm will not sponsor visas for this position.")
    monkeypatch.setattr(jr, "_source_jd",
                        lambda page, card: (real, "https://careers.arm.com/job/33099"))
    card = JobCard("jobright", "x", "https://jobright.ai/jobs/info/x", "Arm",
                   "Graduate CPU Engineer", "Austin, TX", "", "")
    posting = parse_detail(load(chrome_page, "detail_clean.html"), card)
    assert posting.url == "https://careers.arm.com/job/33099"
    assert "will not sponsor" in posting.description
    assert hardfilter(posting) == "no-sponsorship"
