from datetime import date

import pytest
from app import compute_stats, create_app
from profile_data import build_profile, set_active_profile


@pytest.fixture
def client(tmp_path):
    db_path = str(tmp_path / "test.db")
    app = create_app(db_path=db_path)
    app.config["TESTING"] = True
    with app.test_client() as client:
        yield client


def test_list_applications_empty(client):
    resp = client.get("/api/applications")
    assert resp.status_code == 200
    assert resp.get_json() == []


def test_create_application_success(client):
    resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18",
        "company": "Acme",
        "role": "SWE",
        "type": "Entry",
        "status": "Applied",
    })
    assert resp.status_code == 201
    body = resp.get_json()
    assert "id" in body

    rows = client.get("/api/applications").get_json()
    assert len(rows) == 1
    assert rows[0]["company"] == "Acme"


def test_create_application_invalid_status(client):
    resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18",
        "company": "Acme",
        "role": "SWE",
        "type": "Entry",
        "status": "Bogus",
    })
    assert resp.status_code == 400


def test_create_application_missing_fields(client):
    resp = client.post("/api/applications", json={"company": "Acme"})
    assert resp.status_code == 400


def test_update_application_status(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]

    patch_resp = client.patch(f"/api/applications/{app_id}", json={"status": "Interviewing"})
    assert patch_resp.status_code == 200

    rows = client.get("/api/applications").get_json()
    assert rows[0]["status"] == "Interviewing"


def test_update_application_invalid_status(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]
    resp = client.patch(f"/api/applications/{app_id}", json={"status": "Bogus"})
    assert resp.status_code == 400


def test_update_application_not_found(client):
    resp = client.patch("/api/applications/999", json={"status": "Applied"})
    assert resp.status_code == 404


def test_delete_application(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]

    del_resp = client.delete(f"/api/applications/{app_id}")
    assert del_resp.status_code == 200

    rows = client.get("/api/applications").get_json()
    assert rows == []


def test_delete_application_not_found(client):
    resp = client.delete("/api/applications/999")
    assert resp.status_code == 404


def test_list_applications_filter_by_status(client):
    client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Beta", "role": "SWE",
        "type": "Entry", "status": "Rejected",
    })
    resp = client.get("/api/applications?status=Rejected")
    rows = resp.get_json()
    assert len(rows) == 1
    assert rows[0]["company"] == "Beta"


def test_list_applications_filter_by_company(client):
    client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme Corp", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Beta Inc", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    resp = client.get("/api/applications?company=acme")
    rows = resp.get_json()
    assert len(rows) == 1
    assert rows[0]["company"] == "Acme Corp"


def test_list_applications_sort_by_date_asc(client):
    client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Later", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    client.post("/api/applications", json={
        "date_applied": "2026-08-01", "company": "Earlier", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    resp = client.get("/api/applications?sort=date_applied&dir=asc")
    rows = resp.get_json()
    assert [r["company"] for r in rows] == ["Earlier", "Later"]


def test_list_applications_sort_by_id(client):
    for company in ["First", "Second", "Third"]:
        client.post("/api/applications", json={
            "date_applied": "2026-08-18", "company": company, "role": "SWE",
            "type": "Entry", "status": "Applied",
        })
    resp = client.get("/api/applications?sort=id&dir=asc")
    rows = resp.get_json()
    assert [r["company"] for r in rows] == ["First", "Second", "Third"]
    assert [r["id"] for r in rows] == sorted(r["id"] for r in rows)


def test_list_applications_sort_by_referred(client):
    client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "B", "role": "SWE",
        "type": "Entry", "status": "Applied", "referred": True,
    })
    client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "A", "role": "SWE",
        "type": "Entry", "status": "Applied", "referred": False,
    })
    resp = client.get("/api/applications?sort=referred&dir=asc")
    rows = resp.get_json()
    assert [r["referred"] for r in rows] == sorted([1, 0])


