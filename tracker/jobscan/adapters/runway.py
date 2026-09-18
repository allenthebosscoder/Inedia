"""runway.io (joinrunway.io) adapter. All site-specific CSS lives in SELECTORS
so drift is a one-line fix; run tests/test_adapter_runway.py against fresh
fixtures after any change.

runway is a Next.js + Tailwind app with NO semantic class names. Two things
follow from that:

  * The feed is a single <table>; every data row is ``tr.cursor-pointer``
    (the header row is not). A row carries the role, company, location and a
    relative "posted" string, but **no job id and no href** -- clicking a row
    triggers a client-side route to ``/explore/job/<cuid>``. So JobCard.url is
    "" from the feed and ``external_id`` is a deterministic slug of
    ``"<company>-<role>"`` (stable across runs -> usable as the seen-cache key).

  * The detail view is a Radix dialog (``div[role="dialog"]``) showing runway's
    AI-summarised JD (Role Summary / Responsibilities / Qualifications), not the
    raw posting. ``parse_detail`` is a pure DOM parse of whichever dialog is
    loaded; ``extract_detail`` clicks the feed row first to get there.
"""
from __future__ import annotations

import re
from typing import Iterator

from jobscan.adapters.base import JobCard, JobPosting, ParseError
from jobscan.detail_fetch import fetch_ats_detail, looks_blocked, strip_tracking

__all__ = ["RunwayAdapter", "LoginRequired", "ParseError", "parse_cards", "parse_detail"]

MAX_CARDS = 300
CONSECUTIVE_SEEN_STOP = 15

# Every site-specific selector the adapter uses.
SELECTORS: dict[str, str] = {
    # A marker present ONLY on the logged-out page. The fixture is a logged-in
    # capture with no auth markup, so this is left empty: walk_feed then never
    # raises LoginRequired and a run summary of "0 cards" is the fallback
    # signal that the session died. (Task 20 may fill this from a live logout.)
    "login_wall": "",
    # Data rows only -- the header <tr> is not .cursor-pointer.
    "card": "table tr.cursor-pointer",
    # First <p> in the first cell is the role title; the company sits in a
    # "Filter by <company>" button in the same cell.
    "card_role": "td:first-child p",
    "card_company": 'button[title^="Filter by "]',
    "card_location": "td:nth-child(2) p",
    "card_posted": "td:nth-child(3) p",
    # The JD panel (Radix dialog). There is also a tiny "Pop up content" dialog
    # in the DOM, so parse_detail picks the [role="dialog"] with the most text.
    # This yields runway's AI summary (Role Summary / Responsibilities /
    # Qualifications) plus the header role title.
    "detail_description": 'div[role="dialog"]',
    # The "View full job description" accordion body: a Radix region holding the
    # COMPLETE original JD. It sits in the DOM but starts collapsed/`hidden`, so
    # it must be read with text_content() (inner_text() returns "" when hidden)
    # and, in a live run, ideally expanded first via `detail_fulljd_toggle`.
    "detail_fulljd": '[role="region"][data-orientation="vertical"]',
    "detail_fulljd_toggle": 'text="View full job description"',
    # <link rel="canonical" href=".../explore/job/<cuid>"> -> the real job URL
    # (feed rows carry no id/href, so this is the only place the URL appears).
    "detail_canonical": 'link[rel="canonical"]',
    # Fallbacks for role/company when the card lacks them (detail header).
    "detail_role": 'div[role="dialog"] h5',
    "detail_company": 'div[role="dialog"] h5 + p',
    # No clean standalone requirements container -> requirements_text is "".
    "detail_requirements": "",
}


class LoginRequired(RuntimeError):
    pass


def feed_url() -> str:
    return "https://app.joinrunway.io/explore"


def _text(el) -> str:
    return (el.inner_text() if el else "").strip()


def _query(node, key: str):
    sel = SELECTORS[key]
    return node.query_selector(sel) if sel else None


def _slug(company: str, role: str, location: str = "") -> str:
    """lowercase, non-alphanumerics -> '-', collapse repeats, strip ends.

    ``location`` is folded in so the same title at two sites (Amazon SWE Intern
    in Austin vs San Jose) gets distinct external_ids / job_keys rather than the
    second one being skipped forever as a dupe."""
    raw = f"{company}-{role}-{location}" if location else f"{company}-{role}"
    return re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")


def _company_of(node) -> str:
    btn = _query(node, "card_company")
    if not btn:
        return ""
    txt = _text(btn)
    if txt:
        return txt
    return (btn.get_attribute("title") or "").removeprefix("Filter by ").strip()


