import json
from pathlib import Path
import datetime

import pytest

from db import init_db, get_db
from jobscan import seen, run as runmod
from jobscan.adapters.base import JobCard, JobPosting, dedup_key
from jobscan.adapters.jobright import LoginRequired

TODAY = datetime.date(2026, 9, 2)


class FakePage:
    url = "https://x"
    def goto(self, *a, **k): pass
    def wait_for_timeout(self, *a, **k): pass


class FakeFeed:
    source = "jobright"
    def __init__(self, cards, details): self._cards, self._details = cards, details
    def feed_url(self): return "u"
    def walk_feed(self, page, is_seen=lambda k: False):
        for c in self._cards:
            if not is_seen(f"{c.source}:{c.external_id}"):
                yield c
    def extract_detail(self, page, card): return self._details[card.external_id]


def _card(eid, role="Firmware Engineer Intern", loc="Austin, TX"):
    return JobCard("jobright", eid, f"https://jobright.ai/jobs/{eid}", "Acme", role, loc, "", "2026-09-01")


def _detail(card, desc="Summer 2027 internship for ECE students. " * 5):
    return JobPosting(card.source, card.external_id, card.url, card.company, card.role,
                      card.location, "", card.posted_at, desc, "Internship", "")


def test_run_produces_candidates_and_drops(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path)
    good = _card("g1")
    badloc = _card("b1", loc="London, UK")
    sponsor = _card("s1")
    feed = FakeFeed(
        [good, badloc, sponsor],
        {"g1": _detail(good),
         "b1": _detail(badloc),
         "s1": _detail(sponsor, desc="We do not sponsor visas. " * 5)},
    )
    artifact = runmod.run(db_path, [feed], None, [], FakePage(), str(tmp_path / "daily_run"), today=TODAY)

    keys = {c["external_id"] for c in artifact["candidates"]}
    assert keys == {"g1"}
    reasons = {d["job_key"]: d["reason"] for d in artifact["dropped"]}
    assert reasons["jobright:b1"] == "prefilter:location"
    assert reasons["jobright:s1"] == "no-sponsorship"

    conn = get_db(db_path)
    assert seen.disposition_of(conn, "jobright:g1") == "candidate"
    assert seen.disposition_of(conn, "jobright:s1") == "dropped"
    conn.close()

    files = list((tmp_path / "daily_run").glob("*.json"))
    assert len(files) == 1
    assert json.loads(files[0].read_text())["summary"]["jobright"]["candidates"] == 1


def test_run_skips_already_seen(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path)
    conn = get_db(db_path)
    seen.record(conn, key="jobright:g1", source="jobright", url="u", disposition="deleted")
    conn.close()
    good = _card("g1")
    feed = FakeFeed([good], {"g1": _detail(good)})
    artifact = runmod.run(db_path, [feed], None, [], FakePage(), str(tmp_path / "daily_run"), today=TODAY)
    assert artifact["candidates"] == []


def test_run_bumps_last_seen_for_already_seen_cards(tmp_path):
    # walk_feed's is_seen callback skips these cards before they ever reach
    # _process, so nothing else in run() touches their row -- last_seen must
    # be refreshed right there, in the is_seen callback itself, or a job
    # that's still actively listed every day looks stale forever.
    db_path = str(tmp_path / "t.db"); init_db(db_path)
    conn = get_db(db_path)
    seen.record(conn, key="jobright:g1", source="jobright", url="u", disposition="deleted")
    conn.execute("UPDATE seen_jobs SET last_seen = '2020-01-01 00:00:00' WHERE job_key='jobright:g1'")
    conn.commit()
    conn.close()

    good = _card("g1")
    feed = FakeFeed([good], {"g1": _detail(good)})
    runmod.run(db_path, [feed], None, [], FakePage(), str(tmp_path / "daily_run"), today=TODAY)

    conn = get_db(db_path)
    row = conn.execute("SELECT last_seen FROM seen_jobs WHERE job_key = ?", ("jobright:g1",)).fetchone()
    conn.close()
    assert row["last_seen"] != "2020-01-01 00:00:00"


