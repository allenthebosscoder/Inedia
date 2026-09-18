import importlib.util
from pathlib import Path

import pytest

from db import init_db, get_db

spec = importlib.util.spec_from_file_location(
    "reset_seen", Path(__file__).parent.parent / "scripts/reset_seen.py")
reset_seen_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reset_seen_mod)
reset_seen = reset_seen_mod.reset_seen


def _seed(db_path):
    conn = get_db(db_path)
    conn.executemany(
        "INSERT INTO seen_jobs (job_key, source, url, disposition, drop_reason) "
        "VALUES (?, 'runway', 'u', 'dropped', ?)",
        [("k1", "prefilter:location"), ("k2", "prefilter:location"), ("k3", "no-sponsorship")],
    )
    for jk, status in [("k1", "new"), ("k3", "applied")]:
        conn.execute(
            "INSERT INTO daily_picks (job_key, source, url, company, role, "
            "first_run_date, last_run_date, status) VALUES (?, 'runway', 'u', 'C', 'R', "
            "'2026-09-01', '2026-09-01', ?)",
            (jk, status),
        )
    conn.commit()
    conn.close()


def test_reset_by_reason_deletes_seen_and_new_picks(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path); _seed(db_path)

    res = reset_seen(db_path, reason="prefilter:location")
    assert res == {"seen_deleted": 2, "picks_deleted": 1, "dry_run": False}

    conn = get_db(db_path)
    assert [r["job_key"] for r in conn.execute("SELECT job_key FROM seen_jobs")] == ["k3"]
    # k1's 'new' pick is gone; k3 stays (it wasn't matched anyway)
    assert [r["job_key"] for r in conn.execute("SELECT job_key FROM daily_picks")] == ["k3"]
    conn.close()


def test_reset_never_deletes_applied_pick(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path); _seed(db_path)
    reset_seen(db_path, reason="no-sponsorship")
    conn = get_db(db_path)
    row = conn.execute("SELECT status FROM daily_picks WHERE job_key = 'k3'").fetchone()
    assert row["status"] == "applied"  # applied pick untouched
    conn.close()


def test_dry_run_changes_nothing(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path); _seed(db_path)
    res = reset_seen(db_path, reason="prefilter:location", dry_run=True)
    assert res["seen_deleted"] == 2 and res["dry_run"] is True
    conn = get_db(db_path)
    assert conn.execute("SELECT COUNT(*) c FROM seen_jobs").fetchone()["c"] == 3
    conn.close()


def test_refuses_without_filter_or_all(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path); _seed(db_path)
    with pytest.raises(SystemExit):
        reset_seen(db_path)


def test_all_flag_wipes_everything(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path); _seed(db_path)
    res = reset_seen(db_path, all_rows=True)
    assert res["seen_deleted"] == 3
