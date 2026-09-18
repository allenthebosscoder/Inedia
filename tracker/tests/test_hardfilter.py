import datetime
from jobscan.adapters.base import JobPosting
from jobscan.hardfilter import hardfilter, resolve_term

TODAY = datetime.date(2026, 9, 2)


def posting(desc="", role="Firmware Engineer Intern", etype="Internship", reqs=""):
    return JobPosting(
        source="jobright", external_id="1", url="u", company="Acme", role=role,
        location="Austin, TX", salary_hint="", posted_at="",
        description=desc, employment_type_hint=etype, requirements_text=reqs,
    )


def test_clean_posting_passes():
    assert hardfilter(posting(desc="Great summer internship for ECE students."), today=TODAY) is None


def test_drops_no_sponsorship():
    assert hardfilter(posting(desc="We do not sponsor visas for this role."), today=TODAY) == "no-sponsorship"
    assert hardfilter(posting(desc="Candidates must be a U.S. Citizen."), today=TODAY) == "no-sponsorship"


def test_drops_no_sponsorship_form_field_and_indirect_phrasings():
    # Real phrasings the daily scan surfaced past the filter (2026-09-05):
    # Solidigm, PayPal, Boston Scientific, Flex, Corning, DriveTime, Barclays, HP.
    for desc in [
        "This role is not eligible for candidates requiring VISA sponsorship.",
        "Visa Sponsorship through PayPal is not available for this position.",
        "Boston Scientific will not offer sponsorship or take over sponsorship "
        "of an employment VISA for this position at this time.",
        "Is Sponsorship Available?  No  Flex is an Equal Opportunity Employer.",
        "This position does not support immigration sponsorship.",
        "This is not a position for which sponsorship will be provided. "
        "Individuals who need sponsorship now or in the future are not eligible.",
        "Barclays will not offer or consider offering sponsorship for work visas.",
        "Candidates must not require work authorization sponsorship in the future.",
        # phrasings Allen surfaced 2026-09-08 that the JD-text filter still missed
        "We are not providing visa sponsorship for this role.",
        "We are not currently providing sponsorship for this position.",
        "Applicants must be authorized to work in the U.S. on a permanent basis.",
        "You must have permanent work authorization in the United States.",
        "Candidates must be permanent residents or U.S. citizens.",
        "This position is not open to candidates requiring sponsorship.",
        # Motorola (2026-09-09): the "unrestricted work authorization" screen
        "You are a U.S. Citizen, U.S. permanent resident or possess other "
        "unrestricted US work authorization.",
        # John Deere (2026-09-10)
        "This position is not available to students on immigration visas.",
        # Allegion (2026-09-10)
        "The company does not intend to provide sponsorship for employment "
        "visa status (e.g., H-1B, TN, etc.) for this position.",
        # Tanium (2026-09-11) -- "now and in the future" implies no future
        # sponsorship need even with no literal "sponsor" nearby.
        "Authorized to work in the U.S. now and in the future.",
    ]:
        assert hardfilter(posting(desc=desc), today=TODAY) == "no-sponsorship", desc


def test_sponsorship_available_is_not_dropped():
    for desc in [
        "Visa sponsorship is available for this role.",
        "Is Sponsorship Available?  Yes",
        "We are happy to sponsor visas for exceptional candidates.",
        "Our company has proudly sponsored hundreds of work visas.",
        "Candidates requiring sponsorship are encouraged to apply.",
    ]:
        assert hardfilter(posting(desc=desc), today=TODAY) is None, desc


def test_drops_clearance():
    assert hardfilter(posting(desc="Active security clearance required."), today=TODAY) == "clearance"


def test_drops_phd_required():
    assert hardfilter(posting(desc="PhD in EE is required."), today=TODAY) == "degree"


def test_masters_preferred_not_dropped():
    assert hardfilter(posting(desc="Master's degree preferred but not required."), today=TODAY) is None


