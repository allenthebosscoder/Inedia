"""jobright.ai adapter. All site-specific CSS lives in SELECTORS so drift is
a one-line fix; run tests/test_adapter_jobright.py against fresh fixtures
after any change.

jobright is a Next.js + Ant Design SPA with hashed CSS-module class names
(``index_<name>__<hash>``). The hash changes per deploy, so every selector
matches on the stable ``index_<name>__`` prefix via ``[class*="..."]``.
"""
from __future__ import annotations

import re
from typing import Iterator

from jobscan.adapters.base import (
    JobCard,
    JobPosting,
    ParseError,
    external_id_from_url,
)
from urllib.parse import urlsplit

from jobscan.detail_fetch import (
    ats_url_in_text, fetch_ats_detail, looks_blocked, source_jd, strip_tracking,
)

__all__ = ["JobrightAdapter", "LoginRequired", "ParseError", "parse_cards", "parse_detail"]

MAX_CARDS = 300
CONSECUTIVE_SEEN_STOP = 15

# Every site-specific CSS selector the adapter uses. Prefix-match the stable
# CSS-module name; the trailing hash is deploy-specific.
SELECTORS: dict[str, str] = {
    # A selector present ONLY on the logged-out page. Allen's fixture is a
    # logged-in capture and shows no login/auth markup, so this is left empty:
    # walk_feed then simply never raises LoginRequired and a run summary of
    # "0 cards" is the fallback signal that the session died.
    "login_wall": "",
    "card": '[class*="index_job-card-main__"]',
    "card_company": '[class*="index_company-name__"]',
    "card_role": '[class*="index_job-title__"]',
    "card_location": '[class*="index_primary-location__"]',
    # Best-effort only: salary is the 3rd cell of the first metadata row and
    # has no dedicated class. salary_hint is not a filter/score input, so an
    # occasional miss (e.g. a remote job whose 3rd cell is "Remote") is fine.
    "card_salary": '[class*="index_job-metadata-row__"] .ant-col:nth-child(3) span',
    "card_posted": '[class*="index_publish-time__"]',
    "card_link": 'a[href*="/jobs/info/"]',
    # Single-job detail body: role/location/scores + jobright's AI brief +
    # Responsibilities + Qualification (Required/Preferred) + Benefits +
    # Company. Does NOT include the "more jobs for you" sidebar.
    "detail_description": '[class*="index_jobDetailContent__"]',
    # The Required/Preferred list is inside detail_description and has no
    # clean standalone container, so requirements_text is left empty.
    "detail_requirements": "",
}


class LoginRequired(RuntimeError):
    pass


def feed_url() -> str:
    return "https://jobright.ai/jobs"


def _text(el) -> str:
    return (el.inner_text() if el else "").strip()


def _clean_role(role: str) -> str:
    """Card role text sometimes has a screen-reader tail concatenated by
    inner_text(), e.g. 'SWE Intern Job Details | NetApp, Inc.'."""
    role = (role or "").split("\n", 1)[0].strip()
    role = re.split(r"\s+(?:Job Details\b|\|)", role, maxsplit=1)[0]
    return role.strip()


def _query(node, key: str):
    sel = SELECTORS[key]
    return node.query_selector(sel) if sel else None


def parse_cards(page) -> list[JobCard]:
    """Pure parse of whatever job cards are currently in the DOM. No scrolling."""
    cards: list[JobCard] = []
    for node in page.query_selector_all(SELECTORS["card"]):
        link = _query(node, "card_link")
        href = link.get_attribute("href") if link else None
        if not href:
            continue
        url = href if href.startswith("http") else f"https://jobright.ai{href}"
        cards.append(JobCard(
            source="jobright",
            external_id=external_id_from_url(url),
            url=url,
            company=_text(_query(node, "card_company")),
            role=_clean_role(_text(_query(node, "card_role"))),
            location=_text(_query(node, "card_location")),
            salary_hint=_text(_query(node, "card_salary")),
            posted_at=_text(_query(node, "card_posted")),
        ))
    return cards


