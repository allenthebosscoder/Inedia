# Job Application Tracker — Phase 2b: Outreach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-row "Draft Outreach": upload an optional LinkedIn screenshot, Claude picks the best contact (alum > plausible title, falling back to a recruiter web search), the user confirms, then Claude drafts a personalized outreach email using the resume matching the row's judged domain (hardware/software) and existing `type` field (Entry/Intern), saved to the row.

**Architecture:** `claude_client.py` gains two functions — `find_contacts` (vision + web_search) and `draft_email` (a cheap domain-judgment call, then a drafting call with the matching resume PDF attached as a document block). `app.py` gains two new per-row routes that call these and translate exceptions to JSON errors; `find-contact` doesn't write to the DB, `draft-email` both drafts and saves in one request. `db.py` migrates two new columns non-destructively. The frontend adds a per-row "Draft Outreach" button opening a small modal that walks through screenshot upload → contact confirmation → draft review.

**Tech Stack:** Same as Phase 2a (Flask + SQLite + vanilla JS + `anthropic` SDK) — no new packages. Adds a local, gitignored `resumes/` folder holding 4 fixed-name PDFs the user maintains directly.

**Spec:** [docs/superpowers/specs/2026-08-19-job-tracker-phase2b-outreach-design.md](../specs/2026-08-19-job-tracker-phase2b-outreach-design.md)

## Global Constraints