def test_run_swelist_path(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path)

    class FakeSwelist:
        source = "swelist"
        def resolve_and_extract(self, page, url, company_hint="", role_hint=""):
            return JobPosting("swelist", "abc123", url, company_hint or "Anduril",
                              role_hint or "Firmware Engineer Intern", "Irvine, CA", "", "",
                              "Summer 2027 embedded internship. " * 5, "Internship", "")

    links = [{"url": "https://simplify.jobs/p/abc123", "company_hint": "Anduril", "role_hint": "Firmware Engineer Intern"}]
    artifact = runmod.run(db_path, [], FakeSwelist(), links, FakePage(), str(tmp_path / "daily_run"), today=TODAY)
    assert len(artifact["candidates"]) == 1
    assert artifact["candidates"][0]["source"] == "swelist"
    assert artifact["candidates"][0]["term"] == "Summer 2027"


def test_run_skips_postings_already_in_the_applications_table(tmp_path):
    # Allen applies to plenty of roles outside the pipeline (directly on an
    # ATS). Those never touch seen_jobs, so the scan re-surfaces them unless
    # run() cross-checks the applications table. Match is by dedup_key, so
    # the ATS req-id suffix on the applications row must not defeat it.
    db_path = str(tmp_path / "t.db"); init_db(db_path)
    conn = get_db(db_path)
    conn.execute(
        "INSERT INTO applications (date_applied, company, role, type, status) "
        "VALUES ('2026-09-05', 'Microsoft', 'Hardware Engineering Intern (200053349)', 'Intern', 'Applied')"
    )
    conn.commit()
    conn.close()

    hit = JobCard("jobright", "h1", "https://jobright.ai/jobs/h1", "Microsoft",
                  "Hardware Engineer Intern", "Redmond, WA", "", "2026-09-04")
    other = _card("g1")
    feed = FakeFeed([hit, other], {"h1": _detail(hit), "g1": _detail(other)})
    artifact = runmod.run(db_path, [feed], None, [], FakePage(),
                          str(tmp_path / "daily_run"), today=TODAY)

    companies = {c["company"] for c in artifact["candidates"]}
    assert "Microsoft" not in companies
    assert "Acme" in companies
    reasons = {d["company"]: d["reason"] for d in artifact["dropped"]}
    assert "applied" in reasons["Microsoft"]

    conn = get_db(db_path)
    assert seen.disposition_of(conn, "jobright:h1") == "applied"
    conn.close()


def test_run_buckets_blocked_detail_pages_separately(tmp_path):
    from jobscan.adapters.base import BlockedError
    db_path = str(tmp_path / "t.db"); init_db(db_path)

    class BlockedFeed:
        source = "jobright"
        def feed_url(self): return "u"
        def walk_feed(self, page, is_seen=lambda k: False):
            yield _card("b1")
        def extract_detail(self, page, card):
            raise BlockedError("blocked:www.tesla.com")

    artifact = runmod.run(db_path, [BlockedFeed()], None, [], FakePage(),
                          str(tmp_path / "daily_run"), today=TODAY)
    assert artifact["candidates"] == []
    assert artifact["summary"]["jobright"]["blocked"] == 1
    assert artifact["summary"]["jobright"]["errors"] == 0
    assert artifact["errors"][0]["blocked"] is True
    # no seen_jobs row -> retried next run
    conn = get_db(db_path)
    assert seen.disposition_of(conn, "jobright:b1") is None
    conn.close()


def test_run_propagates_login_required(tmp_path):
    # A dead session (walk_feed raises LoginRequired) must abort the whole run
    # so scripts/scan_jobs.py can catch it -- not be swallowed into errors[].
    db_path = str(tmp_path / "t.db"); init_db(db_path)

    class LoginFeed:
        source = "jobright"
        def feed_url(self): return "u"
        def walk_feed(self, page, is_seen=lambda k: False):
            raise LoginRequired("jobright")
        def extract_detail(self, page, card):  # pragma: no cover
            raise AssertionError

    with pytest.raises(LoginRequired):
        runmod.run(db_path, [LoginFeed()], None, [], FakePage(),
                   str(tmp_path / "daily_run"), today=TODAY)


def test_run_initializes_db_schema(tmp_path):
    db_path = str(tmp_path / "fresh.db")  # never init_db'd
    good = _card("g1")
    feed = FakeFeed([good], {"g1": _detail(good)})
    artifact = runmod.run(db_path, [feed], None, [], FakePage(), str(tmp_path / "daily_run"), today=TODAY)
    assert artifact["errors"] == []
    assert len(artifact["candidates"]) == 1


