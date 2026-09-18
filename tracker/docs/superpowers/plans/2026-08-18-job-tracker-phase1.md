# Job Application Tracker (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Flask + SQLite job application tracker with a sortable/filterable table, inline-editable color-coded status, quick-add form, and paste-rows bulk import, seeded with the user's existing ~118 tracked applications.

**Architecture:** A single Flask app (`app.py`, application-factory style) backed by a SQLite database (`tracker.db`) via a thin `db.py` connection/schema layer. A pure-data `seed_data.py` module holds the transcribed historical rows; `seed.py` inserts them idempotently. The frontend is one server-rendered page (`templates/index.html`) with vanilla JS (`static/app.js`) driving a JSON API for all reads/writes — no page reloads for edits, sorting, or filtering.

**Tech Stack:** Python 3, Flask, SQLite (via `sqlite3` stdlib), pytest, vanilla HTML/CSS/JS.

**Spec:** [docs/superpowers/specs/2026-08-18-job-tracker-phase1-design.md](../specs/2026-08-18-job-tracker-phase1-design.md)

## Global Constraints

- Status values are exactly: `Applied`, `Interviewing`, `Accepted`, `Rejected`, `Incomplete` — no others.
- Type values are exactly: `Intern`, `Entry`, `Other`.
- Status colors: Accepted=green, Interviewing=blue, Rejected=red, Incomplete=yellow, Applied=white/neutral.
- `notes` is always a separate column from `status`.
- No authentication/authorization — single local user.
- No API keys, no external services (Phase 1 only).
- Runs via `python app.py`, served at `localhost:5000`.

---

## Task 1: Project setup + DB schema & connection layer

**Files:**
- Create: `requirements.txt`
- Create: `pytest.ini`
- Create: `db.py`
- Test: `tests/test_db.py`

**Interfaces:**
- Produces: `db.get_db(db_path: str) -> sqlite3.Connection` (row_factory set to `sqlite3.Row`), `db.init_db(db_path: str) -> None` (creates the `applications` table if it doesn't exist).

- [ ] **Step 1: Create `requirements.txt`**

```
Flask>=3.0
pytest>=8.0
```

- [ ] **Step 2: Create `pytest.ini` so tests can import root-level modules**

```ini
[pytest]
pythonpath = .
```

- [ ] **Step 3: Write the failing test**

Create `tests/test_db.py`:

```python
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
        "notes", "created_at", "updated_at",
    }
    assert columns == expected
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pytest tests/test_db.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'db'`

- [ ] **Step 5: Write `db.py`**

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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def get_db(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(db_path):
    conn = get_db(db_path)
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pytest tests/test_db.py -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add requirements.txt pytest.ini db.py tests/test_db.py
git commit -m "feat: add SQLite schema and connection layer"
```

---

## Task 2: Flask app skeleton + GET /api/applications (list)

**Files:**
- Create: `app.py`
- Test: `tests/test_api.py`

**Interfaces:**
- Consumes: `db.get_db(db_path)`, `db.init_db(db_path)` from Task 1.
- Produces: `app.create_app(db_path="tracker.db") -> Flask` factory. Module-level `STATUS_VALUES` and `TYPE_VALUES` sets (used by later tasks). Route `GET /api/applications` returning a JSON list of row dicts.

- [ ] **Step 1: Write the failing test**

Create `tests/test_api.py`:

```python
import pytest
from app import create_app


@pytest.fixture
def client(tmp_path):
    db_path = str(tmp_path / "test.db")
    app = create_app(db_path=db_path)
    app.config["TESTING"] = True
    with app.test_client() as client:
        yield client


def test_list_applications_empty(client):
    resp = client.get("/api/applications")
    assert resp.status_code == 200
    assert resp.get_json() == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_api.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app'`

- [ ] **Step 3: Write `app.py`**

```python
from flask import Flask, jsonify, render_template

from db import init_db, get_db

STATUS_VALUES = {"Applied", "Interviewing", "Accepted", "Rejected", "Incomplete"}
TYPE_VALUES = {"Intern", "Entry", "Other"}


def create_app(db_path="tracker.db"):
    app = Flask(__name__)
    app.config["DATABASE"] = db_path
    init_db(db_path)

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/api/applications", methods=["GET"])
    def list_applications():
        conn = get_db(app.config["DATABASE"])
        rows = conn.execute("SELECT * FROM applications").fetchall()
        conn.close()
        return jsonify([dict(row) for row in rows])

    return app


if __name__ == "__main__":
    flask_app = create_app()
    flask_app.run(debug=True, port=5000)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_api.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_api.py
git commit -m "feat: add Flask app skeleton with list endpoint"
```

---

## Task 3: POST /api/applications (quick-add, with enum validation)

**Files:**
- Modify: `app.py` (add `create_application` route inside `create_app`, before `return app`)
- Modify: `tests/test_api.py`

**Interfaces:**
- Consumes: `STATUS_VALUES`, `TYPE_VALUES` from Task 2.
- Produces: `POST /api/applications` — `201` with `{"id": <int>}` on success, `400` with `{"error": "..."}` on invalid/missing fields.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api.py`:

```python
def test_create_application_success(client):
    resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18",
        "company": "Acme",
        "role": "SWE",
        "type": "Entry",
        "status": "Applied",
    })
    assert resp.status_code == 201
    body = resp.get_json()
    assert "id" in body

    rows = client.get("/api/applications").get_json()
    assert len(rows) == 1
    assert rows[0]["company"] == "Acme"


def test_create_application_invalid_status(client):
    resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18",
        "company": "Acme",
        "role": "SWE",
        "type": "Entry",
        "status": "Bogus",
    })
    assert resp.status_code == 400