def test_list_applications_sort_by_apply_by_date(client):
    """Clicking the Apply By column header on the Reaching Out tab should
    actually sort by that column, not silently fall back to date_applied.
    date_applied and apply_by_date are deliberately in reversed order here
    so a fallback to date_applied would produce the wrong result."""
    later_date_applied_earlier_deadline = client.post("/api/applications", json={
        "date_applied": "2026-09-20", "company": "DeadlineSoon", "role": "SWE",
        "type": "Entry", "status": "Reaching Out",
    }).get_json()["id"]
    earlier_date_applied_later_deadline = client.post("/api/applications", json={
        "date_applied": "2026-09-01", "company": "DeadlineLater", "role": "SWE",
        "type": "Entry", "status": "Reaching Out",
    }).get_json()["id"]
    client.post(f"/api/applications/{later_date_applied_earlier_deadline}/outreach-contact", json={
        "name": "A", "date_sent": "2026-09-01",
    })
    client.post(f"/api/applications/{earlier_date_applied_later_deadline}/outreach-contact", json={
        "name": "B", "date_sent": "2026-09-20",
    })

    resp = client.get("/api/applications?sort=apply_by_date&dir=asc")
    rows = resp.get_json()
    assert [r["company"] for r in rows] == ["DeadlineSoon", "DeadlineLater"]


def test_list_applications_filter_by_status_reaching_out(client):
    client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Beta", "role": "SWE",
        "type": "Entry", "status": "Reaching Out",
    })
    resp = client.get("/api/applications?status=Reaching+Out")
    rows = resp.get_json()
    assert len(rows) == 1
    assert rows[0]["company"] == "Beta"


def test_paste_applications_inserts_valid_rows(client):
    text = "2026-08-18\tAcme\tSWE\tEntry\tApplied\tNo\tNo\tsome note"
    resp = client.post("/api/applications/paste", json={"text": text})
    assert resp.status_code == 200
    assert resp.get_json() == {"inserted": 1, "skipped": 0}

    rows = client.get("/api/applications").get_json()
    assert len(rows) == 1
    assert rows[0]["notes"] == "some note"


def test_paste_applications_skips_malformed_rows(client):
    text = "\n".join([
        "2026-08-18\tAcme\tSWE\tEntry\tApplied\tNo\tNo\tok row",
        "not enough columns",
        "2026-08-18\tBeta\tSWE\tBogusType\tApplied\tNo\tNo\tbad type",
    ])
    resp = client.post("/api/applications/paste", json={"text": text})
    assert resp.get_json() == {"inserted": 1, "skipped": 2}


def test_paste_applications_crlf_notes_no_trailing_cr(client):
    text = "2026-08-18\tAcme\tSWE\tEntry\tApplied\tNo\tNo\tsome note\r\n"
    resp = client.post("/api/applications/paste", json={"text": text})
    assert resp.get_json() == {"inserted": 1, "skipped": 0}

    rows = client.get("/api/applications").get_json()
    assert len(rows) == 1
    assert rows[0]["notes"] == "some note"
    assert "\r" not in rows[0]["notes"]


def test_paste_applications_crlf_multiple_rows_all_inserted(client):
    text = "\r\n".join([
        "2026-08-18\tAcme\tSWE\tEntry\tApplied",
        "2026-08-19\tBeta\tPM\tEntry\tInterviewing",
    ])
    resp = client.post("/api/applications/paste", json={"text": text})
    assert resp.get_json() == {"inserted": 2, "skipped": 0}

    rows = client.get("/api/applications").get_json()
    assert len(rows) == 2
    assert {r["company"] for r in rows} == {"Acme", "Beta"}


