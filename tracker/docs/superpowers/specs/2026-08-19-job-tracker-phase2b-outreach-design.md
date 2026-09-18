# Job Application Tracker — Phase 2b: Outreach (Contact Finding + Email Drafting) — Design Spec

## Purpose

Let the user, per row, upload a LinkedIn screenshot of people at that company
(e.g. Duke alumni) and have Claude identify the best person to reach out to
— falling back to a web search for a recruiter if there's no good match or
no screenshot — then draft a personalized outreach email using the resume
that best fits the role's domain and type. The user reviews/confirms the
contact before drafting, and the draft is saved to the row for later reuse.

This is the second of two sub-projects under Phase 2 (AI-assisted features).
The first — job-link import with an outreach-worth-it suggestion — already
shipped (Phase 2a). Gmail-based sending/automation (Phase 3) is out of
scope; drafts are for the user to copy and send manually.

This also folds in the "resume auto-selection" piece from the original
Phase 2 plan, since the user's actual resume set makes that trivial: 4
PDFs across a {hardware, software} × {Entry, Intern} matrix, the second
axis already existing as the row's `type` field.

## Tech stack additions

- No new packages beyond Phase 2a's `anthropic` SDK — vision and PDF
  document input are both supported by the existing Messages API.
- New local resource: a `resumes/` folder (not tracked in git — resumes
  are personal documents) holding exactly 4 fixed-name PDFs:
  - `resumes/hardware_entry.pdf`
  - `resumes/hardware_intern.pdf`
  - `resumes/software_entry.pdf`
  - `resumes/software_intern.pdf`
  The user maintains these directly (swap the file when a resume updates).
  If the resume matching a given row is missing, `draft_email` returns a
  clear error rather than drafting without resume context.

## Data model changes

Two new columns on `applications` (same non-destructive migration pattern
as Phase 2a — `ALTER TABLE ... ADD COLUMN`, guarded, idempotent):

| Column | Type | Notes |
|---|---|---|
| `contact_name` | text | Who the saved draft is addressed to, `''` if none saved yet |
| `drafted_email` | text | The saved draft body, `''` if none saved yet |

No new column for domain (hardware/software) — Claude judges it fresh from
the row's `company`/`role` on every `draft-email` call rather than storing
it, per the design decision made during brainstorming (avoids a schema
change and a field that could go stale relative to the row's actual
company/role if either is edited later).

## What Claude does, and how

### Step 1: Find contact (`claude_client.find_contacts`)

**Inputs:** an optional screenshot (base64 image + media type) and the
row's `company`.

**Task:**
1. If a screenshot is provided, use vision to extract every person visible
   (name, title, any visible affiliation signal e.g. "Duke University" in
   their profile).
2. Judge the best contact to reach out to, in priority order:
   - Alumni of the user's school (hardcoded constant, see below) — this is
     the strongest signal.
   - Otherwise, someone whose title suggests they can plausibly help
     (recruiter, engineer/manager in a relevant team) — not too junior, not
     senior enough to be an unreachable executive.
3. If no screenshot was provided, or none of the extracted people are a
   plausible fit, fall back to the `web_search` tool: search for a
   recruiter or university-recruiting contact at the company, and propose
   that as the contact instead.
4. If nothing plausible turns up even via search, return a generic
   `"Hiring Team"` contact rather than blocking the flow.

**School affiliation:** a hardcoded constant (e.g. `SCHOOL = "Duke
University"` in `claude_client.py`), matching Phase 2a's precedent of no
profile-management UI for a single-user tool.

**Output:** the full list of candidates extracted (if any), the top pick's
name/title/reasoning, and whether the pick came from the screenshot or a
web search (so the UI can label it accordingly). Nothing is saved to the
database at this step.

**Tools declared:** `web_search_20260209` (only — no `web_fetch` needed
here, unlike Phase 2a).

### Step 2: Draft email (`claude_client.draft_email`)

**Inputs:** the confirmed `contact_name` and whatever context string the
user has about them (from step 1's output, possibly edited), plus the
row's `company` and `role`.

**Task:**
1. Judge domain (hardware vs software) from `company`/`role`.
2. Combine with the row's existing `type` field (`Entry` or `Intern`,
   already passed in) to pick one of the 4 resume PDFs.
