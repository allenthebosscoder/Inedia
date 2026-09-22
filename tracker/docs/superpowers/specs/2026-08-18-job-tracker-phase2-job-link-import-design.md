# Job Application Tracker — Phase 2a: Job-Link Import + Outreach Suggestion — Design Spec

## Purpose

Let the user paste a job posting URL and have Claude read it and create a
tracker row (company, role, type), instead of typing it in by hand. At the
same time, Claude judges whether the role is worth pursuing a referral/alumni
outreach for, based on company size, and surfaces that as a new column so the
user doesn't have to make that call manually for every application.

This is the first of two sub-projects under Phase 2 (AI-assisted features).
The second — a per-row "Draft Outreach" button covering LinkedIn screenshot
parsing, contact selection, and email drafting — is a separate future spec.
Gmail-based automatic status updates (Phase 3) are explicitly out of scope
here.

## Tech stack additions

- **`anthropic`** Python SDK (official), added to `requirements.txt`
- Model: `claude-opus-5` (project default per the user's Claude API
  conventions — do not downgrade)
- Requires `ANTHROPIC_API_KEY` in the environment. The rest of the app
  (Phase 1) must keep working with no key set — only the new
  "add from link" feature is gated on it.

## Data model changes

Two new columns on the existing `applications` table:

| Column | Type | Notes |
|---|---|---|
| `reach_out_suggestion` | text | `Yes` / `No` / `Maybe` / `""` (empty for rows not created via link import, or where suggestion wasn't requested) |
| `suggestion_reason` | text | Free-text explanation, e.g. "Large company (~200k employees) — referral likely helps you stand out" |

### Migration

`tracker.db` already exists on the user's machine with 118+ real rows —
this must be a **non-destructive** migration, not a fresh `CREATE TABLE`.
`init_db` runs `ALTER TABLE applications ADD COLUMN reach_out_suggestion TEXT DEFAULT ''`
and the same for `suggestion_reason`, each guarded so re-running `init_db`
against an already-migrated database is a no-op (catch the
"duplicate column name" `sqlite3.OperationalError`, or check
`PRAGMA table_info` first).

### Suggestion badge colors (UI)

| Value | Color |
|---|---|
| Yes | green |
| Maybe | yellow |
| No | red |
| (empty) | white / neutral |

## What Claude judges, and how

**Inputs to the Claude call:** the job posting URL.

**Claude's task**, in one non-streaming `client.messages.create` call:
1. Fetch the posting via the `web_fetch` tool (`web_fetch_20260209`).
2. Extract: `company`, `role`, `type` (`Intern` / `Entry` / `Other`).
3. Judge `reach_out_suggestion` based **only on company size**:
   - Larger company → more worth it (`Yes`) — big applicant volume means a
     referral helps a candidate stand out.
   - Smaller company → less worth it (`No`) — less formal process, a
     personal contact matters less.
   - Ambiguous or can't determine size → `Maybe`.
4. To estimate company size: use built-in knowledge for well-known
   companies; for smaller/unfamiliar ones (most of what's in this user's
   tracker), fall back to the `web_search` tool (`web_search_20260209`) to
   look up approximate employee count.
5. Return `suggestion_reason` as one short sentence naming the
   size estimate and the reasoning.

**Explicitly not considered:** visa sponsorship, citizenship requirements,
security clearance, or any other eligibility gate. Those are "apply or
don't" decisions the user makes before ever submitting a link — folding
them into this suggestion would conflate two different questions.

**Tools declared on the request:** `web_fetch_20260209` and
`web_search_20260209` together (both server-side, no client execution
loop needed — results arrive as content blocks in the same response).

**Output parsing:** ask Claude to respond with a JSON object as its final
text content (`{"company": ..., "role": ..., "type": ..., "reach_out_suggestion": ..., "suggestion_reason": ...}`)
via a system-prompt instruction, not `output_config.format` — keeps the
request simpler alongside the two server tools. Parse with `json.loads()`
inside a `try/except`; on parse failure or a missing/invalid `type` or
`reach_out_suggestion` value, fall back to safe defaults (`type="Entry"`,
`reach_out_suggestion="Maybe"`) rather than failing the whole request, and
surface the raw text if parsing failed entirely so the user can see what
went wrong.

**Errors surfaced to the user, not swallowed:**
- `ANTHROPIC_API_KEY` unset → clear message, no request attempted.
- Claude reports it couldn't fetch/read the URL (paywall, JS-rendered
  content, 404, etc.) → clear error, nothing saved.
- Any Anthropic SDK exception (rate limit, timeout, etc.) → clear error
  with the exception's message, nothing saved.

## API

- `POST /api/applications/from-link` — body `{"url": "..."}`.
  - On success: `200` with the extracted fields as a **preview**, not
    saved to the database: `{"company", "role", "type", "reach_out_suggestion", "suggestion_reason"}`.
  - On missing API key: `400` with `{"error": "ANTHROPIC_API_KEY is not set"}`.
  - On fetch/parse/API failure: `400` with `{"error": "..."}` describing
    what went wrong.
- `POST /api/applications` (existing, Phase 1) — extended to accept the
  two new optional fields (`reach_out_suggestion`, `suggestion_reason`),
  defaulting to `""` if omitted, same as `resume_used`/`notes` today.
  This is how the previewed row actually gets saved — the frontend calls
  this endpoint with the (possibly user-edited) preview data plus
  `date_applied` (defaults to today) and `status` (defaults to `Applied`).
- `PATCH /api/applications/<id>` (existing) — extended `allowed_fields`
  to include the two new columns, so they're editable inline like any
  other field.

## UI

- New box next to the existing quick-add form and paste-rows box: a URL
  input + "Preview from link" button.
- On click: calls `POST /api/applications/from-link`, shows a loading
  state, then renders an **editable preview** below the box — the same
  fields as quick-add (date, company, role, type, status) pre-filled from
  Claude's extraction, plus the suggestion badge and reason as read-only
  text (editable via the table after saving, not in the preview form).
  An "Add" button commits it via `POST /api/applications`; a "Discard"
  button clears the preview without saving.
- On error (missing key, fetch failure, etc.): the error message replaces
  the preview area; no row is created.
- Table: new "Worth Outreach?" column between Status and Referred,
  rendered as a color-coded badge (matching the status-dropdown pattern),
  with `suggestion_reason` shown via the `title` attribute (native
  tooltip on hover) — no new JS interaction pattern needed beyond what
  Phase 1 already has for editable cells.

## Testing

- **Automated:** the Anthropic client is mocked in tests — no real API
  calls in the test suite. Cover: JSON parsing (valid response, malformed
  JSON, missing/invalid `type` or `reach_out_suggestion` values each fall
  back to safe defaults), the migration (running `init_db` twice against
  a database that already has the new columns doesn't raise), and the
  `POST /api/applications/from-link` route's error paths (missing key,
  mocked SDK exception) without needing a real network call.
- **Manual, once, with a real API key:** paste one real job posting URL
  end-to-end, confirm a sensible preview appears, confirm saving it
  produces a correct row with a plausible suggestion badge.

## Out of scope (future work, not this build)

- The per-row "Draft Outreach" button (LinkedIn screenshot parsing →
  contact selection → email drafting) — separate future spec.
- Gmail-based automatic status updates (Phase 3) — needs OAuth
  infrastructure not yet built.
- Any profile-management UI for eligibility/sponsorship filtering — the
  user filters that themselves before submitting a link.
- Company-size lookup accuracy tuning beyond "use knowledge, fall back to
  search" — no caching, no persistence of looked-up sizes.