def test_get_profile_returns_valid_shape(client, monkeypatch):
    # Isolate from any local profile_data_private.py -- these assertions
    # describe the generic fallback profile, not whatever a real private
    # file on this machine contains.
    monkeypatch.setattr("profile_data.PRIVATE_PROFILE", None)
    monkeypatch.setattr("profile_data._private_build_profile", None)
    resp = client.get("/api/profile")
    assert resp.status_code == 200
    profile = resp.get_json()
    assert profile["version"] == 1
    assert profile["personal"]["firstName"] == "Example"
    assert profile["workAuthorization"]["requiresSponsorship"] == "no"
    assert profile["workAuthorization"]["usPerson"] == ""
    assert isinstance(profile["workHistory"], list) and len(profile["workHistory"]) > 0
    assert profile["education"][0]["school"] == "Example University"


def test_build_profile_defaults_to_entry_grad_date_with_no_active_profile(tmp_path):
    path = str(tmp_path / "active_profile.json")
    profile = build_profile(path=path)
    assert profile["education"][0]["graduationDate"] == "05/2027"
    assert profile["resume"] is None


def test_set_active_profile_primes_intern_grad_date_and_resume(tmp_path):
    path = str(tmp_path / "active_profile.json")
    set_active_profile("Intern", "Example-User-Acme-SWE.pdf", "data:application/pdf;base64,ZmFrZQ==", path=path)
    profile = build_profile(path=path)
    assert profile["education"][0]["graduationDate"] == "12/2027"
    assert profile["resume"] == {
        "name": "Example-User-Acme-SWE.pdf",
        "type": "application/pdf",
        "dataUrl": "data:application/pdf;base64,ZmFrZQ==",
    }


def test_set_active_profile_grad_date_override_wins_over_role_type_default(tmp_path):
    """A real user can have three possible graduation dates, not two: an
    early grad with a full-time offer, an early-ish internship-driven date,
    or the normal on-track timeline. The Entry/Intern default table only
    covers the first two, so a posting requiring "graduating 2028 or
    beyond" (e.g. ID.me) needs an explicit override."""
    path = str(tmp_path / "active_profile.json")
    set_active_profile(
        "Intern", "resume.pdf", "data:application/pdf;base64,ZmFrZQ==",
        grad_date="05/2028",
        path=path,
    )
    profile = build_profile(path=path)
    assert profile["education"][0]["graduationDate"] == "05/2028"
    assert profile["education"][0]["endDate"] == "05/2028"


def test_set_active_profile_defaults_to_entry_grad_date_for_unknown_type(tmp_path):
    path = str(tmp_path / "active_profile.json")
    set_active_profile("Other", "resume.pdf", "data:application/pdf;base64,ZmFrZQ==", path=path)
    profile = build_profile(path=path)
    assert profile["education"][0]["graduationDate"] == "05/2027"


def test_set_active_profile_primes_role_specific_skills(tmp_path):
    path = str(tmp_path / "active_profile.json")
    set_active_profile(
        "Entry", "resume.pdf", "data:application/pdf;base64,ZmFrZQ==",
        skills="C++, Verilog, PCB Design, Oscilloscope",
        path=path,
    )
    profile = build_profile(path=path)
    assert profile["professional"]["skills"] == "C++, Verilog, PCB Design, Oscilloscope"


def test_build_profile_falls_back_to_full_skills_list_when_none_primed(tmp_path):
    path = str(tmp_path / "active_profile.json")
    set_active_profile("Entry", "resume.pdf", "data:application/pdf;base64,ZmFrZQ==", path=path)
    profile = build_profile(path=path)
    assert "Python" in profile["professional"]["skills"]
    assert "Git" in profile["professional"]["skills"]


def test_set_active_profile_primes_role_specific_work_history(tmp_path):
    path = str(tmp_path / "active_profile.json")
    trimmed_history = [
        {
            "company": "Example Labs",
            "title": "Research Intern",
            "location": "Example City, EX",
            "startDate": "2026-05",
            "endDate": "2026-07",
            "currentlyWorksHere": False,
            "description": "- Designed and implemented a compile-time information-flow control framework in Rust.",
        }
    ]
    set_active_profile(
        "Intern", "resume.pdf", "data:application/pdf;base64,ZmFrZQ==",
        work_history=trimmed_history,
        path=path,
    )
    profile = build_profile(path=path)
    assert profile["workHistory"] == trimmed_history


