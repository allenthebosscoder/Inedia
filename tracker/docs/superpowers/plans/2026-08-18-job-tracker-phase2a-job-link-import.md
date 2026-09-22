# Job Application Tracker — Phase 2a: Job-Link Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user paste a job posting URL and have Claude extract company/role/type and judge whether pursuing a referral is worth it (based on company size only), producing an editable preview row the user confirms before saving.

**Architecture:** A new `claude_client.py` module wraps a single Anthropic API call (model `claude-opus-5`, `web_fetch` + `web_search` server tools) and returns a plain dict or raises one of three typed exceptions. `app.py` gains one new route (`POST /api/applications/from-link`) that calls this module and translates its exceptions into JSON error responses, plus extends the existing create/update routes to accept two new optional fields. `db.py`'s `init_db` migrates the existing `tracker.db` non-destructively. The frontend gets a new "paste a link" box that previews before saving, and a new color-coded badge column in the table.

**Tech Stack:** Adds the `anthropic` Python SDK to the existing Flask + SQLite + vanilla JS stack from Phase 1.

**Spec:** [docs/superpowers/specs/2026-08-18-job-tracker-phase2-job-link-import-design.md](../specs/2026-08-18-job-tracker-phase2-job-link-import-design.md)

## Global Constraints

- Status values are exactly: `Applied`, `Interviewing`, `Accepted`, `Rejected`, `Incomplete` (unchanged from Phase 1).
- Type values are exactly: `Intern`, `Entry`, `Other` (unchanged from Phase 1).
- `reach_out_suggestion` values are exactly: `Yes`, `No`, `Maybe`, or `""` (empty).
- Suggestion badge colors: Yes=green, Maybe=yellow, No=red, empty=white/neutral.
- The `reach_out_suggestion` judgment considers **only company size** — never sponsorship, citizenship, clearance, or any other eligibility factor.
- Model: `claude-opus-5`. Requires `ANTHROPIC_API_KEY` in the environment; the rest of the app must keep working with no key set.
- `tracker.db` already holds 118+ real rows on the target machine — all schema changes must be non-destructive migrations, never a drop/recreate.
- No automated test may make a real network call to the Anthropic API — the client is always mocked/injected in tests.

---

## Task 1: DB migration — add `reach_out_suggestion` and `suggestion_reason` columns

**Files:**
- Modify: `db.py`
- Modify: `tests/test_db.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `db.init_db(db_path)` now also ensures `reach_out_suggestion TEXT DEFAULT ''` and `suggestion_reason TEXT DEFAULT ''` exist on `applications`, whether the table is freshly created or already exists from Phase 1's schema. Safe to call repeatedly.

- [ ] **Step 1: Write the failing tests**

Replace the existing `test_init_db_creates_applications_table` in `tests/test_db.py` (the `expected` set needs the two new columns) and add two new tests:

```python
import sqlite3

from db import init_db, get_db


def test_init_db_creates_applications_table(tmp_path):
    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    conn = get_db(db_path)
    cursor = conn.execute("PRAGMA table_info(applications)")
    columns = {row["name"] for row in cursor.fetchall()}
    conn.close()
    expected = {
        "id", "date_applied", "company", "role", "type", "status",
        "referred", "outreach_sent", "reply_received", "resume_used",
        "notes", "reach_out_suggestion", "suggestion_reason",
        "created_at", "updated_at",
    }
    assert columns == expected


