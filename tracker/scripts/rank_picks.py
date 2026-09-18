"""Rank the newest run artifact onto the /picks page.

    python3 scripts/rank_picks.py [--db tracker.db] [--out daily_run]
                                  [--api http://127.0.0.1:8080] [--dry-run]

Reads the most recent daily_run/*.json, drops what isn't Allen's field /
won't sponsor / he already applied to or deleted (jobscan.rank), and
POSTs the survivors to /api/picks/bulk, ranked. --dry-run just prints.
"""
from __future__ import annotations

import argparse
import datetime
import glob
import json
import os
import sqlite3
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from jobscan.adapters.base import JobPosting, dedup_key  # noqa: E402
from jobscan.detail_fetch import (  # noqa: E402
    fetch_ats_detail, looks_blocked, resolve_source_url, workday_api_url,
    greenhouse_api_url, smartrecruiters_api_url, workable_api_url, lever_api_url,
    ashby_api_url, oracle_api_url)
from jobscan.hardfilter import hardfilter, resolve_term  # noqa: E402
from jobscan.rank import rank  # noqa: E402


def _recognized_ats(url: str) -> bool:
    u = resolve_source_url(url) if "simplify" in url else url
    return any(f(u) for f in (workday_api_url, greenhouse_api_url, smartrecruiters_api_url,
                              workable_api_url, lever_api_url, ashby_api_url, oracle_api_url))


def _fresh_jd(c: dict, page) -> tuple[str, str]:
    """(real JD text, resolved URL) for a candidate. Resolves the aggregator
    link to the actual posting (jobright 'Original Job Post' href / simplify
    /jobs/click redirect) and reads that -- JSON API, else rendered page --
    falling back to the candidate's stored description + url."""
    from jobscan.detail_fetch import source_jd, strip_tracking, simplify_click_url
    from jobscan.adapters.jobright import original_job_post_url
    url, company = c["url"], c["company"]

    if "jobright.ai" in url and page is not None:
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(3000)
            real = original_job_post_url(page)
            if real:
                jd = source_jd(page, real, company)
                if jd and not looks_blocked(jd):
                    return jd, real
        except Exception:  # noqa: BLE001
            pass
        return c.get("description", ""), url

    real = url
    click = simplify_click_url(url)
    if click and page is not None:  # follow the redirect in a real browser
        try:
            page.goto(click, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(2500)
            real = strip_tracking(page.url)
        except Exception:  # noqa: BLE001
            real = url
    if real and "simplify.jobs" not in real and "joinjobright" not in real:
        t = source_jd(page, strip_tracking(real), company) if page is not None \
            else (fetch_ats_detail(real, company) or "")
        if t and not looks_blocked(t):
            return t, strip_tracking(real)
    return c.get("description", ""), url


def _verify(candidates: list[dict]) -> tuple[list[dict], list[dict]]:
    """Re-fetch each candidate from its real ATS and re-run hardfilter /
    resolve_term against the fresh text -- catches restrictions the run's
    scrape missed."""
    kept, dropped = [], []
    from jobscan.profile import launch
    ctx = launch(headless=True)
    page = ctx.__enter__()[1]
    try:
        for c in candidates:
            jd, real = _fresh_jd(c, page)
            p = JobPosting(c["source"], "x", real, c["company"], c["role"],
                           c.get("location", ""), "", "", jd, "Internship", "")
            hf, term = hardfilter(p), resolve_term(p)
            if hf or term == "Off-season":
                dropped.append({"company": c["company"], "role": c["role"],
                                "reason": hf or "term:off-season"})
                continue
            c["description"], c["term"], c["url"] = jd, term, real
            if c.get("locations"):
                for loc in c["locations"]:
                    loc["url"] = real
            kept.append(c)
    finally:
        if ctx:
            ctx.__exit__(None, None, None)
    return kept, dropped


def _latest_artifact(out_dir: str) -> str:
    files = sorted(glob.glob(os.path.join(out_dir, "20*.json")))
    if not files:
        sys.exit(f"no run artifact in {out_dir}/")
    return files[-1]


def _key_halves(company: str, role: str) -> tuple[str, str]:
    a, _, b = dedup_key(company, role).partition("|")
    return a, b


def _db_keys(db_path: str):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    apps = [(r["company"], r["role"]) for r in conn.execute("SELECT company, role FROM applications")]
    deleted = {_key_halves(r["company"], r["role"])
               for r in conn.execute(
                   "SELECT company, role FROM seen_jobs WHERE disposition = 'deleted'")}
    conn.close()
    return {_key_halves(c, r) for c, r in apps}, deleted, apps


def _post_bulk(api: str, picks: list[dict]) -> None:
    body = json.dumps({"run_date": datetime.date.today().isoformat(), "picks": picks}).encode()
    req = urllib.request.Request(f"{api}/api/picks/bulk", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        print(f"  POST {r.status}: {r.read().decode()}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="tracker.db")
    ap.add_argument("--out", default="daily_run")
    ap.add_argument("--api", default="http://127.0.0.1:8080")
    ap.add_argument("--verify", action="store_true",
                    help="re-fetch each candidate's real ATS + re-run hardfilter first")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    art_path = _latest_artifact(args.out)
    candidates = json.loads(open(art_path).read())["candidates"]
    applied, deleted, _apps = _db_keys(args.db)

    from collections import Counter
    vdropped: list[dict] = []
    if args.verify:
        candidates, vdropped = _verify(candidates)
        print(f"  verify: -{len(vdropped)} ({dict(Counter(d['reason'] for d in vdropped))})")

    # No per-company application cap (Allen, 2026-09-16: "ignore the 3 per
    # company cap" -- some logged applications are resume-intake/talent-pool
    # submissions, not distinct real roles, so counting them toward a cap
    # was misleading).
    ranked, dropped = rank(candidates, applied, deleted)
    dropped += vdropped
    print(f"{art_path}: -> {len(ranked)} picks")
    print("  dropped:", dict(Counter(d["reason"] for d in dropped)))
    for r in ranked:
        print(f"  {r['rank']:>2} | {r['company'][:26]:26} | {r['role'][:44]:44} | {r.get('term') or '?'}")

    if args.dry_run:
        return 0

    payload = [{
        "job_key": f"{r['source']}:{r['external_id']}", "source": r["source"], "url": r["url"],
        "company": r["company"], "role": r["role"], "location": r.get("location", ""),
        "salary": r.get("salary_hint", ""), "term": r.get("term", ""),
        "app_type": r.get("app_type", "Other"), "heuristic_score": r.get("heuristic_score", 0),
        "rank": r["rank"], "reasoning": r.get("reasoning", ""),
        "description": (r.get("description") or "")[:8000],
        "locations": r.get("locations", []),
    } for r in ranked]
    _post_bulk(args.api, payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