def test_drops_bachelors_tier_that_requires_prior_experience():
    # KLA (2026-09-11): the Bachelor's tier needs 2 years Allen won't have.
    for d in ["Master's Level Degree and 0 years related work experience; "
              "Bachelor's Level Degree and related work experience of 2 years",
              "Bachelor's degree and 3 years of related work experience"]:
        assert hardfilter(posting(desc=d + " " * 200)) == "experience", d
    # a 0-years Bachelor's tier is fine
    assert hardfilter(posting(desc="Bachelor's degree and 0 years of experience"
                                    " required." + " x" * 200)) is None
    # a loose, unrelated mention of "years" must not false-positive
    assert hardfilter(posting(desc="Bachelor's degree required. Our team has 10 years "
                                    "of combined industry experience." + " x" * 200)) is None


def test_drops_grad_window_entirely_before_allens_earliest_grad():
    # General Motors (2026-09-11): wants someone who already graduated --
    # Allen's earliest possible grad is May 2027, after this window ends.
    for d in ["Degree completed between December 2025 and August 2026, "
              "with availability to begin employment in 2026.",
              "Graduation between December 2025 and August 2026, with "
              "availability to begin employment in 2026."]:
        assert hardfilter(posting(role="Software Engineer - Early Career", desc=d + " " * 200)
                          ) == "grad-window", d


def test_grad_window_overlapping_allens_earliest_grad_is_not_dropped():
    assert hardfilter(posting(desc="Degree completed between January 2027 and "
                                    "August 2027." + " x" * 200)) is None


def test_drops_grad_only_role_title_even_with_no_degree_text_in_body():
    # Intel (2026-09-11): "AI Software Engineering PhD Intern" -- the JD body
    # never mentions a degree requirement at all, only the title does.
    p = posting(role="AI Software Engineering PhD Intern",
                desc="Job Description: contribute to AI infrastructure. " * 15)
    assert hardfilter(p, today=TODAY) == "degree"
    for role in ["Research Intern - Master's", "Doctoral Research Intern"]:
        assert hardfilter(posting(role=role, desc="Build things. " * 20),
                          today=TODAY) == "degree", role
    # BS/MS/PhD in the title means undergrads ARE eligible -- must not drop
    for role in ["Software Engineer Intern (BS/MS/PhD)",
                 "Research Intern - Bachelor's, Master's, or PhD"]:
        assert hardfilter(posting(role=role, desc="Build things. " * 20),
                          today=TODAY) is None, role


def test_drops_grad_only_title_hidden_in_body_first_line_not_role():
    # Same Intel req (JR0286730), different scrape/job_key (2026-09-11 pick
    # #429): the stored `role` field is a generic re-label ("AI Software
    # Engineer Intern - Artificial Intelligence") with no "PhD" in it, but
    # the JD body's own first line -- the ATS's real embedded title, always
    # line 1 per detail_fetch._assemble() -- says "AI Software Engineering
    # PhD Intern". role-only title check misses this; must also check body.
    p = posting(role="AI Software Engineer Intern - Artificial Intelligence",
                desc="AI Software Engineering PhD Intern\n"
                     "Location: US, Arizona, Phoenix\n"
                     "Job Description: contribute to AI infrastructure. " * 15)
    assert hardfilter(p, today=TODAY) == "degree"


def test_drops_currently_pursuing_a_masters_or_phd():
    # Real NXP "Embedded ML & Radar Processing Intern" phrasing -- grad-only,
    # no "required"/"must", never mentions a Bachelor's.
    desc = ("Strong programming skills in C, C++. Excellent communication skills. "
            "Currently pursuing a Master's or Ph.D. degree in Electrical Engineering, "
            "Computer Engineering, Computer Science, Robotics, or a related field. "
            "You must be returning to school at the conclusion of the internship.")
    assert hardfilter(posting(desc=desc), today=TODAY) == "degree"


