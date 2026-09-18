# Daily job scan — post-merge follow-ups

The pipeline (`jobscan/`, `/picks`, `scripts/scan_jobs.py`) merged with the
whole-branch review clean. These are the deferred items — none block use;
most are either "tune against real data" or small hardening.

## Fixed from the first real ranking pass (2026-09-05)

- **Title-vs-description term conflict**: several Tesla reqs titled
  `"(Winter/Spring 2027)"` were mislabeled `Summer 2027` because their
  shared description boilerplate mentions "Summer" as one of several terms
  Tesla generally offers. `resolve_term` now checks the role/title text
  FIRST — a title-level signal wins over the description — falling back to
  the full text only when the title says nothing either way.
- **`is_us_location` missed Canada-primary multi-location postings**:
  simplify.jobs appends `"+ N more"` to the first listed location (e.g.
  `"Burnaby, BC, Canada + 2 more"`), which hid the `"canada"` token from the
  segment match. The suffix is now stripped before segmenting.

Both were found manually while ranking the first real batch (109 merged
candidates from the three Task 20 test runs) — worth a periodic manual
spot-check of a real batch, since these patterns don't show up in fixtures.

## Part 2 — location dropdown on the `/picks` card (not built)

`run.py` groups cross-source / multi-location twins into one candidate with
a `locations: [{location, url, source}]` array, `daily_picks.locations`
stores it, `GET /api/picks` returns it — but `picks.js` still renders only
the primary location. The follow-up: on a top-15 card, show the primary
location plus a dropdown of the alternates, and let **Applied** target a
chosen location (its own posting URL). Purely `picks.js` / `picks.css` +
`apply` taking an optional location. Brainstorm separately.

## Task 20 — live end-to-end shakedown

**jobright: DONE and confirmed live (2026-09-04).** `scan_jobs.py --only
jobright` scanned 82 real postings, 38 candidates, 0 errors, filters and
cross-source dedup all behaved correctly. Along the way this fixed a real
architecture bug: `extract_detail` was reusing the same browser tab
`walk_feed` was scrolling, so every scan only ever saw its first rendered
batch — `run.py` now hands detail lookups a separate tab
(`detail_page`/`uses_separate_detail_page`). Also fixed: the feed URL was
`/jobs/recommend` (1 card) instead of `/jobs` (the real list); the list's
virtualization responds to real mouse-wheel events, not `scrollTop`.

**jobright: DONE and confirmed live (2026-09-05).** `--only jobright` scanned
34 real postings, 22 candidates (16 after cross-source/duplicate-listing
dedup), 0 errors. Needed one more live fix: the JD side-panel is a Radix
dialog overlay, not a real navigation — `page.go_back()` didn't actually
dismiss it, so it stayed open and blocked every click on the next row
(30s timeout each). Fixed by pressing Escape and verifying the dialog is
actually gone before moving on, with an off-dialog click and a hard reload
as escalating fallbacks (`_close_detail_dialog` in `jobright.py`).

**swelist: DONE and confirmed live (2026-09-05).** `--only swelist` against
a real 118-link SWElist digest: 118 scanned, 69 candidates (56 after
dedup), 46 hardfiltered, 3 errors (expected — a handful of dead/removed
`simplify.jobs` postings raise `ResolveError`, which is the correct, safe
behavior: logged to `errors[]`, no `seen_jobs` row written, retried next
run rather than silently passed through).