def test_create_application_missing_fields(client):
    resp = client.post("/api/applications", json={"company": "Acme"})
    assert resp.status_code == 400
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_api.py -v`
Expected: FAIL with `405 != 201` (the `/api/applications` URL rule already exists from Task 2's GET route, so an unsupported POST method returns 405 Method Not Allowed, not 404)

- [ ] **Step 3: Add the route to `app.py`**

Insert into `create_app`, after `list_applications` and before `return app`:

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

        conn = get_db(app.config["DATABASE"])
        cursor = conn.execute(
            """
            INSERT INTO applications
                (date_applied, company, role, type, status, referred, outreach_sent, reply_received, resume_used, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            ),
        )
        conn.commit()
        new_id = cursor.lastrowid
        conn.close()
        return jsonify({"id": new_id}), 201
```

Also update the top import line to include `request`:

```python
from flask import Flask, jsonify, render_template, request
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_api.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_api.py
git commit -m "feat: add quick-add endpoint with enum validation"
```

---

## Task 4: PATCH /api/applications/<id> (inline edit)

**Files:**
- Modify: `app.py` (add `update_application` route)
- Modify: `tests/test_api.py`

**Interfaces:**
- Consumes: `STATUS_VALUES`, `TYPE_VALUES` from Task 2.
- Produces: `PATCH /api/applications/<id>` — `200` with `{"ok": true}` on success, `404` if id doesn't exist, `400` on invalid enum value or no valid fields given.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api.py`:

```python
def test_update_application_status(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]

    patch_resp = client.patch(f"/api/applications/{app_id}", json={"status": "Interviewing"})
    assert patch_resp.status_code == 200

    rows = client.get("/api/applications").get_json()
    assert rows[0]["status"] == "Interviewing"


def test_update_application_invalid_status(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]
    resp = client.patch(f"/api/applications/{app_id}", json={"status": "Bogus"})
    assert resp.status_code == 400


def test_update_application_not_found(client):
    resp = client.patch("/api/applications/999", json={"status": "Applied"})
    assert resp.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_api.py -v`
Expected: FAIL with `404 != 200` on the first test (no such route yet, and `404` is coincidentally the missing-route error for that assertion but the third test also gets a plain "not found" 404 HTML page rather than the JSON error we assert)

- [ ] **Step 3: Add the route to `app.py`**

Insert into `create_app`, after `create_application` and before `return app`:

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

        allowed_fields = {
            "date_applied", "company", "role", "type", "status",
            "referred", "outreach_sent", "reply_received", "resume_used", "notes",
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_api.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_api.py
git commit -m "feat: add inline-edit PATCH endpoint"
```

---

## Task 5: DELETE /api/applications/<id>

**Files:**
- Modify: `app.py` (add `delete_application` route)
- Modify: `tests/test_api.py`

**Interfaces:**
- Produces: `DELETE /api/applications/<id>` — `200` with `{"ok": true}` on success, `404` if id doesn't exist.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api.py`:

```python
def test_delete_application(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]

    del_resp = client.delete(f"/api/applications/{app_id}")
    assert del_resp.status_code == 200

    rows = client.get("/api/applications").get_json()
    assert rows == []


def test_delete_application_not_found(client):
    resp = client.delete("/api/applications/999")
    assert resp.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_api.py -v`
Expected: FAIL (no DELETE route yet)

- [ ] **Step 3: Add the route to `app.py`**

Insert into `create_app`, after `update_application` and before `return app`:

```python
    @app.route("/api/applications/<int:app_id>", methods=["DELETE"])
    def delete_application(app_id):
        conn = get_db(app.config["DATABASE"])
        existing = conn.execute(
            "SELECT id FROM applications WHERE id = ?", (app_id,)
        ).fetchone()
        if existing is None:
            conn.close()
            return jsonify({"error": "not found"}), 404
        conn.execute("DELETE FROM applications WHERE id = ?", (app_id,))
        conn.commit()
        conn.close()
        return jsonify({"ok": True})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_api.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_api.py
git commit -m "feat: add delete endpoint"
```

---

## Task 6: Sorting and filtering on GET /api/applications

**Files:**
- Modify: `app.py` (replace the `list_applications` function body from Task 2)
- Modify: `tests/test_api.py`

**Interfaces:**
- Produces: `GET /api/applications` now accepts `?sort=<field>&dir=asc|desc`, `?status=<value>`, `?company=<substring>` query params.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api.py`:

```python
def test_list_applications_filter_by_status(client):
    client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Beta", "role": "SWE",
        "type": "Entry", "status": "Rejected",
    })
    resp = client.get("/api/applications?status=Rejected")
    rows = resp.get_json()
    assert len(rows) == 1
    assert rows[0]["company"] == "Beta"


def test_list_applications_filter_by_company(client):
    client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme Corp", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Beta Inc", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    resp = client.get("/api/applications?company=acme")
    rows = resp.get_json()
    assert len(rows) == 1
    assert rows[0]["company"] == "Acme Corp"


