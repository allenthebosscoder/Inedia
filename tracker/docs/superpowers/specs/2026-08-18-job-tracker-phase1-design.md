# Job Application Tracker — Phase 1 Design Spec

## Purpose

Replace the Google Sheets tracker with a local, single-user web app for
tracking job applications: a persistent database instead of a spreadsheet,
inline-editable status with color coding, and a fast paste-based import for
adding many rows at once. Phase 1 only — no API keys, no external services.

## Tech stack

- **Backend:** Python + Flask, single-file-friendly (`app.py`)
- **Database:** SQLite (`tracker.db`), file-based
- **Frontend:** Server-rendered HTML + vanilla CSS/JS, no framework, no build step
- **Run:** `python app.py`, served at `localhost:5000`

## Data model

`applications` table:

| Column | Type | Notes |
|---|---|---|
| `id` | integer, primary key | auto-increment |
| `date_applied` | date | |
| `company` | text | |
| `role` | text | |
| `type` | text | `Intern` / `Entry` / `Other` |
| `status` | text | `Applied` / `Interviewing` / `Accepted` / `Rejected` / `Incomplete` |
| `referred` | boolean | |
| `outreach_sent` | boolean | |
| `reply_received` | boolean | |
| `resume_used` | text | optional, free text |
| `notes` | text | separate column from status |
| `created_at` / `updated_at` | timestamp | |

### Status color mapping (UI)

| Status | Color |
|---|---|
| Accepted | green |
| Interviewing | blue |
| Rejected | red |
| Incomplete | yellow |
| Applied | white / neutral |

## Endpoints

- `GET /` — table view (server-rendered shell)
- `GET /api/applications` — JSON list, supports sort (`?sort=date_applied&dir=desc`) and filter (`?status=Applied&company=...`) query params
- `POST /api/applications` — quick-add a single row
- `POST /api/applications/paste` — accepts raw tab-separated text (same column order as the table), splits into rows, bulk-inserts
- `PATCH /api/applications/<id>` — inline edit of any field (status dropdown, yes/no toggles, notes, etc.)
- `DELETE /api/applications/<id>` — remove a row

## UI

- Table of all applications, sortable by clicking column headers, filterable by status/company/date via a small filter bar
- Status column is a real `<select>` dropdown per row; background color changes live based on selected value (client-side JS, no page reload)
- Referred / Outreach Sent / Reply Received are Yes/No toggle pills, editable inline
- Notes is a separate, click-to-edit text cell
- Quick-add form pinned above the table (date, company, role, type, status — minimum fields to create a row)
- "Paste rows" textarea + submit button: pastes tab-separated text (e.g. copied from a spreadsheet), splits on newlines/tabs, bulk-inserts as new rows

## Seeding

- All ~100 rows from the current tracker PDF are imported as-is on first run (auto-seed if `tracker.db` doesn't exist yet, or via a one-time `seed.py` script)
- Imported **including duplicates** (e.g. Zipline, Virtu Financial, Western Digital SWE appear more than once in the source data) — no dedup logic; duplicates are cleaned up later in the UI via the `DELETE` endpoint
- Status normalization on import:
  - `Incomplete - Not Submitted` → `Incomplete`
  - `Action Required` → `Incomplete` (the one Emory University row)
  - All other statuses map 1:1 (`Applied`, `Interviewing`, `Rejected`; `Accepted` doesn't appear yet in source data but is a valid target status)
- `type` typos normalized on import (e.g. `Etry` → `Entry`)
- Notes field carries over free-text context from the source (e.g. "referred by Nishil Madhani", "3 cold outreach emails... do not reuse these patterns")

## Error handling

- Paste-rows import: skip malformed lines (wrong column count) rather than failing the whole batch; report skipped-row count back to the user
- Inline edits: validate `status`/`type` against the fixed enum server-side; reject with a 400 on invalid values
- No auth, no multi-user concerns — single local user, so no need for request-level authorization logic

## Testing

Manual verification only, proportionate to a local single-user v1 tool:
- Launch app, confirm seeded row count and spot-check a few known rows (including the Incomplete-mapped ones)
- Add a row via quick-add
- Paste a few tab-separated rows and confirm they're inserted
- Edit a status inline and confirm the row's color updates
- Sort by a column, filter by status and by company, confirm results

## Out of scope (future phases, not this build)

- Phase 2: Claude-powered LinkedIn screenshot parsing, email drafting, resume auto-selection (needs `ANTHROPIC_API_KEY`)
- Phase 3: Gmail OAuth integration, auto-import from inbox, draft-only email push (needs Google Cloud OAuth)