def _employment_hint(text: str) -> str:
    """runway's Role Summary exposes a bare 'Internship' / 'Full Time' chip.
    Reading it lets hardfilter tell a new-grad role from an internship."""
    m = re.search(
        r"\b(Internship|Co-?op|Full[\s-]?Time|Part[\s-]?Time|Contract|Temporary)\b",
        text, re.I,
    )
    return m.group(1) if m else ""


def parse_cards(page) -> list[JobCard]:
    """Pure parse of whatever feed rows are currently in the DOM. No scrolling."""
    cards: list[JobCard] = []
    for node in page.query_selector_all(SELECTORS["card"]):
        role = _text(_query(node, "card_role"))
        company = _company_of(node)
        if not (role and company):
            continue
        location = _text(_query(node, "card_location"))
        cards.append(JobCard(
            source="runway",
            external_id=_slug(company, role, location),
            url="",  # unknown from the feed
            company=company,
            role=role,
            location=location,
            salary_hint="",
            posted_at=_text(_query(node, "card_posted")),  # raw relative text
        ))
    return cards


def _find_row(page, card: JobCard):
    """The feed <tr> whose role + company match the card -- the click target."""
    for node in page.query_selector_all(SELECTORS["card"]):
        if _text(_query(node, "card_role")) != card.role or _company_of(node) != card.company:
            continue
        row_loc = _text(_query(node, "card_location"))
        # Fold location in when both sides have it -- two rows can share a
        # title + company and differ only by location.
        if card.location and row_loc and row_loc != card.location:
            continue
        return node
    return None


def _region_text(page) -> str:
    """Full-JD accordion body. It is usually collapsed/`hidden`, so inner_text()
    returns "" -- read the raw textContent instead."""
    el = _query(page, "detail_fulljd")
    if not el:
        return ""
    try:
        return (el.text_content() or "").strip()
    except Exception:
        return ""


def _apply_target_url_and_jd(page, company: str = "") -> tuple[str | None, str]:
    """runway's "Apply to Job" button has no href -- it opens a popup that
    navigates to the real ATS posting. Click it, then read the JD FROM THE
    POPUP TAB (API first, else its own rendered body) and close it.

    Root-cause fix (2026-09-11): runway has no per-job URL, so `page` here
    is the SAME shared feed page reused across every card in the walk
    (`uses_separate_detail_page = False`) -- if JD-reading ever navigated
    `page` itself (the old `source_jd(page, ...)` fallback did, via
    `fetch_jd_via_browser`), the feed's virtualized table was gone and
    every subsequent card's `_find_row` failed ("no feed row for ..."),
    cascading through the rest of the run. Reading on the disposable popup
    page instead means the feed page is never touched."""
    try:
        btn = page.query_selector('button:has-text("Apply to Job")') \
            or page.query_selector('a:has-text("Apply to Job")')
        if not btn:
            return None, ""
        with page.context.expect_page(timeout=8000) as pop:
            btn.click()
        newpg = pop.value
        newpg.wait_for_load_state("domcontentloaded", timeout=15000)
        url = newpg.url
    except Exception:  # noqa: BLE001
        return None, ""
    if not url or "joinrunway" in url:
        try:
            newpg.close()
        except Exception:  # noqa: BLE001
            pass
        return None, ""
    url = strip_tracking(url)
    jd = fetch_ats_detail(url, company) or ""
    if not jd or looks_blocked(jd):
        try:
            newpg.wait_for_timeout(1500)
            el = newpg.query_selector("body")
            text = (el.inner_text() if el else "") or ""
            jd = "" if looks_blocked(text) else text.strip()
        except Exception:  # noqa: BLE001
            jd = ""
    try:
        newpg.close()
    except Exception:  # noqa: BLE001
        pass
    return url, jd


def parse_detail(page, card: JobCard) -> JobPosting:
    """Parse the loaded runway JD dialog, then resolve the real posting.

    The real ATS JD (reached via the "Apply to Job" popup) is authoritative;
    runway's AI summary + "View full job description" region is only the
    fallback when the real posting can't be read.
    """
    els = page.query_selector_all(SELECTORS["detail_description"])
    summary_el = max(els, key=lambda e: len(e.inner_text()), default=None) if els else None
    own = "\n".join(p for p in (_text(summary_el), _region_text(page)) if p)

    role, company = card.role, card.company
    if not role:
        role = _text(_query(page, "detail_role"))
    if not company:
        company = _text(_query(page, "detail_company"))
    canon = _query(page, "detail_canonical")
    href = canon.get_attribute("href") if canon else None
    runway_url = href if (href and "/explore/job/" in href) else card.url

    real, real_jd = _apply_target_url_and_jd(page, company)  # popup tab only -- last
    is_real = bool(real and real.startswith("http") and "joinrunway.io" not in real)
    if real_jd and not looks_blocked(real_jd):
        description, url = real_jd, real
    elif len(own) >= 40:
        description = own
        # We may know the real ATS url even though its content was
        # unreadable (bot-wall) -- keep it instead of reverting the pick's
        # link to the runway.io permalink (Allen: links must point to the
        # direct posting, never runway/simplify/jobright).
        url = real if is_real else runway_url
    else:
        raise ParseError(f"no description container at {card.url or feed_url()}")

    return JobPosting(
        source=card.source or "runway",
        external_id=card.external_id or _slug(company, role, card.location),
        url=url,
        company=company,
        role=role,
        location=card.location,
        salary_hint=card.salary_hint,
        posted_at=card.posted_at,
        description=description,
        employment_type_hint=_employment_hint(description),
        requirements_text="",
    )


