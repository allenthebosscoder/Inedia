import json
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "scan_jobs", Path(__file__).parent.parent / "scripts/scan_jobs.py")
scan_jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan_jobs)


def test_load_swelist_links_missing_file(tmp_path):
    assert scan_jobs.load_swelist_links(str(tmp_path / "nope.json")) == []


def test_load_swelist_links_reads_and_validates(tmp_path):
    p = tmp_path / "links.json"
    p.write_text(json.dumps([
        {"url": "https://simplify.jobs/p/1", "company_hint": "A", "role_hint": "R"},
        {"company_hint": "no url"},
    ]))
    links = scan_jobs.load_swelist_links(str(p))
    assert len(links) == 1 and links[0]["url"].endswith("/1")


def test_format_summary_shows_deduped_count():
    artifact = {
        "summary": {"jobright": {"scanned": 10, "deduped": 3, "prefiltered": 6,
                                 "hardfiltered": 0, "candidates": 1}},
        "candidates": [1], "dropped": [1, 1, 1], "errors": [],
    }
    out = scan_jobs.format_summary(artifact)
    assert "dedup -3" in out


def test_format_summary_mentions_each_source():
    artifact = {
        "summary": {"jobright": {"scanned": 10, "deduped": 0, "prefiltered": 6, "hardfiltered": 2, "candidates": 2},
                    "swelist": {"scanned": 3, "deduped": 0, "prefiltered": 1, "hardfiltered": 0, "candidates": 2}},
        "candidates": [1, 2, 3, 4], "dropped": [1] * 9, "errors": [],
    }
    out = scan_jobs.format_summary(artifact)
    assert "jobright" in out and "swelist" in out and "4" in out


def test_default_is_headless_so_a_scan_never_steals_focus():
    # Allen (2026-09-15): "is there a way to make the scan run without my
    # laptop forcing to that screen everytime a new page is opened?" -- the
    # docstring already claimed "Runs headless" but the actual CLI default
    # was a *visible* browser (--headless was opt-in, defaulting False).
    # Headless must be the default; --show is the opt-in for debugging.
    args = scan_jobs._parser().parse_args([])
    assert args.show is False


def test_show_flag_opts_into_a_visible_browser_for_debugging():
    args = scan_jobs._parser().parse_args(["--show"])
    assert args.show is True


def test_select_sources_only_swelist_skips_both_feeds():
    feeds, swelist, links = scan_jobs._select_sources(
        "swelist", {"jobright": "JR", "jobright": "RW"}, [{"url": "x"}])
    assert feeds == []
    assert swelist is not None
    assert links == [{"url": "x"}]


def test_select_sources_only_one_feed_skips_swelist():
    feeds, swelist, links = scan_jobs._select_sources(
        "jobright", {"jobright": "JR"}, [{"url": "x"}])
    assert feeds == ["JR"]
    assert swelist is None
    assert links == []


def test_select_sources_full_run_scans_everything():
    feeds, swelist, links = scan_jobs._select_sources(
        None, {"jobright": "JR"}, [{"url": "x"}])
    assert feeds == ["JR"]
    assert swelist is not None
    assert links == [{"url": "x"}]


def test_format_summary_shows_errors_and_blocked_counts():
    artifact = {
        "summary": {"jobright": {"scanned": 10, "deduped": 0, "prefiltered": 6,
                                 "hardfiltered": 1, "candidates": 1, "errors": 2,
                                 "blocked": 1}},
        "candidates": [1], "dropped": [1],
        "errors": [{"url": "u", "error": "boom"}, {"url": "v", "error": "boom"},
                   {"url": "w", "error": "blocked:www.tesla.com", "blocked": True}],
    }
    out = scan_jobs.format_summary(artifact)
    assert "errors 2" in out and "blocked 1" in out
    assert "errors: 2 · blocked: 1" in out
