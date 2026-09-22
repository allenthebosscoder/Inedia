import pytest
from app import create_app


@pytest.fixture
def client(tmp_path):
    db_path = str(tmp_path / "test.db")
    app = create_app(db_path=db_path)
    app.config["TESTING"] = True
    with app.test_client() as client:
        yield client


def test_reminders_page_loads(client):
    resp = client.get("/reminders")
    assert resp.status_code == 200


def test_list_reminders_empty(client):
    resp = client.get("/api/reminders")
    assert resp.status_code == 200
    assert resp.get_json() == []


def test_create_reminder_success(client):
    resp = client.post("/api/reminders", json={
        "due_date": "2026-09-18",
        "message": "Check in with Eric about Micron recruiters",
    })
    assert resp.status_code == 201
    body = resp.get_json()
    assert "id" in body

    rows = client.get("/api/reminders").get_json()
    assert len(rows) == 1
    assert rows[0]["message"] == "Check in with Eric about Micron recruiters"
    assert rows[0]["done"] == 0


def test_create_reminder_missing_fields(client):
    resp = client.post("/api/reminders", json={"due_date": "2026-09-18"})
    assert resp.status_code == 400


def test_create_reminder_links_to_application(client):
    app_resp = client.post("/api/applications", json={
        "date_applied": "2026-09-01",
        "company": "Acme",
        "role": "SWE",
        "type": "Entry",
        "status": "Applied",
    })
    app_id = app_resp.get_json()["id"]

    resp = client.post("/api/reminders", json={
        "due_date": "2026-09-14",
        "message": "Bump Lenny",
        "application_id": app_id,
    })
    assert resp.status_code == 201

    rows = client.get("/api/reminders").get_json()
    assert rows[0]["application_id"] == app_id


def test_create_reminder_invalid_application_id(client):
    resp = client.post("/api/reminders", json={
        "due_date": "2026-09-14",
        "message": "Bump someone",
        "application_id": 9999,
    })
    assert resp.status_code == 400


def test_list_reminders_excludes_done_by_default(client):
    create = client.post("/api/reminders", json={"due_date": "2026-09-14", "message": "A"})
    reminder_id = create.get_json()["id"]
    client.patch(f"/api/reminders/{reminder_id}", json={"done": True})

    assert client.get("/api/reminders").get_json() == []
    all_rows = client.get("/api/reminders?all=1").get_json()
    assert len(all_rows) == 1
    assert all_rows[0]["done"] == 1


def test_update_reminder_not_found(client):
    resp = client.patch("/api/reminders/9999", json={"done": True})
    assert resp.status_code == 404


def test_update_reminder_no_valid_fields(client):
    create = client.post("/api/reminders", json={"due_date": "2026-09-14", "message": "A"})
    reminder_id = create.get_json()["id"]
    resp = client.patch(f"/api/reminders/{reminder_id}", json={"bogus": "value"})
    assert resp.status_code == 400


def test_delete_reminder(client):
    create = client.post("/api/reminders", json={"due_date": "2026-09-14", "message": "A"})
    reminder_id = create.get_json()["id"]

    resp = client.delete(f"/api/reminders/{reminder_id}")
    assert resp.status_code == 200
    assert client.get("/api/reminders?all=1").get_json() == []


def test_delete_reminder_not_found(client):
    resp = client.delete("/api/reminders/9999")
    assert resp.status_code == 404
