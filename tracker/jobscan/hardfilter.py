"""Full-text auto-drop. Conservative: only drops on explicit language;
anything ambiguous is kept and tagged term='Unknown' for Claude to judge."""
from __future__ import annotations

import datetime
import re

from jobscan import criteria
from jobscan.adapters.base import JobPosting
from jobscan.criteria import is_us_location
from jobscan.detail_fetch import QUESTIONS_HEADER, restricted_by_questions

# Fallback for JD text with no "Location:"-prefixed line at all (the
# browser-scrape path for an ATS with no JSON API just renders the page's
# own text, which puts the city/country on its own line near the top
# instead) -- Amazon (Annapurna Labs, Canada) and Lyft (Toronto) both slipped
# through this way. Whole-word hints rather than is_us_location's stricter
# comma-segment match, since these lines aren't cleanly comma-delimited.
_NON_US_WORD_RX = re.compile(
    r"\b(?:canada|england|scotland|wales|ireland|germany|india|singapore|australia|"
    r"france|netherlands|toronto|vancouver|bengaluru|bangalore|london)\b", re.I)


def _header_non_us(text: str) -> bool:
    # A site with a long nav menu (Apple: Store/Mac/iPad/.../Search/Back to
    # search results/<title>/<location>) can push the real location line 20+
    # lines in, so scan generously -- but only short, sentence-free lines
    # (a real location line, not a paragraph that happens to mention a
    # country in passing) to keep the false-positive risk low.
    for line in (text or "").splitlines()[:40]:
        line = line.strip()
        if not line or len(line) > 90 or line.endswith((".", "!", "?")):
            continue
        if _NON_US_WORD_RX.search(line):
            return True
    return False


_LOCAL_ONLY_RX = re.compile(
    r"candidates?\s+must\s+be\s+local"
    r"|local\s+candidates?\s+only"
    r"|must\s+be\s+local(?:ly\s+based)?\b(?![^.]*\bor\s+willing\s+to\s+relocat)"
    r"|must\s+(?:be\s+)?(?:located|reside|based)\s+in\b.{0,90}?\bnot\s+(?:able\s+to\s+)?"
    r"(?:consider(?:ing)?|accept)\s+(?:remote|relocat|out.of.state|out.of.area)"
    r"|no\s+relocation\s+(?:assistance\s+)?(?:is\s+)?(?:provided|offered|available)"
    r"[^.]{0,40}\b(?:local|must\s+be)", re.I)

_CONVERSION_RX = re.compile(
    r"this\s+(?:role|posting|position|req\w*)\s+is\s+for\b[^.]{0,45}\bintern"
    r"|open\s+only\s+to\b[^.]{0,25}\b(?:current|our|returning)\b[^.]{0,15}intern"
    r"|for\s+(?:our\s+)?20\d\d\s+(?:summer\s+)?interns?\s+who\s+worked"
    r"|for\s+(?:our\s+)?20\d\d\s+(?:summer\s+)?interns?\b[^.]{0,30}(?:convert|return|second\s+term)",
    re.I)

_SPONSOR = [re.compile(p, re.I) for p in criteria.SPONSORSHIP_NEGATIVE]
_CLEAR = [re.compile(p, re.I) for p in criteria.CLEARANCE_NEGATIVE]
_DEGREE = [re.compile(p, re.I) for p in criteria.DEGREE_NEGATIVE]

# "No security clearance is required" negates *before* the match, unlike
# "preferred"/"not required" which follow it -- a plain trailing-window
# check never sees it. Catches a bare negation word immediately before.
_LEADING_NEGATION = re.compile(r"\b(?:no|not|without)\s*$", re.I)

