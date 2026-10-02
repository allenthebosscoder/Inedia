import pytest
from jobscan.linkedin import (
    LINKEDIN_PROFILE_DIR, LinkedInBlocked, check_not_blocked, is_blocked_url, pace,
)


def test_profile_dir_is_dedicated_linkedin_profile():
    assert LINKEDIN_PROFILE_DIR.name == "linkedin-profile"
    assert ".jobtracker" in str(LINKEDIN_PROFILE_DIR)


@pytest.mark.parametrize("url", [
    "https://www.linkedin.com/checkpoint/challenge/abc",
    "https://www.linkedin.com/authwall?trk=x",
    "https://www.linkedin.com/login?session_redirect=y",
    "https://www.linkedin.com/uas/login",
])
def test_blocked_urls(url):
    assert is_blocked_url(url)


@pytest.mark.parametrize("url", [
    "https://www.linkedin.com/search/results/people/?keywords=acme",
    "https://www.linkedin.com/messaging/",
    "https://www.linkedin.com/in/jane-doe/",
])
def test_normal_urls_not_blocked(url):
    assert not is_blocked_url(url)


class _FakePage:
    def __init__(self, url):
        self.url = url


def test_check_not_blocked_raises_on_authwall():
    with pytest.raises(LinkedInBlocked):
        check_not_blocked(_FakePage("https://www.linkedin.com/authwall"))
    check_not_blocked(_FakePage("https://www.linkedin.com/messaging/"))  # no raise


def test_pace_sleeps_within_bounds():
    slept = []
    pace(2.0, 5.0, sleep=slept.append)
    assert len(slept) == 1 and 2.0 <= slept[0] <= 5.0
