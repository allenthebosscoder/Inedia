"""jobscan.detail_fetch — block detection + ATS JSON-API fallback."""
import pytest

from jobscan.detail_fetch import looks_blocked, workday_api_url, greenhouse_api_url


def test_looks_blocked_on_bot_walls_and_thin_pages():
    for t in [
        "Access Denied You don't have permission to access this server.",
        "Just a moment... Verify you are human",
        "English Workday is currently unavailable. We are experiencing a service interruption.",
        "short",
        "",
    ]:
        assert looks_blocked(t), t


def test_looks_blocked_on_dead_dell_oracle_cloud_posting():
    # Dell (2026-09-15): "This job is no longer available." -- a different
    # ATS's phrasing for the same removed-posting problem as the Workday
    # case below, again wrapped in enough real site chrome (nav, footer,
    # social links) to clear the 300-char floor on its own.
    t = ("Skip to main content. Careers Join Talent Network My Application "
         "Life at Dell You and Dell Early in Career Our Opportunities Locations "
         "American English This job is no longer available. You may also VIEW ALL JOBS. "
         "Connect with Us Instagram LinkedIn Glassdoor Indeed X Twitter YouTube Our Company "
         "Who We Are Team Member Stories Dell Technologies Capital Investors Newsroom Recycling "
         "Corporate Impact Customer Stories Resources Dell Rewards Specialty Product Collections "
         "Security Trust Center Trial Software Downloads Our Offerings Artificial Intelligence "
         "Products Solutions Services Deals Our Partners Find a Partner Find a Reseller OEM Solutions "
         "Partner Program Dell Technologies Dell Premier for Business Dell Financial Services "
         "Copyright 2026 Dell Inc Privacy Statement Equal Employment Opportunity")
    assert looks_blocked(t)


def test_looks_blocked_on_dead_greenhouse_posting():
    # IonQ (2026-09-15): "The job you are looking for is no longer open."
    # -- a third ATS's phrasing (Greenhouse) for the same removed-posting
    # problem as the Workday/Dell cases below; the page redirects to the
    # board's full job list, so there's plenty of real-looking site chrome
    # around the dead-posting message to clear the 300-char floor.
    t = ("The job you are looking for is no longer open. Current Openings at IonQ "
         "Create a Job Alert Level-up your career by having opportunities at IonQ "
         "sent directly to your inbox. Create alert Search Department Select... "
         "Office Select... 104 jobs Compute Job Physicist - Ion Transport and Waveform "
         "Engineering Design Software Engineer Hardware Engineer Research Scientist")
    assert looks_blocked(t)


def test_looks_blocked_on_dead_workday_posting():
    # HPE (2026-09-12) and Intel (2026-09-14): a removed/expired Workday
    # posting renders the site's normal chrome (nav, cookie banner, footer)
    # around a generic "doesn't exist" message -- easily over the 300-char
    # floor, so it was passing as "not blocked" and returning a false
    # 'hardfilter: None' clean verdict for a link with zero real JD content.
    t = ("Skip to main content\nWelcome!\nIntel Corporation uses cookies and similar "
         "technologies on this website to improve your online experience.\nSign In\n"
         "Life at Intel\nSearch for Jobs\nJoin Our Talent Community\n"
         "The page you are looking for doesn't exist.\nSearch for Jobs\n"
         "© 2026 Workday, Inc. All rights reserved.")
    assert looks_blocked(t)