def test_drops_ms_with_experience_or_fresh_phd():
    # Nokia (2026-09-11): "M.S. with 3 years of experience or fresh Ph.D. in
    # EE, Physics or related fields." -- no Bachelor's tier at all, either
    # graduate-degree order.
    desc = "M.S. with 3 years of experience or fresh Ph.D. in EE, Physics or related fields."
    assert hardfilter(posting(desc=desc), today=TODAY) == "degree"
    desc2 = "Fresh Ph.D. or M.S. with 3+ years of experience in EE or Physics."
    assert hardfilter(posting(desc=desc2), today=TODAY) == "degree"


def test_pursuing_bachelors_or_masters_not_dropped():
    # BS-eligible: a Bachelor's is explicitly acceptable alongside the grad degree.
    for d in ("Currently pursuing a Bachelor's, Master's, or PhD in Computer Science.",
              "Enrolled in a BS or MS program in Electrical Engineering.",
              "Pursuing a Master's degree; a Bachelor's in a related field is also accepted."):
        assert hardfilter(posting(desc=d), today=TODAY) is None, d


def test_drops_fall_only_internship():
    p = posting(desc="This is a Fall 2026 internship, no summer option.")
    assert hardfilter(p, today=TODAY) == "term:off-season"


def test_drops_winter_internship_by_start_month():
    p = posting(desc="Internship starting in January 2027, running through June.")
    assert hardfilter(p, today=TODAY) == "term:off-season"


def test_drops_spring_coop():
    p = posting(role="Software Engineering Co-op",
                desc="Spring 2027 co-op term for undergraduates.")
    assert hardfilter(p, today=TODAY) == "term:off-season"


def test_unclear_term_internship_is_kept():
    # no summer signal AND no off-season signal -> kept, Claude judges
    p = posting(desc="Internship working on embedded systems and firmware.")
    assert hardfilter(p, today=TODAY) is None


def test_spring_summer_internship_is_kept():
    p = posting(desc="Spring/Summer 2027 internship available in our robotics lab.")
    assert hardfilter(p, today=TODAY) is None


def test_drops_past_summer():
    pad = " x" * 120
    # explicit past summer (today is Sept 2026) -> dropped
    assert hardfilter(posting(desc="Summer 2026 internship for ECE students." + pad),
                      today=TODAY) == "term:past"
    assert hardfilter(posting(role="Software Engineer Intern - Summer 2026", desc=pad),
                      today=TODAY) == "term:past"
    # a future summer is fine
    assert hardfilter(posting(desc="Summer 2027 internship." + pad), today=TODAY) is None
    # an undated "summer internship" scanned in Sept resolves to next year, not past
    assert hardfilter(posting(desc="A summer internship for students." + pad), today=TODAY) is None
    # boundary: still fine in May of that year
    assert hardfilter(posting(desc="Summer 2026 internship." + pad),
                      today=datetime.date(2026, 5, 1)) is None


def test_resolve_term_off_season():
    assert resolve_term(posting(desc="Fall 2026 internship, no summer option."),
                        today=TODAY) == "Off-season"


def test_resolve_term_summer():
    assert resolve_term(posting(desc="Summer 2027 internship"), today=TODAY) == "Summer 2027"


def test_resolve_term_new_grad_fulltime():
    p = posting(role="Software Engineer, New Grad", etype="Full-time",
                desc="Join our team full time.")
    assert resolve_term(p, today=TODAY) == "New Grad"


def test_resolve_term_unknown():
    assert resolve_term(posting(desc="An internship."), today=TODAY) == "Unknown"


def test_resolve_term_reads_schedule_phrasing_as_off_season():
    # Real Tesla-via-simplify.jobs phrasings the keyword list missed.
    for desc in [
        "This position is expected to start around January or February 2027 and "
        "continue through the entire Spring term (ending approximately May 2027).",
        "The internship runs January 2027 through April 2027.",
        "You will join us for the Spring term.",
        "Expected to start in March 2027, continuing through May 2027.",
    ]:
        assert resolve_term(posting(desc=desc), today=TODAY) == "Off-season", desc
        assert hardfilter(posting(desc=desc), today=TODAY) == "term:off-season", desc


def test_resolve_term_summer_month_start_is_still_summer():
    assert resolve_term(posting(desc="Internship starting June 2027 for 12 weeks."),
                        today=TODAY) == "Summer 2027"