def test_init_db_migrates_existing_database_missing_new_columns(tmp_path):
    db_path = str(tmp_path / "old.db")
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date_applied TEXT NOT NULL,
            company TEXT NOT NULL,
            role TEXT NOT NULL,
            type TEXT NOT NULL,
            status TEXT NOT NULL,
            referred INTEGER NOT NULL DEFAULT 0,
            outreach_sent INTEGER NOT NULL DEFAULT 0,
            reply_received INTEGER NOT NULL DEFAULT 0,
            resume_used TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute(
        "INSERT INTO applications (date_applied, company, role, type, status) VALUES (?, ?, ?, ?, ?)",
        ("2026-08-18", "Acme", "SWE", "Entry", "Applied"),
    )
    conn.commit()
    conn.close()

    init_db(db_path)

    conn = get_db(db_path)
    row = conn.execute("SELECT * FROM applications WHERE company = 'Acme'").fetchone()
    columns = {col["name"] for col in conn.execute("PRAGMA table_info(applications)").fetchall()}
    conn.close()

    assert "reach_out_suggestion" in columns
    assert "suggestion_reason" in columns
    assert row["reach_out_suggestion"] == ""
    assert row["suggestion_reason"] == ""
    assert row["company"] == "Acme"


def test_init_db_migration_is_idempotent(tmp_path):
    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    init_db(db_path)
    conn = get_db(db_path)
    columns = {col["name"] for col in conn.execute("PRAGMA table_info(applications)").fetchall()}
    conn.close()
    assert "reach_out_suggestion" in columns
    assert "suggestion_reason" in columns
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_db.py -v`
Expected: `test_init_db_creates_applications_table` FAILs (columns mismatch — missing the two new columns); the other two FAIL with `sqlite3.OperationalError: no such column` or similar, since the migration doesn't exist yet.

- [ ] **Step 3: Update `db.py`**

Replace the file's contents with:

```python
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date_applied TEXT NOT NULL,
    company TEXT NOT NULL,
    role TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    referred INTEGER NOT NULL DEFAULT 0,
    outreach_sent INTEGER NOT NULL DEFAULT 0,
    reply_received INTEGER NOT NULL DEFAULT 0,
    resume_used TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    reach_out_suggestion TEXT DEFAULT '',
    suggestion_reason TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

MIGRATION_COLUMNS = {
    "reach_out_suggestion": "TEXT DEFAULT ''",
    "suggestion_reason": "TEXT DEFAULT ''",
}