def test_looks_blocked_on_linkedin_signin_wall():
    # 2026-09-14: two jobright postings resolved to linkedin.com/jobs/view
    # links -- our browser profile has no LinkedIn login, so every fetch
    # there lands on the sign-in wall, never a real JD. It's easy to miss
    # since the wall page is well over the 300-char floor and sometimes
    # even echoes the role/company title near the bottom, so a caller could
    # mistake it for a real (if short) JD and trust a stray "None" hardfilter
    # verdict that never actually saw any qualifications text.
    for t in [
        "Skip to main content\nLinkedIn\nJoin LinkedIn\nEmail\nPassword (6+ characters)\n\n"
        "By clicking Agree & Join, you agree to the LinkedIn User Agreement, Privacy "
        "Policy, and Cookie Policy.\nAgree & Join\nor\nContinue with Google" + " x" * 100,
        "Skip to main content\nLinkedIn\nJobs\nClear text\nClear text\nSign in\nJoin now\n"
        "Intern: Engineering (Embedded)\nEquipmentShare  Columbia, MO\n1 hour ago" + " x" * 100,
    ]:
        assert looks_blocked(t), t


def test_looks_blocked_false_on_a_real_jd():
    jd = ("About the Role: We are hiring a firmware engineering intern for Summer 2027. "
          "You will write bare-metal C for our motor controllers, bring up new boards, "
          "and work with the hardware team on debug. Requirements: pursuing a BS in EE or CE. " * 3)
    assert not looks_blocked(jd)


def test_workday_api_url_transform():
    html = ("https://marvell.wd1.myworkdayjobs.com/MarvellCareers2/job/"
            "Santa-Clara-CA/Physical-Design-Engineer-Intern--BS---Summer-2027_2604517")
    assert workday_api_url(html) == (
        "https://marvell.wd1.myworkdayjobs.com/wday/cxs/marvell/MarvellCareers2/job/"
        "Santa-Clara-CA/Physical-Design-Engineer-Intern--BS---Summer-2027_2604517")


def test_workday_api_url_strips_locale_prefix():
    html = ("https://kiongroup.wd3.myworkdayjobs.com/en-US/kiongroup/job/"
            "Grand-Rapids-MI-United-States/Controls-Engineer---Co-Op_JR-0089161-1")
    assert workday_api_url(html) == (
        "https://kiongroup.wd3.myworkdayjobs.com/wday/cxs/kiongroup/kiongroup/job/"
        "Grand-Rapids-MI-United-States/Controls-Engineer---Co-Op_JR-0089161-1")


def test_workday_api_url_none_for_other_hosts():
    assert workday_api_url("https://www.tesla.com/careers/search/job/282331") is None
    assert workday_api_url("https://boards.greenhouse.io/neuralink/jobs/7702527003") is None


def test_greenhouse_api_url_transform():
    for html in ["https://boards.greenhouse.io/neuralink/jobs/7702527003",
                 "https://job-boards.greenhouse.io/neuralink/jobs/7702527003?gh_src=x"]:
        assert greenhouse_api_url(html) == (
            "https://boards-api.greenhouse.io/v1/boards/neuralink/jobs/7702527003?questions=true")


def test_greenhouse_api_url_none_for_other_hosts():
    assert greenhouse_api_url("https://marvell.wd1.myworkdayjobs.com/x/job/y_1") is None


def test_greenhouse_api_url_from_embed_with_for_and_token():
    # the "Original Job Post" / simplify /jobs/click landing URL
    u = "https://job-boards.greenhouse.io/embed/job_app?for=coinbase&gh_src=Simplify&token=8168315"
    assert greenhouse_api_url(u) == (
        "https://boards-api.greenhouse.io/v1/boards/coinbase/jobs/8168315?questions=true")
    # token but no for= and no company -> can't build it
    assert greenhouse_api_url("https://boards.greenhouse.io/embed/job_app?token=8168315") is None
    # company arg still works as a fallback slug
    assert greenhouse_api_url("https://boards.greenhouse.io/embed/job_app?token=8168315",
                              company="Coinbase") is not None


def test_strip_tracking_params():
    from jobscan.detail_fetch import strip_tracking
    assert strip_tracking(
        "https://careers.twosigma.com/careers/JobDetail/x/14016?source=jobright&jr_id=abc"
    ) == "https://careers.twosigma.com/careers/JobDetail/x/14016"
    assert strip_tracking(
        "https://job-boards.greenhouse.io/embed/job_app?for=coinbase&gh_src=Simplify&token=8168315"
    ) == "https://job-boards.greenhouse.io/embed/job_app?for=coinbase&token=8168315"
    # nothing to strip
    assert strip_tracking("https://x.co/a/b") == "https://x.co/a/b"


