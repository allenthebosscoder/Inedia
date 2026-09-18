"""Cheap, title/location-level filter. Runs on a JobCard before opening the
detail page (feed adapters) or on the extracted JobPosting (SWElist)."""
from __future__ import annotations

from jobscan import criteria


def _has_kw(text: str, keywords) -> bool:
    low = text.lower()
    return any(kw in low for kw in keywords)


def prefilter(item) -> str | None:
    role = item.role or ""
    if not criteria.is_us_location(item.location or ""):
        return "prefilter:location"

    role_low = role.lower()
    if _has_kw(role_low, criteria.SENIORITY_EXCLUDE) and not _has_kw(
        role_low, criteria.SENIORITY_BYPASS
    ):
        return "prefilter:seniority"

    if not _has_kw(role_low, criteria.INTEREST_KEYWORDS):
        return "prefilter:role"

    return None
