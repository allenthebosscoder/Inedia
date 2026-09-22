"""Delete rows from the seen_jobs cache so dropped/candidate postings can be
re-scanned. Several scan behaviours are terminal ("and it never comes back") —
this is the escape hatch.

    python3 scripts/reset_seen.py --db tracker.db --reason prefilter:location
    python3 scripts/reset_seen.py --db tracker.db --since 2026-09-01 --dry-run
    python3 scripts/reset_seen.py --db tracker.db --all          # everything

Filters (combine freely; all are AND-ed):
    --reason <drop_reason>   only rows with this exact drop_reason
    --since  YYYY-MM-DD      only rows first seen on/after this date
With no filter you must pass --all, otherwise the script refuses.

Matching daily_picks rows (same job_key) are also deleted, but ONLY when their
status is 'new' — 'applied' / actioned picks are never touched.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys


def _build_filters(reason: str | None, since: str | None) -> tuple[str, list]:
    clauses: list[str] = []
    params: list = []
    if reason is not None:
        clauses.append("drop_reason = ?")
        params.append(reason)
    if since is not None:
        clauses.append("date(first_seen) >= date(?)")
        params.append(since)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


def reset_seen(db_path: str, reason: str | None = None, since: str | None = None,
               all_rows: bool = False, dry_run: bool = False) -> dict:
    if reason is None and since is None and not all_rows:
        raise SystemExit("refusing to delete every seen_jobs row without --all")

    where, params = _build_filters(reason, since)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        keys = [r["job_key"] for r in
                conn.execute(f"SELECT job_key FROM seen_jobs{where}", params).fetchall()]
        picks = []
        if keys:
            qs = ",".join("?" * len(keys))
            picks = [r["job_key"] for r in conn.execute(
                f"SELECT job_key FROM daily_picks WHERE status = 'new' AND job_key IN ({qs})",
                keys,
            ).fetchall()]

        if not dry_run:
            conn.execute(f"DELETE FROM seen_jobs{where}", params)
            if picks:
                qs = ",".join("?" * len(picks))
                conn.execute(
                    f"DELETE FROM daily_picks WHERE status = 'new' AND job_key IN ({qs})",
                    picks,
                )
            conn.commit()
    finally:
        conn.close()

    return {"seen_deleted": len(keys), "picks_deleted": len(picks), "dry_run": dry_run}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default="tracker.db")
    ap.add_argument("--reason", default=None, help="exact seen_jobs.drop_reason to match")
    ap.add_argument("--since", default=None, help="only rows first seen on/after YYYY-MM-DD")
    ap.add_argument("--all", action="store_true", help="required to delete with no filter")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    res = reset_seen(args.db, reason=args.reason, since=args.since,
                     all_rows=args.all, dry_run=args.dry_run)
    verb = "would delete" if res["dry_run"] else "deleted"
    print(f"{verb} {res['seen_deleted']} seen_jobs row(s) "
          f"and {res['picks_deleted']} 'new' daily_picks row(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