def test_list_applications_sort_by_date_asc(client):
    client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Later", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    client.post("/api/applications", json={
        "date_applied": "2026-08-01", "company": "Earlier", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    resp = client.get("/api/applications?sort=date_applied&dir=asc")
    rows = resp.get_json()
    assert [r["company"] for r in rows] == ["Earlier", "Later"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_api.py -v`
Expected: FAIL (filters/sort currently ignored, both rows returned unsorted/unfiltered)

- [ ] **Step 3: Replace `list_applications` in `app.py`**

Replace the existing function body with:

```python
    @app.route("/api/applications", methods=["GET"])
    def list_applications():
        conn = get_db(app.config["DATABASE"])

        sortable_fields = {
            "date_applied", "company", "role", "type", "status",
            "referred", "outreach_sent", "reply_received", "created_at",
        }
        sort = request.args.get("sort", "date_applied")
        if sort not in sortable_fields:
            sort = "date_applied"
        direction = "ASC" if request.args.get("dir", "desc").lower() == "asc" else "DESC"

        query = "SELECT * FROM applications WHERE 1=1"
        params = []

        status = request.args.get("status")
        if status:
            query += " AND status = ?"
            params.append(status)

        company = request.args.get("company")
        if company:
            query += " AND company LIKE ?"
            params.append(f"%{company}%")

        query += f" ORDER BY {sort} {direction}"
        rows = conn.execute(query, params).fetchall()
        conn.close()
        return jsonify([dict(row) for row in rows])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_api.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_api.py
git commit -m "feat: add sorting and filtering to list endpoint"
```

---

## Task 7: POST /api/applications/paste (bulk tab-separated import)

**Files:**
- Modify: `app.py` (add `paste_applications` route)
- Modify: `tests/test_api.py`

**Interfaces:**
- Produces: `POST /api/applications/paste` — body `{"text": "<tab-separated rows, one per line>"}`, response `200` with `{"inserted": <int>, "skipped": <int>}`. Column order per line: `date_applied, company, role, type, status, referred, outreach_sent, reply_received, notes`. Lines with fewer than 5 tab-separated fields, or an invalid `type`/`status`, are skipped rather than failing the whole batch.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api.py`:

```python
def test_paste_applications_inserts_valid_rows(client):
    text = "2026-08-18\tAcme\tSWE\tEntry\tApplied\tNo\tNo\tNo\tsome note"
    resp = client.post("/api/applications/paste", json={"text": text})
    assert resp.status_code == 200
    assert resp.get_json() == {"inserted": 1, "skipped": 0}

    rows = client.get("/api/applications").get_json()
    assert len(rows) == 1
    assert rows[0]["notes"] == "some note"


def test_paste_applications_skips_malformed_rows(client):
    text = "\n".join([
        "2026-08-18\tAcme\tSWE\tEntry\tApplied\tNo\tNo\tNo\tok row",
        "not enough columns",
        "2026-08-18\tBeta\tSWE\tBogusType\tApplied\tNo\tNo\tNo\tbad type",
    ])
    resp = client.post("/api/applications/paste", json={"text": text})
    assert resp.get_json() == {"inserted": 1, "skipped": 2}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_api.py -v`
Expected: FAIL (no such route yet)

- [ ] **Step 3: Add the route to `app.py`**

Insert into `create_app`, after `delete_application` and before `return app`:

```python
    @app.route("/api/applications/paste", methods=["POST"])
    def paste_applications():
        data = request.get_json(force=True) or {}
        text = data.get("text", "")
        lines = [line for line in text.split("\n") if line.strip()]

        inserted = 0
        skipped = 0
        conn = get_db(app.config["DATABASE"])
        for line in lines:
            fields = line.split("\t")
            if len(fields) < 5:
                skipped += 1
                continue
            padded = fields + [""] * (9 - len(fields))
            (date_applied, company, role, type_, status,
             referred, outreach_sent, reply_received, notes) = padded[:9]

            if type_ not in TYPE_VALUES or status not in STATUS_VALUES:
                skipped += 1
                continue

            conn.execute(
                """
                INSERT INTO applications
                    (date_applied, company, role, type, status, referred, outreach_sent, reply_received, resume_used, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?)
                """,
                (
                    date_applied, company, role, type_, status,
                    referred.strip().lower() == "yes",
                    outreach_sent.strip().lower() == "yes",
                    reply_received.strip().lower() == "yes",
                    notes,
                ),
            )
            inserted += 1
        conn.commit()
        conn.close()
        return jsonify({"inserted": inserted, "skipped": skipped})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_api.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_api.py
git commit -m "feat: add paste-rows bulk import endpoint"
```

---

## Task 8: Seed data + seed script + auto-seed wiring

**Files:**
- Create: `seed_data.py`
- Create: `seed.py`
- Test: `tests/test_seed.py`
- Modify: `app.py` (add `seed` parameter to `create_app`)

**Interfaces:**
- Consumes: `db.get_db` from Task 1; `STATUS_VALUES`, `TYPE_VALUES` from Task 2.
- Produces: `seed_data.SEED_ROWS: list[tuple]` (118 tuples of `(date_applied, company, role, type, status, referred, outreach_sent, reply_received, notes)`). `seed.run_seed(db_path: str) -> int` — inserts all `SEED_ROWS` if the table is empty, returns number inserted (0 if already seeded). `app.create_app(db_path="tracker.db", seed=False)` — when `seed=True`, calls `run_seed(db_path)` after `init_db`.

- [ ] **Step 1: Create `seed_data.py`**

```python
SEED_ROWS = [
    ("2026-08-18", "Simplex (staffing agency)", "Junior Software Engineer", "Entry", "Applied", False, False, False, ""),
    ("2026-08-18", "WSP", "EE (ESSP) Intern Summer 2027", "Intern", "Applied", False, False, False, ""),
    ("2026-08-17", "HDR", "Electrical Engineering Intern", "Intern", "Applied", False, False, False, ""),
    ("2026-08-17", "Providence Engineering", "Summer Intern - Electrical", "Intern", "Applied", False, False, False, ""),
    ("2026-08-17", "SAP", "iXp Intern - Full-Stack SWE", "Intern", "Applied", False, False, False, ""),
    ("2026-08-17", "Micron", "Intern - DRAM Design Engineer", "Intern", "Applied", False, False, False, ""),
    ("2026-08-17", "PSI Molded Plastics Indiana", "Part-time role", "Other", "Applied", False, False, False, ""),
    ("2026-08-17", "Drive Medical", "Associate Embedded Systems Engineer", "Entry", "Applied", False, False, False, ""),
    ("2026-08-16", "GF", "Process Integration - Duke alumni contact (James Alatis)", "Entry", "Applied", False, True, False, "guessed email james.alatis@gf.com invalid; found in trash"),
    ("2026-08-15", "Infineon", "Internship - Embedded Systems Engineer", "Intern", "Applied", False, False, False, ""),
    ("2026-08-15", "Infineon", "Internship - Analog Design", "Intern", "Applied", False, False, False, ""),
    ("2026-08-14", "Amazon", "Controls Integration Engineer - One MHS Systems Integration and Flow", "Entry", "Incomplete", False, False, False, "Amazon flagged application as incomplete; found in trash"),
    ("2026-08-13", "WSP", "EE Substation Intern Summer 2027", "Intern", "Applied", False, False, False, ""),
    ("2026-08-13", "Bot Auto", "(unspecified)", "Entry", "Applied", False, False, False, "initial application"),
    ("2026-08-13", "Esri", "(unspecified)", "Entry", "Applied", False, False, False, ""),
    ("2026-08-13", "Renesas", "Application Engineer (20031299)", "Entry", "Applied", False, True, False, "3 cold outreach emails to guessed Renesas addresses all bounced (carolina.nolivos@, markd@, mark.dennis@renesas.com) - do not reuse these patterns"),
    ("2026-08-13", "Panasonic Avionics", "SWE I - Embedded Systems", "Entry", "Applied", False, False, False, ""),
    ("2026-08-13", "Interstates Engineering", "Intern", "Intern", "Applied", False, False, False, "initial application"),
    ("2026-08-13", "Western Digital", "Summer 2027 Intern - SWE", "Intern", "Applied", False, False, False, ""),
    ("2026-08-13", "Silicon Labs", "Design Engineer I - Modem Design", "Entry", "Applied", False, False, False, ""),
    ("2026-08-13", "RS Medical", "Engineering Intern I", "Intern", "Applied", False, False, False, ""),
    ("2026-08-12", "Foundation", "(unspecified)", "Entry", "Applied", False, False, False, ""),
    ("2026-08-12", "Renesas", "Graduate Digital Design EE (20031892)", "Entry", "Applied", False, False, False, ""),
    ("2026-08-12", "Schweitzer Engineering Laboratories", "(general application)", "Entry", "Applied", False, False, False, ""),
    ("2026-08-12", "Western Digital", "SWE (Apps)", "Entry", "Applied", False, False, False, "duplicate thread of same role"),
    ("2026-08-12", "Florida Municipal Power Agency", "(resume submission)", "Entry", "Applied", False, False, False, ""),
    ("2026-08-12", "Meso Scale Diagnostics", "Engineer I - Systems", "Entry", "Applied", False, False, False, ""),
    ("2026-08-12", "The Nuclear Company", "Platform & AI Pre-Engineer", "Entry", "Applied", False, False, False, "initial application, rejected 8/17"),
    ("2026-08-12", "Albireo Energy", "Junior Engineer", "Entry", "Applied", False, False, False, ""),
    ("2026-08-11", "Veregy", "(unspecified)", "Entry", "Applied", False, False, False, ""),
    ("2026-08-11", "Aehr Test Systems", "Associate Software Engineer", "Entry", "Applied", False, False, False, ""),
    ("2026-08-10", "KPM Analytics", "Embedded Software Engineer", "Entry", "Applied", False, False, False, ""),
    ("2026-08-10", "Seagate", "Firmware Engineer - Early Career (14813)", "Entry", "Applied", False, False, False, ""),
    ("2026-08-10", "Seagate", "Firmware Engineer - Early Career (14815)", "Entry", "Applied", False, False, False, "duplicate posting"),
    ("2026-08-10", "Keysight", "R&D SWE Internship (53652)", "Intern", "Applied", False, False, False, ""),
    ("2026-08-10", "Digital Dynamics Inc", "Intern - Electrical Engineering", "Intern", "Applied", False, False, False, ""),
    ("2026-08-10", "Cummins", "Electronic Systems Product Engineer", "Entry", "Applied", False, False, False, ""),
    ("2026-08-10", "Cummins", "Electronic Systems Engineer - Software", "Entry", "Applied", False, False, False, ""),
    ("2026-08-09", "Vanderbilt University", "TERM Research Assistant - Institute for Software Integrated Systems", "Entry", "Incomplete", False, False, False, "draft saved, not submitted; found in trash"),
    ("2026-08-07", "Silicon Labs", "Digital Design Engineer I", "Entry", "Applied", False, False, False, ""),
    ("2026-08-07", "UL Solutions", "Entry Level Engineer - Raleigh NC", "Entry", "Applied", False, False, False, ""),
    ("2026-08-07", "Texas Instruments", "Career Accelerator Program - Test Engineer", "Entry", "Applied", False, False, False, ""),
    ("2026-08-07", "Oracle", "Hardware Design Engineer", "Entry", "Applied", False, False, False, ""),
    ("2026-08-06", "Emory University", "SWE - College of Arts & Sciences", "Entry", "Incomplete", False, False, False, "needs additional info submitted via portal link, not yet rejected/accepted"),
    ("2026-08-06", "MKS Instruments", "Associate Electronic Engineer", "Entry", "Applied", False, False, False, "initial application before rejection"),
    ("2026-08-06", "Astrodyne TDI", "(unspecified)", "Entry", "Applied", False, False, False, ""),
    ("2026-08-06", "ByteDance", "Applied ML Production Engineer Intern", "Intern", "Applied", False, False, False, ""),
    ("2026-08-06", "Starkey", "Electrical Engineer I", "Entry", "Applied", False, False, False, "initial application before rejection"),
    ("2026-08-06", "Mytra", "(unspecified)", "Entry", "Applied", False, False, False, ""),
    ("2026-08-05", "Microsoft", "SWE - Cloud & Distributed Backend Intern", "Intern", "Applied", True, True, True, "referred by Nishil Madhani"),
    ("2026-08-05", "Microsoft", "SWE - Security & Identity Intern", "Intern", "Applied", True, True, True, "referred by Nishil Madhani"),
    ("2026-08-05", "ESG Global", "Firmware Engineer Intern", "Intern", "Applied", False, False, False, "initial application before rejection"),
    ("2026-08-05", "Torc Robotics", "(unspecified)", "Entry", "Applied", False, False, False, ""),
    ("2026-08-05", "Keysight", "R&D SWE Internship (53636)", "Intern", "Applied", False, False, False, "initial application"),
    ("2026-08-04", "SimpliSafe", "SWE I - User Systems", "Entry", "Applied", False, False, False, "initial application"),
    ("2026-08-04", "Chicago Trading Company", "SWE Internship Summer 2027", "Intern", "Applied", False, False, False, ""),
    ("2026-08-04", "Atwell LLC", "(unspecified)", "Entry", "Applied", False, False, False, ""),
    ("2026-08-04", "Texas Instruments", "Analog Design Development Program", "Entry", "Applied", False, False, False, ""),
    ("2026-08-04", "Axon", "RenderATL - SWE Internship", "Intern", "Applied", False, False, False, ""),
    ("2026-08-04", "Microsoft", "SWE - Cloud & Distributed Backend Intern", "Intern", "Applied", False, False, False, "initial application"),
    ("2026-08-04", "Microsoft", "SWE - CoreAI", "Intern", "Applied", False, False, False, ""),
    ("2026-08-04", "Microsoft", "SWE - Security & Identity Intern", "Intern", "Applied", False, False, False, "initial application"),
    ("2026-08-04", "Microsoft", "SWE - Fullstack Product Intern", "Intern", "Applied", False, False, False, ""),
    ("2026-08-04", "Microsoft", "SWE - AI/ML & LLM Intern", "Intern", "Applied", False, False, False, ""),
    ("2026-08-04", "Studyfetch", "(unspecified)", "Entry", "Applied", False, False, False, ""),
    ("2026-08-04", "Zipline", "Failure Analysis Engineer", "Entry", "Applied", False, False, False, "initial application"),
    ("2026-08-04", "Amperesand", "Power Electronics Integration & Validation Engineer", "Entry", "Applied", False, False, False, ""),
    ("2026-08-04", "Arrow International", "(unspecified)", "Entry", "Applied", False, False, False, ""),
    ("2026-08-03", "Rockwell Automation", "Intern - Applied AI", "Intern", "Applied", False, False, False, "initial application"),
    ("2026-08-03", "SiFive", "Platform Technologies Language Design Intern", "Intern", "Applied", False, False, False, ""),
    ("2026-08-03", "Skydio", "Electrical Engineer Intern", "Intern", "Applied", False, False, False, ""),
    ("2026-08-03", "Stolle Machinery", "Engineering Intern", "Intern", "Applied", False, False, False, ""),
    ("2026-08-03", "L3Harris", "Associate - Electrical Engineering", "Entry", "Applied", False, False, False, ""),
    ("2026-08-01", "Shield AI", "Electrical Engineer - Test Equipment Design", "Entry", "Applied", False, False, False, ""),
    ("2026-08-01", "Qualdoc", "Electrical Design Engineer I", "Entry", "Applied", False, False, False, ""),
    ("2026-08-01", "Burr Oak Tool", "Engineer 1-3 - Controls/SWE", "Entry", "Applied", False, False, False, ""),
    ("2026-08-01", "SiFive", "Intern - Design Verification Infrastructure Engineer", "Intern", "Applied", False, False, False, ""),
    ("2026-07-31", "Microchip", "(unspecified)", "Entry", "Applied", False, False, False, ""),
    ("2026-07-31", "Skydio", "Product Management Intern", "Intern", "Applied", False, False, False, ""),
    ("2026-07-31", "Virtu Financial", "(unspecified)", "Entry", "Applied", False, False, False, ""),
    ("2026-07-31", "Western Digital", "Summer 2027 Intern - Hardware Engineering", "Intern", "Applied", False, False, False, ""),
    ("2026-07-31", "L3Harris", "Associate - Software Engineering", "Entry", "Applied", False, False, False, ""),
    ("2026-07-31", "(unspecified via Paylocity)", "Electrical Engineer", "Entry", "Applied", False, False, False, ""),
    ("2026-07-30", "Texas Sports Academy", "Junior Software Engineer", "Entry", "Interviewing", False, False, False, "you disclosed need for future sponsorship in reply"),
    ("2026-07-30", "Flock", "Associate Wireless Software Engineer", "Entry", "Applied", False, False, False, ""),
    ("2026-07-30", "Virtu Financial", "(unspecified)", "Entry", "Applied", False, False, False, "duplicate"),
    ("2026-07-30", "Sensor Systems Inc", "Test Engineer", "Entry", "Applied", False, False, False, ""),
    ("2026-07-30", "Green Tanner Industrial", "Junior Software Engineer", "Entry", "Applied", False, False, False, ""),
    ("2026-07-30", "Copart", "(unspecified)", "Entry", "Applied", False, False, False, ""),
    ("2026-07-30", "Axon", "Embedded Software Engineer I", "Entry", "Applied", False, False, False, ""),
    ("2026-07-29", "Texas Sports Academy", "Junior Software Engineer (AI-Forward)", "Entry", "Applied", False, False, False, "found in trash; possibly same role that reached interview stage 7/30"),
    ("2026-07-28", "Renesas", "Product Engineer (20028810)", "Entry", "Applied", False, False, False, "found in trash"),
    ("2026-07-28", "L3Harris", "Associate - Software Engineer (38926)", "Entry", "Applied", False, False, False, "found in trash"),
    ("2026-07-28", "Zipline", "(unspecified)", "Entry", "Applied", False, False, False, "duplicate"),
    ("2026-07-28", "Textron", "SWE I - Sea Systems - Hunt Valley MD", "Entry", "Applied", False, False, False, "initial application"),
    ("2026-07-27", "Blissway", "Embedded Systems Engineer, Recent Graduate", "Entry", "Interviewing", False, False, False, "next-steps email 8/6, interview reminder 8/14 - active interview process"),
    ("2026-08-17", "Bot Auto", "(unspecified)", "Entry", "Rejected", False, False, False, ""),
    ("2026-08-17", "Renesas", "Graduate Digital Design EE", "Entry", "Rejected", False, False, False, ""),
    ("2026-08-17", "The Nuclear Company", "Platform & AI Pre-Engineer", "Entry", "Rejected", False, False, False, ""),
    ("2026-08-16", "Toyota Industries (TMHNA)", "Research Engineer", "Entry", "Rejected", False, False, False, ""),
    ("2026-08-14", "Keysight", "R&D SWE Internship (53636)", "Intern", "Rejected", False, False, False, '"narrowed our search to" wording'),
    ("2026-08-14", "Interstates Engineering", "Intern", "Intern", "Rejected", False, False, False, "possible citizenship-only requirement - check wording"),
    ("2026-08-14", "Schweitzer Engineering Laboratories", "Test Engineering Intern", "Intern", "Rejected", False, False, False, ""),
    ("2026-08-13", "Zipline", "Failure Analysis Engineer", "Entry", "Rejected", False, False, False, '"Update on your application"'),
    ("2026-08-12", "Lam Research", "Hardware Designer 1", "Entry", "Rejected", False, False, False, "rejection found in trash, dated 8/14"),
    ("2026-08-12", "Dragos", "Junior OT/ICS Lab Engineer", "Entry", "Rejected", False, False, False, "rejection found in trash, dated 8/14"),
    ("2026-08-12", "Rockwell Automation", "Intern - Applied AI", "Intern", "Rejected", False, False, False, ""),
    ("2026-08-12", "Western Digital", "SWE (Apps)", "Entry", "Rejected", False, False, False, ""),
    ("2026-08-11", "MKS Instruments", "Associate Electronic Engineer", "Entry", "Rejected", False, False, False, ""),
    ("2026-08-10", "Starkey", "Electrical Engineer I", "Entry", "Rejected", False, False, False, ""),
    ("2026-08-10", "ESG Global", "Firmware Engineer Intern", "Intern", "Rejected", False, False, False, ""),
    ("2026-08-07", "Unknown company (SuccessFactors portal)", "Electrical Engineer - Entry Level (27651)", "Entry", "Rejected", False, False, False, "found in trash; company name not visible in email content"),
    ("2026-08-05", "SimpliSafe", "SWE I - User Systems", "Entry", "Rejected", False, False, False, ""),
    ("2026-08-04", "Tavern", "Research Engineer I - Digital Engagement", "Entry", "Rejected", False, False, False, ""),
    ("2026-07-30", "Textron", "SWE I - Sea Systems - Hunt Valley MD", "Entry", "Rejected", False, False, False, ""),
    ("2026-07-30", "SimpliSafe", "SWE I - Device Control", "Entry", "Rejected", False, False, False, ""),
    ("2026-07-29", "ADT", "Senior Product Engineer", "Entry", "Rejected", False, False, False, "found in trash; applied 7/29, rejected 7/31"),
    ("2026-07-29", "Keysight", "Software Engineering Intern (53648)", "Intern", "Rejected", False, False, False, "found in trash; applied 7/29, rejected 7/30"),
]
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_seed.py`:

```python
from db import init_db, get_db
from seed import run_seed
from seed_data import SEED_ROWS


def test_run_seed_inserts_all_rows(tmp_path):
    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    inserted = run_seed(db_path)
    assert inserted == len(SEED_ROWS)

    conn = get_db(db_path)
    count = conn.execute("SELECT COUNT(*) AS c FROM applications").fetchone()["c"]
    conn.close()
    assert count == len(SEED_ROWS)


def test_run_seed_is_idempotent(tmp_path):
    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    run_seed(db_path)
    second_run = run_seed(db_path)
    assert second_run == 0

    conn = get_db(db_path)
    count = conn.execute("SELECT COUNT(*) AS c FROM applications").fetchone()["c"]
    conn.close()
    assert count == len(SEED_ROWS)


def test_run_seed_maps_incomplete_statuses(tmp_path):
    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    run_seed(db_path)

    conn = get_db(db_path)
    emory = conn.execute(
        "SELECT status FROM applications WHERE company = ?", ("Emory University",)
    ).fetchone()
    amazon = conn.execute(
        "SELECT status FROM applications WHERE company = ?", ("Amazon",)
    ).fetchone()
    conn.close()
    assert emory["status"] == "Incomplete"
    assert amazon["status"] == "Incomplete"


def test_run_seed_no_invalid_statuses_or_types(tmp_path):
    from app import STATUS_VALUES, TYPE_VALUES

    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    run_seed(db_path)

    conn = get_db(db_path)
    rows = conn.execute("SELECT status, type FROM applications").fetchall()
    conn.close()
    for row in rows:
        assert row["status"] in STATUS_VALUES
        assert row["type"] in TYPE_VALUES


def test_create_app_seed_true_populates_db(tmp_path):
    from app import create_app

    db_path = str(tmp_path / "test.db")
    app = create_app(db_path=db_path, seed=True)
    with app.test_client() as client:
        rows = client.get("/api/applications").get_json()
    assert len(rows) == len(SEED_ROWS)


def test_create_app_seed_false_stays_empty(tmp_path):
    from app import create_app

    db_path = str(tmp_path / "test.db")
    app = create_app(db_path=db_path, seed=False)
    with app.test_client() as client:
        rows = client.get("/api/applications").get_json()
    assert rows == []
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pytest tests/test_seed.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'seed'`

- [ ] **Step 4: Write `seed.py`**

```python
from db import get_db
from seed_data import SEED_ROWS


def run_seed(db_path):
    conn = get_db(db_path)
    count = conn.execute("SELECT COUNT(*) AS c FROM applications").fetchone()["c"]
    if count > 0:
        conn.close()
        return 0

    for row in SEED_ROWS:
        (date_applied, company, role, type_, status,
         referred, outreach_sent, reply_received, notes) = row
        conn.execute(
            """
            INSERT INTO applications
                (date_applied, company, role, type, status, referred, outreach_sent, reply_received, resume_used, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?)
            """,
            (date_applied, company, role, type_, status, referred, outreach_sent, reply_received, notes),
        )
    conn.commit()
    conn.close()
    return len(SEED_ROWS)
```

- [ ] **Step 5: Wire `seed` parameter into `app.py`**

Replace the `create_app` signature and body's top/bottom, and the `__main__` block:

```python
from seed import run_seed


def create_app(db_path="tracker.db", seed=False):
    app = Flask(__name__)
    app.config["DATABASE"] = db_path
    init_db(db_path)
    if seed:
        run_seed(db_path)

    # ... existing routes unchanged ...

    return app


if __name__ == "__main__":
    flask_app = create_app(seed=True)
    flask_app.run(debug=True, port=5000)
```

(Add `from seed import run_seed` near the top of `app.py`, alongside the existing `from db import init_db, get_db` line.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pytest -v`
Expected: PASS (all tests across all files, including Tasks 1-7's tests, since none of them pass `seed=True`)

- [ ] **Step 7: Commit**

```bash
git add seed_data.py seed.py tests/test_seed.py app.py
git commit -m "feat: add seed data and idempotent seeding, wired into create_app"
```

---

## Task 9: Frontend UI (table, quick-add, paste-rows, inline edit, color-coded status)

**Files:**
- Create: `templates/index.html`
- Create: `static/style.css`
- Create: `static/app.js`

**Interfaces:**
- Consumes: all `/api/applications*` endpoints from Tasks 2-7. `GET /` (already defined in `app.py` Task 2) renders `templates/index.html`.
- Produces: a working browser UI at `http://localhost:5000/`.

- [ ] **Step 1: Create `templates/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Job Application Tracker</title>
    <link rel="stylesheet" href="{{ url_for('static', filename='style.css') }}">
</head>
<body>
    <h1>Job Application Tracker</h1>

    <form id="quick-add-form">
        <input type="date" name="date_applied" required>
        <input type="text" name="company" placeholder="Company" required>
        <input type="text" name="role" placeholder="Role" required>
        <select name="type" required>
            <option value="Entry">Entry</option>
            <option value="Intern">Intern</option>
            <option value="Other">Other</option>
        </select>
        <select name="status" required>
            <option value="Applied">Applied</option>
            <option value="Interviewing">Interviewing</option>
            <option value="Accepted">Accepted</option>
            <option value="Rejected">Rejected</option>
            <option value="Incomplete">Incomplete</option>
        </select>
        <button type="submit">Add</button>
    </form>

    <details>
        <summary>Paste rows</summary>
        <textarea id="paste-textarea" rows="6" cols="80"
            placeholder="Paste tab-separated rows: date&#9;company&#9;role&#9;type&#9;status&#9;referred&#9;outreach_sent&#9;reply_received&#9;notes"></textarea>
        <button id="paste-submit" type="button">Import pasted rows</button>
        <span id="paste-result"></span>
    </details>

    <div class="filters">
        <label>Status:
            <select id="filter-status">
                <option value="">All</option>
                <option value="Applied">Applied</option>
                <option value="Interviewing">Interviewing</option>
                <option value="Accepted">Accepted</option>
                <option value="Rejected">Rejected</option>
                <option value="Incomplete">Incomplete</option>
            </select>
        </label>
        <label>Company:
            <input type="text" id="filter-company" placeholder="Search company">
        </label>
    </div>

    <table id="applications-table">
        <thead>
            <tr>
                <th data-sort="date_applied">Date Applied</th>
                <th data-sort="company">Company</th>
                <th data-sort="role">Role</th>
                <th data-sort="type">Type</th>
                <th data-sort="status">Status</th>
                <th data-sort="referred">Referred</th>
                <th data-sort="outreach_sent">Outreach Sent</th>
                <th data-sort="reply_received">Reply Received</th>
                <th>Notes</th>
                <th></th>
            </tr>
        </thead>
        <tbody id="applications-body"></tbody>
    </table>

    <script src="{{ url_for('static', filename='app.js') }}"></script>
</body>
</html>
```

- [ ] **Step 2: Create `static/style.css`**

```css
body {
    font-family: system-ui, sans-serif;
    margin: 2rem;
}

table {
    border-collapse: collapse;
    width: 100%;
    margin-top: 1rem;
}

th, td {
    border: 1px solid #ccc;
    padding: 0.4rem 0.6rem;
    text-align: left;
}

th {
    cursor: pointer;
    background: #f2f2f2;
}

td.notes {
    max-width: 300px;
}

select.status-select {
    border: none;
    font-weight: bold;
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
}

.status-Applied { background-color: #ffffff; }
.status-Interviewing { background-color: #cfe2ff; }
.status-Accepted { background-color: #d4edda; }
.status-Rejected { background-color: #f8d7da; }
.status-Incomplete { background-color: #fff3cd; }

.toggle-pill {
    border: none;
    border-radius: 12px;
    padding: 0.2rem 0.6rem;
    cursor: pointer;
}

.toggle-yes { background-color: #d4edda; }
.toggle-no { background-color: #f0f0f0; }
```

- [ ] **Step 3: Create `static/app.js`**

```javascript
const STATUSES = ["Applied", "Interviewing", "Accepted", "Rejected", "Incomplete"];

async function fetchApplications() {
    const status = document.getElementById("filter-status").value;
    const company = document.getElementById("filter-company").value;
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (company) params.set("company", company);
    if (window.currentSort) {
        params.set("sort", window.currentSort.field);
        params.set("dir", window.currentSort.dir);
    }
    const resp = await fetch(`/api/applications?${params.toString()}`);
    const rows = await resp.json();
    renderRows(rows);
}

function renderRows(rows) {
    const body = document.getElementById("applications-body");
    body.innerHTML = "";
    for (const row of rows) {
        const tr = document.createElement("tr");

        tr.appendChild(makeCell(row.date_applied));
        tr.appendChild(makeCell(row.company));
        tr.appendChild(makeCell(row.role));
        tr.appendChild(makeCell(row.type));
        tr.appendChild(makeStatusCell(row));
        tr.appendChild(makeToggleCell(row, "referred"));
        tr.appendChild(makeToggleCell(row, "outreach_sent"));
        tr.appendChild(makeToggleCell(row, "reply_received"));
        tr.appendChild(makeNotesCell(row));
        tr.appendChild(makeDeleteCell(row));

        body.appendChild(tr);
    }
}

function makeCell(text) {
    const td = document.createElement("td");
    td.textContent = text;
    return td;
}

function makeStatusCell(row) {
    const td = document.createElement("td");
    const select = document.createElement("select");
    select.className = `status-select status-${row.status}`;
    for (const status of STATUSES) {
        const option = document.createElement("option");
        option.value = status;
        option.textContent = status;
        if (status === row.status) option.selected = true;
        select.appendChild(option);
    }
    select.addEventListener("change", async () => {
        await updateApplication(row.id, { status: select.value });
        select.className = `status-select status-${select.value}`;
    });
    td.appendChild(select);
    return td;
}

function makeToggleCell(row, field) {
    const td = document.createElement("td");
    const button = document.createElement("button");
    const value = !!row[field];
    button.className = `toggle-pill ${value ? "toggle-yes" : "toggle-no"}`;
    button.textContent = value ? "Yes" : "No";
    button.addEventListener("click", async () => {
        await updateApplication(row.id, { [field]: !value });
        fetchApplications();
    });
    td.appendChild(button);
    return td;
}

function makeNotesCell(row) {
    const td = document.createElement("td");
    td.className = "notes";
    td.textContent = row.notes || "";
    td.contentEditable = "true";
    td.addEventListener("blur", () => {
        updateApplication(row.id, { notes: td.textContent });
    });
    return td;
}

function makeDeleteCell(row) {
    const td = document.createElement("td");
    const button = document.createElement("button");
    button.textContent = "Delete";
    button.addEventListener("click", async () => {
        if (!confirm(`Delete ${row.company} - ${row.role}?`)) return;
        await fetch(`/api/applications/${row.id}`, { method: "DELETE" });
        fetchApplications();
    });
    td.appendChild(button);
    return td;
}

async function updateApplication(id, fields) {
    await fetch(`/api/applications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
    });
}