- Status/type enums unchanged from Phase 1. `reach_out_suggestion` unchanged from Phase 2a.
- `contact_name` and `drafted_email` are free-text columns, no enum, default `''`.
- Model: `claude-opus-5` throughout (matches Phase 2a).
- Requires `ANTHROPIC_API_KEY`; the rest of the app (Phase 1 + 2a) must keep working with no key set.
- No automated test may make a real network call to the Anthropic API — always mocked/injected.
- Resume PDFs live at `resumes/{domain}_{type}.pdf` where `domain` is `hardware`/`software` and `type` is `entry`/`intern` (lowercase, matching the row's `type` field lowercased). Never tracked in git.
- Carrying forward lessons from Phase 2a's final review: parse only the LAST text block in a Claude response (never join all text blocks — narration/thinking interleave with the final answer), always check `response.stop_reason` for `"max_tokens"`/`"refusal"` before parsing, and always instruct the model to emit an explicit `{"error": "..."}` JSON on failure rather than letting it guess.
- `tracker.db` holds real user data — schema changes must be non-destructive migrations, matching Task 1's pattern from both prior phases.

---

## Task 1: DB migration — add `contact_name` and `drafted_email` columns

**Files:**
- Modify: `db.py`
- Modify: `tests/test_db.py`

**Interfaces:**
- Produces: `db.init_db(db_path)` now also ensures `contact_name TEXT DEFAULT ''` and `drafted_email TEXT DEFAULT ''` exist on `applications`, whether freshly created or migrated from an earlier version. Safe to call repeatedly.

- [ ] **Step 1: Write the failing tests**

Update the `expected` set in `test_init_db_creates_applications_table` (in `tests/test_db.py`) to include the two new columns, and add a new migration test:

```python
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
        "contact_name", "drafted_email",
        "created_at", "updated_at",
    }
    assert columns == expected


def test_init_db_migrates_database_missing_outreach_columns(tmp_path):
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
            reach_out_suggestion TEXT DEFAULT '',
            suggestion_reason TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute(
        "INSERT INTO applications (date_applied, company, role, type, status) VALUES (?, ?, ?, ?, ?)",
        ("2026-08-19", "Acme", "SWE", "Entry", "Applied"),
    )
    conn.commit()
    conn.close()

    init_db(db_path)

    conn = get_db(db_path)
    row = conn.execute("SELECT * FROM applications WHERE company = 'Acme'").fetchone()
    columns = {col["name"] for col in conn.execute("PRAGMA table_info(applications)").fetchall()}
    conn.close()

    assert "contact_name" in columns
    assert "drafted_email" in columns
    assert row["contact_name"] == ""
    assert row["drafted_email"] == ""
    assert row["company"] == "Acme"
```

(Keep the existing `test_init_db_migrates_existing_database_missing_new_columns` and `test_init_db_migration_is_idempotent` tests from Phase 2a as-is — they still pass unchanged.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_db.py -v`
Expected: `test_init_db_creates_applications_table` FAILs (columns mismatch); `test_init_db_migrates_database_missing_outreach_columns` FAILs with `sqlite3.OperationalError: no such column`

- [ ] **Step 3: Update `db.py`**

Add the two new columns to `SCHEMA` (insert right after the `suggestion_reason` line):

```python
    reach_out_suggestion TEXT DEFAULT '',
    suggestion_reason TEXT DEFAULT '',
    contact_name TEXT DEFAULT '',
    drafted_email TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
```

Add the two new columns to `MIGRATION_COLUMNS`:

```python
MIGRATION_COLUMNS = {
    "reach_out_suggestion": "TEXT DEFAULT ''",
    "suggestion_reason": "TEXT DEFAULT ''",
    "contact_name": "TEXT DEFAULT ''",
    "drafted_email": "TEXT DEFAULT ''",
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_db.py -v`
Expected: PASS (5/5)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `python3 -m pytest -v`
Expected: PASS (all)

- [ ] **Step 6: Commit**

```bash
git add db.py tests/test_db.py
git commit -m "feat: migrate applications table with contact_name and drafted_email columns"
```

---

## Task 2: `claude_client.py` — `find_contacts` and `draft_email`

**Files:**
- Modify: `claude_client.py`
- Modify: `tests/test_claude_client.py`

**Interfaces:**
- Produces: `claude_client.find_contacts(company, image_base64=None, media_type=None, client=None) -> dict` returning `{"candidates": [...], "suggested_name": "...", "suggested_context": "...", "source": "screenshot"|"search"|"none"}`. Raises `MissingAPIKeyError` (reused from Phase 2a) or `ContactFindError`.
- Produces: `claude_client.draft_email(company, role, type_, contact_name, contact_context, client=None, resume_dir="resumes") -> str` (the drafted email text). Raises `MissingAPIKeyError`, or `EmailDraftError` (invalid `type_`, missing resume file on disk, any Claude API failure, or an unparseable/truncated/refused response).
- Also exports `SCHOOL`, `RESUME_FILENAMES` (a dict from `(domain, type)` to filename, for reference/testing).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_claude_client.py`:

```python
from claude_client import find_contacts, draft_email, ContactFindError, EmailDraftError


def make_multi_block_response_general(text, extra_blocks=None):
    narration = MagicMock()
    narration.type = "text"
    narration.text = "Let me look into that."

    final = MagicMock()
    final.type = "text"
    final.text = text

    response = MagicMock()
    response.content = [narration] + (extra_blocks or []) + [final]
    response.stop_reason = "end_turn"
    return response


def test_find_contacts_screenshot_pick():
    client = MagicMock()
    client.messages.create.return_value = make_multi_block_response_general(
        '{"candidates": [{"name": "Jane Doe", "title": "SWE", "context": "Duke alum"}], '
        '"suggested_name": "Jane Doe", "suggested_context": "Duke alum, SWE", "source": "screenshot"}'
    )

    result = find_contacts("Acme", image_base64="fakebase64", media_type="image/png", client=client)

    assert result["suggested_name"] == "Jane Doe"
    assert result["source"] == "screenshot"
    assert len(result["candidates"]) == 1


def test_find_contacts_search_fallback():
    client = MagicMock()
    client.messages.create.return_value = make_multi_block_response_general(
        '{"candidates": [], "suggested_name": "John Recruiter", '
        '"suggested_context": "Found via search", "source": "search"}'
    )

    result = find_contacts("Acme", client=client)

    assert result["suggested_name"] == "John Recruiter"
    assert result["source"] == "search"


def test_find_contacts_defaults_missing_fields():
    client = MagicMock()
    client.messages.create.return_value = make_multi_block_response_general(
        '{"candidates": [], "source": "none"}'
    )

    result = find_contacts("Acme", client=client)

    assert result["suggested_name"] == "Hiring Team"
    assert result["suggested_context"] == ""


def test_find_contacts_raises_on_explicit_error():
    client = MagicMock()
    client.messages.create.return_value = make_multi_block_response_general(
        '{"error": "could not process the screenshot"}'
    )

    with pytest.raises(ContactFindError):
        find_contacts("Acme", client=client)


def test_find_contacts_raises_on_truncation():
    client = MagicMock()
    response = make_multi_block_response_general('{"candidates": [')
    response.stop_reason = "max_tokens"
    client.messages.create.return_value = response

    with pytest.raises(ContactFindError):
        find_contacts("Acme", client=client)


def test_find_contacts_wraps_api_errors():
    client = MagicMock()
    client.messages.create.side_effect = RuntimeError("boom")

    with pytest.raises(ContactFindError):
        find_contacts("Acme", client=client)


def test_find_contacts_raises_missing_api_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    with pytest.raises(MissingAPIKeyError):
        find_contacts("Acme")


def make_resume_dir(tmp_path):
    for filename in ("hardware_entry.pdf", "hardware_intern.pdf", "software_entry.pdf", "software_intern.pdf"):
        (tmp_path / filename).write_bytes(b"%PDF-1.4 fake resume content")
    return str(tmp_path)


def test_draft_email_picks_software_entry_resume(tmp_path):
    resume_dir = make_resume_dir(tmp_path)
    client = MagicMock()
    client.messages.create.side_effect = [
        make_multi_block_response_general("software"),
        make_multi_block_response_general('{"domain": "software", "email": "Dear Jane, ..."}'),
    ]

    email = draft_email(
        "Acme", "SWE", "Entry", "Jane Doe", "Duke alum",
        client=client, resume_dir=resume_dir,
    )

    assert email == "Dear Jane, ..."
    assert client.messages.create.call_count == 2


def test_draft_email_picks_hardware_intern_resume(tmp_path):
    resume_dir = make_resume_dir(tmp_path)
    client = MagicMock()
    client.messages.create.side_effect = [
        make_multi_block_response_general("hardware"),
        make_multi_block_response_general('{"domain": "hardware", "email": "Dear John, ..."}'),
    ]

    email = draft_email(
        "Acme", "EE Intern", "Intern", "John Doe", "recruiter",
        client=client, resume_dir=resume_dir,
    )

    assert email == "Dear John, ..."
    # Confirm the second call attached the hardware_intern resume, not software_entry
    second_call_kwargs = client.messages.create.call_args_list[1].kwargs
    content_blocks = second_call_kwargs["messages"][0]["content"]
    document_block = next(b for b in content_blocks if b["type"] == "document")
    assert document_block["source"]["data"] == base64.standard_b64encode(b"%PDF-1.4 fake resume content").decode("utf-8")


def test_draft_email_rejects_other_type(tmp_path):
    resume_dir = make_resume_dir(tmp_path)
    client = MagicMock()

    with pytest.raises(EmailDraftError):
        draft_email("Acme", "Something", "Other", "Jane Doe", "", client=client, resume_dir=resume_dir)

    client.messages.create.assert_not_called()


def test_draft_email_raises_on_missing_resume_file(tmp_path):
    client = MagicMock()
    client.messages.create.return_value = make_multi_block_response_general("software")

    with pytest.raises(EmailDraftError):
        draft_email(
            "Acme", "SWE", "Entry", "Jane Doe", "",
            client=client, resume_dir=str(tmp_path),  # empty dir, no PDFs
        )


def test_draft_email_wraps_api_errors(tmp_path):
    resume_dir = make_resume_dir(tmp_path)
    client = MagicMock()
    client.messages.create.side_effect = RuntimeError("boom")

    with pytest.raises(EmailDraftError):
        draft_email("Acme", "SWE", "Entry", "Jane Doe", "", client=client, resume_dir=resume_dir)


def test_draft_email_raises_missing_api_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    with pytest.raises(MissingAPIKeyError):
        draft_email("Acme", "SWE", "Entry", "Jane Doe", "")
```

Also add `import base64` to the top of `tests/test_claude_client.py` if not already present (needed for `test_draft_email_picks_hardware_intern_resume`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_claude_client.py -v`
Expected: FAIL — `ImportError: cannot import name 'find_contacts'` (and `draft_email`, `ContactFindError`, `EmailDraftError`)

- [ ] **Step 3: Add the new code to `claude_client.py`**

Add near the top, after the existing `TYPE_VALUES`/`SUGGESTION_VALUES` constants:

```python
import base64

SCHOOL = "Duke University"

RESUME_FILENAMES = {
    ("hardware", "Entry"): "hardware_entry.pdf",
    ("hardware", "Intern"): "hardware_intern.pdf",
    ("software", "Entry"): "software_entry.pdf",
    ("software", "Intern"): "software_intern.pdf",
}

FIND_CONTACT_SYSTEM_PROMPT = """You are a job-search outreach assistant. Given an optional screenshot of people at a company on LinkedIn, and the company name, identify the single best person to reach out to for a referral or informational conversation.

Priority order:
1. An alum of {school} -- this is the strongest signal.
2. Otherwise, someone whose title suggests they can plausibly help (a recruiter, or an engineer/manager in a relevant team) -- not too junior, not senior enough to be an unreachable executive (avoid C-suite, VP+).

If a screenshot was provided, extract every person visible (name, title, any visible affiliation like "{school}") and judge among them.

If no screenshot was provided, or none of the people extracted are a plausible fit, use the web_search tool to find a recruiter or university-recruiting contact at the company instead.

If nothing plausible turns up even via search, propose "Hiring Team" as a generic contact with an empty context.

If you could not complete this task at all (e.g. the screenshot is unreadable), respond with ONLY this JSON object instead: {{"error": "<brief description of what went wrong>"}}

Otherwise respond with ONLY a JSON object in this exact shape, and no other text:
{{"candidates": [{{"name": "...", "title": "...", "context": "..."}}], "suggested_name": "...", "suggested_context": "...", "source": "screenshot" or "search" or "none"}}
""".format(school=SCHOOL)

DOMAIN_SYSTEM_PROMPT = """Judge whether this job posting is more hardware or software focused. Respond with ONLY the single word "hardware" or "software", nothing else."""

DRAFT_EMAIL_SYSTEM_PROMPT = """You are a job-search outreach assistant. Draft a short, personalized outreach email to a contact at a company, referencing the attached resume's actual background, the specific role, and the contact by name/title.

Keep the email brief (3-5 sentences), warm but professional, and specific -- avoid generic templates.

If you could not complete this task at all, respond with ONLY this JSON object instead: {"error": "<brief description of what went wrong>"}

Otherwise respond with ONLY a JSON object in this exact shape, and no other text:
{"email": "..."}
"""


class ContactFindError(Exception):
    pass


class EmailDraftError(Exception):
    pass


def _last_text_block(response):
    text_blocks = [b.text for b in response.content if b.type == "text"]
    return text_blocks[-1] if text_blocks else ""


def find_contacts(company, image_base64=None, media_type=None, client=None):
    if client is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise MissingAPIKeyError("ANTHROPIC_API_KEY is not set")
        client = anthropic.Anthropic()

    content = []
    if image_base64:
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type or "image/png", "data": image_base64},
        })
    content.append({"type": "text", "text": f"Company: {company}"})

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=8000,
            system=FIND_CONTACT_SYSTEM_PROMPT,
            tools=[{"type": "web_search_20260209", "name": "web_search", "max_uses": 3}],
            messages=[{"role": "user", "content": content}],
        )
    except Exception as e:
        # Broad on purpose: the only external call here, every failure mode
        # should surface as the same clear, non-crashing error.
        raise ContactFindError(f"Claude API error: {e}") from e

    if response.stop_reason == "max_tokens":
        raise ContactFindError("Response was truncated (hit max_tokens)")
    if response.stop_reason == "refusal":
        raise ContactFindError("Claude declined to process this request")

    text = _last_text_block(response)

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        raise ContactFindError(f"Could not parse contact-finding response: {text!r}")

    if "error" in data:
        raise ContactFindError(data["error"])

    return {
        "candidates": data.get("candidates", []),
        "suggested_name": data.get("suggested_name") or "Hiring Team",
        "suggested_context": data.get("suggested_context", ""),
        "source": data.get("source", "none"),
    }


