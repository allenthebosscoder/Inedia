"""jobscan.adapters.company_workday — direct per-company Workday scrape."""
import json
from pathlib import Path

import pytest

from jobscan.adapters.base import JobCard
from jobscan.adapters.company_workday import (
    CompanyWorkdayAdapter, _cards_from_search, _is_early_career, job_url,
)

FX = Path(__file__).parent / "fixtures/ats"


def test_is_early_career_title():
    for t in ["Physical Design Engineer Intern, BS - Summer 2027",
              "Software Engineering Co-op", "New Grad Hardware Engineer",
              "Firmware Engineer - University Graduate"]:
        assert _is_early_career(t), t
    for t in ["Senior Staff Physical Design Engineer", "Engineering Manager, RTL",
              "Principal Firmware Architect"]:
        assert not _is_early_career(t), t


def test_job_url_builds_from_external_path():
    assert job_url("marvell.wd1.myworkdayjobs.com", "MarvellCareers2",
                   "/job/Santa-Clara-CA/Physical-Design-Engineer-Intern--BS_2604517") == (
        "https://marvell.wd1.myworkdayjobs.com/MarvellCareers2/job/Santa-Clara-CA/"
        "Physical-Design-Engineer-Intern--BS_2604517")


def test_cards_from_search_filters_to_early_career_and_builds_cards():
    payload = {"total": 3, "jobPostings": [
        {"title": "Physical Design Engineer Intern, BS - Summer 2027",
         "externalPath": "/job/Santa-Clara-CA/PD-Intern_2604517",
         "locationsText": "7 Locations", "postedOn": "Posted 2 Days Ago"},
        {"title": "Senior Staff Verification Engineer",
         "externalPath": "/job/x/Senior_1", "locationsText": "Austin, TX", "postedOn": "Posted Today"},
        {"title": "Firmware Engineering Co-op",
         "externalPath": "/job/y/FW-Coop_2", "locationsText": "Boise, ID", "postedOn": "Posted Today"},
    ]}
    cards = _cards_from_search(payload, "marvell.wd1.myworkdayjobs.com", "Marvell", "MarvellCareers2")
    assert [c.role for c in cards] == [
        "Physical Design Engineer Intern, BS - Summer 2027", "Firmware Engineering Co-op"]
    c = cards[0]
    assert c.source == "company-wd" and c.company == "Marvell"
    assert c.url == "https://marvell.wd1.myworkdayjobs.com/MarvellCareers2/job/Santa-Clara-CA/PD-Intern_2604517"
    assert c.posted_at == "Posted 2 Days Ago"
    assert c.external_id == "PD-Intern_2604517"


def test_adapter_shape():
    a = CompanyWorkdayAdapter()
    assert a.source == "company-wd"
    assert a.uses_separate_detail_page is True
