import pytest
from app import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(db_path=str(tmp_path / "t.db"))
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


def _insert_pick(client, **over):
    from db import get_db
    conn = get_db(client.application.config["DATABASE"])
    row = dict(job_key="jobright:1", source="jobright", url="u", company="Acme",
               role="Firmware Intern", location="Austin, TX", salary="", term="Summer 2027",
               app_type="Intern", heuristic_score=50, rank=1, reasoning="good",
               description="d", first_run_date="2026-09-02", last_run_date="2026-09-02",
               status="new")
    row.update(over)
    cols = ", ".join(row)
    conn.execute(f"INSERT INTO daily_picks ({cols}) VALUES ({', '.join('?' for _ in row)})",
                 list(row.values()))
    conn.commit()
    conn.close()


def test_get_picks_empty(client):
    assert client.get("/api/picks").get_json() == []


def test_get_picks_orders_by_rank_nulls_last(client):
    _insert_pick(client, job_key="j:1", rank=2)
    _insert_pick(client, job_key="j:2", rank=None)
    _insert_pick(client, job_key="j:3", rank=1)
    keys = [p["job_key"] for p in client.get("/api/picks").get_json()]
    assert keys == ["j:3", "j:1", "j:2"]


def test_picks_page_renders(client):
    resp = client.get("/picks")
    assert resp.status_code == 200


def _bulk_body(**over):
    pick = dict(job_key="jobright:1", source="jobright", url="u", company="Acme",
                role="Firmware Intern", location="Austin, TX", salary="$40/hr",
                term="Summer 2027", app_type="Intern", heuristic_score=60, rank=1,
                reasoning="strong ECE match", description="desc")
    pick.update(over)
    return {"run_date": "2026-09-02", "picks": [pick]}


def test_bulk_inserts_new_pick(client):
    resp = client.post("/api/picks/bulk", json=_bulk_body())
    assert resp.status_code == 200
    assert resp.get_json() == {"inserted": 1, "updated": 0, "ignored": 0}
    picks = client.get("/api/picks").get_json()
    assert picks[0]["reasoning"] == "strong ECE match"
    assert picks[0]["first_run_date"] == "2026-09-02"

    from db import get_db
    conn = get_db(client.application.config["DATABASE"])
    disp = conn.execute("SELECT disposition FROM seen_jobs WHERE job_key='jobright:1'").fetchone()["disposition"]
    conn.close()
    assert disp == "candidate"


def test_bulk_updates_existing_new_pick_keeps_first_run_date(client):
    client.post("/api/picks/bulk", json=_bulk_body())
    r2 = client.post("/api/picks/bulk", json={
        "run_date": "2026-09-03",
        "picks": [dict(_bulk_body()["picks"][0], rank=5, reasoning="reranked")],
    })
    assert r2.get_json() == {"inserted": 0, "updated": 1, "ignored": 0}
    p = client.get("/api/picks").get_json()[0]
    assert p["rank"] == 5 and p["reasoning"] == "reranked"
    assert p["first_run_date"] == "2026-09-02" and p["last_run_date"] == "2026-09-03"


def test_bulk_ignores_applied_pick(client):
    client.post("/api/picks/bulk", json=_bulk_body())
    pid = client.get("/api/picks").get_json()[0]["id"]
    from db import get_db
    conn = get_db(client.application.config["DATABASE"])
    conn.execute("UPDATE daily_picks SET status='applied' WHERE id=?", (pid,))
    conn.commit()
    conn.close()
    r = client.post("/api/picks/bulk", json=_bulk_body(reasoning="should not overwrite"))
    assert r.get_json() == {"inserted": 0, "updated": 0, "ignored": 1}


def test_bulk_rejects_bad_app_type(client):
    r = client.post("/api/picks/bulk", json=_bulk_body(app_type="Bogus"))
    assert r.status_code == 400
    assert client.get("/api/picks").get_json() == []


def test_apply_creates_application_and_flips_state(client):
    client.post("/api/picks/bulk", json=_bulk_body())
    pid = client.get("/api/picks").get_json()[0]["id"]

    r = client.post(f"/api/picks/{pid}/apply")
    assert r.status_code == 200
    app_id = r.get_json()["application_id"]

    apps = client.get("/api/applications").get_json()
    match = [a for a in apps if a["id"] == app_id][0]
    assert match["company"] == "Acme"
    assert match["role"] == "Firmware Intern"
    assert match["type"] == "Intern"
    assert match["status"] == "Applied"

    pick = client.get("/api/picks").get_json()[0]
    assert pick["status"] == "applied" and pick["application_id"] == app_id

    from db import get_db
    conn = get_db(client.application.config["DATABASE"])
    disp = conn.execute("SELECT disposition FROM seen_jobs WHERE job_key='jobright:1'").fetchone()["disposition"]
    conn.close()
    assert disp == "applied"


def test_apply_twice_is_409(client):
    client.post("/api/picks/bulk", json=_bulk_body())
    pid = client.get("/api/picks").get_json()[0]["id"]
    client.post(f"/api/picks/{pid}/apply")
    assert client.post(f"/api/picks/{pid}/apply").status_code == 409


def test_apply_missing_pick_is_404(client):
    assert client.post("/api/picks/999/apply").status_code == 404


def test_delete_removes_pick_and_marks_seen_deleted(client):
    client.post("/api/picks/bulk", json=_bulk_body())
    pid = client.get("/api/picks").get_json()[0]["id"]

    r = client.delete(f"/api/picks/{pid}")
    assert r.status_code == 200
    assert client.get("/api/picks").get_json() == []

    from db import get_db
    conn = get_db(client.application.config["DATABASE"])
    row = conn.execute("SELECT disposition, drop_reason FROM seen_jobs WHERE job_key='jobright:1'").fetchone()
    conn.close()
    assert row["disposition"] == "deleted" and row["drop_reason"] == "user-deleted"