def draft_email(company, role, type_, contact_name, contact_context, client=None, resume_dir="resumes"):
    if type_ not in ("Entry", "Intern"):
        raise EmailDraftError(f"Cannot draft outreach for type '{type_}' -- only Entry or Intern are supported")

    if client is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise MissingAPIKeyError("ANTHROPIC_API_KEY is not set")
        client = anthropic.Anthropic()

    try:
        domain_response = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            system=DOMAIN_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": f"Company: {company}\nRole: {role}"}],
        )
    except Exception as e:
        raise EmailDraftError(f"Claude API error: {e}") from e

    domain = _last_text_block(domain_response).strip().lower()
    if domain not in ("hardware", "software"):
        domain = "software"

    resume_filename = RESUME_FILENAMES[(domain, type_)]
    resume_path = os.path.join(resume_dir, resume_filename)
    if not os.path.exists(resume_path):
        raise EmailDraftError(f"Resume file not found: {resume_path}")

    with open(resume_path, "rb") as f:
        resume_b64 = base64.standard_b64encode(f.read()).decode("utf-8")

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=8000,
            system=DRAFT_EMAIL_SYSTEM_PROMPT,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": resume_b64}},
                    {"type": "text", "text": f"Company: {company}\nRole: {role}\nContact: {contact_name} ({contact_context})"},
                ],
            }],
        )
    except Exception as e:
        raise EmailDraftError(f"Claude API error: {e}") from e

    if response.stop_reason == "max_tokens":
        raise EmailDraftError("Response was truncated (hit max_tokens)")
    if response.stop_reason == "refusal":
        raise EmailDraftError("Claude declined to process this request")

    text = _last_text_block(response)

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        raise EmailDraftError(f"Could not parse email draft response: {text!r}")

    if "error" in data:
        raise EmailDraftError(data["error"])

    email = data.get("email")
    if not email:
        raise EmailDraftError(f"Could not parse email draft response: {text!r}")

    return email
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_claude_client.py -v`
Expected: PASS (all — 10 existing from Phase 2a + 13 new)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `python3 -m pytest -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add claude_client.py tests/test_claude_client.py
git commit -m "feat: add contact-finding and email-drafting to claude_client"
```

---

## Task 3: Backend API — `find-contact` + `draft-email` routes, extend `update_application`

**Files:**
- Modify: `app.py`
- Modify: `tests/test_api.py`

**Interfaces:**
- Consumes: `claude_client.find_contacts`, `claude_client.draft_email`, `claude_client.ContactFindError`, `claude_client.EmailDraftError` from Task 2 (in addition to the Phase 2a imports already present).
- Produces: `POST /api/applications/<id>/find-contact` — `200` with the contact-finding result on success; `404` if the row doesn't exist; `400` on missing key or a `ContactFindError`. `POST /api/applications/<id>/draft-email` — `200` with `{"contact_name", "drafted_email"}` and the row updated in the DB on success; `404` if the row doesn't exist; `400` on missing `contact_name` in the request, missing key, or an `EmailDraftError`. `PATCH /api/applications/<id>` now also accepts `contact_name` and `drafted_email`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api.py`:

```python
from claude_client import ContactFindError, EmailDraftError


def test_find_contact_success(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-19", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]

    with patch("app.find_contacts") as mock_find:
        mock_find.return_value = {
            "candidates": [{"name": "Jane Doe", "title": "SWE", "context": "Duke alum"}],
            "suggested_name": "Jane Doe",
            "suggested_context": "Duke alum, SWE",
            "source": "screenshot",
        }
        resp = client.post(f"/api/applications/{app_id}/find-contact", json={
            "image_base64": "fakebase64", "media_type": "image/png",
        })

    assert resp.status_code == 200
    assert resp.get_json()["suggested_name"] == "Jane Doe"
    mock_find.assert_called_once()
    assert mock_find.call_args.args[0] == "Acme"


def test_find_contact_not_found(client):
    resp = client.post("/api/applications/999/find-contact", json={})
    assert resp.status_code == 404


def test_find_contact_missing_api_key(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-19", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]

    with patch("app.find_contacts", side_effect=MissingAPIKeyError("no key")):
        resp = client.post(f"/api/applications/{app_id}/find-contact", json={})
    assert resp.status_code == 400
    assert "ANTHROPIC_API_KEY" in resp.get_json()["error"]


def test_find_contact_fetch_error(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-19", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]

    with patch("app.find_contacts", side_effect=ContactFindError("boom")):
        resp = client.post(f"/api/applications/{app_id}/find-contact", json={})
    assert resp.status_code == 400
    assert resp.get_json()["error"] == "boom"


def test_draft_email_success(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-19", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]

    with patch("app.draft_email") as mock_draft:
        mock_draft.return_value = "Dear Jane, ..."
        resp = client.post(f"/api/applications/{app_id}/draft-email", json={
            "contact_name": "Jane Doe", "contact_context": "Duke alum",
        })

    assert resp.status_code == 200
    body = resp.get_json()
    assert body["contact_name"] == "Jane Doe"
    assert body["drafted_email"] == "Dear Jane, ..."

    rows = client.get("/api/applications").get_json()
    assert rows[0]["contact_name"] == "Jane Doe"
    assert rows[0]["drafted_email"] == "Dear Jane, ..."


def test_draft_email_missing_contact_name(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-19", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]

    resp = client.post(f"/api/applications/{app_id}/draft-email", json={})
    assert resp.status_code == 400


def test_draft_email_not_found(client):
    resp = client.post("/api/applications/999/draft-email", json={"contact_name": "Jane"})
    assert resp.status_code == 404


def test_draft_email_error(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-19", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]

    with patch("app.draft_email", side_effect=EmailDraftError("no resume")):
        resp = client.post(f"/api/applications/{app_id}/draft-email", json={"contact_name": "Jane Doe"})
    assert resp.status_code == 400
    assert resp.get_json()["error"] == "no resume"


def test_update_application_contact_fields(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-19", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]

    patch_resp = client.patch(f"/api/applications/{app_id}", json={
        "contact_name": "Jane Doe", "drafted_email": "Hand-edited draft",
    })
    assert patch_resp.status_code == 200

    rows = client.get("/api/applications").get_json()
    assert rows[0]["contact_name"] == "Jane Doe"
    assert rows[0]["drafted_email"] == "Hand-edited draft"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_api.py -v`