# "sponsor"/"sponsorship" is dropped only when a negative cue sits right
# next to it -- covers the dozens of ways a posting says it: "not eligible
# for ... sponsorship", "does not support immigration sponsorship", "will
# not offer sponsorship", "not a position for which sponsorship will be
# provided", "sponsorship is not available", "... are not eligible", the
# form-field "Is Sponsorship Available? No". "sponsorship is available" /
# "we sponsor visas" have no cue and pass.
_SPONSOR_WORD = re.compile(r"sponsor(?:ship|ed|ing|s)?", re.I)
# Negative cue in the ~90 chars before "sponsor". Deliberately narrow --
# bare "does not" catches "does not guarantee sponsorship" (a *positive*
# H1B-track-record disclaimer), so "does not" only counts paired with
# offer/provide/support/sponsor.
_SPONSOR_NEG_BEFORE = re.compile(
    r"\b(?:without|unable\s+to|cannot|can\s*not|can't|won't|ineligible|"
    r"will\s+not|must\s+not|do(?:es)?\s+not\s+(?:offer|provide|support|sponsor)|"
    r"not\s+(?:able|eligible|provide|provided|offer|offered|offering|support|"
    r"supported|sponsor|sponsoring|require|a\s+position))\b[^.]{0,80}$", re.I)
_SPONSOR_NEG_AFTER = re.compile(
    r"^[^.]{0,50}\b(?:is|are|will)\s+not\s+(?:be\s+)?"
    r"(?:available|provided|offered|considered|supported|eligible)", re.I)
_SPONSOR_FORM_FIELD = re.compile(r"sponsorship\s+available\s*\?\s*no\b", re.I)


def _sponsorship_dropped(text: str) -> bool:
    if _SPONSOR_FORM_FIELD.search(text):
        return True
    for m in _SPONSOR_WORD.finditer(text):
        before = text[max(0, m.start() - 90): m.start()]
        after = text[m.end(): m.end() + 60]
        if _SPONSOR_NEG_BEFORE.search(before) or _SPONSOR_NEG_AFTER.search(after):
            return True
    return False


def _is_internship(posting: JobPosting) -> bool:
    blob = f"{posting.role} {posting.employment_type_hint}".lower()
    return "intern" in blob or "co-op" in blob or "coop" in blob


def _matches_unnegated(patterns, text: str, negation_lists, check_leading: bool = False) -> bool:
    """True if any pattern matches text and isn't rescued by a negation word
    either immediately before the match (check_leading) or within a ±60-char
    window clamped to the match's own line (so a negation in a *different*
    section -- hardfilter joins description + "\\n" + requirements_text --
    never rescues a hit in another)."""
    for rx in patterns:
        m = rx.search(text)
        if not m:
            continue
        if check_leading and _LEADING_NEGATION.search(text[max(0, m.start() - 15):m.start()]):
            continue
        line_start = text.rfind("\n", 0, m.start()) + 1
        nl_after = text.find("\n", m.end())
        line_end = len(text) if nl_after == -1 else nl_after
        window = text[max(m.start() - 60, line_start): min(m.end() + 60, line_end)].lower()
        if any(neg in window for negs in negation_lists for neg in negs):
            continue
        return True
    return False


def _degree_dropped(text: str) -> bool:
    return _matches_unnegated(
        _DEGREE, text,
        [criteria.PREFERRED_NEGATION, criteria.DEGREE_NEGATION, criteria.BACHELOR_OK])


_PART_TIME_ROLE_RX = re.compile(
    r"\bpart[\s-]?time\s+(?:intern|internship|position|role|opportunity|co-?op|"
    r"student|engineer|analyst|developer|assistant)", re.I)
_HOURS_NUM_RX = re.compile(
    r"(?:weekly\s+(?:working\s+)?hours?|time\s+commitment|commitment|hours?\s*/\s*w(?:ee)?k)"
    r"\s*[:\-]?\s*(?:up\s*to\s*|approximately\s*|about\s*|~\s*|min(?:imum)?\s*(?:of\s*)?)?"
    r"(\d{1,2})(?:\s*(?:[-–]|to)\s*(\d{1,2}))?"
    r"|(\d{1,2})(?:\s*(?:[-–]|to)\s*(\d{1,2}))?\s*(?:hours?|hrs?)\s*(?:per|/|a|each)?\s*w(?:ee)?k", re.I)