def test_delete_missing_pick_is_404(client):
    assert client.delete("/api/picks/999").status_code == 404


def test_deleted_job_key_is_ignored_by_future_bulk(client):
    client.post("/api/picks/bulk", json=_bulk_body())
    pid = client.get("/api/picks").get_json()[0]["id"]
    client.delete(f"/api/picks/{pid}")
    # a later run re-surfaces the same job_key
    r = client.post("/api/picks/bulk", json=_bulk_body())
    # it re-inserts the daily_picks row (bulk keys on daily_picks, which was deleted)
    # but seen_jobs stays 'deleted'
    from db import get_db
    conn = get_db(client.application.config["DATABASE"])
    disp = conn.execute("SELECT disposition FROM seen_jobs WHERE job_key='jobright:1'").fetchone()["disposition"]
    conn.close()
    assert disp == "deleted"


# --- dedup_key / locations ---

def _seen_row(client, job_key):
    from db import get_db
    conn = get_db(client.application.config["DATABASE"])
    row = conn.execute("SELECT * FROM seen_jobs WHERE job_key=?", (job_key,)).fetchone()
    conn.close()
    return dict(row) if row else None


def test_bulk_stores_locations_and_dedup_key(client):
    body = _bulk_body(locations=[
        {"location": "Austin, TX", "url": "u1", "source": "jobright"},
        {"location": "Denver, CO", "url": "u2", "source": "runway"},
    ])
    client.post("/api/picks/bulk", json=body)
    pick = client.get("/api/picks").get_json()[0]
    assert [l["location"] for l in pick["locations"]] == ["Austin, TX", "Denver, CO"]
    assert _seen_row(client, "jobright:1")["dedup_key"] == "acme|firmware intern"


def test_get_picks_locations_defaults_to_empty_list(client):
    client.post("/api/picks/bulk", json=_bulk_body())
    assert client.get("/api/picks").get_json()[0]["locations"] == []


def test_apply_writes_dedup_key_so_cross_source_twin_is_terminal(client):
    client.post("/api/picks/bulk", json=_bulk_body())
    pid = client.get("/api/picks").get_json()[0]["id"]
    client.post(f"/api/picks/{pid}/apply")

    from db import get_db
    from jobscan import seen
    conn = get_db(client.application.config["DATABASE"])
    assert seen.terminal_dedup_disposition(conn, "acme|firmware intern") == "applied"
    conn.close()


def test_delete_writes_dedup_key_so_cross_source_twin_is_terminal(client):
    client.post("/api/picks/bulk", json=_bulk_body())
    pid = client.get("/api/picks").get_json()[0]["id"]
    client.delete(f"/api/picks/{pid}")

    from db import get_db
    from jobscan import seen
    conn = get_db(client.application.config["DATABASE"])
    assert seen.terminal_dedup_disposition(conn, "acme|firmware intern") == "deleted"
    conn.close()


# --- payload bound / hardening ---

def test_get_picks_default_excludes_old_applied_picks(client):
    _insert_pick(client, job_key="old:1", status="applied", updated_at="2020-01-01 00:00:00")
    assert client.get("/api/picks").get_json() == []


def test_get_picks_all_includes_old_applied_picks(client):
    _insert_pick(client, job_key="old:1", status="applied", updated_at="2020-01-01 00:00:00")
    rows = client.get("/api/picks?all=1").get_json()
    assert len(rows) == 1 and rows[0]["job_key"] == "old:1"


def test_get_picks_includes_applied_today(client):
    _insert_pick(client, job_key="today:1", status="applied")  # updated_at defaults to now
    rows = client.get("/api/picks").get_json()
    assert len(rows) == 1 and rows[0]["job_key"] == "today:1"


def test_priority_toggle_returns_flag_and_exposes_priority_pick(client):
    _insert_pick(client)
    pid = client.get("/api/picks").get_json()[0]["id"]

    r = client.post(f"/api/picks/{pid}/priority")
    assert r.status_code == 200 and r.get_json() == {"ok": True, "priority": 1}
    pick = client.get("/api/picks").get_json()[0]
    assert pick["priority"] == 1

    r = client.post(f"/api/picks/{pid}/priority")
    assert r.get_json() == {"ok": True, "priority": 0}


def test_priority_missing_pick_is_404(client):
    assert client.post("/api/picks/999/priority").status_code == 404


def test_priority_rejects_cross_origin_request(client):
    assert client.post("/api/picks/999/priority",
                       headers={"Origin": "https://evil.example.com"}).status_code == 403


def test_bulk_rejects_pick_missing_required_field(client):
    body = _bulk_body()
    del body["picks"][0]["company"]
    r = client.post("/api/picks/bulk", json=body)
    assert r.status_code == 400
    assert client.get("/api/picks").get_json() == []


def test_bulk_skips_job_key_marked_deleted_in_seen_jobs(client):
    from db import get_db
    conn = get_db(client.application.config["DATABASE"])
    conn.execute("""INSERT INTO seen_jobs (job_key, source, url, disposition, drop_reason)
                    VALUES ('jobright:1', 'jobright', 'u', 'deleted', 'user-deleted')""")
    conn.commit()
    conn.close()

    r = client.post("/api/picks/bulk", json=_bulk_body())
    assert r.get_json() == {"inserted": 0, "updated": 0, "ignored": 1}
    assert client.get("/api/picks").get_json() == []


def test_bulk_rejects_cross_origin_request(client):
    r = client.post("/api/picks/bulk", json=_bulk_body(),
                    headers={"Origin": "https://evil.example.com"})
    assert r.status_code == 403
