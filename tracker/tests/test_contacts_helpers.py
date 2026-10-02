from contacts import CATEGORIES, STATUSES, normalize_profile_url


def test_normalize_strips_query_trailing_slash_and_case():
    want = "https://www.linkedin.com/in/jane-doe"
    assert normalize_profile_url("https://www.linkedin.com/in/Jane-Doe/?miniProfile=x") == want
    assert normalize_profile_url("https://linkedin.com/in/jane-doe") == want
    assert normalize_profile_url("  https://www.linkedin.com/in/jane-doe#frag ") == want


def test_normalize_rejects_non_profile_urls():
    assert normalize_profile_url("") == ""
    assert normalize_profile_url(None) == ""
    assert normalize_profile_url("https://example.com/in/jane") == ""
    assert normalize_profile_url("https://www.linkedin.com/company/acme") == ""
    assert normalize_profile_url("https://notlinkedin.com/in/jane") == ""


def test_enums():
    assert CATEGORIES == ("duke", "engineer", "recruiter")
    assert STATUSES == ("found", "drafted", "sent", "replied", "skipped")
