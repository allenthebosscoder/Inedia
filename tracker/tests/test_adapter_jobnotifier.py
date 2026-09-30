from jobscan.adapters.base import JobCard
from jobscan.adapters.jobnotifier import _posting

CARD = JobCard(source="jobnotifier", external_id="1", url="https://example.com/job/1",
                company="Chamberlain Group", role="Software Engineer 1 Intern - Middleware",
                location="Oak Brook, IL", salary_hint="", posted_at="")


def test_posting_prefers_the_real_jd_title_when_from_api():
    # Chamberlain Group (2026-09-30): jobnotifier's own card title dropped
    # the disqualifying "(Intern Conversion)" suffix that the real Workday
    # posting's own title carries -- the from_api path (detail_fetch's
    # _assemble(), which always puts the real title as the JD's first line)
    # must be trusted over the aggregator's paraphrase.
    desc = ("Software Engineer 1, Middleware (Intern Conversion)\n"
            "Location: Oak Brook, IL\nChamberlain Group is a global leader "
            "in intelligent access.")
    posting = _posting(CARD, desc, from_api=True)
    assert posting.role == "Software Engineer 1, Middleware (Intern Conversion)"


def test_posting_keeps_card_title_when_not_from_api():
    # A raw browser body scrape isn't run through _assemble() -- its first
    # line is whatever the page happens to render first, not a title, so
    # trusting it would reintroduce the nav-chrome-as-title bug.
    desc = "Skip to main content\nSome unrelated page chrome."
    posting = _posting(CARD, desc, from_api=False)
    assert posting.role == "Software Engineer 1 Intern - Middleware"