**jobnotifier: DONE and confirmed live (2026-09-05, added as a 4th source).**
`--only jobnotifier` scanned 301 real postings (hit `MAX_CARDS`), 213
candidates, 53 prefiltered, 20 hardfiltered, 15 errors (~5%, expected —
mostly Workday maintenance/interrupted-navigation pages on the external
ATS site a card links to; each logged to `errors[]` and retried next run,
same handling as swelist's dead-link case). Unlike the other three
sources, my-job-notifier.vercel.app has no login (a "guest" name typed
into a modal is just `localStorage`, not a real account) and no detail
view of its own — every card links straight out to the real external ATS
posting (SmartRecruiters, Workday, a company's own careers page, ...), a
different template every time, so `extract_detail` does a generic
full-page text scrape instead of reading a site-specific selector.
Pagination is a plain "Load More Listings" button, not virtualized
scroll — simpler than jobright/jobright.

**All four sources are now shakedown-complete.** Remaining before daily
use is routine: build the `daily_run/swelist_links.json` step into the
Claude-chat runbook (currently done by hand for this test) and do one
full combined run (`scan_jobs.py` with no `--only`) end to end onto the
`/picks` page.
- whether the `SELECTORS` dicts hold on today's markup
- `LoginRequired` handling (the adapters ship with `login_wall=""`, so a
  dead session shows as a 0-card run, not an explicit error — see below)

Run: `python3 scripts/chrome_login.py` (log into jobright.ai +
jobright.ai), then `python3 scripts/scan_jobs.py`, then follow
`docs/daily-scan-runbook.md`. Expect to tune `jobscan/criteria.py` and a
few adapter selectors against the first real run.

## Behavior to tune against real data

- **Term filter is off-season rejection** (`criteria.OFF_SEASON_TERMS` +
  `hardfilter.resolve_term`): an internship is dropped (`term:off-season`)
  only when an explicit Spring/Winter/Fall/co-op-term signal is present and
  no Summer signal is. No signal either way → `"Unknown"`, kept.
  `SUMMER_TERMS` only feeds the score bonus + the pill now. Add real
  off-season phrasings to `OFF_SEASON_TERMS` as they show up.
- **`login_wall=""`** in both feed adapters — fill in a real logged-out
  selector during Task 20 so `scan_jobs.py` prints "NOT LOGGED IN" instead
  of a silent 0-card run.
- **`_NON_US_HINTS`** now matches on comma/slash-delimited segments, so US
  cities literally named "London, KY" / "London, OH" are still dropped
  (the `_NON_US_HINTS` loop runs before the state-abbr check). Reorder the
  checks in `criteria.is_us_location` if this bites.

## Fixed from the 2026-09-05 curation pass

- **`resolve_term` only read season keywords.** Added `_schedule_signal`:
  "start around January 2027", "the Spring term", "continue through April
  2027" now resolve to off-season. Every Tesla intern role in the run is
  Spring 2027 (Jan–May) and was being kept as Unknown. Guarded against
  "graduating Fall of 2027" (a grad-date) and "Spring, Summer or Fall
  term" (an offer list).
- **Blocked/outage pages became junk candidates.** New
  `jobscan/detail_fetch.py`: `looks_blocked()` + `fetch_ats_detail()`
  (Workday `/wday/cxs/` JSON, Greenhouse `boards-api` — plain HTTP, no
  browser). jobnotifier's `parse_detail` tries the API when the rendered
  page looks blocked, else raises `BlockedError` → `run.py` buckets it as
  `blocked: N` in the summary, no seen_jobs row, retried next run. Tesla
  `/careers/` stays blocked (Akamai walls the API too) but is now visible
  as blocked, not a silent Unknown-term pick.

### Sponsorship / clearance verification — slice 1 shipped (2026-09-06)

`detail_fetch` now resolves a `simplify.jobs` link to its real ATS URL
(`simplify.jobs/jobs/click/{uuid}` redirect), pulls Greenhouse
`?questions=true` and Oracle Cloud (multi-field, incl.
`CorporateDescriptionStr`), and appends the application-question labels
under an `--- Application questions ---` header.
`hardfilter._restricted_by_questions` drops on a clearance / citizens-only
/ export-control-US-person question (not on a plain "require sponsorship?"
— asking means they consider you). Wired through swelist + jobnotifier
(ATS API first, page scrape fallback). Verified: Vertiv → no-sponsorship,
General Matter → clearance.

### Still open

- **Ashby, Lever** — not in the router yet (`api.ashbyhq.com/posting-api/…`,
  `api.lever.co/v0/postings/…`). Ashby's public API has no questions.
- **jobright / jobright** — still pure page scrapes, no ATS-URL extraction,
  so their picks' sponsorship is unverified (CDM Smith stays a miss).
  Both link to the real posting via an Apply button whose href could be
  pulled during the scrape.
- **jobnotifier card `postedOn`** — `posted_at` is still the scrape
  timestamp, so `score.py`'s stale-posting penalty never bites for
  jobnotifier picks. Workday/Greenhouse/Oracle all return a real posted
  date in `fetch_ats_detail` now — thread it onto the JobPosting.
- **Per-company deep scrape.** jobnotifier/swelist only surface what the
  aggregators carry; a company with 20 intern reqs on its Workday may show
  2. The `/wday/cxs/` JSON API makes a direct per-company Workday adapter
  very doable.
- **Tesla** — `/careers/` is a hard Akamai wall (HTML + API + headed +
  warmed profile all 403). Only route is simplify.jobs when it carries the
  job, or manual.

## Fixed from the first combined 4-source run (2026-09-05)

- **hardfilter missed four no-sponsorship phrasings** the run surfaced as
  candidates: `"not eligible for candidates requiring VISA sponsorship"`
  (Solidigm ×4), `"Visa Sponsorship through <co> is not available"`
  (PayPal), `"will not offer sponsorship"` (Boston Scientific), and the
  form-field `"Is Sponsorship Available?  No"` (Flex). Patterns added to
  `criteria.SPONSORSHIP_NEGATIVE`; `"sponsorship is available"` / `"...?
  Yes"` still pass.
- **`dedup_key` too strict:** `_norm` now folds `engineering`→`engineer`
  and strips 4-digit years / long ATS req-ids (`200053349`) plus a
  trailing `(…digits…)` group. Before this, jobright's "Firmware
  Engineering INTERN" and jobnotifier's "Firmware Engineer Intern" stayed
  separate, and `applications` rows like "Hardware Engineering Intern
  (200053349)" matched nothing.
- **Pipeline ignored the `applications` table:** roles Allen applied to
  directly on an ATS (never through `/picks`) left no `seen_jobs` row and
  kept re-surfacing. `run()` now drops any card/posting whose `dedup_key`
  matches an `applications` row (`dedup:applied-external`).

## Fixed in the polish pass (2026-09-05)

All of the following were fixed via TDD, one at a time, each committed and
pushed separately:

- `hardfilter`: `_CLEAR` (clearance) and `_SPONSOR`/`_DEGREE` negation
  handling generalized into `_matches_unnegated`, with a leading-negation
  check (`"No security clearance is required"` no longer drops as
  `clearance`) alongside the existing trailing-window check.
- `resolve_term`: the Summer year now prefers the year actually written in
  the posting ("Summer 2026 internship" scanned in Sept 2026 returns
  "Summer 2026", not a guessed "Summer 2027") via `_summer_year`.
- `jobscan/run.py`: `_process` now returns `(outcome, reason)` so callers
  bucket drops correctly (`_bucket_for`); `_fresh_summary` includes
  `errors`; the whole body runs under `try/finally: conn.close()`;
  `deduped` candidates are sorted by `-heuristic_score` before the artifact
  is written.
- `GET /api/picks` defaults to `status='new' OR (status='applied' AND
  updated_at=today)`, with a `?all=1` escape hatch, instead of returning
  every historical row.
- `POST /api/picks/bulk`: required-field validation, `try/finally:
  conn.close()`, and a skip-if-`seen_jobs.disposition='deleted'` check so
  the two tables can't disagree.
- All write endpoints (`bulk`, `apply`, `delete`) reject a cross-origin
  `Origin` header (anything not `http://localhost`/`127.0.0.1`).
- `static/picks.js`: Applied/Delete now check the fetch response's status
  and surface a visible error instead of silently no-oping on a 409/500;
  `link.href` is only set for `http(s)://` URLs.
- `jobscan/seen.py::bump()` is now wired into `run.py`'s `is_seen`
  callback, so a job that's still actively listed on a repeat scan gets
  its `last_seen` refreshed instead of looking stale forever.
- `jobright`/`jobright` adapters: `SELECTORS` annotated `dict[str, str]`.

## Still open

- **`resolve_term` false-positive on "start in February *or* August 2027".**
  IMC Trading's Graduate SWE/HW postings say "Must be available for
  full-time employment starting in February or August 2027" — hardfilter
  drops them `term:off-season` on the February clause, but August 2027 is
  a valid post-graduation start for a May-2027 grad. `_explicit_offseason_start`
  should not fire when an in-season start (summer / Aug / Sep of the grad
  year) is offered as an alternative in the same clause.
- **DONE 2026-09-10 (commit 39a3be2): adapters read the real ATS JD.**
  jobright/jobright/swelist resolve to the actual posting the aggregator
  links to and read *that* (`fetch_ats_detail` JSON API, else
  `fetch_jd_via_browser` renders + scrapes body text); the aggregator's
  own thin summary is only the last resort; `posting.url` is now the real
  URL. jobright uses the "Original Job Post" `<a href>` (carries
  `?for=&token=`), swelist follows `simplify.jobs/jobs/click/{uuid}` in a
  browser (a HEAD request dropped the `?for=&token=` query), jobright clicks
  "Apply to Job" and captures the popup URL. `greenhouse_api_url` reads
  the board slug from `?for=`. `scripts/rank_picks.py --verify`
  (`_fresh_jd`) uses the same path. Live: CACI-Lisle + GD Mission Systems
  SWE-Intern now trip `no-sponsorship` from their real Workday/iCIMS JD.
  **Remaining:** not wired into the scan loop's `seen_jobs` skip — a role
  cached `candidate` from before this commit keeps its thin JD until a
  `reset_seen` or `--verify` pass. iCIMS / Workday bot-wall on some reqs →
  tracked `blocked`, expected.
- `jobright` `_find_row` / `detail_fulljd` `[role="region"]` take the first
  match — could click the wrong row / read the wrong Radix region on a
  live page. Needs more live testing against a page with multiple
  candidate matches before it's safe to fix blind (Task 20).
- **Structured degree signal:** the swelist adapter synthesizes a
  "…a Master's or PhD is required." line so `hardfilter` catches
  simplify.jobs's "Degree: Master's, PhD" chip. A first-class
  `degree_requirement` field on `JobPosting` that `hardfilter` checks
  directly would retire that coupling (touches `base.py` + all 3 adapters
  + `hardfilter` + `run.py`). Bigger refactor, not part of this pass.
