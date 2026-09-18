"""Read/write helpers for the seen_jobs cache. The scanner skips any job_key
already present, so repeat scans do almost no work and deleted/applied jobs
never resurface."""
from __future__ import annotations

import sqlite3

from jobscan.adapters.base import dedup_key

TERMINAL = {"applied", "deleted"}


def applied_dedup_keys(conn: sqlite3.Connection) -> set[str]:
    """dedup_key for every posting in the `applications` table — roles Allen
    applied to directly (not via /picks), which leave no seen_jobs row. run()
    drops a scanned posting whose dedup_key is in here so it never resurfaces."""
    rows = conn.execute("SELECT company, role FROM applications").fetchall()
    return {dedup_key(r["company"], r["role"]) for r in rows}


def is_seen(conn: sqlite3.Connection, key: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM seen_jobs WHERE job_key = ?", (key,)
    ).fetchone() is not None


def disposition_of(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute(
        "SELECT disposition FROM seen_jobs WHERE job_key = ?", (key,)
    ).fetchone()
    return row["disposition"] if row else None


def record(conn, *, key, source, url, disposition, drop_reason="",
           company="", role="", dedup_key=""):
    existing = conn.execute(
        "SELECT company, role, dedup_key FROM seen_jobs WHERE job_key = ?", (key,)
    ).fetchone()
    if existing is None:
        conn.execute(
            """INSERT INTO seen_jobs
               (job_key, source, url, company, role, disposition, drop_reason, dedup_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (key, source, url, company, role, disposition, drop_reason, dedup_key),
        )
    else:
        conn.execute(
            """UPDATE seen_jobs
               SET disposition = ?, drop_reason = ?, last_seen = datetime('now'),
                   company = ?, role = ?, dedup_key = ?
               WHERE job_key = ?""",
            (
                disposition,
                drop_reason,
                company or existing["company"],
                role or existing["role"],
                dedup_key or existing["dedup_key"],
                key,
            ),
        )
    conn.commit()


def terminal_dedup_disposition(conn, dedup_key: str) -> str | None:
    """If any seen_jobs row with this dedup_key was applied or deleted (on
    either source), return that disposition — the scanner then skips the
    cross-source twin. Empty dedup_key never matches."""
    if not dedup_key:
        return None
    row = conn.execute(
        """SELECT disposition FROM seen_jobs
           WHERE dedup_key = ? AND disposition IN ('applied', 'deleted')
           ORDER BY CASE disposition WHEN 'applied' THEN 0 ELSE 1 END
           LIMIT 1""",
        (dedup_key,),
    ).fetchone()
    return row["disposition"] if row else None


def bump(conn, key: str) -> None:
    conn.execute(
        "UPDATE seen_jobs SET last_seen = datetime('now') WHERE job_key = ?", (key,)
    )
    conn.commit()
