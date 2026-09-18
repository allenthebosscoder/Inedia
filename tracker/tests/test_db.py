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
        "notes", "contact_name", "drafted_email",
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


def test_init_db_drops_retired_suggestion_columns(tmp_path):
    """The 'Worth Outreach?' AI-suggestion workflow (reach_out_suggestion/
    suggestion_reason) was retired 2026-09-13 in favor of directly tracking
    outreach_sent/reply_received/referred -- an existing DB carrying those
    columns (and data in them) from before the change must have them
    dropped on the next startup, without losing any other column's data."""
    db_path = str(tmp_path / "old_with_suggestions.db")
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
            contact_name TEXT DEFAULT '',
            drafted_email TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute(
        """INSERT INTO applications
           (date_applied, company, role, type, status, reach_out_suggestion, suggestion_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        ("2026-08-19", "Acme", "SWE", "Entry", "Applied", "Yes", "Large company"),
    )
    conn.commit()
    conn.close()

    init_db(db_path)

    conn = get_db(db_path)
    row = conn.execute("SELECT * FROM applications WHERE company = 'Acme'").fetchone()
    columns = {col["name"] for col in conn.execute("PRAGMA table_info(applications)").fetchall()}
    conn.close()

    assert "reach_out_suggestion" not in columns
    assert "suggestion_reason" not in columns
    assert row["company"] == "Acme"
    assert row["status"] == "Applied"


def test_init_db_migration_is_idempotent(tmp_path):
    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    init_db(db_path)  # must not raise, even with no dropped/added columns left to touch
    conn = get_db(db_path)
    columns = {col["name"] for col in conn.execute("PRAGMA table_info(applications)").fetchall()}
    conn.close()
    assert "reach_out_suggestion" not in columns
    assert "suggestion_reason" not in columns


def test_init_db_creates_seen_jobs_and_daily_picks(tmp_path):
    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    conn = get_db(db_path)
    tables = {r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    seen_cols = {r["name"] for r in conn.execute("PRAGMA table_info(seen_jobs)").fetchall()}
    pick_cols = {r["name"] for r in conn.execute("PRAGMA table_info(daily_picks)").fetchall()}
    conn.close()
    assert {"seen_jobs", "daily_picks"} <= tables
    assert seen_cols == {
        "job_key", "source", "url", "company", "role",
        "first_seen", "last_seen", "disposition", "drop_reason", "dedup_key",
    }
    assert pick_cols == {
        "id", "job_key", "source", "url", "company", "role", "location",
        "salary", "term", "app_type", "heuristic_score", "rank", "reasoning",
        "description", "first_run_date", "last_run_date", "status",
        "application_id", "created_at", "updated_at", "locations",
    }


def test_init_db_migrates_seen_jobs_dedup_key_and_daily_picks_locations(tmp_path):
    db_path = str(tmp_path / "old_pipeline.db")
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE seen_jobs (
            job_key TEXT PRIMARY KEY, source TEXT NOT NULL, url TEXT NOT NULL,
            company TEXT DEFAULT '', role TEXT DEFAULT '',
            first_seen TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen TEXT NOT NULL DEFAULT (datetime('now')),
            disposition TEXT NOT NULL, drop_reason TEXT DEFAULT ''
        );
        CREATE TABLE daily_picks (
            id INTEGER PRIMARY KEY AUTOINCREMENT, job_key TEXT NOT NULL UNIQUE,
            source TEXT NOT NULL, url TEXT NOT NULL, company TEXT NOT NULL,
            role TEXT NOT NULL, first_run_date TEXT NOT NULL,
            last_run_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new'
        );
    """)
    conn.execute("INSERT INTO seen_jobs (job_key, source, url, disposition) VALUES ('jobright:1','jobright','u','applied')")
    conn.commit()
    conn.close()

    init_db(db_path)

    conn = get_db(db_path)
    seen_cols = {r["name"] for r in conn.execute("PRAGMA table_info(seen_jobs)").fetchall()}
    pick_cols = {r["name"] for r in conn.execute("PRAGMA table_info(daily_picks)").fetchall()}
    row = conn.execute("SELECT dedup_key, disposition FROM seen_jobs WHERE job_key='jobright:1'").fetchone()
    conn.close()
    assert "dedup_key" in seen_cols and "locations" in pick_cols
    assert row["dedup_key"] == "" and row["disposition"] == "applied"


def test_init_db_adds_new_tables_to_legacy_db(tmp_path):
    db_path = str(tmp_path / "legacy.db")
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date_applied TEXT NOT NULL, company TEXT NOT NULL, role TEXT NOT NULL,
            type TEXT NOT NULL, status TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()

    init_db(db_path)

    conn = get_db(db_path)
    tables = {r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    conn.close()
    assert {"seen_jobs", "daily_picks"} <= tables


def test_init_db_new_tables_idempotent(tmp_path):
    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    init_db(db_path)  # must not raise
    conn = get_db(db_path)
    n = conn.execute("SELECT COUNT(*) AS c FROM seen_jobs").fetchone()["c"]
    conn.close()
    assert n == 0