def test_set_active_profile_normalizes_employer_jobtitle_current_aliases(tmp_path):
    """Regression test for a real bug: every work_history= call made during
    the 2026-09-02/03 session used employer/jobTitle/current instead of the
    canonical company/title/currentlyWorksHere (matching STATIC_PROFILE and
    the extension's WorkHistoryEntry schema). The extension's
    renderWorkHistoryEntry() reads entry.company/.title/.currentlyWorksHere
    directly and throws on undefined, so every tailored resume primed that
    session silently rendered zero Work History entries in the extension,
    undetected until a user checked the options page directly."""
    path = str(tmp_path / "active_profile.json")
    aliased_history = [
        {
            "employer": "Example Labs",
            "jobTitle": "Research Intern",
            "location": "Example City, EX",
            "startDate": "05/2026",
            "endDate": "07/2026",
            "current": False,
            "description": "- Designed and implemented a compile-time information-flow control framework in Rust.",
        }
    ]
    set_active_profile(
        "Intern", "resume.pdf", "data:application/pdf;base64,ZmFrZQ==",
        work_history=aliased_history,
        path=path,
    )
    profile = build_profile(path=path)
    entry = profile["workHistory"][0]
    assert entry["company"] == "Example Labs"
    assert entry["title"] == "Research Intern"
    assert entry["currentlyWorksHere"] is False
    assert "employer" not in entry
    assert "jobTitle" not in entry
    assert "current" not in entry


def test_build_profile_falls_back_to_full_work_history_when_none_primed(tmp_path, monkeypatch):
    # Isolate from any local profile_data_private.py -- see the comment on
    # test_get_profile_returns_valid_shape.
    monkeypatch.setattr("profile_data.PRIVATE_PROFILE", None)
    monkeypatch.setattr("profile_data._private_build_profile", None)
    path = str(tmp_path / "active_profile.json")
    set_active_profile("Entry", "resume.pdf", "data:application/pdf;base64,ZmFrZQ==", path=path)
    profile = build_profile(path=path)
    companies = [entry["company"] for entry in profile["workHistory"]]
    assert "Example Labs" in companies
    assert len(profile["workHistory"]) == 1


def test_set_active_profile_primes_role_label(tmp_path):
    path = str(tmp_path / "active_profile.json")
    set_active_profile(
        "Intern", "resume.pdf", "data:application/pdf;base64,ZmFrZQ==",
        role_label="Example Company - Software Intern",
        path=path,
    )
    profile = build_profile(path=path)
    assert profile["profileLabel"] == "Example Company - Software Intern"


def test_build_profile_defaults_to_empty_profile_label_when_none_primed(tmp_path):
    path = str(tmp_path / "active_profile.json")
    set_active_profile("Entry", "resume.pdf", "data:application/pdf;base64,ZmFrZQ==", path=path)
    profile = build_profile(path=path)
    assert profile["profileLabel"] == ""


def test_update_application_rejects_retired_reach_out_suggestion_field(client):
    """reach_out_suggestion/suggestion_reason were retired 2026-09-13 -- a
    PATCH carrying only that field now has nothing left to apply."""
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]
    patch_resp = client.patch(f"/api/applications/{app_id}", json={"reach_out_suggestion": "No"})
    assert patch_resp.status_code == 400


def test_update_application_rejects_retired_outreach_sent_field(client):
    """outreach_sent was retired 2026-09-28 in favor of the Reaching Out
    tab -- a PATCH carrying only that field now has nothing left to apply."""
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]
    patch_resp = client.patch(f"/api/applications/{app_id}", json={"outreach_sent": True})
    assert patch_resp.status_code == 400


