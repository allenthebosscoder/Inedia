import datetime
from jobscan.adapters.base import JobPosting
from jobscan.score import score

TODAY = datetime.date(2026, 9, 2)


def p(role, desc="", posted_at="", etype="Internship"):
    return JobPosting("jobright", "1", "u", "Acme", role, "Austin, TX", "", posted_at,
                      desc, etype, "")


def test_summer_ece_intern_outranks_generic_unknown_swe():
    strong = p("Embedded Firmware Engineer Intern",
               "Summer 2027 internship working on RTOS and microcontrollers", "2026-09-01")
    weak = p("Software Engineer Intern", "Build web features.")
    assert score(strong, TODAY) > score(weak, TODAY)


def test_score_is_bounded():
    maxed = p("Embedded Hardware Firmware ECE FPGA Engineer Intern",
              "embedded firmware hardware fpga rtl pcb analog " * 10 + " summer 2027",
              "2026-09-02")
    assert 0 <= score(maxed, TODAY) <= 100


def test_fall_spring_gets_no_term_bonus():
    fall = p("Firmware Intern", "Fall 2026 internship")
    unknown = p("Firmware Intern", "An internship")
    assert score(unknown, TODAY) > score(fall, TODAY)


def test_stale_posting_scores_below_a_fresh_one():
    fresh = p("Electrical Engineer Intern", "Summer 2027 embedded role", "2026-09-01")
    stale = p("Electrical Engineer Intern", "Summer 2027 embedded role", "2026-07-15")
    assert score(fresh, TODAY) > score(stale, TODAY)


def test_posted_relative_string_is_parsed():
    from jobscan.score import _posting_age_days
    assert _posting_age_days("Posted Today", TODAY) == 0
    assert _posting_age_days("Posted Yesterday", TODAY) == 1
    assert _posting_age_days("Posted 5 Days Ago", TODAY) == 5
    assert _posting_age_days("Posted 30+ Days Ago", TODAY) == 30
    assert _posting_age_days("Posted 2 Months Ago", TODAY) == 60
    assert _posting_age_days("2026-08-26", TODAY) == 7
    assert _posting_age_days("", TODAY) is None