def test_resolve_term_explicit_offseason_start_beats_a_passing_summer_mention():
    # Real EquipmentShare posting: the internship IS Fall 2026; "Summer 2027"
    # is only a maybe-extension and must not make it read as a Summer role.
    p = posting(desc="EquipmentShare is searching for a student intern to join the "
                     "Engineering Team at our Home Office in Columbia, MO for the "
                     "Fall of 2026 (with potential to extend into Spring 2027 and "
                     "Summer 2027).")
    assert resolve_term(p, today=TODAY) == "Off-season"
    assert hardfilter(p, today=TODAY) == "term:off-season"


def test_resolve_term_month_range_start():
    # GE Vernova: "Internship Term Dates: Jan - Aug 2027" -- a Jan-start
    # co-op, off-cycle for an enrolled undergrad.
    for desc in ["Internship Term Dates: Jan - Aug 2027",
                 "The co-op runs January to August 2027.",
                 "Program dates: Feb - July 2027"]:
        assert resolve_term(posting(desc=desc), today=TODAY) == "Off-season", desc
    # A May/June start is still Summer.
    assert resolve_term(posting(desc="Internship dates: May - August 2027"), today=TODAY) == "Summer 2027"


def test_resolve_term_two_digit_and_apostrophe_year_semester():
    # Ryobi/TTI: "able to intern during the Fall 26' semester".
    for desc in ["Candidates must be local and able to intern during the Fall 26' semester.",
                 "This is a Spring '27 semester co-op.",
                 "Join us for the Fall 2026 semester."]:
        assert resolve_term(posting(desc=desc), today=TODAY) == "Off-season", desc


def test_resolve_term_winter_in_title_beats_generic_summer_in_jd():
    # Real Vercel (jobright): title "Software Engineering Intern - Winter '27",
    # description "Start in 2027 Winter" -- the shared Vercel JD also mentions
    # a Summer cohort, which must NOT win over the title.
    p = posting(role="Software Engineering Intern - Winter '27",
                desc="Start in 2027 Winter. Vercel also runs a Summer 2027 cohort. "
                     + "We build agentic infra. " * 20)
    assert resolve_term(p, today=TODAY) == "Off-season"
    assert hardfilter(p, today=TODAY) == "term:off-season"
    # and the reversed year-season order in body text alone
    assert resolve_term(posting(desc="This internship is scheduled to start in 2027 Winter."
                                     + " x" * 300), today=TODAY) == "Off-season"
    # apostrophe-summer still reads as Summer
    assert resolve_term(posting(role="Software Engineering Intern - Summer '27",
                                desc="A summer internship." + " x" * 100),
                        today=TODAY).startswith("Summer")


def test_resolve_term_schedule_phrasing_no_false_positives():
    # "graduating Fall of 2027" is a grad-date requirement, not the term.
    # "Spring, Summer, or Fall term" is a list of what's offered.
    # "12 weeks, full-time" has no signal at all.
    for desc in [
        "Requirements: Graduating in the Fall of 2027 or the Spring of 2028, BS in CS.",
        "We hire interns for the Spring, Summer, or Fall term each year.",
        "Internships are 12 weeks, full-time and on-site.",
        "Ideal candidates are graduating Winter '27 or later.",  # grad date, not term
        "Our summer internship may start in early June and run through the Spring term the following year.",
    ]:
        assert resolve_term(posting(desc=desc), today=TODAY) in ("Unknown", "Summer 2027"), desc


def test_degree_not_required_is_not_dropped():
    assert hardfilter(posting(desc="Master's is not required, but a Bachelor's is required."), today=TODAY) is None
    assert hardfilter(posting(desc="A PhD is not required for this position."), today=TODAY) is None
    assert hardfilter(posting(desc="A PhD in EE is not required for this role."), today=TODAY) is None
    assert hardfilter(posting(desc="Master's in a related field is not required."), today=TODAY) is None


def test_phd_in_field_required_is_dropped():
    assert hardfilter(posting(desc="PhD in Computer Science is required."), today=TODAY) == "degree"


