from jobscan.detail_fetch import greenhouse_api_url


def test_greenhouse_api_url_recognizes_custom_domain_with_gh_jid():
    # Pinterest (2026-10-03): a custom white-labeled Greenhouse domain
    # (pinterestcareers.com, not greenhouse.io) using the standard
    # ?gh_jid=<id> embed convention. The job id is global and resolvable
    # via the public boards-api once a board slug is known; derive the
    # slug from the company name the same way the embed-form fallback
    # already does.
    url = "https://www.pinterestcareers.com/jobs/?gh_jid=8138039"
    assert greenhouse_api_url(url, company="Pinterest") == (
        "https://boards-api.greenhouse.io/v1/boards/pinterest/jobs/8138039?questions=true")


def test_greenhouse_api_url_gh_jid_without_company_returns_none():
    url = "https://www.pinterestcareers.com/jobs/?gh_jid=8138039"
    assert greenhouse_api_url(url) is None


def test_greenhouse_api_url_still_handles_the_standard_path_form():
    url = "https://job-boards.greenhouse.io/apptronik/jobs/6206626004"
    assert greenhouse_api_url(url) == (
        "https://boards-api.greenhouse.io/v1/boards/apptronik/jobs/6206626004?questions=true")


def test_greenhouse_api_url_non_greenhouse_url_without_gh_jid_returns_none():
    assert greenhouse_api_url("https://example.com/careers/123", company="Example") is None