document.getElementById("quick-add-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const data = Object.fromEntries(new FormData(form).entries());
    const resp = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
    if (resp.ok) {
        form.reset();
        fetchApplications();
    } else {
        const body = await resp.json();
        alert(body.error || "Failed to add application");
    }
});

document.getElementById("paste-submit").addEventListener("click", async () => {
    const text = document.getElementById("paste-textarea").value;
    const resp = await fetch("/api/applications/paste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
    });
    const body = await resp.json();
    document.getElementById("paste-result").textContent =
        `Inserted ${body.inserted}, skipped ${body.skipped}`;
    document.getElementById("paste-textarea").value = "";
    fetchApplications();
});

document.getElementById("filter-status").addEventListener("change", fetchApplications);
document.getElementById("filter-company").addEventListener("input", fetchApplications);

document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
        const field = th.dataset.sort;
        const currentDir = window.currentSort && window.currentSort.field === field
            ? window.currentSort.dir
            : "desc";
        const nextDir = currentDir === "asc" ? "desc" : "asc";
        window.currentSort = { field, dir: nextDir };
        fetchApplications();
    });
});

fetchApplications();
```

- [ ] **Step 4: Manually verify in browser**

Run: `python app.py` (in a terminal; this uses `seed=True` so it auto-seeds on first run since `tracker.db` doesn't exist yet)

Open `http://localhost:5000/` and confirm:
- The table renders already populated with the seeded rows (auto-seeded on first run since Task 8 wired `seed=True` into the `__main__` block)
- Changing a row's Status dropdown changes that row's background color immediately
- Clicking a column header re-sorts the table
- Typing in the Company filter narrows the rows shown
- The quick-add form adds a new row without a page reload
- Pasting `2026-08-01\tTest Co\tSWE\tEntry\tApplied\tNo\tNo\tNo\ttest note` into the paste box and clicking "Import pasted rows" adds one row and shows `Inserted 1, skipped 0`

