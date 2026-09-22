"""Data models and helpers shared by all source adapters."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterator, Protocol
from urllib.parse import urlsplit


@dataclass
class JobCard:
    source: str
    external_id: str
    url: str
    company: str
    role: str
    location: str
    salary_hint: str
    posted_at: str  # ISO date or ""


@dataclass
class JobPosting(JobCard):
    description: str
    employment_type_hint: str
    requirements_text: str


class ParseError(RuntimeError):
    """A detail page loaded but its expected content (e.g. the JD/description
    container) was not in the DOM. run.py routes this to artifact['errors'] and
    does NOT write a terminal seen_jobs row, so the posting is retried next run."""


class BlockedError(ParseError):
    """The detail page could not be read at all -- a bot-wall block page
    (Tesla/Akamai), an ATS outage page, or near-empty content -- and the
    JSON-API fallback didn't cover the host either. run.py buckets this
    separately ("blocked: N" in the summary) but handles it like ParseError:
    no seen_jobs row, retried next run, never a junk candidate."""


def job_key(source: str, external_id: str) -> str:
    return f"{source}:{external_id}"


def external_id_from_url(url: str) -> str:
    path = urlsplit(url).path.rstrip("/")
    return path.rsplit("/", 1)[-1] if path else url


# Trailing noise that varies between how two sources title the same posting:
# "- Summer 2027", "(2027)", "- 2027", "- Req #12345", "(200053349)",
# "(Job 200051878)", "(ID: 10529525)".
_ROLE_NOISE = re.compile(
    r"\s*[-–—(]\s*(?:summer|fall|autumn|spring|winter)\s*20\d\d\b.*$"
    r"|\s*\(\s*20\d\d\s*\)\s*$"
    r"|\s*[-–—]\s*20\d\d\s*$"
    r"|\s*[-–—(]\s*req\.?\s*#?\s*\w+.*$"
    r"|\s*\([^)]*\d[^)]*\)\s*$",
    re.I,
)


def _norm(s: str) -> str:
    s = _ROLE_NOISE.sub("", (s or "").lower().strip())
    s = s.replace("internship", "intern").replace("co-op", "coop").replace("co op", "coop")
    s = s.replace("engineering", "engineer")
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    # Drop 4-digit years and long ATS req/job ids ("200053349", "10529525")
    # -- applications rows carry them, feed titles usually don't, and two
    # postings almost never differ only by such a number.
    s = re.sub(r"\b\d{4,}\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def dedup_key(company: str, role: str) -> str:
    """Cross-source identity for a posting: `"<norm company>|<sorted norm role words>"`.
    jobright and jobright list the same jobs under different source-specific
    ids; this collapses them so an Applied/Deleted pick stays gone. The role
    words are sorted so "Software Engineer Associate" and "Associate Software
    Engineer" (feed vs. tracker word order) match -- a reordered title almost
    always means the same job, while a seniority word ("senior", "ii") still
    keeps the sets distinct."""
    return f"{_norm(company)}|{' '.join(sorted(_norm(role).split()))}"


class FeedAdapter(Protocol):
    source: str
    def feed_url(self) -> str: ...
    def walk_feed(self, page) -> Iterator[JobCard]: ...
    def extract_detail(self, page, card: JobCard) -> JobPosting: ...


class LinkAdapter(Protocol):
    source: str
    def resolve_and_extract(self, page, url: str) -> JobPosting: ...