def test_patch_status_and_date_applied_together(client):
    """The frontend stamps date_applied in the same PATCH call as the
    status change when a row leaves Reaching Out for Applied -- confirm
    the generic PATCH endpoint applies both fields from one request."""
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-09-20", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Reaching Out",
    })
    app_id = create_resp.get_json()["id"]

    patch_resp = client.patch(f"/api/applications/{app_id}", json={
        "status": "Applied", "date_applied": "2026-09-28",
    })
    assert patch_resp.status_code == 200

    row = client.get("/api/applications").get_json()[0]
    assert row["status"] == "Applied"
    assert row["date_applied"] == "2026-09-28"


def test_patch_status_reaching_out_to_rejected_leaves_date_applied_unchanged(client):
    """Moving straight from Reaching Out to Rejected (skipping Applied --
    e.g. a contact says no during outreach) needs no special handling:
    date_applied stays whatever it was, since the client has no reason to
    send it in that PATCH."""
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-09-20", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Reaching Out",
    })
    app_id = create_resp.get_json()["id"]

    patch_resp = client.patch(f"/api/applications/{app_id}", json={"status": "Rejected"})
    assert patch_resp.status_code == 200

    row = client.get("/api/applications").get_json()[0]
    assert row["status"] == "Rejected"
    assert row["date_applied"] == "2026-09-20"


def test_outreach_contact_sets_dates_on_first_contact(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-09-28", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Reaching Out",
    })
    app_id = create_resp.get_json()["id"]

    resp = client.post(f"/api/applications/{app_id}/outreach-contact", json={
        "name": "Jane Doe", "date_sent": "2026-09-28",
    })
    assert resp.status_code == 200

    rows = client.get("/api/applications").get_json()
    row = rows[0]
    assert row["latest_outreach_date"] == "2026-09-28"
    assert row["apply_by_date"] == "2026-10-03"
    import json as jsonlib
    assert jsonlib.loads(row["outreach_contacts"]) == [{"name": "Jane Doe", "date_sent": "2026-09-28"}]


def test_outreach_contact_later_date_advances_deadline(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-09-28", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Reaching Out",
    })
    app_id = create_resp.get_json()["id"]
    client.post(f"/api/applications/{app_id}/outreach-contact", json={
        "name": "Jane Doe", "date_sent": "2026-09-28",
    })
    client.post(f"/api/applications/{app_id}/outreach-contact", json={
        "name": "John Roe", "date_sent": "2026-09-30",
    })

    row = client.get("/api/applications").get_json()[0]
    assert row["latest_outreach_date"] == "2026-09-30"
    assert row["apply_by_date"] == "2026-10-05"


def test_outreach_contact_earlier_date_does_not_move_deadline_backward(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-09-28", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Reaching Out",
    })
    app_id = create_resp.get_json()["id"]
    client.post(f"/api/applications/{app_id}/outreach-contact", json={
        "name": "Jane Doe", "date_sent": "2026-09-30",
    })
    client.post(f"/api/applications/{app_id}/outreach-contact", json={
        "name": "Backdated Contact", "date_sent": "2026-09-20",
    })

    row = client.get("/api/applications").get_json()[0]
    assert row["latest_outreach_date"] == "2026-09-30"
    assert row["apply_by_date"] == "2026-10-05"


def test_outreach_contact_defaults_date_to_today(client, monkeypatch):
    import app as app_module
    monkeypatch.setattr(app_module, "date", type("FixedDate", (), {
        "today": staticmethod(lambda: date(2026, 9, 28)),
    }))
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-09-28", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Reaching Out",
    })
    app_id = create_resp.get_json()["id"]
    client.post(f"/api/applications/{app_id}/outreach-contact", json={"name": "Jane Doe"})

    row = client.get("/api/applications").get_json()[0]
    assert row["latest_outreach_date"] == "2026-09-28"


