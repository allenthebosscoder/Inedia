# Daily Job Scan & Ranking Pipeline — Design

**Date:** 2026-09-02
**Status:** Approved for planning

## Problem

Allen finds roles via two aggregators, jobright.ai and runway.io, that each
show 100+ personalized postings per day, plus the daily SWElist digest email
(from `noreply@swelist.com`). Their built-in filters for visa sponsorship
and internship term (Summer vs Fall/Spring) are unreliable, so he currently
opens every posting by hand to check. Goal: a pipeline that pulls all three
sources, drops the clear non-fits automatically, and surfaces a ranked
shortlist (~15, with reasoning) on a page in the tracker app, with a
one-click path from a pick to an `applications` row. Target outcome: 5+
good-quality applications per day without manual triage.

## Constraints & context

- **No server-side AI.** Consistent with the existing project decision
  (`f99c293`), the ranking/judgment step is Claude Code in a chat session
  reading a run artifact — not a hosted model or API key. The Playwright
  script does only mechanical work.
- **Review-before-write.** Nothing reaches the `applications` table without
  Allen's explicit click on the page. The scan and rank steps only populate
  `daily_picks`.
- **Manual trigger.** Allen asks in chat ("scan jobs"); Claude runs the
  script. Not cron.
- **Both aggregator sites require login** and personalize recommendations,
  so the scraper drives a real Google Chrome with a dedicated, persistent
  profile that Allen logs into once.
- **SWElist is an email source, not a feed.** Claude reads the digest via
  the already-connected Gmail MCP (the scan script cannot), extracts the
  job links, and hands them to the script. Each link resolves through
  simplify.jobs to the real posting.
- **Hard filters may auto-drop**, but only on explicit language; ambiguous
  postings are kept and tagged `Unknown` for Claude to judge during ranking.