Expected: FAIL — the new routes don't exist yet (404s where 200/400 expected), and the contact-field PATCH test fails since those fields aren't in `allowed_fields` yet

- [ ] **Step 3: Update the import block in `app.py`**

Replace:

```python
from claude_client import (
    extract_job_posting,
    MissingAPIKeyError,
    JobPostingFetchError,
    JobPostingParseError,
    SUGGESTION_VALUES,
)
```

with:

```python
from claude_client import (
    extract_job_posting,
    find_contacts,
    draft_email,
    MissingAPIKeyError,
    JobPostingFetchError,
    JobPostingParseError,
    ContactFindError,
    EmailDraftError,
    SUGGESTION_VALUES,
)
```

- [ ] **Step 4: Update `update_application`'s `allowed_fields` in `app.py`**

Replace:

```python
        allowed_fields = {
            "date_applied", "company", "role", "type", "status",
            "referred", "outreach_sent", "reply_received", "resume_used", "notes",
            "reach_out_suggestion", "suggestion_reason",
        }
```

with:

```python
        allowed_fields = {
            "date_applied", "company", "role", "type", "status",
            "referred", "outreach_sent", "reply_received", "resume_used", "notes",
            "reach_out_suggestion", "suggestion_reason",
            "contact_name", "drafted_email",
        }
```