_OPEN_DIALOG = 'div[role="dialog"][data-state="open"]'


def _close_detail_dialog(page, feed_url: str) -> None:
    """The detail view is a Radix dialog overlay on top of the still-live
    list, not a full navigation. A left-open dialog intercepts every click
    on the row underneath it (confirmed live: repeated 30s click timeouts,
    all against the SAME stale dialog id, once a previous close attempt --
    page.go_back() -- failed to actually dismiss it). Escape is Radix's
    normal dismiss; an off-dialog click and a hard reload are fallbacks."""
    for _ in range(4):
        if not page.query_selector(_OPEN_DIALOG):
            return
        try:
            page.keyboard.press("Escape")
        except Exception:
            pass
        page.wait_for_timeout(400)
    if page.query_selector(_OPEN_DIALOG):
        try:
            page.mouse.click(20, 300)  # dialog is right-anchored; this is clear of it
            page.wait_for_timeout(400)
        except Exception:
            pass
    if page.query_selector(_OPEN_DIALOG):
        try:
            page.goto(feed_url, wait_until="domcontentloaded")
            page.wait_for_timeout(1000)
        except Exception:
            pass


def extract_detail(page, card: JobCard) -> JobPosting:
    """From the loaded feed page: click the matching row, wait for the JD, parse.

    runway has no feed-level URL, so this is the only way from a card to its JD.
    """
    row = _find_row(page, card)
    if row is None:
        raise LookupError(f"runway: no feed row for {card.company!r} / {card.role!r}")
    row.click()
    try:
        page.wait_for_url("**/explore/job/**", timeout=10_000)
    except Exception:
        page.wait_for_selector(SELECTORS["detail_description"], timeout=10_000)

    # Expand "View full job description" so the full-JD region is populated
    # (Radix renders its body lazily on open). Best-effort -- parse_detail still
    # works off the AI summary if the toggle is gone or the click is a no-op.
    try:
        toggle = page.query_selector(SELECTORS["detail_fulljd_toggle"])
        if toggle:
            toggle.click()
            page.wait_for_timeout(500)
    except Exception:
        pass

    canonical = page.query_selector(SELECTORS["detail_canonical"])
    href = canonical.get_attribute("href") if canonical else None
    card.url = href if (href and "/explore/job/" in href) else page.url
    return parse_detail(page, card)


class RunwayAdapter:
    source = "runway"
    # extract_detail clicks a row IN the feed page (runway has no per-job
    # URL to just goto) -- it must keep using the shared feed page rather
    # than run.py's separate detail_page.
    uses_separate_detail_page = False

    def feed_url(self) -> str:
        return feed_url()

    def walk_feed(self, page, is_seen=lambda key: False) -> Iterator[JobCard]:
        page.goto(self.feed_url(), wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        if SELECTORS["login_wall"] and page.query_selector(SELECTORS["login_wall"]):
            raise LoginRequired("runway")

        # jobright's identical-looking table turned out to be virtualized and
        # driven by real wheel events, not scrollTop -- position the mouse
        # over the list once so wheel events land on it (unconfirmed live for
        # runway specifically; same pattern as the verified jobright fix).
        first_row = page.query_selector(SELECTORS["card"])
        if first_row:
            box = first_row.bounding_box()
            if box:
                page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)

        emitted: set[str] = set()
        consecutive_seen = 0
        stagnant = 0
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
            stagnant = stagnant + 1 if new_this_pass == 0 else 0
            if stagnant >= 8:
                return
            page.mouse.wheel(0, 2500)
            page.wait_for_timeout(1800)

    def extract_detail(self, page, card: JobCard) -> JobPosting:
        # Belt-and-suspenders: close any dialog left open by a previous,
        # imperfectly-cleaned-up job before clicking this one's row.
        _close_detail_dialog(page, self.feed_url())
        posting = extract_detail(page, card)
        _close_detail_dialog(page, self.feed_url())
        return posting