Stop the server with Ctrl+C when done. Delete the `tracker.db` created during this manual check before Task 10 (Task 10 will do a clean seeded run):

```bash
rm -f tracker.db
```

- [ ] **Step 5: Commit**

```bash
git add templates/index.html static/style.css static/app.js
git commit -m "feat: add table UI with inline edit, sort, filter, and paste-rows import"
```

---

## Task 10: README + final end-to-end verification

**Files:**
- Create: `README.md`
- Modify: `.gitignore` (this file already exists at the repo root with a `.worktrees/` entry — append to it, do not overwrite it)

**Interfaces:**
- Consumes: the full app from Tasks 1-9.
- Produces: a documented, runnable project and a final manual sign-off that the seeded data and full workflow work end-to-end.

- [ ] **Step 1: Append to `.gitignore`**

Read the existing `.gitignore` first, then append these lines below its current content (keep the existing `.worktrees/` line intact):

```
tracker.db
__pycache__/
*.pyc
.pytest_cache/
```

- [ ] **Step 2: Create `README.md`**

```markdown
# Job Application Tracker

Local Flask + SQLite tracker for job applications.

## Setup

    pip install -r requirements.txt

## Run

    python app.py

Open http://localhost:5000. On first run, `tracker.db` is created and
auto-seeded with the existing tracked applications.

## Tests

    pytest -v
```

- [ ] **Step 3: Run the full automated test suite**

Run: `pytest -v`
Expected: PASS, all tests across `tests/test_db.py`, `tests/test_api.py`, `tests/test_seed.py`

- [ ] **Step 4: Run the app and verify seeded data end-to-end**

```bash
rm -f tracker.db
python app.py
```

In a separate terminal, verify the seed landed correctly:

```bash
curl -s http://localhost:5000/api/applications | python3 -c "import json,sys; rows = json.load(sys.stdin); print(len(rows))"
```

Expected: `118`

Then in the browser at `http://localhost:5000/`:
- Confirm the table shows 118 rows
- Filter by Status = Incomplete and confirm exactly 3 rows appear (Amazon, Vanderbilt University, Emory University)
- Filter by Status = Interviewing and confirm exactly 2 rows appear (Texas Sports Academy, Blissway)
- Confirm Emory University's status cell background is yellow (Incomplete)
- Confirm a Rejected row's background is red and an Applied row's background is white/neutral
- Clear filters, sort by Date Applied ascending, confirm the oldest row (2026-07-27, Blissway) appears first
- Stop the server with Ctrl+C

- [ ] **Step 5: Commit**

```bash
git add README.md .gitignore
git commit -m "docs: add README and gitignore"
```
