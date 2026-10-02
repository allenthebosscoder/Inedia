import json

import pytest
from app import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(db_path=str(tmp_path / "t.db"))
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


def _app(client, company="Acme", status="Reaching Out"):
    resp = client.post("/api/applications", json={
        "date_applied": "2026-10-02", "company": company, "role": "Intern",
        "type": "Intern", "status": status,
    })
    return resp.get_json()["id"]


def _bulk(client, company="Acme", contacts=None):
    contacts = contacts if contacts is not None else [
        {"name": "Jane Doe", "title": "Engineer at Acme",
         "profile_url": "https://www.linkedin.com/in/jane-doe", "category": "duke"},
    ]
    return client.post("/api/contacts/bulk", json={"company": company, "contacts": contacts})


def _app_row(client, app_id):
    return next(r for r in client.get("/api/applications").get_json() if r["id"] == app_id)


def test_bulk_inserts_and_links_reaching_out_application(client):
    app_id = _app(client)
    resp = _bulk(client)
    assert resp.status_code == 200 and resp.get_json() == {"inserted": 1, "skipped": 0}
    rows = client.get("/api/contacts?company=acme").get_json()
    assert len(rows) == 1
    assert rows[0]["application_id"] == app_id
    assert rows[0]["status"] == "found" and rows[0]["category"] == "duke"


def test_bulk_dedupes_url_variants(client):
    _bulk(client)
    resp = _bulk(client, contacts=[
        {"name": "Jane Doe", "title": "", "category": "duke",
         "profile_url": "https://linkedin.com/in/Jane-Doe/?miniProfile=x"},
    ])
    assert resp.get_json() == {"inserted": 0, "skipped": 1}
    assert len(client.get("/api/contacts").get_json()) == 1


def test_bulk_rejects_invalid_contact_and_inserts_nothing(client):
    good = {"name": "A", "title": "", "profile_url": "https://www.linkedin.com/in/a", "category": "duke"}
    bad = {"name": "B", "title": "", "profile_url": "https://example.com/b", "category": "duke"}
    assert _bulk(client, contacts=[good, bad]).status_code == 400
    bad_cat = dict(good, category="wizard")
    assert _bulk(client, contacts=[bad_cat]).status_code == 400
    assert client.post("/api/contacts/bulk", json={"contacts": [good]}).status_code == 400
    assert client.get("/api/contacts").get_json() == []


def test_contact_found_before_application_links_when_sent(client):
    _bulk(client)                      # no Reaching Out row yet -> application_id NULL
    cid = client.get("/api/contacts").get_json()[0]["id"]
    assert client.get("/api/contacts").get_json()[0]["application_id"] is None
    app_id = _app(client)              # role moved to Reaching Out afterwards
    resp = client.post(f"/api/contacts/{cid}/sent")
    assert resp.status_code == 200 and resp.get_json() == {"ok": True, "logged": True}
    row = client.get("/api/contacts").get_json()[0]
    assert row["status"] == "sent" and row["application_id"] == app_id
    assert _app_row(client, app_id)["apply_by_date"] != ""


def test_sent_is_idempotent(client):
    app_id = _app(client)
    _bulk(client)
    cid = client.get("/api/contacts").get_json()[0]["id"]
    assert client.post(f"/api/contacts/{cid}/sent").get_json()["logged"] is True
    assert client.post(f"/api/contacts/{cid}/sent").get_json()["logged"] is False
    assert len(json.loads(_app_row(client, app_id)["outreach_contacts"])) == 1


def test_sent_without_any_application_still_marks_sent(client):
    _bulk(client)
    cid = client.get("/api/contacts").get_json()[0]["id"]
    assert client.post(f"/api/contacts/{cid}/sent").get_json() == {"ok": True, "logged": False}
    assert client.get("/api/contacts").get_json()[0]["status"] == "sent"


def test_sent_404(client):
    assert client.post("/api/contacts/999/sent").status_code == 404


def test_patch_draft_and_status(client):
    _bulk(client)
    cid = client.get("/api/contacts").get_json()[0]["id"]
    resp = client.patch(f"/api/contacts/{cid}", json={"draft": "Hi Jane", "status": "drafted"})
    assert resp.status_code == 200
    row = client.get("/api/contacts").get_json()[0]
    assert row["draft"] == "Hi Jane" and row["status"] == "drafted"
    resp = client.patch(f"/api/contacts/{cid}", json={"status": "replied", "reply_text": "sure"})
    assert resp.status_code == 200


def test_patch_rejects_sent_unknown_field_and_bad_status(client):
    _bulk(client)
    cid = client.get("/api/contacts").get_json()[0]["id"]
    assert client.patch(f"/api/contacts/{cid}", json={"status": "sent"}).status_code == 400
    assert client.patch(f"/api/contacts/{cid}", json={"name": "x"}).status_code == 400
    assert client.patch(f"/api/contacts/{cid}", json={"status": "nope"}).status_code == 400
    assert client.patch("/api/contacts/999", json={"draft": "x"}).status_code == 404


def test_list_orders_duke_then_engineer_then_recruiter(client):
    def c(n, cat):
        return {"name": n, "title": "", "category": cat,
                "profile_url": f"https://www.linkedin.com/in/{n}"}
    _bulk(client, contacts=[c("r", "recruiter"), c("e", "engineer"), c("d", "duke")])
    assert [r["name"] for r in client.get("/api/contacts").get_json()] == ["d", "e", "r"]


def test_cross_origin_mutations_rejected(client):
    hdr = {"Origin": "https://evil.example"}
    assert client.post("/api/contacts/bulk", json={"company": "A", "contacts": []}, headers=hdr).status_code == 403
    assert client.post("/api/contacts/1/sent", headers=hdr).status_code == 403
    assert client.patch("/api/contacts/1", json={"draft": "x"}, headers=hdr).status_code == 403


def test_existing_outreach_contact_endpoint_still_works(client):
    app_id = _app(client)
    resp = client.post(f"/api/applications/{app_id}/outreach-contact", json={"name": "Bob"})
    assert resp.status_code == 200
    assert client.post("/api/applications/999/outreach-contact", json={"name": "x"}).status_code == 404


def test_cross_origin_check_is_exact_host_not_prefix(client):
    for origin in ("http://localhost.attacker.com", "http://127.0.0.1.evil.example",
                   "http://localhostevil.com"):
        resp = client.post("/api/contacts/bulk", json={"company": "A", "contacts": []},
                           headers={"Origin": origin})
        assert resp.status_code == 403, origin
    for origin in ("http://localhost:8080", "http://127.0.0.1:5000", "http://localhost"):
        resp = client.post("/api/contacts/bulk", json={"company": "A", "contacts": []},
                           headers={"Origin": origin})
        assert resp.status_code == 200, origin