def test_bare_grad_degree_bullet_under_minimum_qualifications_is_dropped():
    # Silicon Labs (2026-09-16): "Minimum Qualifications   Master's degree
    # in Electrical Engineering, Computer Engineering, or a related
    # technical field." -- no "required"/"must"/"pursuing" verb at all,
    # just a bare degree bullet listed right under a "Minimum
    # Qualifications" header. None of the existing DEGREE_NEGATIVE
    # patterns need a requiring verb to catch a hit like this.
    desc = ("Skills You Need Minimum Qualifications Master's degree in "
            "Electrical Engineering, Computer Engineering, or a related "
            "technical field. " + "Strong interest in embedded software. " * 10)
    assert hardfilter(posting(desc=desc), today=TODAY) == "degree"


def test_word_ending_in_ms_before_required_is_not_a_degree_match():
    # Neuralink (2026-09-12): "m\.?s\.?" in the first DEGREE_NEGATIVE pattern
    # had no leading \b, so it matched the tail "ms" of an ordinary word
    # (systems, platforms, mechanisms, ...) whenever "required" followed
    # within the pattern's gap -- false-positive dropping a clean posting
    # that never mentions a Master's at all.
    for desc in [
        "You will design and integrate custom electronics systems.\n"
        "Required Qualifications:\nDemonstrable experience with circuit design. " * 3,
        "Familiarity with embedded platforms is required for this role. " * 5,
        "Experience debugging control mechanisms is required. " * 5,
    ]:
        assert hardfilter(posting(desc=desc), today=TODAY) is None, desc


def test_negation_in_other_section_does_not_rescue_degree():
    # hardfilter joins description + "\n" + requirements_text; a "a plus" in the
    # description tail must not suppress a degree requirement in requirements_text.
    p = posting(
        desc="Responsibilities: build firmware. Experience with Python is a plus.",
        reqs="A Master's or PhD is required.",
    )
    assert hardfilter(p, today=TODAY) == "degree"


def test_same_line_negation_still_rescues_degree():
    p = posting(desc="", reqs="A Master's degree is required, or equivalent experience.")
    assert hardfilter(p, today=TODAY) is None


def test_role_title_off_season_wins_over_generic_description_boilerplate():
    # Real bug (found 2026-09-05 during a live ranking pass): Tesla titles
    # its reqs per-term e.g. "(Winter/Spring 2027)", but the description is
    # shared boilerplate that also mentions "Summer" as one of several terms
    # Tesla offers in general. The title is specific to THIS req and must win.
    p = posting(
        role="Internship, Embedded Systems Software Engineer, AI Platforms (Winter/Spring 2027)",
        desc=("Interns typically start January 2027 and continue through Spring term "
              "(ending approximately May 2027) or continuing into Summer 2027 if "
              "available and there is an opportunity to do so."),
    )
    assert resolve_term(p, today=TODAY) == "Off-season"
    assert hardfilter(p, today=TODAY) == "term:off-season"


def test_role_title_summer_wins_even_with_generic_description_boilerplate():
    p = posting(
        role="Software Engineering Intern (Summer 2027)",
        desc=("Internships at our company are offered in Fall, Winter, "
              "Spring, and Summer terms depending on team needs."),
    )
    assert resolve_term(p, today=TODAY) == "Summer 2027"


def test_falls_back_to_full_text_when_role_title_has_no_term():
    p = posting(role="Software Engineer Intern", desc="This is a Summer 2027 internship program.")
    assert resolve_term(p, today=TODAY) == "Summer 2027"


def test_no_clearance_required_is_not_dropped():
    # documented gap: "No security clearance is required" was dropped as
    # `clearance` -- the negation ("No ...") precedes the match instead of
    # following it the way "not required" does for degree.
    assert hardfilter(posting(desc="No security clearance is required for this role.")) is None
    assert hardfilter(posting(desc="This position does not require a security clearance.")) is None


