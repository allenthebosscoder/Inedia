import pytest

from jobscan.adapters.base import JobCard
from jobscan.criteria import is_us_location
from jobscan.prefilter import prefilter


@pytest.mark.parametrize("loc, expected", [
    ("Indianapolis, IN", True),      # "india" inside "Indianapolis" must not fire
    ("New London, CT", True),        # "london" inside "New London" must not fire
    ("London, UK", False),
    ("Bengaluru, India", False),
    ("Toronto, Canada", False),
    ("Remote - US", True),
    ("San Francisco, CA", True),
    ("Burnaby, BC, Canada + 2 more", False),  # simplify.jobs multi-location suffix
])
def test_is_us_location_token_boundaries(loc, expected):
    assert is_us_location(loc) is expected


def card(role="Firmware Engineer Intern", location="Austin, TX"):
    return JobCard("jobright", "1", "u", "Acme", role, location, "", "")


def test_keeps_relevant_us_intern():
    assert prefilter(card()) is None


def test_drops_non_us_location():
    assert prefilter(card(location="London, UK")) == "prefilter:location"


def test_keeps_remote_us():
    assert prefilter(card(location="Remote - US")) is None


def test_drops_senior_titles():
    assert prefilter(card(role="Senior Embedded Engineer")) == "prefilter:seniority"
    assert prefilter(card(role="Staff Hardware Engineer")) == "prefilter:seniority"


def test_seniority_bypass_for_new_grad():
    assert prefilter(card(role="Software Engineer, New Grad (University)")) is None


def test_drops_unrelated_role():
    assert prefilter(card(role="Marketing Coordinator")) == "prefilter:role"


def test_keeps_generic_swe():
    assert prefilter(card(role="Software Engineer Intern")) is None