class FakeFeedSrc(FakeFeed):
    """A feed whose source is configurable (FakeFeed hardcodes 'jobright')."""
    def __init__(self, cards, details, source):
        super().__init__(cards, details)
        self.source = source


def _card_src(source, eid, company="Acme", role="Firmware Engineer Intern", loc="Austin, TX"):
    return JobCard(source, eid, f"https://{source}/jobs/{eid}", company, role, loc, "", "2026-09-01")


def _detail_for(card, desc="Summer 2027 internship for ECE students. " * 5):
    return JobPosting(card.source, card.external_id, card.url, card.company, card.role,
                      card.location, "", card.posted_at, desc, "Internship", "")


def test_run_groups_cross_source_twins_into_one_candidate_with_locations(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path)
    jr = _card_src("jobright", "jr1", loc="Austin, TX")
    rw = _card_src("runway", "rw1", loc="Denver, CO")
    feeds = [
        FakeFeedSrc([jr], {"jr1": _detail_for(jr)}, "jobright"),
        FakeFeedSrc([rw], {"rw1": _detail_for(rw)}, "runway"),
    ]
    artifact = runmod.run(db_path, feeds, None, [], FakePage(),
                          str(tmp_path / "daily_run"), today=TODAY)
    assert len(artifact["candidates"]) == 1
    c = artifact["candidates"][0]
    locs = {(l["location"], l["source"]) for l in c["locations"]}
    assert locs == {("Austin, TX", "jobright"), ("Denver, CO", "runway")}


def test_run_skips_card_whose_twin_was_applied_on_another_source(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path)
    conn = get_db(db_path)
    seen.record(conn, key="runway:already", source="runway", url="u",
                disposition="applied", dedup_key=dedup_key("Acme", "Firmware Engineer Intern"))
    conn.close()

    jr = _card_src("jobright", "jr1")  # Acme / Firmware Engineer Intern
    feed = FakeFeedSrc([jr], {"jr1": _detail_for(jr)}, "jobright")
    artifact = runmod.run(db_path, [feed], None, [], FakePage(),
                          str(tmp_path / "daily_run"), today=TODAY)

    assert artifact["candidates"] == []
    reasons = {d["job_key"]: d["reason"] for d in artifact["dropped"]}
    assert reasons["jobright:jr1"] == "dedup:applied"
    conn = get_db(db_path)
    assert seen.disposition_of(conn, "jobright:jr1") == "applied"
    conn.close()


def test_run_records_candidate_dedup_key(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path)
    jr = _card_src("jobright", "jr1")
    feed = FakeFeedSrc([jr], {"jr1": _detail_for(jr)}, "jobright")
    runmod.run(db_path, [feed], None, [], FakePage(), str(tmp_path / "daily_run"), today=TODAY)
    conn = get_db(db_path)
    row = conn.execute("SELECT dedup_key FROM seen_jobs WHERE job_key='jobright:jr1'").fetchone()
    conn.close()
    assert row["dedup_key"] == dedup_key("Acme", "Firmware Engineer Intern")
    assert row["dedup_key"] == "acme|engineer firmware intern"  # words sorted


class TrackingPage:
    """Records every goto so a test can prove which page an adapter touched."""
    def __init__(self):
        self.gotos: list[str] = []
    def goto(self, url, **k):
        self.gotos.append(url)
    def wait_for_timeout(self, *a, **k):
        pass


def test_run_gives_extract_detail_a_separate_page_from_walk_feed(tmp_path):
    # Real bug: extract_detail navigates the page it's given. If run() reused
    # the same page object walk_feed is scrolling, every card after the
    # first batch would be scanned against a job-detail page, not the feed.
    db_path = str(tmp_path / "t.db"); init_db(db_path)
    feed_page = TrackingPage()
    detail_page = TrackingPage()
    good = _card_src("jobright", "g1")

    class TrackingFeed:
        source = "jobright"
        uses_separate_detail_page = True
        def feed_url(self): return "https://jobright.ai/jobs"
        def walk_feed(self, page, is_seen=lambda k: False):
            assert page is feed_page, "walk_feed must get the feed page"
            page.goto(self.feed_url())
            yield good
        def extract_detail(self, page, card):
            assert page is detail_page, "extract_detail must get the detail page"
            page.goto(card.url)
            return _detail_for(good)

    artifact = runmod.run(db_path, [TrackingFeed()], None, [], feed_page,
                          str(tmp_path / "daily_run"), today=TODAY,
                          detail_page=detail_page)

    assert feed_page.gotos == ["https://jobright.ai/jobs"]
    assert detail_page.gotos == [good.url]
    assert len(artifact["candidates"]) == 1