def test_clearance_still_drops_when_genuinely_required():
    assert hardfilter(posting(desc="Active security clearance required.")) == "clearance"
    assert hardfilter(posting(desc="Must be able to obtain a TS/SCI clearance.")) == "clearance"
    # CACI 2026-09-10: "Willingness and ability to obtain a Top Secret clearance."
    for d in ["Willingness and ability to obtain a Top Secret clearance.",
              "Must obtain and maintain a Secret clearance.",
              "Ability to obtain a Top Secret clearance is required.",
              "This role requires a polygraph.",
              "Eligible to obtain a DoD Secret clearance."]:
        assert hardfilter(posting(desc=d + " " * 200)) == "clearance", d
    # Valinor 2026-09-10: eligibility is mandatory even though an *active*
    # clearance is "preferred, but not required"
    assert hardfilter(posting(desc=(
        "This role requires the candidate be eligible to obtain and maintain a "
        "U.S. security clearance. Active clearance preferred, but not required. "
        + "Build C2 software. " * 20))) == "clearance"
    # ...but "Minimum Clearance Required to Start: None" alone must NOT drop
    assert hardfilter(posting(
        desc="Minimum Clearance Required to Start: None. " + "Build software. " * 30)) is None
    # ...and a genuine "no clearance required" still passes
    assert hardfilter(posting(
        desc="No security clearance is required for this role. " + "x " * 200)) is None


def test_drops_export_control_us_person_requirement():
    # Acron Aviation (2026-09-14): "This position may require access to
    # information, technology, software, or hardware that is subject to
    # U.S. export control laws and regulations. To comply with these
    # requirements, applicants must qualify as a U.S. Person." -- ITAR/EAR
    # export-control gate, same category as a security clearance: an
    # unambiguous citizenship/status requirement Allen (Singaporean) can't
    # meet, not something that gets rescued by a nearby "not required".
    for d in [
        "This position may require access to information, technology, software, "
        "or hardware that is subject to U.S. export control laws and regulations. "
        "To comply with these requirements, applicants must qualify as a U.S. Person.",
        "Due to export control regulations, applicants must be a U.S. Person as "
        "defined by 22 C.F.R. 120.15.",
        "U.S. Person status is required for this role due to ITAR restrictions.",
    ]:
        # already caught by existing SPONSORSHIP_NEGATIVE patterns (bare
        # "export control"/"itar", "must be a U.S. Person") -- same bucket
        # as "must be a U.S. Citizen": a citizenship/status gate, not a
        # separate category. This test exists to pin that down and catch
        # a regression if those patterns are ever narrowed.
        assert hardfilter(posting(desc=d + " " * 200)) == "no-sponsorship", d


def test_resolve_term_uses_year_from_matched_text_not_today():
    # Scanned in Sept 2026, but the posting explicitly says Summer 2026 --
    # should report that, not guess "Summer 2027" from today's month alone.
    p = posting(desc="This is a Summer 2026 internship, already underway.")
    assert resolve_term(p, today=TODAY) == "Summer 2026"


def test_resolve_term_falls_back_to_month_heuristic_when_no_year_in_text():
    p = posting(role="Summer Intern", desc="Summer internship, no year given.")
    assert resolve_term(p, today=TODAY) == "Summer 2027"


def test_drops_part_time_internships():
    # Allen wants full-time roles. MAHLE: "Weekly Working Hours: 20-25".
    for desc in [
        "Weekly Working Hours: 20-25. Support the electronic controls team.",
        "This is a part-time internship, approximately 15 hours per week.",
        "Commitment: 20 hours/week during the school year.",
        "Hours: up to 25 hrs per week.",
    ]:
        assert hardfilter(posting(desc=desc), today=TODAY) == "part-time", desc


def test_full_time_and_flexible_hours_not_dropped():
    for desc in [
        "This is a full-time, 40 hours per week summer internship.",
        "Interns work 40 hrs/week for 12 weeks.",
        "Part-time or full-time options available (20-40 hours per week).",
        "Full-time employees are eligible for benefits; part-time staff accrue PTO.",
    ]:
        assert hardfilter(posting(desc=desc), today=TODAY) is None, desc