def _part_time_dropped(text: str) -> bool:
    """Allen wants full-time roles. Drops "part-time internship" and any
    stated weekly-hours figure whose top end is under 32."""
    if _PART_TIME_ROLE_RX.search(text):
        return True
    for m in _HOURS_NUM_RX.finditer(text):
        # A benefits-accrual illustration ("about 3.4 hours/month if working
        # 20 hours/week") states a *hypothetical* number to explain a rate,
        # not the internship's actual schedule (DoorDash, 2026-09-15).
        before = text[max(0, m.start() - 20):m.start()].lower()
        if "if working" in before or "e.g." in before:
            continue
        nums = [int(g) for g in m.groups() if g]
        if nums and max(nums) < 32:
            return True
    return False


# Phrasings that are a hard requirement even with a nearby "not required" --
# "eligible to obtain and maintain a clearance. Active clearance preferred
# but not required" (Valinor): the *eligibility* is still mandatory, the
# "not required" only refers to already holding an active one.
_CLEAR_HARD = re.compile(
    r"eligib\w*\s+to\s+obtain\b.{0,45}?\bclearance"
    r"|(?:requires?|must\s+be)\b.{0,40}?\beligib\w*\b.{0,35}?\bclearance"
    r"|(?:ability|able|willing(?:ness)?)\s+(?:and\s+\w+\s+)?to\s+obtain\b.{0,45}?\bclearance"
    r"|obtain\s+and\s+maintain\b.{0,45}?\bclearance", re.I)


def _clearance_dropped(text: str) -> bool:
    if _CLEAR_HARD.search(text or ""):
        return True
    return _matches_unnegated(_CLEAR, text, [criteria.CLEARANCE_NEGATION], check_leading=True)


_MONTHS = {"january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
          "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
          "december": 12}
_MONTHS.update({m[:3]: n for m, n in list(_MONTHS.items())})  # jan, feb, ...
_MONTH_RX = r"(january|february|march|april|may|june|july|august|september|october|november|december)"
_START_RX = re.compile(r"\b(?:start(?:s|ing)?|begin(?:s|ning)?|commenc\w*|runs?|running|"
                       r"join(?:ing)?\s+(?:us|the\s+team))\b"
                       r"[^.]{0,45}?\b" + _MONTH_RX + r"\b", re.I)
_END_RX = re.compile(r"\b(?:through|until|end(?:s|ing)?|conclud\w*|thru)\b(?:\s+(?:the\s+)?"
                     r"(?:entire\s+)?\w+){0,3}?\s+(?:approximately\s+|around\s+)?\b" + _MONTH_RX + r"\b", re.I)
# "the Spring term" / "the Fall 26' semester" -- but NOT "Spring, Summer,
# or Fall term" (a list of what the company offers) and not near "summer".
_SEASON_TERM_RX = re.compile(
    r"(?<![,/]\s)(?<!\bor\s)(?<!\band\s)\b(spring|winter|fall|autumn)\s+"
    r"(?:['’]?(?:20)?\d\d['’]?\s+)?(?:term|semester|quarter)\b"
    r"(?!\s*(?:,|/|or\b|and\b|\bthrough\b))", re.I)
# A start-month..end-month range: "Jan - Aug 2027", "January to August".
_MRANGE = (r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?)\.?\s*"
           r"(?:[-–—]|to|through|thru|until)\s*"
           r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|"
           r"aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b")
_MONTH_RANGE_RX = re.compile(_MRANGE, re.I)
_SUMMER_NEAR = re.compile(r"\bsummer\b", re.I)
# "...for the Fall of 2026", "starting Spring 2027" -- a stated start term,
# authoritative even when the body also mentions summer as a maybe-extension.
_OFFSEASON_START_RX = re.compile(
    r"\b(?:for|in|during|start(?:s|ing)?|begin(?:s|ning)?|through(?:out)?|join\w*\s+\w+\s+for)"
    r"\s+(?:the\s+)?(fall|autumn|spring|winter)\s+(?:of\s+)?20\d\d\b", re.I)
