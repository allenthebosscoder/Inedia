"""Entry point for a daily job scan. Claude runs this from chat, then reads
the printed artifact path.

    python3 scripts/scan_jobs.py

Runs headless (never steals focus) against the bundled-Chromium profile at
~/.jobtracker/chrome-profile; pass --show for a visible window when
debugging. First-time login is a separate step:
`python3 scripts/chrome_login.py` (opens a window; sign into jobright.ai and
app.joinrunway.io, close it). If the session has died this prints
"NOT LOGGED IN" and exits 2.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from jobscan.adapters.company_workday import CompanyWorkdayAdapter
from jobscan.adapters.jobnotifier import JobnotifierAdapter
from jobscan.adapters.jobright import JobrightAdapter, LoginRequired as JobrightLogin
from jobscan.adapters.runway import RunwayAdapter, LoginRequired as RunwayLogin
from jobscan.adapters.swelist import SwelistAdapter
from jobscan.profile import launch
from jobscan.run import run


def load_swelist_links(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    data = json.loads(open(path).read())
    return [d for d in data if isinstance(d, dict) and d.get("url")]


def format_summary(artifact: dict) -> str:
    lines = []
    for src, s in artifact["summary"].items():
        lines.append(
            f"  {src:9s} scanned {s['scanned']:3d} · "
            f"dedup -{s.get('deduped', 0)} · "
            f"prefilter -{s['prefiltered']} · hardfilter -{s['hardfiltered']} · "
            f"candidates {s['candidates']} · errors {s.get('errors', 0)} · "
            f"blocked {s.get('blocked', 0)}"
        )
    blocked = sum(1 for e in artifact['errors'] if isinstance(e, dict) and e.get('blocked'))
    lines.append(f"  total candidates: {len(artifact['candidates'])} · "
                 f"dropped: {len(artifact['dropped'])} · "
                 f"errors: {len(artifact['errors']) - blocked} · blocked: {blocked}")
    return "\n".join(lines)


def _progress(msg):
    print(msg, file=sys.stderr, flush=True)


def _select_sources(only, feed_map, links):
    """Decide what to scan given --only. Returns (feeds, swelist_adapter_or_None, links).
    `only=None` (no flag) scans everything. `only="swelist"` scans just the
    digest links, no feeds. `only=<a feed name>` isolates that one feed and
    skips swelist entirely (and the passed-in links with it)."""
    if only == "swelist":
        return [], SwelistAdapter(), links
    if only:
        return [feed_map[only]], None, []
    return list(feed_map.values()), SwelistAdapter(), links


def _parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="tracker.db")
    ap.add_argument("--out", default="daily_run")
    # Headless is the default -- a scan opens dozens of detail pages, and a
    # visible browser steals focus on every single one. --show opts into a
    # visible window only for debugging.
    ap.add_argument("--show", action="store_true",
                    help="show the browser window (default: headless)")
    ap.add_argument("--no-swelist", action="store_true")
    ap.add_argument("--only", choices=["jobright", "runway", "swelist", "jobnotifier", "company-wd"],
                    help="scan just this one source")
    ap.add_argument("--quiet", action="store_true", help="suppress per-job progress")
    return ap


def main(argv=None):
    args = _parser().parse_args(argv)

    links = [] if args.no_swelist else \
        load_swelist_links(os.path.join(args.out, "swelist_links.json"))
    feed_map = {"jobright": JobrightAdapter(), "runway": RunwayAdapter(),
                "jobnotifier": JobnotifierAdapter(), "company-wd": CompanyWorkdayAdapter()}
    feeds, swelist, links = _select_sources(args.only, feed_map, links)
    if links:
        _progress(f"SWElist: {len(links)} link(s) queued")
    progress = None if args.quiet else _progress

    try:
        with launch(headless=not args.show) as (context, page):
            # A second tab for job-detail lookups, so opening a posting never
            # disturbs the tab that's scrolling the feed (see jobscan.run).
            detail_page = context.new_page()
            artifact = run(args.db, feeds, swelist, links, page, args.out,
                           progress=progress, detail_page=detail_page)
    except (JobrightLogin, RunwayLogin) as e:
        print(f"NOT LOGGED IN: {e}. Run `python3 scripts/chrome_login.py`, "
              f"sign into that site, then run again.")
        return 2

    print(format_summary(artifact))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
