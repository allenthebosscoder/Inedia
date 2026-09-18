"""my-job-notifier.vercel.app adapter.

A 2026-09 site redesign broke every DOM selector the old scraper used and
hid the full list behind a button. The site now serves every listing as
JSON at /api/jobs (no auth, no browser), each row carrying the real
external ATS url -- so walk_feed just fetches that endpoint.

extract_detail is unchanged: my-job-notifier has no JD of its own, so it
navigates to the external ATS posting (Workday, Greenhouse,
SmartRecruiters, ...) and scrapes that, exactly as before.
"""
import json
from pathlib import Path

import pytest

from jobscan.adapters.base import JobCard, ParseError
from jobscan.adapters.jobnotifier import (
    BlockedError,
    JobnotifierAdapter,
    _posting,
    parse_detail,
    parse_jobs,
)
from jobscan.hardfilter import hardfilter

FX = Path(__file__).parent / "fixtures/jobnotifier"
API_JOBS = json.loads((FX / "api_jobs.json").read_text())["jobs"]


def load(chrome_page, name):
    chrome_page.set_content((FX / name).read_text())
    return chrome_page


# --- /api/jobs parsing -----------------------------------------------------

def test_parse_jobs_returns_jobcards():
    cards = parse_jobs(API_JOBS)
    assert len(cards) >= 1
    for c in cards:
        assert c.source == "jobnotifier"
        assert c.company and c.role and c.url
        assert c.external_id
        # url is the real external ATS posting, not my-job-notifier itself
        assert c.url.startswith("http")
        assert "my-job-notifier" not in c.url


def test_parse_jobs_keeps_us_drops_canada_and_other():
    countries = {j["country"] for j in API_JOBS}
    assert {"usa", "both", "canada", "other"} <= countries  # fixture covers all
    kept_urls = {c.url for c in parse_jobs(API_JOBS)}
    for j in API_JOBS:
        expected = j["country"] in ("usa", "both")
        assert (j["url"] in kept_urls) is expected, (j["country"], j["title"])


def test_parse_jobs_uses_api_id_as_external_id():
    # The API's stable `id` (e.g. "simplify-newgrad:7d735d17-…") survives ATS
    # URL churn better than slugging the url, so it's the seen_jobs skip key.
    usa = next(j for j in API_JOBS if j["country"] in ("usa", "both"))
    card = next(c for c in parse_jobs(API_JOBS) if c.url == usa["url"])
    assert card.external_id == usa["id"]


def test_parse_jobs_parses_posted_date_to_iso():
    cards = parse_jobs(API_JOBS)
    dated = [c for c in cards if c.posted_at]
    assert dated, "expected at least one card with a posted_at"
    assert all(len(c.posted_at) == 10 and c.posted_at[:2] == "20" for c in dated)


def test_parse_jobs_skips_rows_missing_url_or_title():
    rows = [
        {"id": "x:1", "url": "", "title": "SWE Intern", "company": "Acme", "country": "usa"},
        {"id": "x:2", "url": "https://x.co/j", "title": "", "company": "Acme", "country": "usa"},
        {"id": "x:3", "url": "not-a-url", "title": "SWE", "company": "Acme", "country": "usa"},
    ]
    assert parse_jobs(rows) == []


# --- walk_feed -----------------------------------------------------------

def test_walk_feed_fetches_api_and_skips_seen(monkeypatch):
    monkeypatch.setattr("jobscan.adapters.jobnotifier._fetch_api", lambda: API_JOBS)
    a = JobnotifierAdapter()
    all_cards = list(a.walk_feed(None))
    assert all_cards, "expected cards from the stubbed API"

    first_key = f"jobnotifier:{all_cards[0].external_id}"
    fewer = list(a.walk_feed(None, is_seen=lambda k: k == first_key))
    assert len(fewer) == len(all_cards) - 1
    assert all(f"jobnotifier:{c.external_id}" != first_key for c in fewer)


def test_walk_feed_raises_parseerror_when_api_unreachable(monkeypatch):
    def boom():
        raise OSError("connection refused")

    monkeypatch.setattr("jobscan.adapters.jobnotifier._fetch_api", boom)
    with pytest.raises(ParseError):
        list(JobnotifierAdapter().walk_feed(None))


def test_adapter_feed_url():
    assert JobnotifierAdapter().feed_url() == "https://my-job-notifier.vercel.app"
    assert JobnotifierAdapter.source == "jobnotifier"
    assert JobnotifierAdapter.uses_separate_detail_page is True


# --- extract_detail: generic external-site scrape (unchanged) -------------

def test_parse_detail_real_smartrecruiters_fixture(chrome_page):
    card = JobCard("jobnotifier", "744000147613629",
                   "https://jobs.smartrecruiters.com/Solidigm/744000147613629",
                   "Solidigm", "Software Development & Firmware Engineering Intern",
                   "Rancho Cordova, CA", "", "2026-09-05")
    posting = parse_detail(load(chrome_page, "detail_smartrecruiters.html"), card)
    assert len(posting.description) > 100
    assert "Solidigm" in posting.description
    # This real Solidigm page carries "not eligible for candidates requiring
    # VISA sponsorship" -- the generic body scrape must surface it to hardfilter.
    assert hardfilter(posting) == "no-sponsorship"


def test_parse_detail_raises_blocked_when_page_is_a_bot_wall(chrome_page):
    card = JobCard("jobnotifier", "x", "https://www.tesla.com/careers/search/job/1",
                   "Tesla", "Embedded SW Intern", "Palo Alto, CA", "", "")
    chrome_page.set_content(
        "<html><body>Access Denied You don't have permission to access this "
        "server. Reference #18.abcdef</body></html>")
    with pytest.raises(BlockedError):
        parse_detail(chrome_page, card)


_PAD = " ".join(["The team builds embedded systems and firmware for our products."] * 8)


def test_parse_detail_feeds_hardfilter_no_sponsorship(chrome_page):
    card = JobCard("jobnotifier", "x", "https://x.co/j", "Acme", "SWE Intern", "Austin, TX", "", "")
    chrome_page.set_content(
        f"<html><body>We are hiring a summer intern. {_PAD} Note: we do not "
        f"sponsor visas for this position.</body></html>")
    posting = parse_detail(chrome_page, card)
    assert hardfilter(posting) == "no-sponsorship"


def test_parse_detail_feeds_hardfilter_fall_term(chrome_page):
    card = JobCard("jobnotifier", "x", "https://x.co/j", "Acme", "SWE Intern", "Austin, TX", "", "")
    chrome_page.set_content(
        f"<html><body>This is a Fall 2026 internship, no summer option. {_PAD}</body></html>")
    posting = parse_detail(chrome_page, card)
    assert hardfilter(posting) == "term:off-season"


def test_posting_prefers_ats_posted_date_over_card_timestamp():
    card = JobCard("jobnotifier", "x", "u", "Acme", "SWE Intern", "Austin, TX", "", "2026-09-05")
    text = ("SWE Intern\nPosted: Posted 18 Days Ago\n" + "real jd body. " * 40)
    assert _posting(card, text).posted_at == "Posted 18 Days Ago"