3. Read that PDF from `resumes/`, attach it as a `document` content block
   (base64, no beta header needed — this is the standard PDF input path).
4. Draft a short, personalized outreach email referencing the resume's
   actual background, the specific role, and the contact by name/title.

**Output:** the drafted email text (plain text, no subject line assumed —
the user pastes it into whatever they're using to send).

**Errors surfaced to the user, not swallowed:**
- `ANTHROPIC_API_KEY` unset → clear message, no request attempted (same
  pattern as Phase 2a).
- The matching resume PDF file is missing on disk → clear error naming
  which file, nothing drafted.
- Any Claude API failure → clear error with the exception's message.
- `type` is `Other` (not `Entry` or `Intern`) → clear error explaining
  that outreach drafting needs a row typed as Entry or Intern (there's no
  resume variant for "Other").

## API

- `POST /api/applications/<id>/find-contact` — body
  `{"image_base64": "...", "media_type": "image/png"}` (both keys
  optional/omittable — omitting them means "search only, no screenshot").
  On success: `200` with
  `{"candidates": [...], "suggested_name": "...", "suggested_context": "...", "source": "screenshot"|"search"}`.
  Does not write to the database.
  On missing key / Claude failure: `400` with `{"error": "..."}`.
- `POST /api/applications/<id>/draft-email` — body
  `{"contact_name": "...", "contact_context": "..."}`. On success: `200`
  with `{"contact_name": "...", "drafted_email": "..."}`, and the row's
  `contact_name`/`drafted_email` columns are updated in the same request
  (this endpoint both drafts and saves — no separate save step, since the
  user already confirmed the contact in step 1's UI before triggering
  this call). `404` if the row doesn't exist. `400` on missing API key,
  missing resume file, invalid `type`, or any Claude API failure, each
  with a distinct clear message.
- `PATCH /api/applications/<id>` (existing) — extended `allowed_fields` to
  include `contact_name` and `drafted_email`, so the user can hand-edit a
  saved draft inline like any other field.

## UI

- New "Draft Outreach" button per row (next to the existing Delete
  button), toggling an inline expandable area below that row (or a
  lightweight overlay — implementation detail for the plan; functionally
  it must not require leaving the table view).
- Inside: a file input for the screenshot (optional) + "Find Contact"
  button. On click, calls `find-contact`, then shows: the suggested
  contact's name/title/reasoning, a note on whether it came from the
  screenshot or a search fallback, and (if more than one candidate was
  extracted) a way to pick a different one instead of the suggested pick.
- Once a contact is confirmed (accepting the suggestion or picking an
  alternate), a "Draft Email" button calls `draft-email` and shows the
  result in an editable textarea, already saved to the row.
- A row with a non-empty `drafted_email` shows a small indicator (e.g. a
  filled vs outline icon, or a "Draft ready" label) in the table so the
  user knows without re-opening the panel.
- Errors (missing key, no resume file, etc.) replace the relevant section
  of the panel with the error message; nothing else in the row is
  affected.

## Testing

- **Automated:** the Anthropic client is mocked — no real API calls.
  Cover: `find_contacts` returning a screenshot-sourced pick, falling back
  to search when no screenshot/no good candidates, and the generic
  "Hiring Team" last-resort; `draft_email`'s domain→resume-file mapping
  logic for all 4 combinations, the missing-resume-file error, and the
  invalid-`type` error; both new routes' error paths (missing key, 404 on
  unknown id, Claude API failure) without a real network call.
- **Manual, once, with a real API key and a real screenshot:** run the
  full flow end-to-end on one real row, confirm a sensible contact pick
  and a sensible draft referencing the actual resume content.

## Out of scope (future work, not this build)

- Gmail sending/automation (Phase 3).
- Any UI for managing/uploading resumes through the app — the user
  manages the 4 PDF files directly on disk.
- Multiple screenshots per contact-finding call, or screenshots covering
  multiple companies at once.
- Persisting or caching web-search results for recruiter lookups across
  rows (each `find-contact` call is independent, same as Phase 2a's
  company-size lookups).