- [ ] **Step 5: Add the two new routes to `app.py`**

Insert after the existing `applications_from_link` route and before `return app`:

```python
    @app.route("/api/applications/<int:app_id>/find-contact", methods=["POST"])
    def find_contact(app_id):
        conn = get_db(app.config["DATABASE"])
        row = conn.execute("SELECT company FROM applications WHERE id = ?", (app_id,)).fetchone()
        conn.close()
        if row is None:
            return jsonify({"error": "not found"}), 404

        data = request.get_json(force=True) or {}
        image_base64 = data.get("image_base64")
        media_type = data.get("media_type")

        try:
            result = find_contacts(row["company"], image_base64=image_base64, media_type=media_type)
        except MissingAPIKeyError:
            return jsonify({"error": "ANTHROPIC_API_KEY is not set"}), 400
        except ContactFindError as e:
            return jsonify({"error": str(e)}), 400

        return jsonify(result), 200

    @app.route("/api/applications/<int:app_id>/draft-email", methods=["POST"])
    def draft_email_for_application(app_id):
        conn = get_db(app.config["DATABASE"])
        row = conn.execute(
            "SELECT company, role, type FROM applications WHERE id = ?", (app_id,)
        ).fetchone()
        if row is None:
            conn.close()
            return jsonify({"error": "not found"}), 404

        data = request.get_json(force=True) or {}
        contact_name = data.get("contact_name", "").strip()
        contact_context = data.get("contact_context", "")
        if not contact_name:
            conn.close()
            return jsonify({"error": "contact_name is required"}), 400

        try:
            email = draft_email(row["company"], row["role"], row["type"], contact_name, contact_context)
        except MissingAPIKeyError:
            conn.close()
            return jsonify({"error": "ANTHROPIC_API_KEY is not set"}), 400
        except EmailDraftError as e:
            conn.close()
            return jsonify({"error": str(e)}), 400

        conn.execute(
            "UPDATE applications SET contact_name = ?, drafted_email = ?, updated_at = datetime('now') WHERE id = ?",
            (contact_name, email, app_id),
        )
        conn.commit()
        conn.close()
        return jsonify({"contact_name": contact_name, "drafted_email": email}), 200
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_api.py -v`
Expected: PASS (all)

- [ ] **Step 7: Run the full suite to confirm no regressions**

Run: `python3 -m pytest -v`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add app.py tests/test_api.py
git commit -m "feat: add find-contact and draft-email endpoints, extend update for contact fields"
```

---

## Task 4: Frontend — "Draft Outreach" button, modal flow, draft-ready indicator

**Files:**
- Modify: `templates/index.html`
- Modify: `static/style.css`
- Modify: `static/app.js`

**Interfaces:**
- Consumes: `POST /api/applications/<id>/find-contact`, `POST /api/applications/<id>/draft-email` from Task 3.
- Produces: a working per-row "Draft Outreach" flow: screenshot upload (optional) → contact confirmation → draft review, saved automatically.

- [ ] **Step 1: Add the modal skeleton to `templates/index.html`**

Insert right before the closing `</body>` tag, after the `<script>` tag reference (or anywhere inside `<body>` outside the table — position doesn't matter since it's hidden by default and shown/positioned via CSS):

```html
    <div id="outreach-modal" class="modal hidden">
        <div class="modal-content">
            <button id="outreach-close" type="button">Close</button>
            <h2 id="outreach-company"></h2>

            <div id="outreach-screenshot-step">
                <label>LinkedIn screenshot (optional):
                    <input type="file" id="outreach-screenshot-input" accept="image/*">
                </label>
                <button id="outreach-find-contact" type="button">Find Contact</button>
            </div>

            <div id="outreach-contact-result"></div>
            <div id="outreach-draft-result"></div>
        </div>
    </div>