# season + year in loose order: "Winter '27", "Spring 27'", "2027 Winter".
_OFFSEASON_LOOSE_RX = re.compile(
    r"\b(?:fall|autumn|spring|winter)\s*['’]\s?\d\d\b"
    r"|\b(?:fall|autumn|spring|winter)\s+\d\d\s?['’]"
    r"|\b20\d\d\s+(?:fall|autumn|spring|winter)\b", re.I)
_SUMMER_LOOSE_RX = re.compile(r"\bsummer\s*['’]\s?\d\d\b|\b20\d\d\s+summer\b", re.I)


def _grad_context(text: str, at: int) -> bool:
    start = max(text.rfind(".", 0, at), text.rfind("\n", 0, at), text.rfind("•", 0, at)) + 1
    sentence = text[start: at].lower()
    return any(w in sentence for w in ("graduat", "degree", "complet", "class of",
                                       "expected to finish", "eligibility"))


def _explicit_offseason_start(text: str) -> bool:
    """A stated Jan/Feb/Mar/spring/winter start -- authoritative even when
    the body also mentions summer as a maybe-extension ("continuing into
    Summer 2027 if available", real Tesla wording). Grad-date phrasing
    ("graduating in the Fall of 2027") does not count."""
    for m in _OFFSEASON_START_RX.finditer(text):
        if not _grad_context(text, m.end()):
            return True
    for m in _START_RX.finditer(text):
        if _MONTHS[m.group(1).lower()] in (1, 2, 3) and not _grad_context(text, m.end()):
            after = text[m.start(): m.end() + 40].lower()
            if not (_SUMMER_NEAR.search(after) or re.search(r"\bmay\b|\bjune?\b", after)):
                return True
    for m in _OFFSEASON_LOOSE_RX.finditer(text):
        if not _grad_context(text, m.start()):
            return True
    return False


def _schedule_signal(text: str) -> str | None:
    """Reads schedule phrasing the SUMMER/OFF_SEASON keyword lists miss:
    "start around January 2027", "the Spring term", "continue through April
    2027". Returns "Summer" | "Off-season" | None. Deliberately narrow --
    "graduating Fall of 2027" and "Spring, Summer or Fall term" must not trip it."""
    m = _START_RX.search(text)
    if m:
        month = _MONTHS[m.group(1).lower()]
        if month in (5, 6):
            return "Summer"
        # "start dates: January, May, or September" -- a list of options, one
        # of which is summer -- is ambiguous, not an off-season commitment.
        window = text[m.start(): m.end() + 40].lower()
        if not (_SUMMER_NEAR.search(window) or re.search(r"\bmay\b|\bjune?\b", window)):
            return "Off-season"
    m = _END_RX.search(text)
    if m and _MONTHS[m.group(1).lower()] in (3, 4, 5):
        window = text[max(0, m.start() - 60): m.end() + 30]
        if not _SUMMER_NEAR.search(window):
            return "Off-season"
    m = _SEASON_TERM_RX.search(text)
    if m and not _SUMMER_NEAR.search(text[max(0, m.start() - 40): m.end() + 40]):
        return "Off-season"
    m = _MONTH_RANGE_RX.search(text)
    if m:
        start_month = _MONTHS[m.group(1).lower()]
        return "Summer" if start_month in (5, 6) else "Off-season"
    return None