def test_vacation_accrual_example_hours_not_mistaken_for_part_time():
    # DoorDash (2026-09-15): "vacation accrued at about 1 hour for every
    # 25.97 hours worked (e.g. about 6.7 hours/month if working 40
    # hours/week; about 3.4 hours/month if working 20 hours/week)" -- a
    # benefits-accrual illustration using a *hypothetical* 20 hours/week,
    # not the internship's actual schedule. _HOURS_NUM_RX's finditer picked
    # up that standalone "20 hours/week" and dropped an otherwise full-time
    # Summer 2027 posting as part-time.
    desc = ("Software Engineer, Intern (Summer 2027). This is a full-time, 40 "
            "hours per week internship. " + "Build things. " * 20
            + "Vacation is accrued at about 1 hour for every 25.97 hours worked "
            "(e.g. about 6.7 hours/month if working 40 hours/week; about 3.4 "
            "hours/month if working 20 hours/week).")
    assert hardfilter(posting(desc=desc), today=TODAY) is None


def test_drops_when_application_questions_screen_for_clearance():
    from jobscan.detail_fetch import QUESTIONS_HEADER
    # "Clearance Eligibility" as a bare question label -- no "security
    # clearance" phrase for the existing regex to catch.
    desc = ("Summer 2027 embedded software internship. Great team, real hardware.\n\n"
            f"{QUESTIONS_HEADER}\nGPA\nClearance Eligibility\nAcademic Transcript\n"
            "Are you legally authorized to work in the United States?")
    assert hardfilter(posting(desc=desc), today=TODAY) == "clearance"


def test_standard_work_auth_questions_do_not_drop():
    from jobscan.detail_fetch import QUESTIONS_HEADER
    desc = ("Summer 2027 firmware internship building motor controllers.\n\n"
            f"{QUESTIONS_HEADER}\nAre you currently authorized to work in the United States?\n"
            "Will you, at any point, require employer sponsorship to work in the United States?")
    assert hardfilter(posting(desc=desc), today=TODAY) is None


def test_resolve_term_jan_start_beats_conditional_summer_mention():
    # Real Tesla wording: Jan start, Spring term, "continuing into Summer
    # 2027 IF AVAILABLE" -- the summer mention is conditional, not the term.
    for desc in [
        "This position is expected to start January 2027 and continue through "
        "Spring term (ending approximately May 2027) or continuing into Summer "
        "2027 if available and there is an opportunity to do so.",
        "Expected to start January or February 2027 and continue through "
        "Winter/Spring term, or continuing into Summer 2027 if available.",
    ]:
        assert resolve_term(posting(desc=desc), today=TODAY) == "Off-season", desc


def test_drops_citizenship_or_permanent_residency_requirement():
    # TD Bank: "Must have US Citizenship or Permanent Residency status".
    for desc in [
        "Must have US Citizenship or Permanent Residency status.",
        "Applicants must possess U.S. citizenship or permanent residency.",
        "Requires US citizenship or green card.",
        "US citizen (required)",                              # Collier Aerospace, 2026-09-10
        "Work authorization: U.S. Citizen. (Required)",
    ]:
        assert hardfilter(posting(desc=desc + " " * 300), today=TODAY) == "no-sponsorship", desc


def test_drops_export_controlled_hyphenated():
    # Moog (2026-09-09): "This position requires access to U.S. export-controlled
    # information." -- hyphenated form the "export\s+control" pattern missed.
    for desc in [
        "This position requires access to U.S. export-controlled information.",
        "Must be able to access export-controlled technical data (ITAR/EAR).",
    ]:
        assert hardfilter(posting(desc=desc + " " * 300), today=TODAY) == "no-sponsorship", desc


def test_drops_return_offer_conversion_roles():
    # Walmart: "THIS ROLE IS FOR 2026 INTERNS WHO WORKED IN A ROLE THIS SUMMER."
    for desc in [
        "This role is for 2026 interns who worked in a role this summer. "
        "New net roles will open in September.",
        "Open only to current Walmart interns returning for a second term.",
        "This posting is for our 2026 summer interns converting to a fall term.",
    ]:
        assert hardfilter(posting(desc=desc + " " * 200), today=TODAY) == "intern-conversion", desc