def test_fetch_jd_via_browser_returns_body_text_or_empty_on_block():
    from jobscan.detail_fetch import fetch_jd_via_browser

    class _El:
        def __init__(self, t): self._t = t
        def inner_text(self): return self._t

    class _Page:
        def __init__(self, body): self._body = body; self.goto_url = None
        def goto(self, url, **kw): self.goto_url = url
        def wait_for_timeout(self, ms): pass
        def query_selector(self, sel): return _El(self._body)

    good = _Page("A real job description. " * 40)
    assert "real job description" in fetch_jd_via_browser(good, "https://x.co/j")
    assert good.goto_url == "https://x.co/j"
    blocked = _Page("Access Denied. You don't have permission.")
    assert fetch_jd_via_browser(blocked, "https://x.co/j") == ""


# --- simplify.jobs source-URL resolution -----------------------------------

from jobscan.detail_fetch import (  # noqa: E402
    simplify_click_url, parse_greenhouse, parse_oracle, restricted_by_questions,
)


def test_simplify_click_url():
    assert simplify_click_url(
        "https://simplify.jobs/p/0f3c4057-6580-4955-8436-b08bb3fa2e4e/Embedded-SW?utm_source=swelist"
    ) == "https://simplify.jobs/jobs/click/0f3c4057-6580-4955-8436-b08bb3fa2e4e"
    assert simplify_click_url("https://boards.greenhouse.io/x/jobs/1") is None


# --- Greenhouse handler (offline, against captured fixtures) ---------------

import json  # noqa: E402
from pathlib import Path  # noqa: E402

FX = Path(__file__).parent / "fixtures/ats"


def test_parse_greenhouse_includes_jd_and_questions_block():
    text, posted, labels = parse_greenhouse(json.loads((FX / "greenhouse_generalmatter.json").read_text()))
    assert "Summer 2027 Internship" in text
    assert "--- Application questions ---" in text
    assert "Clearance Eligibility" in text
    assert "Clearance Eligibility" in labels and "Active Security Clearance(s)" in labels


def test_parse_oracle_concatenates_corporate_description():
    text, posted, labels = parse_oracle(json.loads((FX / "oracle_vertiv.json").read_text()))
    # the sponsorship clause lives in CorporateDescriptionStr, not ExternalDescriptionStr
    assert "not a position for which sponsorship will be provided" in text.lower()
    assert labels == []


# --- restricted_by_questions ---------------------------------------------

def test_restricted_by_questions_flags_clearance_not_sponsorship():
    assert restricted_by_questions(["Clearance Eligibility", "GPA"]) == "clearance"
    assert restricted_by_questions(["Active Security Clearance(s)"]) == "clearance"
    assert restricted_by_questions([
        "Are you currently authorized to work in the United States?",
        "Will you, at any point, require employer sponsorship to work in the United States?",
        "Are you legally authorized to work in the United States?",
    ]) is None


from jobscan.detail_fetch import smartrecruiters_api_url, parse_smartrecruiters  # noqa: E402


def test_smartrecruiters_api_url_transform():
    assert smartrecruiters_api_url("https://jobs.smartrecruiters.com/Solidigm/744000147613629") == (
        "https://api.smartrecruiters.com/v1/companies/Solidigm/postings/744000147613629")
    assert smartrecruiters_api_url("https://boards.greenhouse.io/x/jobs/1") is None


def test_parse_smartrecruiters_includes_all_sections():
    text, posted, labels = parse_smartrecruiters(
        json.loads((FX / "smartrecruiters_solidigm.json").read_text()))
    assert "not eligible for candidates requiring visa sponsorship" in text.lower()
    assert labels == []


from jobscan.detail_fetch import ats_url_in_text, workable_api_url, lever_api_url, parse_workable  # noqa: E402