def get_db(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _migrate(conn):
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(applications)").fetchall()}
    for column, definition in MIGRATION_COLUMNS.items():
        if column not in existing:
            conn.execute(f"ALTER TABLE applications ADD COLUMN {column} {definition}")
    conn.commit()


def init_db(db_path):
    conn = get_db(db_path)
    conn.executescript(SCHEMA)
    _migrate(conn)
    conn.close()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_db.py -v`
Expected: PASS (3/3)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `python3 -m pytest -v`
Expected: PASS (all tests, including Phase 1's, which don't reference the new columns and are unaffected)

- [ ] **Step 6: Commit**

```bash
git add db.py tests/test_db.py
git commit -m "feat: migrate applications table with reach_out_suggestion columns"
```

---

## Task 2: `claude_client.py` — job posting extraction

**Files:**
- Modify: `requirements.txt`
- Create: `claude_client.py`
- Test: `tests/test_claude_client.py`

**Interfaces:**
- Produces: `claude_client.extract_job_posting(url: str, client=None) -> dict` returning `{"company", "role", "type", "reach_out_suggestion", "suggestion_reason"}`. Raises `claude_client.MissingAPIKeyError` (no `ANTHROPIC_API_KEY` and no injected client), `claude_client.JobPostingFetchError` (any exception from the Claude API call itself), or `claude_client.JobPostingParseError(raw_text)` (response text isn't valid JSON, or is missing `company`/`role`). Also exports `claude_client.SUGGESTION_VALUES = {"Yes", "No", "Maybe"}` for reuse in `app.py` (Task 3).
- `client` is dependency-injected for testing — when `None`, a real `anthropic.Anthropic()` is constructed (after checking the API key is set).

- [ ] **Step 1: Add `anthropic` to `requirements.txt`**

```
Flask>=3.0
pytest>=8.0
anthropic>=0.40
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_claude_client.py`:

```python
from unittest.mock import MagicMock

import pytest

from claude_client import (
    extract_job_posting,
    MissingAPIKeyError,
    JobPostingFetchError,
    JobPostingParseError,
)


def make_response(text):
    block = MagicMock()
    block.type = "text"
    block.text = text
    response = MagicMock()
    response.content = [block]
    return response


def test_extract_job_posting_success():
    client = MagicMock()
    client.messages.create.return_value = make_response(
        '{"company": "Acme", "role": "SWE", "type": "Entry", '
        '"reach_out_suggestion": "Yes", "suggestion_reason": "Large company"}'
    )

    result = extract_job_posting("https://example.com/job", client=client)

    assert result == {
        "company": "Acme",
        "role": "SWE",
        "type": "Entry",
        "reach_out_suggestion": "Yes",
        "suggestion_reason": "Large company",
    }


def test_extract_job_posting_defaults_invalid_type_and_suggestion():
    client = MagicMock()
    client.messages.create.return_value = make_response(
        '{"company": "Acme", "role": "SWE", "type": "Bogus", '
        '"reach_out_suggestion": "Definitely", "suggestion_reason": "n/a"}'
    )

    result = extract_job_posting("https://example.com/job", client=client)

    assert result["type"] == "Entry"
    assert result["reach_out_suggestion"] == "Maybe"


def test_extract_job_posting_raises_on_invalid_json():
    client = MagicMock()
    client.messages.create.return_value = make_response("not json at all")

    with pytest.raises(JobPostingParseError) as exc_info:
        extract_job_posting("https://example.com/job", client=client)

    assert exc_info.value.raw_text == "not json at all"


def test_extract_job_posting_raises_on_missing_company():
    client = MagicMock()
    client.messages.create.return_value = make_response(
        '{"role": "SWE", "type": "Entry", "reach_out_suggestion": "Yes", "suggestion_reason": ""}'
    )

    with pytest.raises(JobPostingParseError):
        extract_job_posting("https://example.com/job", client=client)


def test_extract_job_posting_wraps_api_errors():
    client = MagicMock()
    client.messages.create.side_effect = RuntimeError("rate limited")

    with pytest.raises(JobPostingFetchError):
        extract_job_posting("https://example.com/job", client=client)


def test_extract_job_posting_raises_missing_api_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    with pytest.raises(MissingAPIKeyError):
        extract_job_posting("https://example.com/job")
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_claude_client.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'claude_client'`

- [ ] **Step 4: Install the new dependency**

Run: `pip3 install -r requirements.txt`

- [ ] **Step 5: Write `claude_client.py`**

```python
import json
import os

import anthropic

MODEL = "claude-opus-5"

TYPE_VALUES = {"Intern", "Entry", "Other"}
SUGGESTION_VALUES = {"Yes", "No", "Maybe"}

SYSTEM_PROMPT = """You are a job-application-tracking assistant. Given a job posting URL, fetch it and extract structured information.

Extract:
- company: the hiring company's name
- role: the job title
- type: exactly one of "Intern", "Entry", or "Other"

Then judge reach_out_suggestion based ONLY on company size:
- Larger companies (more employees, higher application volume) -> "Yes" (a referral helps a candidate stand out from the volume)
- Smaller companies -> "No" (less formal process, a personal contact matters less)
- If you cannot determine company size -> "Maybe"

Do not consider visa sponsorship, citizenship, security clearance, or any other eligibility requirement in this judgment -- only company size.

Use your own knowledge for well-known companies. For smaller or unfamiliar companies, use the web_search tool to estimate employee count.

suggestion_reason should be one short sentence naming your size estimate and reasoning.

Respond with ONLY a JSON object in this exact shape, and no other text:
{"company": "...", "role": "...", "type": "...", "reach_out_suggestion": "...", "suggestion_reason": "..."}
"""


class MissingAPIKeyError(Exception):
    pass


class JobPostingFetchError(Exception):
    pass


class JobPostingParseError(Exception):
    def __init__(self, raw_text):
        self.raw_text = raw_text
        super().__init__(f"Could not parse job posting response: {raw_text!r}")


def extract_job_posting(url, client=None):
    if client is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise MissingAPIKeyError("ANTHROPIC_API_KEY is not set")
        client = anthropic.Anthropic()

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=2048,
            system=SYSTEM_PROMPT,
            tools=[
                {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 1},
                {"type": "web_search_20260209", "name": "web_search", "max_uses": 3},
            ],
            messages=[{"role": "user", "content": f"Job posting URL: {url}"}],
        )
    except Exception as e:
        # Broad on purpose: this is the only external call in this module, and
        # every failure mode (rate limit, timeout, connection, bad request)
        # should surface as the same clear, non-crashing error to the caller.
        raise JobPostingFetchError(f"Claude API error: {e}") from e

    text = "".join(block.text for block in response.content if block.type == "text")

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        raise JobPostingParseError(text)

    company = data.get("company")
    role = data.get("role")
    if not company or not role:
        raise JobPostingParseError(text)

    type_ = data.get("type")
    if type_ not in TYPE_VALUES:
        type_ = "Entry"

    suggestion = data.get("reach_out_suggestion")
    if suggestion not in SUGGESTION_VALUES:
        suggestion = "Maybe"

    return {
        "company": company,
        "role": role,
        "type": type_,
        "reach_out_suggestion": suggestion,
        "suggestion_reason": data.get("suggestion_reason", ""),
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_claude_client.py -v`
Expected: PASS (6/6)

- [ ] **Step 7: Run the full suite to confirm no regressions**

Run: `python3 -m pytest -v`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add requirements.txt claude_client.py tests/test_claude_client.py
git commit -m "feat: add Claude-powered job posting extraction module"
```

---

## Task 3: Backend API — `POST /api/applications/from-link` + extend create/update

**Files:**
- Modify: `app.py`
- Modify: `tests/test_api.py`

**Interfaces:**
- Consumes: `claude_client.extract_job_posting`, `claude_client.MissingAPIKeyError`, `claude_client.JobPostingFetchError`, `claude_client.JobPostingParseError`, `claude_client.SUGGESTION_VALUES` from Task 2.
- Produces: `POST /api/applications/from-link` — `200` with the extracted fields on success; `400` with `{"error": "..."}` on a missing/empty `url`, a missing API key, or a Claude API failure; `400` with `{"error": "Could not parse job posting", "raw_text": "..."}` on a parse failure. `POST /api/applications` and `PATCH /api/applications/<id>` now also accept `reach_out_suggestion` and `suggestion_reason`, validated against `SUGGESTION_VALUES` when non-empty.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api.py`:

```python
from unittest.mock import patch

from claude_client import MissingAPIKeyError, JobPostingFetchError, JobPostingParseError


def test_from_link_success(client):
    with patch("app.extract_job_posting") as mock_extract:
        mock_extract.return_value = {
            "company": "Acme",
            "role": "SWE",
            "type": "Entry",
            "reach_out_suggestion": "Yes",
            "suggestion_reason": "Large company",
        }
        resp = client.post("/api/applications/from-link", json={"url": "https://example.com/job"})
    assert resp.status_code == 200
    assert resp.get_json() == {
        "company": "Acme",
        "role": "SWE",
        "type": "Entry",
        "reach_out_suggestion": "Yes",
        "suggestion_reason": "Large company",
    }


def test_from_link_missing_url(client):
    resp = client.post("/api/applications/from-link", json={})
    assert resp.status_code == 400


def test_from_link_missing_api_key(client):
    with patch("app.extract_job_posting", side_effect=MissingAPIKeyError("no key")):
        resp = client.post("/api/applications/from-link", json={"url": "https://example.com/job"})
    assert resp.status_code == 400
    assert "ANTHROPIC_API_KEY" in resp.get_json()["error"]


def test_from_link_fetch_error(client):
    with patch("app.extract_job_posting", side_effect=JobPostingFetchError("boom")):
        resp = client.post("/api/applications/from-link", json={"url": "https://example.com/job"})
    assert resp.status_code == 400
    assert resp.get_json()["error"] == "boom"


def test_from_link_parse_error(client):
    with patch("app.extract_job_posting", side_effect=JobPostingParseError("garbled text")):
        resp = client.post("/api/applications/from-link", json={"url": "https://example.com/job"})
    assert resp.status_code == 400
    body = resp.get_json()
    assert body["error"] == "Could not parse job posting"
    assert body["raw_text"] == "garbled text"


def test_create_application_with_reach_out_suggestion(client):
    resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
        "reach_out_suggestion": "Yes", "suggestion_reason": "Large company",
    })
    assert resp.status_code == 201
    rows = client.get("/api/applications").get_json()
    assert rows[0]["reach_out_suggestion"] == "Yes"
    assert rows[0]["suggestion_reason"] == "Large company"