def resolve_term(posting: JobPosting, today: datetime.date | None = None) -> str:
    today = today or datetime.date.today()

    if not _is_internship(posting):
        return "New Grad"

    def _summer_year(matched_in: str) -> str:
        # Prefer the year actually written in the posting ("Summer 2026")
        # over guessing from today's date -- a Sept-2026 scan of a Summer
        # 2026 posting (already underway, still listed) should say 2026,
        # not assume it must mean next year.
        found = re.search(r"summer\s+(20\d\d)", matched_in)
        year = found.group(1) if found else str(today.year if today.month <= 5 else today.year + 1)
        return f"Summer {year}"

    # The role/title is specific to THIS req; the description is often
    # reused boilerplate that lists every term the company generally offers
    # ("...continuing into Summer 2027 if available...") even when the title
    # names one specific term for this posting. A title-level signal must
    # win over a generic description-level one (confirmed live 2026-09-05:
    # several Tesla reqs titled "(Winter/Spring 2027)" were mislabeled
    # Summer because their shared description mentions Summer in passing).
    role_text = (posting.role or "").lower()
    role_has_summer = (any(t in role_text for t in criteria.SUMMER_TERMS)
                       or bool(_SUMMER_LOOSE_RX.search(role_text)))
    role_has_off_season = (any(t in role_text for t in criteria.OFF_SEASON_TERMS)
                           or bool(_OFFSEASON_LOOSE_RX.search(role_text)))
    if role_has_off_season and not role_has_summer:
        return "Off-season"
    if role_has_summer:
        return _summer_year(role_text)

    # Title didn't say either way -- fall back to the full text.
    full_text = f"{posting.role} {posting.description} {posting.requirements_text}".lower()
    if _explicit_offseason_start(full_text):
        return "Off-season"
    if any(t in full_text for t in criteria.SUMMER_TERMS):
        return _summer_year(full_text)
    if any(t in full_text for t in criteria.OFF_SEASON_TERMS):
        return "Off-season"
    sched = _schedule_signal(full_text)
    if sched == "Summer":
        return _summer_year(full_text)
    if sched == "Off-season":
        return "Off-season"
    return "Unknown"


# A role TITLE naming a grad-only degree ("AI Software Engineering PhD
# Intern") is a hard, unambiguous signal on its own -- the JD body doesn't
# always restate it (Intel: title-only, no degree text in the body at all,
# so the body-text DEGREE_NEGATIVE checks never see it). Only fires when no
# undergrad-level degree is ALSO named in the title ("BS/MS/PhD Intern").
_TITLE_GRAD_ONLY_RX = re.compile(
    r"\b(?:ph\.?d|doctoral|master'?s|m\.?s\.?|m\.?eng)\b", re.I)
_TITLE_UNDERGRAD_RX = re.compile(
    r"\b(?:bachelor|b\.?s\.?|b\.?a\.?|undergrad(?:uate)?)\b", re.I)


def _title_degree_dropped(role: str) -> bool:
    return bool(_TITLE_GRAD_ONLY_RX.search(role or "")) and not _TITLE_UNDERGRAD_RX.search(role or "")


def _first_line(text: str) -> str:
    return (text or "").strip().splitlines()[0] if (text or "").strip() else ""


# The JD body's first line is the ATS's own embedded posting title (see
# detail_fetch._assemble()) -- but only when it actually reads like a
# title. A sentence like "Master's degree preferred but not required."
# also happens to land as line 1 sometimes and must NOT be run through
# the title-only check, which has no notion of negation. Require it to be
# short, contain an intern/co-op/fellow-type noun, and be free of sentence
# words ("is", "required", "preferred", "not", ...) that mark it as prose
# rather than a title.
_TITLE_LIKE_RX = re.compile(r"\b(?:intern(?:ship)?|co.?op|fellow|extern|new\s+grad)\b", re.I)
_TITLE_SENTENCE_GUARD_RX = re.compile(
    r"\b(?:is|are|was|were|preferred|required|requires|must|should|only|but|not)\b", re.I)


def _looks_like_title(line: str) -> bool:
    line = (line or "").strip()
    if not line or len(line) > 80:
        return False
    return bool(_TITLE_LIKE_RX.search(line)) and not _TITLE_SENTENCE_GUARD_RX.search(line)


