from pathlib import Path

from jobscan.linkedin_extract import (
    extract_conversations, extract_people, parse_conversations, parse_people,
)

FIX = Path(__file__).parent / "fixtures" / "linkedin"


def test_parse_people_name_title_dedupe_and_noise_removed():
    raw = [
        {"href": "https://www.linkedin.com/in/pat-lee/?x=1", "name": "Pat Lee View Pat Lee's profile",
         "lines": ["Pat Lee", "View Pat Lee's profile", "• 2nd", "Firmware Engineer at Acme",
                   "Example City, EX", "Connect"]},
        {"href": "https://www.linkedin.com/in/pat-lee", "name": "Pat Lee", "lines": ["dup"]},
        {"href": "https://www.linkedin.com/company/acme", "name": "Acme", "lines": ["Acme"]},
        {"href": "https://www.linkedin.com/in/no-name", "name": "", "lines": []},
    ]
    people = parse_people(raw)
    assert len(people) == 1
    p = people[0]
    assert p["name"] == "Pat Lee"
    assert p["title"] == "Firmware Engineer at Acme"
    assert p["profile_url"] == "https://www.linkedin.com/in/pat-lee"
    assert "Example City, EX" in p["blob"]


def test_parse_people_empty():
    assert parse_people([]) == []


def test_parse_conversations_from_me_detection():
    raw = [
        {"href": "/messaging/thread/1/", "lines": ["Pat Lee", "Oct 1", "Sure, send the job ID"]},
        {"href": "/messaging/thread/2/", "lines": ["Sam Roe", "Sep 30", "You: Hi Sam"]},
        {"href": "/messaging/thread/3/", "lines": ["Only Name"]},
    ]
    convs = parse_conversations(raw)
    assert convs == [
        {"name": "Pat Lee", "snippet": "Sure, send the job ID", "from_me": False},
        {"name": "Sam Roe", "snippet": "You: Hi Sam", "from_me": True},
    ]


def test_extract_people_from_fixture_html(chrome_page):
    chrome_page.set_content((FIX / "people_search.html").read_text())
    people = extract_people(chrome_page)
    assert [p["name"] for p in people] == ["Pat Lee", "Sam Roe"]
    assert people[0]["title"] == "Firmware Engineer at Acme"
    assert people[1]["title"] == "University Recruiter at Acme"


def test_extract_conversations_from_fixture_html(chrome_page):
    chrome_page.set_content((FIX / "inbox.html").read_text())
    convs = extract_conversations(chrome_page)
    assert [(c["name"], c["from_me"]) for c in convs] == [("Pat Lee", False), ("Sam Roe", True)]