def test_drops_non_us_location_from_ats_text():
    from jobscan.detail_fetch import _assemble
    text = _assemble("Software Developer Co-op", "2026-08-01",
                     "Join our team in Winnipeg." + " " * 300, [], location="Winnipeg, MB, Canada")
    assert hardfilter(posting(desc=text), today=TODAY) == "location"
    us = _assemble("SWE Intern", "", "Great role." + " " * 300, [], location="Austin, TX, USA")
    assert hardfilter(posting(desc=us), today=TODAY) is None


def test_drops_uk_location_not_covered_by_existing_hints():
    # TTP (2026-09-12): "Location: Melbourn, England, gb" -- _NON_US_HINTS
    # had "united kingdom"/", uk"/"london" but not "england" or the bare
    # country-code segment "gb", so a UK posting slipped through as clean.
    text = "Location: Melbourn, England, gb\n" + "Great engineering role. " * 40
    assert hardfilter(posting(desc=text), today=TODAY) == "location"


def test_drops_non_us_location_with_no_explicit_location_line():
    # Amazon (Annapurna Labs, Canada) and Lyft (Toronto): the browser-scraped
    # JD text never has a "Location:"-prefixed line at all -- the city/country
    # just appears as its own line near the top, e.g. right under the title.
    # The existing check only looked for "^Location:", so both slipped
    # through as clean even though the role is not US-based.
    for desc in [
        "ML Systems Software Development Engineer Intern, Annapurna Labs - 2027\n\n"
        "Job ID: 10538066 | Amazon Development Centre Canada ULC - K03\n" + "Great role. " * 40,
        "Software Engineer Intern, Machine Learning (Summer 2027)\nToronto, Canada\nID: 111180\n"
        + "Great role. " * 40,
    ]:
        assert hardfilter(posting(desc=desc), today=TODAY) == "location", desc


def test_drops_non_us_location_buried_past_a_long_nav_menu():
    # Apple (2026-09-15): the location line ("Swindon, England, United
    # Kingdom") sits ~23 lines into the scraped text, after a long run of
    # single-word site-nav chrome (Store/Mac/iPad/.../Search/Back to search
    # results/<role title>). The header scan only checked the first 3 lines,
    # so this slipped through. Nexthop.ai buries its Canada location less
    # deep but on a line with other text ("4220 - Engr SW Canada -
    # Burnaby, British Columbia (Hybrid)"), still past line 3.
    for desc in [
        "Apple\nStore\nMac\niPad\niPhone\nWatch\nVision\nAirPods\nTV & Home\nEntertainment\n"
        "Accessories\nSupport\n0\n+\nCareers at Apple\nWork at Apple\nLife at Apple\nProfile\n"
        "Sign In\nSearch\nBack to search results\nPMU Design Verification Intern\n"
        "Swindon, England, United Kingdom\nHardware\n" + "Great role. " * 40,
        "Privacy Policy\nJob Openings\nSoftware Engineer - Intern\n"
        "4220 - Engr SW Canada - Burnaby, British Columbia (Hybrid)\n\n"
        "Please Note: this position is hybrid/on-site. " + "Great role. " * 40,
    ]:
        assert hardfilter(posting(desc=desc), today=TODAY) == "location", desc


def test_drops_must_be_local_roles():
    # Dynamic Catholic: "Candidates must be local for consideration."
    for desc in [
        "This position is located in the Greater Cincinnati area. Candidates must be local for consideration.",
        "Local candidates only; no relocation assistance is provided.",
        "Must be located in the Bay Area. We are not able to consider remote candidates.",
    ]:
        assert hardfilter(posting(desc=desc + " " * 200), today=TODAY) == "local-only", desc


def test_relocation_offered_is_not_local_only():
    assert hardfilter(posting(desc="Relocation assistance is available for this role. " * 8), today=TODAY) is None
