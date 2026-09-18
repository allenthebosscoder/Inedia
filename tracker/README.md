# Job Application Tracker

Local Flask + SQLite tracker for job applications.

## Setup

    pip3 install -r requirements.txt

## Run

    python3 app.py

Open http://localhost:8080. On first run, `tracker.db` is created locally.
The public repository contains no personal applications or profile data.
To use profile sync, copy `profile_data_private.py.example` to
`profile_data_private.py` and fill in your own values; that file is ignored by Git.
On later runs against an existing `tracker.db`, the schema is migrated in place
automatically.

(Port 8080 is used instead of the more common 5000 because macOS's AirPlay
Receiver occupies 5000 by default on many Macs.)

## Tests

    python3 -m pytest -v

## Daily job scan

`jobscan/` scrapes jobright.ai + runway.io (and SWElist digest links) and
surfaces ~15 ranked picks at http://localhost:8080/picks.

One-time setup:

    pip3 install -r requirements.txt
    python3 -m playwright install chromium   # REQUIRED — the scraper uses bundled Chromium

First-time login:

    python3 scripts/chrome_login.py

This opens a Chromium window on a dedicated profile (`~/.jobtracker/chrome-profile`).
Sign into **jobright.ai** and **app.joinrunway.io**, then close the window. The
session persists across runs. `scripts/scan_jobs.py` runs headless and closes in
seconds — it is NOT where you log in.

Fixtures: `tests/fixtures/{jobright,runway,swelist}/*.html` are committed HTML
captures used by the adapter tests; recapture with `scripts/capture_fixture.py`
if a site's markup drifts.

Each run is triggered from a Claude Code chat ("scan jobs"). Claude:
1. checks Gmail for a new SWElist digest, writes its links to
   `daily_run/swelist_links.json`
2. runs `python3 scripts/scan_jobs.py`
3. reads the newest `daily_run/*.json`, dedupes against the tracker, ranks,
   and POSTs the picks to `/api/picks/bulk`

On the page: **Applied** creates a tracker row; **Delete** removes a pick for
good. Unactioned picks carry over to the next run under "Carried over".

Tuning: edit the keyword/regex lists in `jobscan/criteria.py`, then rerun.

Selector drift: if a run returns 0 candidates from a site, its HTML changed —
recapture fixtures with `scripts/capture_fixture.py` and fix the `SELECTORS`
dict in that adapter, guided by `tests/test_adapter_*.py`.

## AI-assisted work (job-link import, email drafting, etc.)

There's no in-app AI integration or API key required. Instead, do this
work in a Claude Code conversation: paste a job link and ask Claude to add
the row, ask it to check your email for status updates, or hand it a
LinkedIn screenshot to find a contact and draft an outreach email. Claude
reads/writes the tracker directly through the app's existing endpoints
(`POST /api/applications`, `PATCH /api/applications/<id>`, etc.) — no
separate billing, no button to click.

Resumes for email drafting live in a `resumes/` folder (not tracked in
git — personal documents), any filenames — just tell Claude which resume
fits when asked, or let it infer from the filenames.
