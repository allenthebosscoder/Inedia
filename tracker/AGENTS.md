# AGENTS.md — running the job scraper

Instructions for any coding agent (Codex, Claude, etc.) operating this
pipeline. Everything below is relative to this directory
(`Inedia/tracker`) — always run commands from here, never from the old,
retired `~/Documents/JobTracker`.

## One-time setup

1. **Browser login.** `python3 scripts/chrome_login.py` opens a bundled
   Chromium window — log into jobright.ai and joinrunway.io there. The
   session persists in a local profile dir, so this is a one-time step
   (redo it only if a scan later reports "NOT LOGGED IN").
   - The scraper always uses the bundled Chromium. There is no working
     "system Chrome" channel option — don't try to wire one up.
   - Turn off any focus/do-not-disturb mode that suppresses window focus
     (e.g. macOS Focus modes) before running — the automation drives a
     real browser window and needs it to actually receive focus.

2. **Optional personal config.** `search_preferences_private.py` (repo
   root, gitignored) holds personal filter values — earliest grad date,
   temporary company holds. Copy `search_preferences_private.py.example`
   to `search_preferences_private.py` and edit it if you want personalized
   filtering; without it, the pipeline runs fine with generic defaults.

## Every run

1. **Start the Flask dev server** (the rank/rerank scripts POST to it):
   ```
   lsof -ti :8080 2>/dev/null | xargs -r kill -9
   cd /Users/allen/Documents/Inedia/tracker
   nohup python3 -c "from app import create_app; app = create_app(); app.run(host='127.0.0.1', port=8080)" > /tmp/jobtracker_server.log 2>&1 &
   sleep 3
   curl -s -o /dev/null -w "HTTP:%{http_code}\n" localhost:8080/api/applications  # expect 200
   ```

2. **Scan.**
   ```
   python3 scripts/scan_jobs.py --db tracker.db --no-swelist
   ```
   Sources: `jobright`, `jobnotifier`, `company-wd` (direct per-company
   Workday walk — `jobscan/adapters/company_workday.py`), and `runway`
   (paid source, its adapter file is gitignored but still wired in).
   Drop `--no-swelist` only after `daily_run/swelist_links.json` has been
   populated from a SWElist digest email (that step needs Gmail access,
   which an agent without it should just skip via `--no-swelist`).
   `--only <source>` restricts to one source.

3. **Rank the new candidates onto `/picks`:**
   ```
   python3 scripts/rank_picks.py --db tracker.db
   ```

4. **Re-rank — required after ANY change to `/picks`** (a fresh scan
   merge, a manual delete, anything):
   ```
   python3 scripts/rerank_picks.py --db tracker.db
   python3 scripts/rerank_picks.py --db tracker.db --dry-run   # expect "0 removed"
   ```
   This renumbers ranks 1..N, drops anything now Applied/Deleted, and
   prunes picks older than 2 days. The `--dry-run` recheck is the standard
   way to confirm the page is stable before calling a run done.

## Known, non-regressive limitations

- Some ATS sites reliably bot-wall or SPA-shell the scraper (LinkedIn,
   Avature, Tesla, Rivian, AMD, Keysight, JHU APL, example employers, careers.*.com
  for several others). These show up as `blocked` or an unreadably-short
  description in scan output — that's expected, not a bug to chase.
- `channel="chrome"` is a dead code path — don't reintroduce it.

## Tests

Run `python3 -m pytest tests/` before changing anything in `jobscan/` or
`scripts/`. The suite is fast (a few seconds) and should stay fully green.

## Deeper context

`docs/daily-scan-runbook.md` and `docs/daily-scan-followups.md` (both
gitignored, local-only) have more background on the pipeline's design
history and open follow-ups.
