"""Direct per-company Workday scrape.

jobright / runway / jobnotifier / swelist only surface what the
aggregators happen to carry -- Marvell has ~19 intern reqs on its Workday,
the aggregators showed 5. Workday's search API (``POST
/wday/cxs/{tenant}/{site}/jobs``) is unauthenticated and returns the full
list. This adapter walks a hand-picked set of hardware / semiconductor
companies that sponsor and post on Workday, keeping only early-career
titles. Detail comes from the existing ``fetch_ats_detail`` Workday path.

Add a company: append ``(host, tenant, site, "Display Name")`` to TARGETS
after confirming ``curl -X POST https://{host}/wday/cxs/{tenant}/{site}/jobs
-d '{"appliedFacets":{},"limit":1,"offset":0,"searchText":"intern"}'``
returns 200 with a ``total``.
"""
from __future__ import annotations

import json
import re
import urllib.request
from typing import Iterator

from jobscan.adapters.base import BlockedError, JobCard, JobPosting
from jobscan.detail_fetch import _UA, fetch_ats_detail, looks_blocked

# (host, tenant, site, display name). Confirmed 200 on 2026-09-06 --
# add more per the module docstring.
TARGETS: list[tuple[str, str, str, str]] = [
    ("globalfoundries.wd1.myworkdayjobs.com", "globalfoundries", "External", "GlobalFoundries"),
    ("micron.wd1.myworkdayjobs.com", "micron", "External", "Micron Technology"),
    ("nxp.wd3.myworkdayjobs.com", "nxp", "careers", "NXP Semiconductors"),
]

_EARLY = re.compile(r"\b(intern(ship)?|co-?op|new\s*grad(uate)?|university\s+grad(uate)?|"
                    r"early\s+career|rotational?\s+program|apprentice)\b", re.I)
_SENIOR = re.compile(r"\b(senior|staff|principal|lead|manager|director|architect|"
                     r"sr\.?|II?I|IV|V)\b", re.I)

_MAX_PER_COMPANY = 120
_PAGE = 20


def _is_early_career(title: str) -> bool:
    return bool(_EARLY.search(title or "")) and not _SENIOR.search(title or "")


def job_url(host: str, site: str, external_path: str) -> str:
    """The human posting URL. `externalPath` from the search API is
    site-relative (`/job/<loc>/<slug>_<id>`); the site segment must be put
    back so detail_fetch.workday_api_url can derive the cxs API URL."""
    return f"https://{host}/{site}{external_path}"


def _post(host: str, tenant: str, site: str, offset: int) -> dict | None:
    body = json.dumps({"appliedFacets": {}, "limit": _PAGE, "offset": offset,
                       "searchText": "intern"}).encode()
    req = urllib.request.Request(
        f"https://{host}/wday/cxs/{tenant}/{site}/jobs", data=body, method="POST",
        headers={"User-Agent": _UA, "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310 - fixed https host
            return json.loads(r.read().decode("utf-8", "replace")) if r.status == 200 else None
    except Exception:  # noqa: BLE001
        return None


def _cards_from_search(payload: dict, host: str, company: str, site: str = "External") -> list[JobCard]:
    cards: list[JobCard] = []
    for j in (payload or {}).get("jobPostings", []):
        title = (j.get("title") or "").strip()
        path = j.get("externalPath") or ""
        if not (title and path and _is_early_career(title)):
            continue
        cards.append(JobCard(
            source="company-wd",
            external_id=path.rsplit("/", 1)[-1],
            url=job_url(host, site, path),
            company=company,
            role=title,
            location=j.get("locationsText", ""),
            salary_hint="",
            posted_at=j.get("postedOn", ""),
        ))
    return cards


def _walk_company(host: str, tenant: str, site: str, company: str,
                  is_seen) -> Iterator[JobCard]:
    offset = 0
    while offset < _MAX_PER_COMPANY:
        payload = _post(host, tenant, site, offset)
        if not payload:
            return
        batch = _cards_from_search(payload, host, company, site)
        for card in batch:
            if not is_seen(f"{card.source}:{card.external_id}"):
                yield card
        got = len(payload.get("jobPostings", []))
        if got < _PAGE or offset + got >= (payload.get("total") or 0):
            return
        offset += _PAGE


class CompanyWorkdayAdapter:
    source = "company-wd"
    uses_separate_detail_page = True

    def feed_url(self) -> str:
        return "workday-direct"

    def walk_feed(self, page, is_seen=lambda key: False) -> Iterator[JobCard]:
        for host, tenant, site, company in TARGETS:
            yield from _walk_company(host, tenant, site, company, is_seen)

    def extract_detail(self, page, card: JobCard) -> JobPosting:
        text = fetch_ats_detail(card.url, card.company)
        if not text or looks_blocked(text):
            raise BlockedError(f"blocked:{card.url}")
        from jobscan.detail_fetch import posted_at_from_ats_text
        return JobPosting(
            source=card.source, external_id=card.external_id, url=card.url,
            company=card.company, role=card.role, location=card.location,
            salary_hint="", posted_at=posted_at_from_ats_text(text) or card.posted_at,
            description=text[:12000], employment_type_hint="", requirements_text="",
        )