def test_create_application_invalid_reach_out_suggestion(client):
    resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
        "reach_out_suggestion": "Definitely",
    })
    assert resp.status_code == 400


def test_update_application_reach_out_suggestion(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]
    patch_resp = client.patch(f"/api/applications/{app_id}", json={"reach_out_suggestion": "No"})
    assert patch_resp.status_code == 200
    rows = client.get("/api/applications").get_json()
    assert rows[0]["reach_out_suggestion"] == "No"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_api.py -v`
Expected: FAIL — `test_from_link_*` fail with 404 (no such route), `test_create_application_with_reach_out_suggestion` fails because the column isn't inserted/returned, `test_create_application_invalid_reach_out_suggestion` fails because nothing validates it (returns 201 instead of 400), `test_update_application_reach_out_suggestion` fails because the field isn't in `allowed_fields`

- [ ] **Step 3: Update the import line in `app.py`**

Replace:

```python
from db import init_db, get_db
from seed import run_seed
```

with:

```python
from db import init_db, get_db
from seed import run_seed
from claude_client import (
    extract_job_posting,
    MissingAPIKeyError,
    JobPostingFetchError,
    JobPostingParseError,
    SUGGESTION_VALUES,
)
```

- [ ] **Step 4: Replace `create_application` in `app.py`**

```python
    @app.route("/api/applications", methods=["POST"])
    def create_application():
        data = request.get_json(force=True) or {}
        required = ["date_applied", "company", "role", "type", "status"]
        missing = [f for f in required if not data.get(f)]
        if missing:
            return jsonify({"error": f"missing fields: {', '.join(missing)}"}), 400
        if data["type"] not in TYPE_VALUES:
            return jsonify({"error": f"invalid type: {data['type']}"}), 400
        if data["status"] not in STATUS_VALUES:
            return jsonify({"error": f"invalid status: {data['status']}"}), 400
        suggestion = data.get("reach_out_suggestion", "")
        if suggestion and suggestion not in SUGGESTION_VALUES:
            return jsonify({"error": f"invalid reach_out_suggestion: {suggestion}"}), 400

        conn = get_db(app.config["DATABASE"])
        cursor = conn.execute(
            """
            INSERT INTO applications
                (date_applied, company, role, type, status, referred, outreach_sent, reply_received, resume_used, notes, reach_out_suggestion, suggestion_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["date_applied"],
                data["company"],
                data["role"],
                data["type"],
                data["status"],
                bool(data.get("referred", False)),
                bool(data.get("outreach_sent", False)),
                bool(data.get("reply_received", False)),
                data.get("resume_used", ""),
                data.get("notes", ""),
                suggestion,
                data.get("suggestion_reason", ""),
            ),
        )
        conn.commit()
        new_id = cursor.lastrowid
        conn.close()
        return jsonify({"id": new_id}), 201
```

- [ ] **Step 5: Replace `update_application` in `app.py`**

```python
    @app.route("/api/applications/<int:app_id>", methods=["PATCH"])
    def update_application(app_id):
        data = request.get_json(force=True) or {}
        conn = get_db(app.config["DATABASE"])
        existing = conn.execute(
            "SELECT id FROM applications WHERE id = ?", (app_id,)
        ).fetchone()
        if existing is None:
            conn.close()
            return jsonify({"error": "not found"}), 404

        if "type" in data and data["type"] not in TYPE_VALUES:
            conn.close()
            return jsonify({"error": f"invalid type: {data['type']}"}), 400
        if "status" in data and data["status"] not in STATUS_VALUES:
            conn.close()
            return jsonify({"error": f"invalid status: {data['status']}"}), 400
        if data.get("reach_out_suggestion") and data["reach_out_suggestion"] not in SUGGESTION_VALUES:
            conn.close()
            return jsonify({"error": f"invalid reach_out_suggestion: {data['reach_out_suggestion']}"}), 400

        allowed_fields = {
            "date_applied", "company", "role", "type", "status",
            "referred", "outreach_sent", "reply_received", "resume_used", "notes",
            "reach_out_suggestion", "suggestion_reason",
        }
        updates = {k: v for k, v in data.items() if k in allowed_fields}
        if not updates:
            conn.close()
            return jsonify({"error": "no valid fields to update"}), 400

        set_clause = ", ".join(f"{field} = ?" for field in updates)
        values = list(updates.values()) + [app_id]
        conn.execute(
            f"UPDATE applications SET {set_clause}, updated_at = datetime('now') WHERE id = ?",
            values,
        )
        conn.commit()
        conn.close()
        return jsonify({"ok": True})
```

- [ ] **Step 6: Add the new route to `app.py`**

Insert after `paste_applications` and before `return app`:

```python
    @app.route("/api/applications/from-link", methods=["POST"])
    def applications_from_link():
        data = request.get_json(force=True) or {}
        url = data.get("url", "").strip()
        if not url:
            return jsonify({"error": "url is required"}), 400

        try:
            extracted = extract_job_posting(url)
        except MissingAPIKeyError:
            return jsonify({"error": "ANTHROPIC_API_KEY is not set"}), 400
        except JobPostingFetchError as e:
            return jsonify({"error": str(e)}), 400
        except JobPostingParseError as e:
            return jsonify({"error": "Could not parse job posting", "raw_text": e.raw_text}), 400

        return jsonify(extracted), 200
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_api.py -v`
Expected: PASS (all)

- [ ] **Step 8: Run the full suite to confirm no regressions**

Run: `python3 -m pytest -v`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add app.py tests/test_api.py
git commit -m "feat: add job-link import endpoint, extend create/update for reach_out_suggestion"
```

---

## Task 4: Frontend — "Add from link" box, preview flow, suggestion badge column

**Files:**
- Modify: `templates/index.html`
- Modify: `static/style.css`
- Modify: `static/app.js`

**Interfaces:**
- Consumes: `POST /api/applications/from-link`, extended `POST /api/applications` from Task 3.
- Produces: a working "Add from link" box with preview/confirm, and a "Worth Outreach?" badge column in the table.

- [ ] **Step 1: Add the "Add from link" box to `templates/index.html`**

Insert a new `<details>` block right after the existing "Paste rows" `<details>` block and before the `<div class="filters">`:

```html
    <details>
        <summary>Add from job link</summary>
        <input type="text" id="link-url" placeholder="https://example.com/job-posting" size="60">
        <button id="link-preview-submit" type="button">Preview from link</button>
        <div id="link-preview-area"></div>
    </details>
```

- [ ] **Step 2: Add the new table header column**

In the `<thead>` row, insert a new `<th>` right after the Status column:

```html
                <th data-sort="status">Status</th>
                <th data-sort="reach_out_suggestion">Worth Outreach?</th>
                <th data-sort="referred">Referred</th>
```

(This replaces the existing `<th data-sort="status">Status</th>` line and the line immediately after it.)

- [ ] **Step 3: Add badge styles to `static/style.css`**

Append:

```css
.suggestion-badge {
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    font-weight: bold;
}

.suggestion-Yes { background-color: #d4edda; }
.suggestion-Maybe { background-color: #fff3cd; }
.suggestion-No { background-color: #f8d7da; }
.suggestion-none { background-color: #ffffff; }
```

- [ ] **Step 4: Render the suggestion cell in `static/app.js`**

In `renderRows`, insert a new cell right after the status cell:

```javascript
        tr.appendChild(makeStatusCell(row));
        tr.appendChild(makeSuggestionCell(row));
        tr.appendChild(makeToggleCell(row, "referred"));
```

(This replaces the existing `tr.appendChild(makeStatusCell(row));` line and the line immediately after it.)

Add the new function near `makeStatusCell`:

```javascript
function makeSuggestionCell(row) {
    const td = document.createElement("td");
    const value = row.reach_out_suggestion || "";
    const span = document.createElement("span");
    span.className = `suggestion-badge suggestion-${value || "none"}`;
    span.textContent = value || "—";
    if (row.suggestion_reason) {
        span.title = row.suggestion_reason;
    }
    td.appendChild(span);
    return td;
}
```

- [ ] **Step 5: Add the link-preview flow to `static/app.js`**

Append at the end of the file (after the existing `fetchApplications();` call, or right before it — either position works since these are just function/listener definitions; keep the final `fetchApplications();` call as the last line of the file):

```javascript
document.getElementById("link-preview-submit").addEventListener("click", async () => {
    const url = document.getElementById("link-url").value.trim();
    const area = document.getElementById("link-preview-area");
    if (!url) return;
    area.textContent = "Loading...";
    const resp = await fetch("/api/applications/from-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
    });
    const body = await resp.json();
    if (!resp.ok) {
        area.textContent = body.error || "Failed to preview job posting";
        if (body.raw_text) {
            area.textContent += ` (${body.raw_text})`;
        }
        return;
    }
    renderLinkPreview(body);
});

function renderLinkPreview(data) {
    const area = document.getElementById("link-preview-area");
    area.innerHTML = "";

    const companyInput = document.createElement("input");
    companyInput.value = data.company;

    const roleInput = document.createElement("input");
    roleInput.value = data.role;

    const typeSelect = document.createElement("select");
    for (const t of ["Entry", "Intern", "Other"]) {
        const option = document.createElement("option");
        option.value = t;
        option.textContent = t;
        if (t === data.type) option.selected = true;
        typeSelect.appendChild(option);
    }

    const suggestionText = document.createElement("span");
    suggestionText.textContent = `Worth outreach: ${data.reach_out_suggestion} — ${data.suggestion_reason}`;

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.textContent = "Add";
    addButton.addEventListener("click", async () => {
        const resp = await fetch("/api/applications", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                date_applied: new Date().toISOString().slice(0, 10),
                company: companyInput.value,
                role: roleInput.value,
                type: typeSelect.value,
                status: "Applied",
                reach_out_suggestion: data.reach_out_suggestion,
                suggestion_reason: data.suggestion_reason,
            }),
        });
        if (resp.ok) {
            document.getElementById("link-url").value = "";
            area.innerHTML = "";
            fetchApplications();
        } else {
            const body = await resp.json();
            alert(body.error || "Failed to add application");
        }
    });

    const discardButton = document.createElement("button");
    discardButton.type = "button";
    discardButton.textContent = "Discard";
    discardButton.addEventListener("click", () => {
        area.innerHTML = "";
    });

    area.appendChild(companyInput);
    area.appendChild(roleInput);
    area.appendChild(typeSelect);
    area.appendChild(suggestionText);
    area.appendChild(addButton);
    area.appendChild(discardButton);
}
```

- [ ] **Step 6: Verify what's checkable without a browser**

Run: `python3 -m pytest -v` — confirm no regressions (this task touches no Python files, so this should already pass; run it anyway as a sanity check).

Start the app (`ANTHROPIC_API_KEY` unset is fine for this check) and confirm the new elements are present:

```bash
rm -f tracker.db
python3 app.py &
sleep 1.5
curl -s http://127.0.0.1:8080/ | grep -o 'link-url\|link-preview-submit\|link-preview-area\|Worth Outreach' | sort -u
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/static/style.css
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/static/app.js
kill %1
rm -f tracker.db
```

Expected: all four grep matches present, both static assets return `200`. Full visual/interactive verification (preview rendering, badge colors, a real link submission) happens in Task 5 with a real API key.

- [ ] **Step 7: Commit**

```bash
git add templates/index.html static/style.css static/app.js
git commit -m "feat: add job-link import UI and outreach-suggestion badge column"
```

---

## Task 5: README update + end-to-end verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the full feature from Tasks 1-4.
- Produces: updated setup docs and a final manual sign-off that the migration and the live Claude integration both work.

- [ ] **Step 1: Update `README.md`**

Replace the file's contents with:

```markdown
# Job Application Tracker

Local Flask + SQLite tracker for job applications, with optional
Claude-powered job-link import.

## Setup

    pip3 install -r requirements.txt

For the "Add from job link" feature, set an API key:

    export ANTHROPIC_API_KEY=sk-ant-...

The rest of the app works fine without it — only that one feature is
gated on the key being set.

## Run

    python3 app.py

Open http://localhost:8080. On first run, `tracker.db` is created and
auto-seeded with the existing tracked applications. On later runs against
an existing `tracker.db`, the schema is migrated in place automatically.

(Port 8080 is used instead of the more common 5000 because macOS's AirPlay
Receiver occupies 5000 by default on many Macs.)

## Tests

    python3 -m pytest -v
```

- [ ] **Step 2: Run the full automated test suite**

Run: `python3 -m pytest -v`
Expected: PASS, all tests across `tests/test_db.py`, `tests/test_api.py`, `tests/test_claude_client.py`

- [ ] **Step 3: Verify the migration against a copy of the real database**

```bash
cp tracker.db tracker.db.verify-backup 2>/dev/null || echo "no existing tracker.db to back up, that's fine"
```

If `tracker.db` exists, run:

```bash
python3 -c "
from db import init_db, get_db
init_db('tracker.db')
conn = get_db('tracker.db')
count = conn.execute('SELECT COUNT(*) AS c FROM applications').fetchone()['c']
cols = {r['name'] for r in conn.execute(\"PRAGMA table_info(applications)\").fetchall()}
print('row count:', count)
print('has reach_out_suggestion:', 'reach_out_suggestion' in cols)
print('has suggestion_reason:', 'suggestion_reason' in cols)
conn.close()
"
```

Expected: row count matches the pre-migration count (118, unless the user has added more since Phase 1), both new columns present. Remove the backup once confirmed: `rm -f tracker.db.verify-backup`.

- [ ] **Step 4: Live end-to-end check (requires a real `ANTHROPIC_API_KEY`)**

If a real key is available in the environment:

```bash
rm -f tracker.db
python3 app.py &
sleep 1.5
curl -s -X POST http://127.0.0.1:8080/api/applications/from-link \
  -H "Content-Type: application/json" \
  -d '{"url": "<a real, currently-live job posting URL>"}' | python3 -m json.tool
kill %1
```

Expected: a JSON object with plausible `company`, `role`, `type`, `reach_out_suggestion` (one of Yes/No/Maybe), and `suggestion_reason` naming a company-size estimate. If no real key is available in this environment, note that in the report and defer this check to the user's own machine — do not skip silently, say explicitly that this step wasn't run and why.

In the browser at `http://localhost:8080/`, confirm:
- The "Add from job link" box appears, pasting a URL and clicking "Preview from link" shows an editable preview with the suggestion text
- Clicking "Add" saves the row and it appears in the table with a colored "Worth Outreach?" badge
- Hovering the badge shows the reasoning as a tooltip

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: update README for job-link import and ANTHROPIC_API_KEY setup"
```
