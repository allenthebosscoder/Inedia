"""my-job-notifier.vercel.app adapter.

The site exposes every listing as JSON at ``/api/jobs`` -- no auth, no
browser -- and each row already carries the real external ATS url
(SmartRecruiters, Workday, Greenhouse, a company careers page, ...). So
``walk_feed`` just fetches that endpoint; there is no per-job detail view
on my-job-notifier itself, so ``extract_detail`` navigates to the external
ATS posting and scrapes that (or reads it over the ATS JSON API via
``fetch_ats_detail`` -- the only path that sees sponsorship / clearance
clauses).

Earlier versions scraped the landing-page DOM. A 2026-09 redesign renamed
every CSS class (``.glass-card`` -> ``.job-card-halo``), dropped the
scraped-timestamp attribute, and hid the full list behind an "Explore"
button that only revealed 6 teaser cards -- ``walk_feed`` silently yielded
nothing. The JSON endpoint is both simpler and redesign-proof.
"""
from __future__ import annotations

import datetime
import json
import urllib.request
from typing import Iterator
from urllib.parse import urlsplit

from jobscan.adapters.base import (
    BlockedError,
    JobCard,
    JobPosting,
    ParseError,
)
from jobscan.detail_fetch import _UA, fetch_ats_detail, looks_blocked, posted_at_from_ats_text

__all__ = ["JobnotifierAdapter", "BlockedError", "ParseError", "parse_jobs", "parse_detail"]

API_URL = "https://my-job-notifier.vercel.app/api/jobs"
MAX_CARDS = 400
MAX_DESCRIPTION_CHARS = 8000
# `country` values seen in the feed: usa / canada / both / other.
_KEEP_COUNTRIES = {"usa", "both", ""}


def feed_url() -> str:
    return "https://my-job-notifier.vercel.app"


def _fetch_api(url: str = API_URL) -> list[dict]:
    req = urllib.request.Request(
        url, headers={"User-Agent": _UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 - fixed https host
        payload = json.loads(r.read().decode("utf-8", "replace"))
    if isinstance(payload, dict):
        return payload.get("jobs") or []
    return payload or []


def _posted_iso(job: dict) -> str:
    ts = job.get("postedTimestamp")
    if isinstance(ts, (int, float)) and ts > 0:
        try:
            return datetime.datetime.fromtimestamp(
                ts, datetime.timezone.utc).date().isoformat()
        except (OverflowError, OSError, ValueError):
            pass
    return ""


def parse_jobs(jobs: list[dict]) -> list[JobCard]:
    """Pure transform of the ``/api/jobs`` rows into JobCards, dropping
    non-US listings and rows missing a usable external url."""
    cards: list[JobCard] = []
    for j in jobs:
        url = (j.get("url") or "").strip()
        title = (j.get("title") or "").strip()
        company = (j.get("company") or "").strip()
        if not (url.startswith("http") and title and company):
            continue
        if (j.get("country") or "").strip().lower() not in _KEEP_COUNTRIES:
            continue
        cards.append(JobCard(
            source="jobnotifier",
            external_id=(j.get("id") or url).strip(),
            url=url,
            company=company,
            role=title,
            location=j.get("location", "") or "",
            salary_hint="",
            posted_at=_posted_iso(j),
        ))
    return cards


class JobnotifierAdapter:
    source = "jobnotifier"
    # extract_detail navigates to the external ATS posting, independent of
    # any feed page -- safe to run on run.py's separate detail_page.
    uses_separate_detail_page = True

    def feed_url(self) -> str:
        return feed_url()

    def walk_feed(self, page, is_seen=lambda key: False) -> Iterator[JobCard]:
        try:
            jobs = _fetch_api()
        except Exception as e:  # noqa: BLE001 - surfaced as a feed error in run.py
            raise ParseError(f"jobnotifier /api/jobs fetch failed: {e!r}") from e

        emitted = 0
        for card in parse_jobs(jobs):
            if emitted >= MAX_CARDS:
                return
            if is_seen(f"{card.source}:{card.external_id}"):
                continue
            emitted += 1
            yield card

    def extract_detail(self, page, card: JobCard) -> JobPosting:
        # A recognized ATS (Workday / Greenhouse / Oracle Cloud, incl. via a
        # simplify.jobs link) gives a clean JD + the application-questions
        # block over plain HTTP -- no browser, and it's the only path that
        # sees sponsorship / clearance clauses. Fall back to the rendered
        # page only when that doesn't pan out.
        api_text = fetch_ats_detail(card.url)
        if api_text and not looks_blocked(api_text):
            return _posting(card, api_text)
        return parse_detail_via_goto(page, card)


def _posting(card: JobCard, description: str) -> JobPosting:
    # The jobnotifier card's timestamp is when *it* scraped the listing, not
    # when the job was posted -- prefer the real posted date the ATS API
    # reports (score.py's stale-posting penalty depends on it).
    posted = posted_at_from_ats_text(description) or card.posted_at
    return JobPosting(
        source=card.source, external_id=card.external_id, url=card.url,
        company=card.company, role=card.role, location=card.location,
        salary_hint=card.salary_hint, posted_at=posted,
        description=description[:MAX_DESCRIPTION_CHARS],
        # my-job-notifier lists both internships and early-career / new-grad
        # roles now -- leave the type to resolve_term / hardfilter to read
        # off the title + JD rather than forcing "Internship".
        employment_type_hint="",
        requirements_text="",
    )


def parse_detail(page, card: JobCard) -> JobPosting:
    description = _text(page.query_selector("body"))
    if looks_blocked(description):
        api_text = fetch_ats_detail(card.url)
        if api_text and not looks_blocked(api_text):
            description = api_text
        else:
            raise BlockedError(f"blocked:{urlsplit(card.url).netloc or card.url}")
    return _posting(card, description)


def parse_detail_via_goto(page, card: JobCard) -> JobPosting:
    page.goto(card.url, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(1500)
    return parse_detail(page, card)


def _text(el) -> str:
    return (el.inner_text() if el else "").strip()