- Standing filter criteria (from prior guidance): needs visa sponsorship
  (exclude "U.S. Person"/citizenship-only/clearance/ITAR), undergrad-
  eligible (exclude PhD/Master's-required), Summer-term internships or
  new-grad roles starting ~May 2027, ECE/embedded/hardware focus plus
  general SWE. Willing to relocate within the US. Salary is displayed but
  is **not** a filter or ranking input.
- SWElist-specific judgment (see `job_tracker_swelist_filter` memory):
  Summer-term only, don't auto-reject internationals (CPT notices alone
  aren't disqualifying), undergrad-eligible only, verify every posting
  individually, and check whether Allen has already hit a per-company
  application cap before ranking more roles at that company.

## Architecture

```
scripts/scan_jobs.py          entry point Claude runs from chat
jobscan/
  criteria.py                 ALL tunable lists/regexes in one place
  profile.py                  dedicated Chrome profile dir + Playwright launch helper
  seen.py                     seen_jobs cache read/write
  adapters/
    base.py                   JobCard, JobPosting dataclasses; Adapter protocol
    jobright.py               _parse_cards(page), scroll loop, extract_detail(page)
    runway.py                 same shape
    swelist.py                resolve_and_extract(page, url) -> JobPosting
                                (follows simplify.jobs redirect; no walk_feed)
  prefilter.py                pure fn: JobCard | JobPosting -> None | (reason: str)
  hardfilter.py               pure fn: JobPosting -> None | (reason: str)
  score.py                    pure fn: JobPosting -> int (0..100)
  run.py                      orchestration
daily_run/<ISO-timestamp>.json  run artifact (gitignored)

app.py                        + /picks page, /api/picks, /api/picks/bulk,
                                /api/picks/<id>/apply, /api/picks/<id> DELETE
db.py                         + seen_jobs, daily_picks schema + in-place migration
daily_run/swelist_links.json  Claude writes this (email links) for a swelist run
templates/picks.html
static/picks.js, static/picks.css
```

### Data flow

0. **SWElist prep (Claude, before running the script).** Claude searches
   Gmail for `from:noreply@swelist.com` digests. For each, computes
   `email_key = "swelist-digest:<gmail-message-id>"` and checks `seen_jobs`.
   - Already present → skip that email silently.
   - New → open it, extract every job link, and append them to
     `daily_run/swelist_links.json` as `[{url, company_hint, role_hint}]`.
   If no unprocessed digest exists, the file is written empty / omitted.
1. Claude runs `python scripts/scan_jobs.py` (headful Chrome, dedicated
   profile). The script picks up `daily_run/swelist_links.json` if present.
2. **Aggregator adapters (jobright, runway):** `walk_feed(page)` yields
   `JobCard`s newest-first.
   - Skip any `job_key` already in `seen_jobs` (bump `last_seen`).
   - `prefilter(card)` — on reject, insert `seen_jobs(disposition='dropped',
     drop_reason='prefilter:...')` and continue.
   - `extract_detail(page, card)` opens the posting page → `JobPosting`.
   - `hardfilter(posting)` — on reject, insert `seen_jobs('dropped', reason)`.
   - Survivor: compute `score`, add to run file, insert
     `seen_jobs(disposition='candidate')`.
   **SWElist adapter:** for each URL in `swelist_links.json`,
   `resolve_and_extract(page, url)` follows the simplify.jobs redirect to
   the real posting and returns a `JobPosting` (`source='swelist'`,
   `external_id` derived from the *resolved* URL). Then the same
   `prefilter` (run against the posting's title/location, since there is no
   card) → `hardfilter` → `score` → `seen_jobs` path as above. Skip URLs
   whose resolved `job_key` is already in `seen_jobs`.
3. Script writes `daily_run/<ts>.json`:
   `{ summary: {...counts per source...}, candidates: [JobPosting+score...],
   dropped: [{job_key, reason}...], errors: [...] }`. (The script never sees
   Gmail message-ids; Claude tracks the processed digest ids from step 0.)
4. Claude reads the run file:
   - Dedupe `candidates` against `applications` (fuzzy company + role match,
     same judgment used in the resume-dupe check). A match → `seen_jobs`
     `disposition='applied'`, drop from consideration.
   - Dedupe *within* the batch across sources by normalized (company, role)
     — the same role can arrive from more than one source with different
     `job_key`s; keep one, prefer the source with the richer description.
   - Load existing carryover picks: `daily_picks` rows with `status='new'`.
   - For SWElist-sourced candidates, apply the extra
     `job_tracker_swelist_filter` judgment (per-company cap check, strict
     Summer-term, individual verification).
   - Rank the merged set. Write a `reasoning` paragraph for at least the
     top 15.
   - `POST /api/picks/bulk` with the ranked list.
   - For each processed SWElist digest, insert
     `seen_jobs("swelist-digest:<message-id>", disposition='dropped',
     drop_reason='email-processed')` so it is never reprocessed.
5. Claude reports a one-line summary (counts per source) and the `/picks`
   URL.
6. Allen reviews on the page. **Applied** → creates the `applications` row.
   **Delete** → removes the pick, `seen_jobs` remembers it as `deleted`.

### Adapter contract

```python
@dataclass
class JobCard:
    source: str          # 'jobright' | 'runway' | 'swelist'
    external_id: str      # parsed from posting URL (resolved URL for swelist)
    url: str
    company: str
    role: str
    location: str
    salary_hint: str      # '' if absent — display only, not filtered/scored
    posted_at: str        # ISO date if available, else ''

@dataclass
class JobPosting(JobCard):
    description: str          # full JD text
    employment_type_hint: str # e.g. 'Internship', 'Full-time', ''
    requirements_text: str    # requirements/qualifications section if separable, else ''

class FeedAdapter(Protocol):        # jobright, runway
    source: str
    def feed_url(self) -> str: ...
    def walk_feed(self, page) -> Iterator[JobCard]: ...
    def extract_detail(self, page, card: JobCard) -> JobPosting: ...

class LinkAdapter(Protocol):        # swelist
    source: str
    def resolve_and_extract(self, page, url: str) -> JobPosting: ...
```

`job_key = f"{source}:{external_id}"`. For SWElist, `external_id` comes from
the *resolved* posting URL (after the simplify.jobs redirect), so re-seeing
the same role in a later digest is caught by `seen_jobs`.

`walk_feed` stops on the first of: a card with `posted_at` older than 48h;
~15 consecutive already-seen `job_key`s (feed caught up); a 300-card safety
cap. Internally split into `_parse_cards(page)` (pure, fixture-testable) and
a thin scroll/paginate loop (covered only by the live smoke test).

**SWElist link extraction (Claude, step 0)** — the digest is HTML email;
Claude pulls every posting link (SWElist wraps them as simplify.jobs URLs),
along with any company/role text shown next to each, into
`daily_run/swelist_links.json`. Non-posting links (unsubscribe, SWElist
site nav, social) are excluded by URL pattern.

### criteria.py (single source of tunables)

- `INTEREST_KEYWORDS` — embedded, firmware, hardware, ECE, electrical, FPGA,
  ASIC, RTL, digital design, power electronics, PCB, controls, robotics,
  signal, "software engineer", SWE, "new grad", intern, … (seeded from
  `profile_data.py` skills + work history).
- `SENIORITY_EXCLUDE` — senior, staff, principal, lead, "II"/"III", manager,
  director, architect, "Sr." — bypassed when title also contains "new grad"
  or "university".
- `US_LOCATION_OK` — predicate: US state / city, "Remote - US", "United
  States"; rejects explicit non-US.
- `SPONSORSHIP_NEGATIVE` — regexes: "unable to (provide |offer )?sponsor",
  "no(t)? .{0,20}sponsor(ship)?", "without (the need for )?sponsorship",
  "must be (a )?U\\.?S\\.? (citizen|person)", "citizens? only", "ITAR",
  "export control".
- `CLEARANCE_NEGATIVE` — "security clearance", "TS/SCI", "active clearance".
- `DEGREE_NEGATIVE` — "(PhD|Ph\\.D|Master'?s|MS|MEng) .{0,15}(required|degree
  required)", "must be (enrolled in|pursuing) a (PhD|Master)"; "preferred"
  nearby negates.
