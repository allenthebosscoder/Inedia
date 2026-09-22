"""Rough 0-100 heuristic. Only used to bound how many survivors Claude
hand-reviews; Claude sets the final rank. Salary is not an input."""
from __future__ import annotations

import datetime
import re

from jobscan import criteria
from jobscan.adapters.base import JobPosting
from jobscan.hardfilter import resolve_term

_HW_HINTS = ["embedded", "firmware", "hardware", "ece", "electrical", "fpga", "asic", "rtl", "pcb"]


def _posting_age_days(posted_at: str, today: datetime.date) -> int | None:
    """Age in days from an ISO date OR a Workday-style relative string
    ("Posted Today", "Posted 5 Days Ago", "Posted 30+ Days Ago",
    "Posted 2 Months Ago"). None if unparseable."""
    s = (posted_at or "").strip().lower()
    if not s:
        return None
    if "today" in s or "just posted" in s:
        return 0
    if "yesterday" in s:
        return 1
    m = re.search(r"(\d+)\s*\+?\s*(day|week|month|year)s?\s+ago", s)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        return n * {"day": 1, "week": 7, "month": 30, "year": 365}[unit]
    try:
        return (today - datetime.date.fromisoformat(posted_at[:10])).days
    except ValueError:
        return None


def _kw_hits(text: str) -> int:
    low = text.lower()
    return sum(1 for kw in criteria.INTEREST_KEYWORDS if kw in low)


def score(posting: JobPosting, today: datetime.date | None = None) -> int:
    today = today or datetime.date.today()
    total = 0

    total += min(_kw_hits(posting.role) * 6, 30)
    total += min(_kw_hits(posting.description) * 2, 20)

    term = resolve_term(posting, today)
    if term.startswith("Summer") or term == "New Grad":
        total += 25
    elif term == "Unknown":
        total += 5

    if any(h in posting.role.lower() for h in _HW_HINTS):
        total += 15

    age = _posting_age_days(posting.posted_at, today)
    if age is not None:
        if age <= 2:
            total += 10
        elif age <= 7:
            total += 5
        elif age >= 45:
            total -= 20   # likely stale / huge applicant pool
        elif age >= 21:
            total -= 8

    return max(0, min(total, 100))
