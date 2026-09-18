from pathlib import Path
from jobscan.swelist_links import extract_job_links

FIXTURE = (Path(__file__).parent / "fixtures/swelist/digest_email.html").read_text()
FIXTURE_REAL = (Path(__file__).parent / "fixtures/swelist/digest_email_real.html").read_text()


def test_extracts_only_simplify_job_links_deduped():
    links = extract_job_links(FIXTURE)
    urls = [l["url"] for l in links]
    assert urls == [
        "https://simplify.jobs/p/abc123/Firmware-Engineer-Intern",
        "https://app.simplify.jobs/p/def456",
    ]


def test_skips_unsubscribe_social_mailto():
    links = extract_job_links(FIXTURE)
    assert all("unsubscribe" not in l["url"] and "twitter" not in l["url"] for l in links)


def test_captures_visible_text_as_hint():
    links = extract_job_links(FIXTURE)
    assert "Firmware Engineer Intern" in links[0]["role_hint"]


# Real digest tests
def test_real_digest_extracts_14_job_links():
    links = extract_job_links(FIXTURE_REAL)
    assert len(links) == 14
    # Verify all URLs are job links
    for link in links:
        assert "/p/" in link["url"]
        assert "simplify.jobs" in link["url"]
        assert "copilot" not in link["url"]
        assert "github" not in link["url"]
        assert "swelist.com" not in link["url"]
        assert "unsubscribe" not in link["url"]


def test_real_digest_first_entry_company_and_role():
    links = extract_job_links(FIXTURE_REAL)
    assert links[0]["company_hint"] == "Deloitte"
    assert links[0]["role_hint"] == "Software Engineering Summer Scholar Intern"


def test_real_digest_preserves_dash_in_role_title():
    links = extract_job_links(FIXTURE_REAL)
    # Find the AMI entry (Computer Vision Scientist Intern - Geometry and 3D Vision)
    ami_entry = next((l for l in links if "Computer Vision" in l["role_hint"]), None)
    assert ami_entry is not None
    assert ami_entry["company_hint"] == "AMI"
    assert ami_entry["role_hint"] == "Computer Vision Scientist Intern - Geometry and 3D Vision"


def test_inline_bold_in_link_text():
    """Inline <strong> tags inside <a> should be preserved as part of role_hint."""
    html = '<p class="internship"><a href="https://simplify.jobs/p/x">Foo <strong>Bar</strong> Baz</a></p>'
    links = extract_job_links(html)
    assert len(links) == 1
    assert links[0]["role_hint"] == "Foo Bar Baz"
    assert links[0]["company_hint"] == ""


def test_non_company_bold_before_job_link_does_not_leak():
    """Bold text before a job entry shouldn't leak as the first job's company."""
    html = '<p><strong>Weekly Picks</strong></p><p class="internship"><a href="https://simplify.jobs/p/z">Some Role</a></p>'
    links = extract_job_links(html)
    assert len(links) == 1
    assert links[0]["company_hint"] == ""
    assert links[0]["role_hint"] == "Some Role"


def test_entity_unescape_in_role_hint():
    """HTML entities like &amp; should be unescaped to literal &."""
    links = extract_job_links(FIXTURE_REAL)
    # Find the Phoenix Contact entry with Data Science & Analytics Intern
    phoenix_entry = next((l for l in links if "Phoenix Contact" in l["company_hint"]), None)
    assert phoenix_entry is not None
    assert phoenix_entry["role_hint"] == "Data Science & Analytics Intern"
