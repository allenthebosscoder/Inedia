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
    contact_name TEXT DEFAULT '',
    drafted_email TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seen_jobs (
    job_key      TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    url          TEXT NOT NULL,
    company      TEXT DEFAULT '',
    role         TEXT DEFAULT '',
    first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen    TEXT NOT NULL DEFAULT (datetime('now')),
    disposition  TEXT NOT NULL,
    drop_reason  TEXT DEFAULT '',
    dedup_key    TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS reminders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    due_date        TEXT NOT NULL,
    message         TEXT NOT NULL,
    application_id  INTEGER,
    done            INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (application_id) REFERENCES applications(id)
);

CREATE TABLE IF NOT EXISTS daily_picks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    job_key         TEXT NOT NULL UNIQUE,
    source          TEXT NOT NULL,
    url             TEXT NOT NULL,
    company         TEXT NOT NULL,
    role            TEXT NOT NULL,
    location        TEXT DEFAULT '',
    salary          TEXT DEFAULT '',
    term            TEXT DEFAULT '',
    app_type        TEXT DEFAULT 'Other',
    heuristic_score INTEGER DEFAULT 0,
    rank            INTEGER,
    reasoning       TEXT DEFAULT '',
    description     TEXT DEFAULT '',
    first_run_date  TEXT NOT NULL,
    last_run_date   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'new',
    application_id  INTEGER,
    locations       TEXT DEFAULT '[]',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    priority        INTEGER NOT NULL DEFAULT 0
);
"""

# {table: {column: definition}} — added to existing tables when missing.
MIGRATION_COLUMNS = {
    "applications": {
        "contact_name": "TEXT DEFAULT ''",
        "drafted_email": "TEXT DEFAULT ''",
    },
    "seen_jobs": {
        "dedup_key": "TEXT DEFAULT ''",
    },
    "daily_picks": {
        "locations": "TEXT DEFAULT '[]'",
        "priority": "INTEGER NOT NULL DEFAULT 0",
    },
}

# Columns dropped from a table after being retired — the "Worth Outreach?"
# AI-suggestion workflow (reach_out_suggestion/suggestion_reason) was
# replaced 2026-09-13 by directly tracking outreach_sent/reply_received/
# referred on each row, so a fresh DB never creates these and an existing
# one has them removed on next startup (SQLite 3.35+ supports DROP COLUMN).
DROPPED_COLUMNS = {
    "applications": ["reach_out_suggestion", "suggestion_reason"],
}


def get_db(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _migrate(conn):
    for table, columns in MIGRATION_COLUMNS.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if not existing:
            continue  # table doesn't exist yet — SCHEMA's CREATE will make it
        for column, definition in columns.items():
            if column not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    for table, columns in DROPPED_COLUMNS.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        for column in columns:
            if column in existing:
                conn.execute(f"ALTER TABLE {table} DROP COLUMN {column}")

    conn.commit()


def init_db(db_path):
    conn = get_db(db_path)
    conn.executescript(SCHEMA)
    _migrate(conn)
    conn.close()
