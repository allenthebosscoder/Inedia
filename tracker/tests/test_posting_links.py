import pytest

from app import create_app
from db import get_db, init_db
from posting_links import posting_url, split_posting_notes


def test_clean_links_preserve_notes_and_url_parameters():
    history = "Contacted recruiter. Form: https://example.com/form"
    assert split_posting_notes("Daily Picks link: https://example.com/jobs/1/apply?ref=x#jd | " + history) == (
        history, "https://example.com/jobs/1?ref=x#jd")
    assert split_posting_notes(history) == (history, "")
    assert posting_url("https://example.com/apply/jobs/1") == "https://example.com/apply/jobs/1"
    assert posting_url("https://example.com/jobs/1/apply/") == "https://example.com/jobs/1"


@pytest.mark.parametrize("status", ["Applied", "Reaching Out", "Rejected"])
def test_migration_preserves_history(tmp_path, status):
    path = str(tmp_path / "tracker.db")
    init_db(path)
    conn = get_db(path)
    conn.execute("""INSERT INTO applications
        (date_applied, company, role, type, status, notes)
        VALUES ('2026-09-01', 'Acme', 'Intern', 'Intern', ?, ?)""",
        (status, "From Daily Picks: https://example.com/jobs/1/apply | Sent referral request."))
    before = dict(conn.execute("SELECT * FROM applications").fetchone())
    conn.commit()
    conn.close()
    init_db(path)
    init_db(path)
    conn = get_db(path)
    after = dict(conn.execute("SELECT * FROM applications").fetchone())
    conn.close()
    assert after.pop("notes") == "Sent referral request."
    assert after.pop("posting_url") == "https://example.com/jobs/1"
    before.pop("notes")
    before.pop("posting_url")
    assert after == before


@pytest.mark.parametrize("action,status", [("apply", "Applied"), ("outreach", "Reaching Out")])
def test_pick_transfer_stores_posting_link(tmp_path, action, status):
    app = create_app(db_path=str(tmp_path / "tracker.db"))
    client = app.test_client()
    conn = get_db(app.config["DATABASE"])
    cur = conn.execute("""INSERT INTO daily_picks
        (job_key, source, url, company, role, first_run_date, last_run_date)
        VALUES ('test:1', 'test', 'https://example.com/jobs/1/apply?ref=x', 'Acme',
                'Intern', '2026-09-30', '2026-09-30')""")
    pid = cur.lastrowid
    conn.commit()
    conn.close()
    response = client.post(f"/api/picks/{pid}/{action}")
    assert response.status_code == 200
    row = client.get("/api/applications").get_json()[0]
    assert row["status"] == status
    assert row["notes"] == ""
    assert row["posting_url"] == "https://example.com/jobs/1?ref=x"