def test_outreach_contact_missing_application_is_404(client):
    resp = client.post("/api/applications/999/outreach-contact", json={"name": "Jane Doe"})
    assert resp.status_code == 404


def test_update_application_reply_received_and_referred(client):
    create_resp = client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    app_id = create_resp.get_json()["id"]
    patch_resp = client.patch(f"/api/applications/{app_id}", json={
        "reply_received": True, "referred": True,
    })
    assert patch_resp.status_code == 200
    rows = client.get("/api/applications").get_json()
    assert rows[0]["reply_received"] == 1
    assert rows[0]["referred"] == 1


def test_compute_stats_counts_applied_and_rejected():
    rows = [
        {"status": "Applied", "date_applied": "2026-08-01"},
        {"status": "Applied", "date_applied": "2026-08-02"},
        {"status": "Rejected", "date_applied": "2026-08-03"},
        {"status": "Interviewing", "date_applied": "2026-08-04"},
    ]
    stats = compute_stats(rows, today=date(2026, 9, 1))
    assert stats["applied"] == 2
    assert stats["rejected"] == 1


def test_compute_stats_counts_today():
    rows = [
        {"status": "Applied", "date_applied": "2026-09-02"},  # today: in
        {"status": "Applied", "date_applied": "2026-09-02"},  # today: in
        {"status": "Applied", "date_applied": "2026-09-01"},  # yesterday: out
        {"status": "Rejected", "date_applied": "2026-09-02"},  # today, but Rejected still counts toward "today"
    ]
    stats = compute_stats(rows, today=date(2026, 9, 2))
    assert stats["today"] == 3


def test_compute_stats_today_skips_malformed_dates():
    rows = [
        {"status": "Applied", "date_applied": ""},
        {"status": "Applied", "date_applied": None},
        {"status": "Applied", "date_applied": "not-a-date"},
    ]
    stats = compute_stats(rows, today=date(2026, 9, 2))
    assert stats["today"] == 0


def test_compute_stats_this_week_monday_boundary():
    # Wednesday 2026-09-02 (today) -> week is Mon 2026-08-31 .. Sun 2026-09-06
    today = date(2026, 9, 2)
    rows = [
        {"status": "Applied", "date_applied": "2026-08-31"},  # Monday: in
        {"status": "Applied", "date_applied": "2026-09-06"},  # Sunday: in
        {"status": "Applied", "date_applied": "2026-08-30"},  # prior Sunday: out
        {"status": "Applied", "date_applied": "2026-09-07"},  # next Monday: out
    ]
    stats = compute_stats(rows, today=today)
    assert stats["this_week"] == 2


def test_compute_stats_skips_malformed_or_empty_dates():
    rows = [
        {"status": "Applied", "date_applied": ""},
        {"status": "Applied", "date_applied": None},
        {"status": "Applied", "date_applied": "not-a-date"},
    ]
    stats = compute_stats(rows, today=date(2026, 9, 2))
    assert stats["this_week"] == 0
    assert stats["applied"] == 3


def test_get_stats_endpoint_matches_direct_counts(client):
    client.post("/api/applications", json={
        "date_applied": "2026-08-18", "company": "Acme", "role": "SWE",
        "type": "Entry", "status": "Applied",
    })
    client.post("/api/applications", json={
        "date_applied": "2026-08-19", "company": "Beta", "role": "SWE",
        "type": "Entry", "status": "Rejected",
    })
    client.post("/api/applications", json={
        "date_applied": "2026-08-20", "company": "Gamma", "role": "SWE",
        "type": "Entry", "status": "Interviewing",
    })

    resp = client.get("/api/stats")
    assert resp.status_code == 200
    stats = resp.get_json()

    rows = client.get("/api/applications").get_json()
    assert stats["applied"] == len([r for r in rows if r["status"] == "Applied"])
    assert stats["rejected"] == len([r for r in rows if r["status"] == "Rejected"])


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