def test_ats_url_in_text_finds_the_first_recognized_host():
    html = ('<div>apply here</div><a href="https://reliaquest.wd5.myworkdayjobs.com/'
            'ReliaQuest_Careers/job/Tampa-FL/Associate-Software-Engineer_R15047">Apply</a>')
    assert ats_url_in_text(html) == (
        "https://reliaquest.wd5.myworkdayjobs.com/ReliaQuest_Careers/job/Tampa-FL/"
        "Associate-Software-Engineer_R15047")
    assert ats_url_in_text("just some job description text, no links") is None


def test_workable_api_url_transform():
    assert workable_api_url("https://apply.workable.com/enfos-inc/j/CA15908E0A/apply") == (
        "https://apply.workable.com/api/v1/accounts/enfos-inc/jobs/CA15908E0A")
    assert workable_api_url("https://boards.greenhouse.io/x/jobs/1") is None


def test_lever_api_url_transform():
    assert lever_api_url("https://jobs.lever.co/matchgroup/abc-123-def") == (
        "https://api.lever.co/v0/postings/matchgroup/abc-123-def?mode=json")


def test_lever_api_url_preserves_eu_region_host():
    # Quantinuum (2026-09-14): an EU-region posting lives at jobs.eu.lever.co,
    # but api.lever.co (no "eu.") 404s on that posting id -- it needs
    # api.eu.lever.co specifically. Rewriting to a hardcoded api.lever.co
    # silently broke the JSON-API path for every EU Lever posting.
    assert lever_api_url("https://jobs.eu.lever.co/quantinuum/672bb667-0569-44bc-a2fa-a0fcd85673fb/apply") == (
        "https://api.eu.lever.co/v0/postings/quantinuum/672bb667-0569-44bc-a2fa-a0fcd85673fb?mode=json")


def test_parse_lever_includes_list_content_not_just_headings():
    # Acron Aviation (2026-09-14): parse_lever only read each Lever "lists"
    # entry's `text` field -- the section HEADING ("Required Qualifications")
    # -- and dropped `content`, the actual <li> bullets. Every Lever posting
    # was silently missing its whole qualifications section, including
    # exactly the kind of disqualifying clause hardfilter needs to see (here,
    # a U.S.-export-control / U.S.-Person requirement).
    from jobscan.detail_fetch import parse_lever
    d = {
        "text": "Electrical Engineer Intern",
        "descriptionPlain": "Join our engineering team.",
        "lists": [
            {"text": "Required Qualifications",
             "content": "<li>Bachelor's in EE.</li><li>Applicants must qualify as a U.S. Person "
                        "due to export control regulations.</li>"},
        ],
        "categories": {"location": "St Petersburg, FL"},
        "createdAt": 1789347394517,
    }
    text, posted, labels = parse_lever(d)
    assert "Required Qualifications" in text
    assert "U.S. Person" in text and "export control" in text
    assert posted.startswith("2026-")


def test_parse_workable_includes_sections_and_location():
    text, posted, labels = parse_workable(json.loads((FX / "workable_enfos.json").read_text()))
    assert "Software Engineer Intern" in text
    assert "Location: Durham" in text and "United States" in text
    assert posted.startswith("2026-09")


from jobscan.detail_fetch import ashby_api_url, parse_ashby  # noqa: E402


def test_ashby_api_url_and_parse():
    assert ashby_api_url("https://jobs.ashbyhq.com/reflect-orbital/"
                         "d2ad1427-89aa-404d-8678-7b8e6dace5e2/application") == (
        "https://api.ashbyhq.com/posting-api/job-board/reflect-orbital"
        "#d2ad1427-89aa-404d-8678-7b8e6dace5e2")
    d = json.loads((FX / "ashby_reflectorbital.json").read_text())
    text, posted, labels = parse_ashby(d, "d2ad1427-89aa-404d-8678-7b8e6dace5e2")
    assert "Flight Software Engineering Intern" in text
    assert "Location: Hawthorne, CA" in text
