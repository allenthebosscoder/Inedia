"""Re-rank whatever `status='new'` rows are currently on /picks: re-run
`jobscan.rank.rank()` over them (dropping anything that now matches an
Applied/Deleted row or a rule), renumber 1..N by the ranking order, and
POST the result back. Also prunes picks older than 2 days (job_tracker_
picks_freshness). Run this after ANY change to the page -- a delete, a
link resolve, a fresh scan merge -- so the rank numbers stay contiguous
and correct (told 2026-09-09: "update rankings after every new update").

    python3 scripts/rerank_picks.py [--api http://localhost:8080] [--dry-run]
"""
from __future__ import annotations

import argparse
import datetime
import json
import sqlite3
import sys
import urllib.request
from collections import Counter

sys.path.insert(0, __file__.rsplit("/", 2)[0])

from jobscan.adapters.base import dedup_key  # noqa: E402
from jobscan.rank import rank  # noqa: E402

PRUNE_DAYS = 2


def _key_halves(company: str, role: str):
    a, _, b = dedup_key(company, role).partition("|")
    return a, b


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8080")
    ap.add_argument("--db", default="tracker.db")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    picks = [p for p in json.loads(urllib.request.urlopen(f"{args.api}/api/picks?all=1").read())
             if p["status"] == "new"]

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    apps = [(r["company"], r["role"]) for r in conn.execute("SELECT company, role FROM applications")]
    applied = {_key_halves(c, r) for c, r in apps}
    deleted = {_key_halves(r["company"], r["role"]) for r in
               conn.execute("SELECT company, role FROM seen_jobs WHERE disposition='deleted'")}
    conn.close()

    cutoff = (datetime.date.today() - datetime.timedelta(days=PRUNE_DAYS)).isoformat()
    stale = [p for p in picks if (p.get("first_run_date") or "9999") < cutoff]
    fresh = [p for p in picks if p not in stale]

    cands = [{
        "source": p["source"], "external_id": p["job_key"].split(":", 1)[-1], "url": p["url"],
        "company": p["company"], "role": p["role"], "location": p.get("location", ""),
        "term": p.get("term", ""), "heuristic_score": p.get("heuristic_score", 0),
        "description": p.get("description", ""), "locations": p.get("locations", []),
        "salary_hint": p.get("salary", ""),
    } for p in fresh]

    # No per-company application cap (Allen, 2026-09-16: "ignore the 3 per
    # company cap" -- some logged applications are resume-intake/talent-pool
    # submissions, not distinct real roles, so counting them toward a cap
    # was misleading).
    ranked, dropped = rank(cands, applied, deleted)
    ranked_keys = {f"{r['source']}:{r['external_id']}" for r in ranked}
    drop_rows = stale + [p for p in fresh if p["job_key"] not in ranked_keys]

    print(f"{len(picks)} on page -> {len(ranked)} kept, {len(drop_rows)} removed "
          f"({len(stale)} aged-out, {dict(Counter(d['reason'] for d in dropped))})")
    for r in ranked:
        print(f"  {r['rank']:>2} | {r['company'][:26]:26} | {r['role'][:44]:44} | {r.get('term') or '?'}")
    for p in drop_rows:
        print(f"  DROP {p['company']} — {p['role']}")

    if args.dry_run:
        return 0

    for p in drop_rows:
        urllib.request.urlopen(urllib.request.Request(
            f"{args.api}/api/picks/{p['id']}", method="DELETE"))

    payload = [{
        "job_key": f"{r['source']}:{r['external_id']}", "source": r["source"], "url": r["url"],
        "company": r["company"], "role": r["role"], "location": r.get("location", ""),
        "salary": r.get("salary_hint", ""), "term": r.get("term", ""), "app_type": "Intern",
        "heuristic_score": r.get("heuristic_score", 0), "rank": r["rank"],
        "reasoning": r.get("reasoning", ""), "description": (r.get("description") or "")[:8000],
        "locations": r.get("locations", []),
    } for r in ranked]
    body = json.dumps({"run_date": datetime.date.today().isoformat(), "picks": payload}).encode()
    resp = urllib.request.urlopen(urllib.request.Request(
        f"{args.api}/api/picks/bulk", data=body,
        headers={"Content-Type": "application/json"}, method="POST"))
    print("POST:", resp.read().decode())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