- `TERM_PATTERNS` — map raw text → season; `FALL_SPRING_ONLY` detection when
  an internship names Fall/Spring/Winter and never Summer, or start month in
  {Jan,Feb,Mar,Apr,Sep,Oct,Nov} with no summer mention.

All regexes case-insensitive. When `criteria.py` changes, only re-run is
needed — no schema change.

### prefilter.py

`prefilter(item: JobCard | JobPosting) -> str | None` returns a
`prefilter:<reason>` string to drop, or `None` to keep. For feed adapters it
runs on the `JobCard` before opening the detail page; for SWElist it runs on
the extracted `JobPosting` (no card exists):
- `prefilter:location` — `not US_LOCATION_OK(item.location)`
- `prefilter:seniority` — title matches `SENIORITY_EXCLUDE` and not the bypass
- `prefilter:role` — title matches no `INTEREST_KEYWORDS`

### hardfilter.py

`hardfilter(posting: JobPosting) -> str | None`:
- `no-sponsorship` — `SPONSORSHIP_NEGATIVE` matches description/requirements
- `clearance` — `CLEARANCE_NEGATIVE` matches
- `degree` — `DEGREE_NEGATIVE` matches without a nearby "preferred"
- `term:<season>` — internship detected as Fall/Spring/Winter-only
- otherwise `None`; `term` resolved to `Summer <year>`, `New Grad`, or
  `Unknown` and carried on the posting.

### score.py

`score(posting) -> 0..100`, weighted heuristic: interest-keyword density in
title/description, term match (Summer/New Grad > Unknown), recency,
ECE/embedded/hardware bonus. Salary is **not** an input. Used only to bound
Claude's review to the top ~25 survivors; Claude sets the final `rank`.

## Database

Both tables live in `tracker.db`, created in `db.SCHEMA` and added to an
in-place migration (extend the existing `_migrate` approach to handle whole
missing tables, not just columns).