def test_run_lets_an_adapter_opt_out_of_the_separate_detail_page(tmp_path):
    # runway's extract_detail clicks a row IN the feed page (no per-job URL
    # to goto), so it must keep sharing the feed page rather than getting
    # the separate detail_page.
    db_path = str(tmp_path / "t.db"); init_db(db_path)
    feed_page = TrackingPage()
    detail_page = TrackingPage()
    good = _card_src("runway", "r1")

    class ClickThroughFeed:
        source = "runway"
        uses_separate_detail_page = False
        def feed_url(self): return "https://app.joinrunway.io/explore"
        def walk_feed(self, page, is_seen=lambda k: False):
            yield good
        def extract_detail(self, page, card):
            assert page is feed_page, "this adapter must keep using the feed page"
            return _detail_for(good)

    artifact = runmod.run(db_path, [ClickThroughFeed()], None, [], feed_page,
                          str(tmp_path / "daily_run"), today=TODAY,
                          detail_page=detail_page)
    assert len(artifact["candidates"]) == 1


def test_run_detail_page_defaults_to_the_feed_page(tmp_path):
    # Backward compatible: callers (and every earlier test) that don't pass
    # detail_page at all still work exactly as before.
    db_path = str(tmp_path / "t.db"); init_db(db_path)
    good = _card("g1")
    feed = FakeFeed([good], {"g1": _detail(good)})
    artifact = runmod.run(db_path, [feed], None, [], FakePage(),
                          str(tmp_path / "daily_run"), today=TODAY)
    assert len(artifact["candidates"]) == 1


def test_run_buckets_posting_level_prefilter_drop_as_prefiltered_not_hardfiltered(tmp_path):
    # The card passes prefilter (location Austin, TX), but extract_detail's
    # posting reveals a non-US location -- _process's own prefilter check
    # catches it. That must count as "prefiltered", not "hardfiltered".
    db_path = str(tmp_path / "t.db"); init_db(db_path)
    card = _card("g1", loc="Austin, TX")
    detail = _detail(card)
    detail.location = "London, UK"
    feed = FakeFeed([card], {"g1": detail})
    artifact = runmod.run(db_path, [feed], None, [], FakePage(), str(tmp_path / "daily_run"), today=TODAY)
    s = artifact["summary"]["jobright"]
    assert s["prefiltered"] == 1
    assert s["hardfiltered"] == 0


def test_run_counts_extract_detail_errors_in_summary(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path)
    good = _card("g1")

    class ErrorFeed(FakeFeed):
        def extract_detail(self, page, card):
            raise RuntimeError("boom")

    feed = ErrorFeed([good], {})
    artifact = runmod.run(db_path, [feed], None, [], FakePage(), str(tmp_path / "daily_run"), today=TODAY)
    assert artifact["summary"]["jobright"]["errors"] == 1
    assert len(artifact["errors"]) == 1


def test_run_sorts_candidates_by_heuristic_score_descending(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path)
    low = _card("lo", role="Software Engineer Intern")
    high = _card("hi", role="Embedded Firmware Engineer FPGA Intern")
    feed = FakeFeed(
        [low, high],
        {"lo": _detail(low, desc="Summer 2027 internship."),
         "hi": _detail(high, desc="Summer 2027 embedded firmware FPGA internship. " * 3)},
    )
    artifact = runmod.run(db_path, [feed], None, [], FakePage(), str(tmp_path / "daily_run"), today=TODAY)
    scores = [c["heuristic_score"] for c in artifact["candidates"]]
    assert scores == sorted(scores, reverse=True)
    assert artifact["candidates"][0]["external_id"] == "hi"