class JobrightAdapter:
    source = "jobright"
    # extract_detail navigates to the job's own URL, independent of the feed
    # -- safe to run on run.py's separate detail_page (the default).
    uses_separate_detail_page = True

    def feed_url(self) -> str:
        return feed_url()

    def walk_feed(self, page, is_seen=lambda key: False) -> Iterator[JobCard]:
        page.goto(self.feed_url(), wait_until="domcontentloaded")
        try:
            page.wait_for_selector(SELECTORS["card"], timeout=20000)
        except Exception:
            pass  # no cards -> loop below yields nothing, run summary shows 0
        page.wait_for_timeout(1500)
        if SELECTORS["login_wall"] and page.query_selector(SELECTORS["login_wall"]):
            raise LoginRequired("jobright")

        # The list's virtualization is driven by real wheel events, not
        # scrollTop (confirmed live: setting scrollTop never moved it, but a
        # wheel event over the list grew the rendered card count). Position
        # the mouse over the list once so subsequent wheel events land on it.
        first_card = page.query_selector(SELECTORS["card"])
        if first_card:
            box = first_card.bounding_box()
            if box:
                page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)

        emitted: set[str] = set()
        consecutive_seen = 0
        stagnant = 0  # scroll passes that surfaced no new card
        while len(emitted) < MAX_CARDS:
            new_this_pass = 0
            for card in parse_cards(page):
                key = f"{card.source}:{card.external_id}"
                if key in emitted:
                    continue
                emitted.add(key)
                new_this_pass += 1
                if is_seen(key):
                    consecutive_seen += 1
                    if consecutive_seen >= CONSECUTIVE_SEEN_STOP:
                        return
                    continue
                consecutive_seen = 0
                yield card

            # jobright's feed is virtualized: the card count in the DOM stays
            # roughly constant (old cards recycle out as new ones render), so
            # "count unchanged" can't detect the end. Stop only after several
            # scroll passes in a row surface nothing new.
            stagnant = stagnant + 1 if new_this_pass == 0 else 0
            if stagnant >= 8:
                return

            page.mouse.wheel(0, 2500)
            page.wait_for_timeout(1800)

    def extract_detail(self, page, card: JobCard) -> JobPosting:
        return parse_detail_via_goto(page, card)


def original_job_post_url(page) -> str | None:
    """The real ATS posting URL behind a jobright job page -- jobright renders
    it as an "Original Job Post" link (and, as a fallback, somewhere in the
    page HTML). Tracking params stripped."""
    for getter in (
        lambda: (page.query_selector('a:has-text("Original Job Post")') or _N).get_attribute("href"),
        lambda: ats_url_in_text(page.content()),
    ):
        try:
            href = getter()
        except Exception:  # noqa: BLE001
            continue
        if href and href.startswith("http") and "jobright" not in urlsplit(href).netloc:
            return strip_tracking(href)
    return None


class _NoEl:
    def get_attribute(self, _):  # noqa: D401
        return None


_N = _NoEl()


def _source_jd(page, card: JobCard) -> tuple[str, str | None] | None:
    """(real JD text, real ATS url) from the posting jobright links to --
    the authoritative source. `jd` is "" when the real url resolved but its
    content couldn't be read (bot-wall, e.g. LinkedIn's sign-in wall) -- the
    caller still gets the real url even though it must fall back to
    jobright's own scrape for the JD text. None only when there's no
    resolvable link at all."""
    real = original_job_post_url(page)
    if not real:
        return None
    jd = source_jd(page, real, card.company)
    return (jd, real) if jd and not looks_blocked(jd) else ("", real)


def parse_detail(page, card: JobCard) -> JobPosting:
    req_el = (
        page.query_selector(SELECTORS["detail_requirements"])
        if SELECTORS["detail_requirements"]
        else None
    )
    own = _text(page.query_selector(SELECTORS["detail_description"]))
    src = _source_jd(page, card)  # navigates `page` away -- do jobright DOM reads first
    if src and src[0]:
        description, url = src
    elif len(own) >= 40:
        description = own
        # We may know the real ATS url even though its content was
        # unreadable (bot-wall) -- keep it instead of reverting the pick's
        # link to the jobright.ai permalink (Allen: links must point to the
        # direct posting, never runway/simplify/jobright).
        url = src[1] if (src and src[1]) else card.url
    else:
        raise ParseError(f"no description container at {card.url or feed_url()}")
    return JobPosting(
        source=card.source, external_id=card.external_id, url=url,
        company=card.company, role=card.role, location=card.location,
        salary_hint=card.salary_hint, posted_at=card.posted_at,
        description=description,
        employment_type_hint="",
        requirements_text=_text(req_el),
    )


def parse_detail_via_goto(page, card: JobCard) -> JobPosting:
    page.goto(card.url, wait_until="domcontentloaded")
    page.wait_for_timeout(1500)
    return parse_detail(page, card)