```sql
CREATE TABLE IF NOT EXISTS seen_jobs (
    job_key      TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    url          TEXT NOT NULL,
    company      TEXT DEFAULT '',
    role         TEXT DEFAULT '',
    first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen    TEXT NOT NULL DEFAULT (datetime('now')),
    disposition  TEXT NOT NULL,          -- dropped | candidate | applied | deleted
                                         -- (also: swelist-digest:<id> rows use 'dropped'
                                         --  + drop_reason='email-processed')
    drop_reason  TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS daily_picks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    job_key        TEXT NOT NULL UNIQUE,
    source         TEXT NOT NULL,
    url            TEXT NOT NULL,
    company        TEXT NOT NULL,
    role           TEXT NOT NULL,
    location       TEXT DEFAULT '',
    salary         TEXT DEFAULT '',
    term           TEXT DEFAULT '',        -- 'Summer 2027' | 'New Grad' | 'Unknown'
    app_type       TEXT DEFAULT 'Other',   -- Intern | Entry | Other
    heuristic_score INTEGER DEFAULT 0,
    rank           INTEGER,
    reasoning      TEXT DEFAULT '',
    description    TEXT DEFAULT '',
    first_run_date TEXT NOT NULL,          -- YYYY-MM-DD
    last_run_date  TEXT NOT NULL,          -- YYYY-MM-DD
    status         TEXT NOT NULL DEFAULT 'new',  -- new | applied  (delete is a hard row delete)
    application_id INTEGER,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`app_type` → tracker `type` mapping: `Intern`→`Intern`, `Entry`→`Entry`,
anything else→`Other`. Derived from `term` / `employment_type_hint` by the
scanner, overridable by Claude in the bulk payload.

## Endpoints

All JSON, mirroring existing validation style in `app.py`.

### `GET /picks`
Renders `templates/picks.html`.

### `GET /api/picks`
Returns all `daily_picks` rows ordered by `rank ASC NULLS LAST`. Frontend
splits into sections by `status` and `first_run_date`.

### `POST /api/picks/bulk`
Body: `{ "run_date": "YYYY-MM-DD", "picks": [ {job_key, source, url,
company, role, location, salary, term, app_type, heuristic_score, rank,
reasoning, description}, ... ] }`

Per pick, upsert by `job_key`:
- new: insert with `status='new'`, `first_run_date = last_run_date =
  run_date`.
- existing and `status='new'`: update `rank`, `reasoning`, `heuristic_score`,
  `last_run_date = run_date` (carryover re-rank). Leave `first_run_date`.
- existing and `status='applied'`: ignore.

Also upsert `seen_jobs(job_key, disposition='candidate')` if not already a
terminal disposition. Validates `app_type` against `{Intern, Entry, Other}`,
rejects unknown with 400. Returns `{ inserted, updated, ignored }`.

### `POST /api/picks/<id>/apply`
Creates an `applications` row: `date_applied` = today (server date),
`company`, `role` from the pick, `type` = mapped `app_type`,
`status='Applied'`. Sets pick `status='applied'`, `application_id` = new id,
`updated_at`. Sets `seen_jobs.disposition='applied'`. Returns
`{ application_id }`. 404 if pick missing; 409 if pick already `applied`.

### `DELETE /api/picks/<id>`
Hard-deletes the `daily_picks` row. Sets
`seen_jobs.disposition='deleted'`, `drop_reason='user-deleted'` (insert the
row if somehow absent). Returns `{ ok: true }`. 404 if missing.

## The page (`/picks`)

Three stacked sections, each a list of pick cards:

1. **Today's picks** — `status='new'` and `first_run_date == today`. Show
   the top 15 by `rank`; remaining under a "More candidates (N)" toggle.
2. **Carried over** — `status='new'` and `first_run_date < today`. Each
   card shows a "from `<first_run_date>`" label. Same card layout.
3. **Applied today** — `status='applied'` and `date(updated_at) == today`.
   Collapsed; company · role + a check, no buttons.

**Pick card:** rank badge · `company` — `role` · pills for `location`,
`salary`, `term` (Unknown pill styled as a caution) · `reasoning` paragraph
· collapsed "Full description" (`description`) · external link to `url` ·
buttons **Applied** and **Delete**.

- **Applied** → `POST /api/picks/<id>/apply`, on success move card to
  "Applied today".
- **Delete** → confirm, `DELETE /api/picks/<id>`, remove card.

Styling reuses `static/style.css` tokens/classes; `picks.css` only for
layout specifics. `picks.js` follows the vanilla-fetch pattern already in
`static/app.js` (no framework). Script order matters — load `picks.js` after
any shared helpers (prior bug `7ed938f`).

## Error handling

- **Not logged in:** adapter's `walk_feed` detects a login wall (no feed
  cards + a known login selector) and raises `NotLoggedIn(source)`.
  `scan_jobs.py` prints instructions ("log into <site> in the open Chrome
  window, then rerun") and exits non-zero without touching the DB.
- **Selector drift:** if `_parse_cards` yields zero cards on a page that
  isn't a login wall, or `extract_detail` can't find the description
  container, raise `ParseError` with the URL. `run.py` catches per-posting
  parse errors, logs them to the run file's `errors[]`, and continues; a
  whole-feed zero-card result aborts that adapter with a clear message.
- **Partial run:** each posting is committed to `seen_jobs` as it's
  processed, so a crash mid-run doesn't re-scrape everything on retry.
- **Dev server down:** the `POST /api/picks/bulk` step is Claude's; if the
  server is unresponsive, Claude restarts it (documented recovery) before
  retrying. The scan script itself never talks to Flask.
- **Duplicate `job_key` within one run:** dedupe in `run.py` before writing.
- **`apply` when the company/role would collide with an existing
  `applications` row:** allowed (no uniqueness constraint there today);
  Claude's pre-rank dedupe is what prevents it in practice.
- **SWElist link won't resolve** (simplify.jobs 404 / posting removed /
  redirect loop): `resolve_and_extract` raises `ParseError`; logged to
  `errors[]`, that link skipped, run continues.
- **No `swelist_links.json`:** the script just runs the two feed adapters.
- **Gmail connector dropped** (tools missing from the session): Claude
  reports it and runs the feed-only scan; SWElist is picked up on a later
  run once Gmail is back. (See the connector-recovery note in the AI
  workflow memory.)

## Testing

**Pure unit tests (no browser)** — `tests/test_jobscan_filters.py`:
- `prefilter` — location/seniority/role cases, bypass for "new grad".
- `hardfilter` — each negative regex family; ambiguous term stays `Unknown`;
  "Master's preferred" is NOT dropped.
- `score` — ordering sanity (Summer ECE intern > Unknown-term generic SWE).
- `job_key` derivation from representative URLs.

**Playwright + Google Chrome (`channel="chrome"`)** —
`tests/test_adapters.py`:
- Committed fixtures `tests/fixtures/{jobright,runway}/feed.html` and
  `detail_{clean,sponsorship,fall_term,senior,phd}.html`; for SWElist,
  `tests/fixtures/swelist/digest_email.html` and a
  `simplify_redirect.html` + resolved `posting.html`.
- Load each via `page.set_content(...)` in real Chrome; assert
  `_parse_cards` / `extract_detail` / `resolve_and_extract` produce the
  right structured fields and that `hardfilter` drops exactly the
  sponsorship/fall/phd fixtures.
- SWElist link extraction: a pure test that pulls the posting links out of
  `digest_email.html` and ignores unsubscribe/nav/social links.

**Endpoint tests** — extend `tests/test_api.py` style in
`tests/test_picks_api.py`:
- `bulk` insert then re-`bulk` same `job_key` → updates not duplicates;
  `applied` rows ignored.
- `apply` creates an `applications` row with correct field mapping and
  flips pick + `seen_jobs`.
- `DELETE` removes the pick and writes `seen_jobs('deleted')`.
- migration: opening an old DB without the tables adds them.

**Page smoke test** — `tests/test_picks_page.py`, Playwright/Chrome: seed a
test DB with picks in all three states, load `/picks`, assert the three
sections render with the right cards and the buttons POST/DELETE.

**Live smoke test** — `@pytest.mark.live` (registered in `pytest.ini`,
skipped unless `--live`): with a logged-in profile, hit each real feed and
assert ≥1 card parses and one detail page extracts. Run by hand after
suspected selector drift.

## Out of scope

- Scheduling / cron (explicitly manual).
- Resume tailoring — the existing chat workflow picks up after **Applied**.
- Sources beyond jobright.ai, runway.io, and the SWElist digest (the
  Feed/Link adapter split leaves room for more).
- The script reading Gmail itself — link extraction stays with Claude.
- Editing a pick's reasoning/rank from the page (re-run instead).
- Notifications.

## Dependencies

- `playwright` added to `requirements.txt`; `playwright install chrome`
  documented in README (or rely on system Google Chrome via
  `channel="chrome"`).
- New `daily_run/` added to `.gitignore`.
- No change to existing tables or endpoints.