```

- [ ] **Step 2: Add a new "Outreach" table column**

In the `<thead>`, add a new `<th>` right before the final empty `<th></th>` (the one above the Delete button column):

```html
                <th>Notes</th>
                <th>Outreach</th>
                <th></th>
```

(This replaces the existing `<th>Notes</th>` line and the `<th></th>` line immediately after it — the trailing empty `<th></th>` for the Delete column stays, you're inserting a new one between them.)

- [ ] **Step 3: Add modal + badge styles to `static/style.css`**

Append:

```css
.modal {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
}

.modal.hidden {
    display: none;
}

.modal-content {
    background: white;
    padding: 1.5rem;
    border-radius: 8px;
    max-width: 500px;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
}

.outreach-draft-ready {
    background-color: #d4edda;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    font-size: 0.85em;
}

.outreach-not-drafted {
    color: #999;
    font-size: 0.85em;
}

#outreach-draft-textarea {
    width: 100%;
    min-height: 150px;
}

.candidate-option {
    display: block;
    margin: 0.3rem 0;
}
```

- [ ] **Step 4: Add `makeOutreachCell` and wire it into `renderRows` in `static/app.js`**

In `renderRows`, insert a new cell right after the notes cell and before the delete cell:

```javascript
        tr.appendChild(makeNotesCell(row));
        tr.appendChild(makeOutreachCell(row));
        tr.appendChild(makeDeleteCell(row));
```

(This replaces the existing `tr.appendChild(makeNotesCell(row));` line and the line immediately after it.)

Add the new function near `makeNotesCell`:

```javascript
function makeOutreachCell(row) {
    const td = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Draft Outreach";
    button.addEventListener("click", () => openOutreachModal(row));
    td.appendChild(button);

    const indicator = document.createElement("span");
    if (row.drafted_email) {
        indicator.className = "outreach-draft-ready";
        indicator.textContent = "Draft ready";
    } else {
        indicator.className = "outreach-not-drafted";
        indicator.textContent = "No draft yet";
    }
    td.appendChild(document.createElement("br"));
    td.appendChild(indicator);

    return td;
}
```

- [ ] **Step 5: Add the modal flow to `static/app.js`**

Append at the end of the file:

```javascript
let outreachRow = null;

function openOutreachModal(row) {
    outreachRow = row;
    document.getElementById("outreach-company").textContent = `${row.company} — ${row.role}`;
    document.getElementById("outreach-screenshot-input").value = "";
    document.getElementById("outreach-contact-result").innerHTML = "";
    document.getElementById("outreach-draft-result").innerHTML = "";
    document.getElementById("outreach-modal").classList.remove("hidden");
}

function closeOutreachModal() {
    document.getElementById("outreach-modal").classList.add("hidden");
    outreachRow = null;
}

document.getElementById("outreach-close").addEventListener("click", closeOutreachModal);

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            const base64 = result.split(",")[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

document.getElementById("outreach-find-contact").addEventListener("click", async () => {
    const resultArea = document.getElementById("outreach-contact-result");
    resultArea.textContent = "Looking for a contact...";

    const fileInput = document.getElementById("outreach-screenshot-input");
    let imageBase64 = null;
    let mediaType = null;
    if (fileInput.files.length > 0) {
        const file = fileInput.files[0];
        imageBase64 = await readFileAsBase64(file);
        mediaType = file.type;
    }

    try {
        const resp = await fetch(`/api/applications/${outreachRow.id}/find-contact`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image_base64: imageBase64, media_type: mediaType }),
        });
        const body = await resp.json();
        if (!resp.ok) {
            resultArea.textContent = body.error || "Failed to find a contact";
            return;
        }
        renderContactResult(body);
    } catch (err) {
        resultArea.textContent = "Something went wrong finding a contact. Please try again.";
    }
});

function renderContactResult(data) {
    const resultArea = document.getElementById("outreach-contact-result");
    resultArea.innerHTML = "";

    const sourceLabel = document.createElement("p");
    sourceLabel.textContent = data.source === "screenshot"
        ? "Picked from your screenshot:"
        : data.source === "search"
        ? "Found via web search:"
        : "No strong candidate found:";
    resultArea.appendChild(sourceLabel);

    const nameInput = document.createElement("input");
    nameInput.id = "outreach-contact-name";
    nameInput.value = data.suggested_name;

    const contextInput = document.createElement("input");
    contextInput.id = "outreach-contact-context";
    contextInput.value = data.suggested_context;
    contextInput.size = 40;

    resultArea.appendChild(nameInput);
    resultArea.appendChild(contextInput);

    if (data.candidates && data.candidates.length > 1) {
        const altLabel = document.createElement("p");
        altLabel.textContent = "Other candidates found:";
        resultArea.appendChild(altLabel);
        for (const candidate of data.candidates) {
            const option = document.createElement("label");
            option.className = "candidate-option";
            const radio = document.createElement("input");
            radio.type = "radio";
            radio.name = "outreach-candidate";
            radio.addEventListener("change", () => {
                nameInput.value = candidate.name;
                contextInput.value = candidate.context;
            });
            option.appendChild(radio);
            option.appendChild(document.createTextNode(` ${candidate.name} — ${candidate.title}`));
            resultArea.appendChild(option);
        }
    }

    const draftButton = document.createElement("button");
    draftButton.type = "button";
    draftButton.textContent = "Draft Email";
    draftButton.addEventListener("click", () => draftOutreachEmail(nameInput.value, contextInput.value));
    resultArea.appendChild(draftButton);
}