# Allen's earliest possible graduation across all three of his real paths
# (May 2027 early-grad / Dec 2027 / May 2028 on-track) is May 2027 -- see
# job_tracker_resumes / job_tracker_visa_sponsorship. A "New Grad" posting
# with an explicit degree-completion window entirely before that excludes
# him no matter which path he takes (GM: "Degree completed between December
# 2025 and August 2026, with availability to begin employment in 2026").
_ALLEN_EARLIEST_GRAD = (2027, 5)
_GRAD_WINDOW_RX = re.compile(
    r"(?:degree\s+complet\w*|graduation)\s*(?:must\s+have\s+occurred\s+)?"
    r"between\s+" + _MONTH_RX + r"\s+(\d{4})\s+and\s+" + _MONTH_RX + r"\s+(\d{4})", re.I)


def _grad_window_dropped(text: str) -> bool:
    m = _GRAD_WINDOW_RX.search(text or "")
    if not m:
        return False
    end_month, end_year = _MONTHS[m.group(3).lower()], int(m.group(4))
    return (end_year, end_month) < _ALLEN_EARLIEST_GRAD


# A degree-tiered experience requirement ("Master's Level Degree and 0
# years related work experience; Bachelor's Level Degree and related work
# experience of 2 years", KLA) means a fresh Bachelor's grad with no prior
# full-time experience -- Allen's situation on every one of his three grad
# paths -- doesn't qualify on either tier. Only fires on the specific
# "degree AND <n> years [of] experience" construction, not a loose mention
# of years elsewhere in the JD.
_BACHELOR_EXPERIENCE_RX = re.compile(
    r"bachelor'?s\s+(?:level\s+)?degree\s+and\s+(?:related\s+work\s+)?experience\s+of\s+(\d+)\+?\s*years?"
    r"|bachelor'?s\s+(?:level\s+)?degree\s+and\s+(\d+)\+?\s*years?\s+(?:of\s+)?(?:related\s+)?"
    r"(?:work\s+)?experience", re.I)


def _experience_dropped(text: str) -> bool:
    m = _BACHELOR_EXPERIENCE_RX.search(text or "")
    if not m:
        return False
    return int(m.group(1) or m.group(2)) >= 1


def hardfilter(posting: JobPosting, today: datetime.date | None = None) -> str | None:
    text = f"{posting.description}\n{posting.requirements_text}"

    if any(rx.search(text) for rx in _SPONSOR) or _sponsorship_dropped(text):
        return "no-sponsorship"
    if _clearance_dropped(text):
        return "clearance"
    first_line = _first_line(posting.description)
    if (_degree_dropped(text) or _title_degree_dropped(posting.role)
            or (_looks_like_title(first_line) and _title_degree_dropped(first_line))):
        return "degree"
    if _grad_window_dropped(text):
        return "grad-window"
    if _experience_dropped(text):
        return "experience"
    if QUESTIONS_HEADER in text:
        labels = text.split(QUESTIONS_HEADER, 1)[1].splitlines()
        if restricted_by_questions([l.strip() for l in labels if l.strip()]):
            return "clearance"
    loc_m = re.search(r"^Location:\s*(.+)$", text, re.M)
    if loc_m and not is_us_location(loc_m.group(1)):
        return "location"
    if not loc_m and _header_non_us(text):
        return "location"
    if _CONVERSION_RX.search(text):
        return "intern-conversion"
    if _LOCAL_ONLY_RX.search(text):
        return "local-only"
    if _part_time_dropped(text):
        return "part-time"
    term = resolve_term(posting, today)
    if term == "Off-season":
        return "term:off-season"
    m = re.match(r"summer (\d{4})$", term.lower())
    if m:
        ref = today or datetime.date.today()
        # a Summer YYYY internship is over once it's September of YYYY or later
        if (ref.year, ref.month) >= (int(m.group(1)), 9):
            return "term:past"
    return None
