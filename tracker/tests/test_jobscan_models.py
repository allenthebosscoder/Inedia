from jobscan.adapters.base import (
    JobCard, JobPosting, job_key, external_id_from_url, dedup_key,
)


def test_job_key():
    assert job_key("jobright", "abc123") == "jobright:abc123"


def test_dedup_key_ignores_case_whitespace_and_punctuation():
    assert dedup_key("Acme, Inc.", "SWE  Intern") == dedup_key("acme inc", "swe intern")


def test_dedup_key_unifies_intern_and_internship():
    assert dedup_key("Vertiv", "Firmware Engineer Intern") == \
           dedup_key("Vertiv", "Firmware Engineer Internship")


def test_dedup_key_strips_trailing_term_and_year_noise():
    base = dedup_key("Zipline", "Embedded Systems Intern")
    assert dedup_key("Zipline", "Embedded Systems Intern - Summer 2027") == base
    assert dedup_key("Zipline", "Embedded Systems Intern (2027)") == base


def test_dedup_key_keeps_genuinely_different_roles_distinct():
    assert dedup_key("Amazon", "Software Engineer Intern") != \
           dedup_key("Amazon", "Hardware Engineer Intern")


def test_dedup_key_is_word_order_insensitive_for_role():
    # feeds title the same job in different word order -- "Software Engineer
    # Associate" (jobnotifier) vs "Associate Software Engineer" (tracker).
    assert dedup_key("Relay", "Software Engineer Associate - Embedded Development") == \
           dedup_key("Relay", "Associate Software Engineer, Embedded Development")
    assert dedup_key("Danaher", "Software Engineer Intern - ICE Software Platform") == \
           dedup_key("Danaher", "ICE Software Platform - Intern, Software Engineer")
    # but a seniority/level word still keeps them apart
    assert dedup_key("Acme", "Senior Software Engineer") != dedup_key("Acme", "Software Engineer")
    assert dedup_key("Acme", "Software Engineer II") != dedup_key("Acme", "Software Engineer III")


def test_dedup_key_unifies_engineer_and_engineering():
    # jobright titles "Firmware Engineering INTERN", jobnotifier "Firmware
    # Engineer Intern" -- same Microsoft req, must group.
    assert dedup_key("Microsoft", "Firmware Engineering Intern") == \
           dedup_key("Microsoft", "Firmware Engineer Intern")


def test_dedup_key_strips_trailing_req_id_parens():
    # applications rows carry the ATS req id: "Hardware Engineering Intern
    # (200053349)", "SDE Intern, Robotics - 2027 (ID: 10529525)".
    base = dedup_key("Microsoft", "Hardware Engineer Intern")
    assert dedup_key("Microsoft", "Hardware Engineering Intern (200053349)") == base
    assert dedup_key("Microsoft", "Hardware Engineering Intern (Job 200053349)") == base
    amzn = dedup_key("Amazon", "Software Development Engineer Intern - Robotics")
    assert dedup_key("Amazon", "Software Development Engineer Intern, Robotics - 2027 (ID: 10529525)") == amzn


def test_dedup_key_strips_alphanumeric_req_ids():
    # NVIDIA (2026-10-04): the applications row carries a letter-prefixed
    # req id -- "2027 Internships: Hardware Engineering (JR2023508)" -- that
    # the old bare-digit-only strip (\b\d{4,}\b) never matched, since
    # "jr2023508" has no \w/\W boundary between the letters and digits.
    # This let a real duplicate -- a user had already applied to this exact req on
    # 2026-08-19 -- resurface as a fresh pick two months later.
    base = dedup_key("NVIDIA", "2027 Internships: Hardware Engineering")
    assert dedup_key("NVIDIA", "2027 Internships: Hardware Engineering (JR2023508)") == base
    assert dedup_key("NVIDIA", "2027 Internships: Software Engineering (JR2023495)") == \
        dedup_key("NVIDIA", "2027 Internships: Software Engineering")


def test_dedup_key_strips_role_words_that_just_repeat_the_company_name():
    # NVIDIA (2026-10-04): the real posting's own title restates the company
    # name ("NVIDIA 2027 Internships: Hardware Engineering"), but the
    # applications row (logged without it) does not -- that lone extra word
    # was enough to keep an exact-match word-set comparison from ever
    # lining up, on top of the req-id mismatch above.
    assert dedup_key("NVIDIA", "NVIDIA 2027 Internships: Hardware Engineering") == \
        dedup_key("NVIDIA", "2027 Internships: Hardware Engineering (JR2023508)")


def test_external_id_from_url_strips_query_and_slash():
    assert external_id_from_url("https://jobright.ai/jobs/abc123?ref=x") == "abc123"
    assert external_id_from_url("https://jobright.ai/p/xyz/") == "xyz"


def test_jobposting_is_a_jobcard():
    p = JobPosting(
        source="swelist", external_id="1", url="u", company="Acme", role="SWE Intern",
        location="Example City, EX", salary_hint="", posted_at="",
        description="full text", employment_type_hint="Internship", requirements_text="",
    )
    assert isinstance(p, JobCard)
    assert p.description == "full text"
