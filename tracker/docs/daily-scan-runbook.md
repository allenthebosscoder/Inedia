# Daily scan — Claude runbook

When Allen says "scan jobs":

1. **SWElist digest.** Gmail search `from:noreply@swelist.com newer_than:3d`.
   For each digest, compute `swelist-digest:<message-id>`; skip if that key is
   already in `seen_jobs` (query the DB). For a new one, read the HTML body,
   run its links through `jobscan.swelist_links.extract_job_links`, and write
   the combined list to `daily_run/swelist_links.json`.
   If Gmail tools are missing, note it and continue feed-only.

2. **Run the scraper.** `python3 scripts/scan_jobs.py`. If it prints
   "NOT LOGGED IN", tell Allen to log into that site in the open Chrome
   window and rerun. Sources: jobright, jobright, jobnotifier, swelist, and
   `company-wd` (direct per-company Workday scrape — `jobscan/adapters/
   company_workday.py` `TARGETS`; add a hardware/semiconductor company
   there when the aggregators keep missing its reqs, e.g. Marvell/Micron).

3. **Rank + post.** `python3 scripts/rank_picks.py --verify` does it:
   reads the newest `daily_run/*.json`, `--verify` re-fetches each
   candidate's real ATS (direct API, or renders a jobright/jobright page to
   read the Apply link) and re-runs `hardfilter`/`resolve_term`, then
   `jobscan.rank.rank()` drops off-domain / defense-or-clearance role
   titles / military-transition / already-applied / user-deleted /
   company-at-app-cap, orders hardware-before-SWE + Summer-2027-first +
   score (score already folds in recency), and POSTs the ranked survivors
   to `/api/picks/bulk`. `--dry-run` to preview.
   - Sponsorship is **not** filtered by company name — only `hardfilter`
     reading an explicit no-sponsorship clause in the posting text /
     Greenhouse questions drops it. A role whose restriction lives only in
     an unreadable application form reaches `/picks`; Allen verifies those.
   - Only hand-adjust for things the rules genuinely miss.
   - **After posting — and after ANY later change to the page** (a delete,
     a link resolve, a re-scan) — run `python3 scripts/rerank_picks.py`.
     It re-ranks the current `new` rows, renumbers 1..N, drops anything
     now Applied/Deleted, and prunes picks whose `first_run_date` is >2
     days old. Keeps `/picks` a short, contiguous, current list (told
     2026-09-09 — see `job_tracker_picks_freshness` memory).
   - **Direct links:** picks must link to the real ATS posting, not
     simplify.jobs / jobright.ai / jobright.ai. Resolve as a
     post-pass (simplify → `resolve_source_url`; jobright → render +
     `ats_url_in_text`; jobright → "Apply to Job" popup URL).
   - For each SWElist digest processed, insert a `seen_jobs` row
     with `job_key = "swelist-digest:<message-id>"`, `disposition = 'dropped'`,
     `drop_reason = 'email-processed'`.

4. **Report.** One line per source (counts) + the `/picks` URL.