async function draftOutreachEmail(contactName, contactContext) {
    const draftArea = document.getElementById("outreach-draft-result");
    draftArea.textContent = "Drafting...";

    try {
        const resp = await fetch(`/api/applications/${outreachRow.id}/draft-email`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contact_name: contactName, contact_context: contactContext }),
        });
        const body = await resp.json();
        if (!resp.ok) {
            draftArea.textContent = body.error || "Failed to draft email";
            return;
        }
        draftArea.innerHTML = "";
        const textarea = document.createElement("textarea");
        textarea.id = "outreach-draft-textarea";
        textarea.value = body.drafted_email;
        draftArea.appendChild(textarea);
        fetchApplications();
    } catch (err) {
        draftArea.textContent = "Something went wrong drafting the email. Please try again.";
    }
}
```

- [ ] **Step 6: Verify what's checkable without a browser**

Run: `python3 -m pytest -v` — confirm no regressions (this task touches no Python files).

Start the app and confirm the new elements are present:

```bash
rm -f tracker.db
python3 app.py &
sleep 1.5
curl -s http://127.0.0.1:8080/ | grep -o 'outreach-modal\|outreach-screenshot-input\|outreach-find-contact\|Outreach' | sort -u
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/static/style.css
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/static/app.js
kill %1
rm -f tracker.db
```

Expected: all four grep matches present, both assets return `200`. Full visual/interactive verification happens in Task 5 with a real API key and a real screenshot.

- [ ] **Step 7: Commit**

```bash
git add templates/index.html static/style.css static/app.js
git commit -m "feat: add Draft Outreach modal, contact confirmation, and draft review UI"
```

---

## Task 5: `resumes/` setup + gitignore + README + end-to-end verification

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`

**Interfaces:**
- Consumes: the full feature from Tasks 1-4.
- Produces: a gitignored `resumes/` folder convention documented for the user, and a final manual sign-off.

- [ ] **Step 1: Append to `.gitignore`**

Read the existing `.gitignore` first, then append below its current content:

```
resumes/
```

- [ ] **Step 2: Update `README.md`**

Read the existing README first, then add a new section after the "Setup" section (before "## Run"):

```markdown
## Resumes (for outreach email drafting)

The "Draft Outreach" feature needs your resumes as PDFs in a `resumes/`
folder (not tracked in git — these are your personal documents), with
these exact filenames:

    resumes/hardware_entry.pdf
    resumes/hardware_intern.pdf
    resumes/software_entry.pdf
    resumes/software_intern.pdf

Claude judges whether a role is hardware- or software-focused, combines
that with the row's existing Entry/Intern type, and attaches the matching
PDF when drafting an email. Swap a file whenever that resume updates —
no upload flow, no re-running anything.
```

- [ ] **Step 3: Run the full automated test suite**

Run: `python3 -m pytest -v`
Expected: PASS, all tests across `tests/test_db.py`, `tests/test_api.py`, `tests/test_claude_client.py`

- [ ] **Step 4: Live end-to-end check (requires a real `ANTHROPIC_API_KEY` and real resume PDFs)**

If a real key is available and the user has placed their 4 resume PDFs in `resumes/`:

1. Start the app (`python3 app.py`), open it in a browser.
2. Click "Draft Outreach" on any row, optionally upload a real LinkedIn screenshot of people at that company.
3. Click "Find Contact" — confirm a plausible contact appears (from the screenshot or a search fallback).
4. Click "Draft Email" — confirm a plausible, personalized draft appears referencing real resume content, and that the row's "Outreach" cell now shows "Draft ready" after the modal is closed and the table refreshes.

If no real key or no resume PDFs are available in this environment, note that explicitly in the report and defer this check to the user's own machine — do not skip silently, say explicitly that this step wasn't run and why, and give the exact steps above for them to follow.

- [ ] **Step 5: Commit**

```bash
git add .gitignore README.md
git commit -m "docs: document resumes/ folder convention for outreach drafting"
```
