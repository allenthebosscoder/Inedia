import threading

import pytest
from werkzeug.serving import make_server

from app import create_app


@pytest.fixture
def live_server(tmp_path):
    app = create_app(db_path=str(tmp_path / "t.db"))
    srv = make_server("127.0.0.1", 0, app)
    port = srv.socket.getsockname()[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{port}", app
    srv.shutdown()


def _seed(app):
    c = app.test_client()
    app_id = c.post("/api/applications", json={
        "date_applied": "2026-10-02", "company": "Acme", "role": "FW Intern",
        "type": "Intern", "status": "Reaching Out"}).get_json()["id"]
    c.post("/api/contacts/bulk", json={"company": "Acme", "contacts": [
        {"name": "Pat Lee", "title": "Engineer at Acme", "category": "duke",
         "profile_url": "https://www.linkedin.com/in/pat-lee"},
        {"name": "Sam Roe", "title": "Recruiter at Acme", "category": "recruiter",
         "profile_url": "https://www.linkedin.com/in/sam-roe"},
    ]})
    for row in c.get("/api/contacts").get_json():
        c.patch(f"/api/contacts/{row['id']}", json={"draft": f"Hi {row['name']}", "status": "drafted"})
    return app_id


@pytest.mark.live
def test_panel_renders_contacts_with_drafts(live_server, chrome_page):
    base, app = live_server
    _seed(app)
    chrome_page.goto(base)
    chrome_page.click('[data-tab="reaching-out"]')
    chrome_page.wait_for_selector(".contacts-panel-row .contact-card")
    cards = chrome_page.query_selector_all(".contact-card")
    assert len(cards) == 2
    assert "Pat Lee" in cards[0].inner_text()
    assert chrome_page.input_value(".contact-card .contact-draft") == "Hi Pat Lee"


@pytest.mark.live
def test_sent_button_marks_sent_and_updates_apply_by(live_server, chrome_page):
    base, app = live_server
    app_id = _seed(app)
    chrome_page.goto(base)
    chrome_page.click('[data-tab="reaching-out"]')
    chrome_page.wait_for_selector(".contact-card [data-act='sent']")
    chrome_page.click(".contact-card [data-act='sent']")
    chrome_page.wait_for_selector(".contact-card .contact-status")
    rows = app.test_client().get(f"/api/contacts?application_id={app_id}").get_json()
    assert sorted(r["status"] for r in rows) == ["drafted", "sent"]


@pytest.mark.live
def test_reply_received_shows_ok_to_apply(live_server, chrome_page):
    base, app = live_server
    _seed(app)
    c = app.test_client()
    cid = c.get("/api/contacts").get_json()[0]["id"]
    c.post(f"/api/contacts/{cid}/sent")
    c.patch(f"/api/contacts/{cid}", json={"status": "replied", "reply_text": "sure"})
    chrome_page.goto(base)
    chrome_page.click('[data-tab="reaching-out"]')
    chrome_page.wait_for_selector(".contacts-panel-row")
    assert "Reply received" in chrome_page.inner_text("#applications-body")
