"""All tunable filter/scoring vocabulary in one place. Edit here, then re-run
the scan — no schema change needed. Seeded from profile_data.py (skills,
work history) and the job_tracker_swelist_filter / job_tracker_visa_sponsorship
memories."""
from __future__ import annotations

import re

INTEREST_KEYWORDS = [
    "embedded", "firmware", "hardware", "electrical", "ece", "fpga", "asic",
    "rtl", "verilog", "vhdl", "digital design", "digital logic", "power electronics",
    "power systems", "pcb", "circuit", "analog", "mixed signal", "signal integrity",
    "controls", "control systems", "robotics", "mechatronics", "systems engineer",
    "software engineer", "software engineering", "swe", "software developer",
    "new grad", "new graduate", "university graduate", "intern", "internship", "co-op",
    "rust", "c++", "embedded systems", "bare metal", "rtos", "microcontroller",
]

SENIORITY_EXCLUDE = [
    "senior", "sr.", "staff", "principal", "lead ", "manager", "director",
    "architect", " ii", " iii", " iv", "vp ", "head of",
]

SENIORITY_BYPASS = ["new grad", "new graduate", "university", "early career", "entry level"]

# Regex source strings, all compiled case-insensitive by the filter modules.
SPONSORSHIP_NEGATIVE = [
    r"not\s+(?:be\s+)?(?:able|eligible)\s+to\s+sponsor",
    r"unable\s+to\s+(?:provide|offer)\s+(?:visa\s+)?sponsor",
    r"do(?:es)?\s+not\s+sponsor",
    r"will\s+not\s+(?:offer|provide|sponsor)\b[^.]{0,40}\bsponsor",
    r"no\s+(?:visa\s+)?sponsorship",
    r"(?:visa\s+)?sponsorship\b[^.]{0,40}\bis\s+not\s+available",
    r"not\s+eligible\s+for\b[^.]{0,50}\bsponsor",
    r"sponsorship\s+available\s*\?\s*no\b",
    r"without\s+(?:the\s+need\s+for\s+)?(?:current\s+or\s+future\s+)?sponsorship",
    r"must\s+be\s+(?:a\s+)?u\.?s\.?\s+(?:citizen|person)",
    r"\b(?:must|requires?|needs?)\b.{0,30}?\bcitizen(?:ship)?\s+or\s+"
    r"(?:permanent\s+residen|green\s+card|lawful\s+permanent)",
    r"u\.?s\.?\s+citizen(?:ship)?\s*[.\s]*\(?\s*(?:is\s+)?required\)?",
    r"citizens?\s+only",
    r"\bitar\b",
    r"export[\s-]?control(?:led)?",
    # phrasings Allen surfaced 2026-09-08 (Capital One / CDM Smith / Skyward style)
    r"not\s+(?:currently\s+)?provid(?:e|ing)\b[^.]{0,25}sponsor",
    r"(?:authoriz\w*\s+to\s+work|work\s+in\s+the\s+u\.?s\.?)\b.{0,30}?"
    r"\bon\s+a\s+permanent\s+basis",
    r"(?:must\s+(?:have|possess)|requires?)\b[^.]{0,25}permanent\s+(?:work\s+)?"
    r"(?:authorization|work\s+eligibility)",
    r"permanent\s+residents?\s+or\s+(?:u\.?s\.?\s+)?citizens?",
    r"not\s+open\s+to\b[^.]{0,40}requir\w*\s+(?:visa\s+)?sponsor",
    r"unrestricted\s+(?:u\.?s\.?\s+)?work\s+authoriz",
    r"not\s+available\s+to\b[^.]{0,45}\b(?:immigration\s+)?visas?\b",
    r"(?:do(?:es)?\s+not|will\s+not)\s+(?:intend|plan|expect|anticipate)\s+to\s+"
    r"(?:provide|offer|sponsor)\b[^.]{0,30}sponsor",
    r"authoriz\w*\s+to\s+work\b.{0,45}?\bnow\s+(?:and|or)\s+in\s+the\s+future\b",
]

CLEARANCE_NEGATIVE = [
    r"security\s+clearance", r"ts/sci", r"active\s+(?:secret|clearance)",
    r"\b(?:top[\s-]?secret|secret|ts/sci|dod\s+secret|q\s+clearance|l\s+clearance)\s+clearance",
    r"(?:ability\s+to\s+obtain|able\s+to\s+obtain|willing(?:ness)?\s+(?:and\s+able\s+)?to\s+obtain|"
    r"obtain\s+and\s+maintain|eligible\s+(?:to\s+obtain|for)\s+a?)\b[^.]{0,45}\bclearance",
    r"\bpolygraph\b",
]

# Negations near a CLEARANCE_NEGATIVE hit that mean no clearance is actually
# required. "No security clearance is required" is a *leading* negation
# (checked separately, see hardfilter._LEADING_NEGATION); these are the
# trailing-style ones, same pattern as DEGREE_NEGATION.
CLEARANCE_NEGATION = [
    "not required", "not necessary", "not need", "no clearance required",
    "does not require", "doesn't require", "without a security clearance",
]

DEGREE_NEGATIVE = [
    # leading \b matters: without it, "m\.?s\.?" matches the tail "ms" of an
    # ordinary word (systems, platforms, mechanisms, ...) whenever
    # "required" follows within the gap below (Neuralink, 2026-09-12).
    r"\b(?:ph\.?d|master'?s|m\.?s\.?|m\.?eng)(?:\s+in\s+[\w/ ]+?)?\s+(?:degree\s+)?(?:is\s+)?required",
    r"must\s+(?:be\s+)?(?:enrolled\s+in|pursuing|have)\s+a\s+(?:ph\.?d|master)",
    r"require[sd]?\s+a\s+(?:ph\.?d|master'?s|graduate\s+degree)",
    # grad-only qualifier with no "required"/"must" -- "currently pursuing a
    # Master's or Ph.D. degree in <field>". Rescued by BACHELOR_OK when a
    # BS is listed as acceptable too (see DEGREE_NEGATION consumers).
    r"(?:currently\s+|actively\s+)?(?:pursuing|enrolled\s+in|working\s+toward(?:s)?|"
    r"completing)\s+(?:a\s+|an\s+|your\s+)?(?:ph\.?d|master'?s|m\.?s\.?|m\.?eng|"
    r"graduate\s+degree)\b",
    # two grad-tier degrees offered as alternatives, no Bachelor's option at
    # all -- "M.S. with 3 years of experience or fresh Ph.D." (Nokia), or
    # reversed order "fresh Ph.D. or M.S. with...". Each side's abbreviation
    # may end in its own period ("M.S.", "Ph.D."), so the boundary after it
    # is a lookahead for space/comma/end rather than \b (which fails right
    # after a matched trailing period -- neither side is a word char).
    r"\b(?:ph\.?d\.?|master'?s|m\.?s\.?|m\.?eng\.?)(?=[\s,)]|$)[^.\n]{0,60}"
    r"\bor\s+(?:a\s+)?(?:fresh\s+)?(?:ph\.?d\.?|master'?s|m\.?s\.?|m\.?eng\.?)(?=[\s,)]|$)",
    # a bare grad-degree bullet listed right under a "Minimum/Basic
    # Qualifications" header, no requiring verb at all -- "Minimum
    # Qualifications   Master's degree in Electrical Engineering..."
    # (Silicon Labs, 2026-09-16).
    r"(?:minimum|basic)\s+qualifications?\s*[:\-]?\s*"
    r"(?:ph\.?d|master'?s|m\.?s\.?|m\.?eng)\s+degree\s+in\b",
]

# If any of these appears within ~60 chars of a DEGREE_NEGATIVE hit, don't drop.
PREFERRED_NEGATION = ["preferred", "a plus", "nice to have", "bonus", "or equivalent"]

# A grad-degree mention doesn't disqualify an undergrad when a Bachelor's is
# offered as an alternative in the same breath ("BS or MS", "pursuing a
# Bachelor's, Master's, or PhD").
BACHELOR_OK = ["bachelor", "b.s.", "b.s ", "bs or", "bs,", "bs/", "/bs",
               " bs ", "undergraduate", "undergrad", "b.eng", "bsee", "bscs"]

# Negations near a DEGREE_NEGATIVE hit that mean the degree is NOT actually required.
DEGREE_NEGATION = [
    "not required", "not need", "not necessary", "not a requirement",
    "not mandatory", "no advanced degree", "isn't required",
]

# SUMMER_TERMS is used only for the score bonus and the term pill — never
# load-bearing for a drop. The term filter rejects explicit OFF_SEASON_TERMS
# and keeps everything else (see hardfilter.resolve_term).
SUMMER_TERMS = [
    "summer 2026", "summer 2027", "summer 2028", "summer intern",
    "summer analyst", "may 2027 start", "june start", "june 2027 start",
]
OFF_SEASON_TERMS = [
    "fall 2026", "fall 2027", "fall 2028", "autumn 2026", "autumn 2027",
    "spring 2026", "spring 2027", "spring 2028",
    "winter 2026", "winter 2027", "winter 2028",
    "fall internship", "spring internship", "winter internship",
    "fall co-op", "spring co-op", "winter co-op",
    "january start", "february start", "september start", "october start",
    "starting in january", "starting in february", "starting january",
    "jan-june", "january to june", "january - june", "jan to june",
    "spring/fall", "fall/spring",
]

_US_STATE_ABBR = {
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS",
    "KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY",
    "NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV",
    "WI","WY","DC",
}
_NON_US_HINTS = [
    "canada", "united kingdom", ", uk", "london", "ireland", "germany", "india",
    "singapore", "australia", "france", "netherlands", "remote - emea", "remote - apac",
    "remote - canada", "toronto", "vancouver", "bengaluru", "bangalore",
    "england", "scotland", "wales", "gb",
]


def is_us_location(location: str) -> bool:
    if not location:
        return True  # unknown → keep, let hardfilter/Claude judge
    low = location.lower()
    # simplify.jobs multi-location postings append "+ N more" to the first
    # listed location (e.g. "Burnaby, BC, Canada + 2 more") -- strip it before
    # segmenting so the country token isn't hidden inside "canada + 2 more".
    low = re.sub(r"\s*\+\s*\d+\s*more\s*$", "", low)
    # Match single-token hints against whole comma/slash-delimited segments so
    # "india" doesn't fire inside "Indianapolis" and "london" doesn't fire
    # inside "New London, CT". Multi-token hints (", uk", "united kingdom",
    # "remote - emea", …) still match as substrings.
    segments = {s.strip() for s in re.split(r"[,/]", low) if s.strip()}
    for h in _NON_US_HINTS:
        multiword = any(c in h for c in " -,")
        if (h in low) if multiword else (h in segments):
            return False
    if "united states" in low or "usa" in low or "u.s." in low:
        return True
    if "remote" in low and "us" in low:
        return True
    tokens = re.split(r"[,\s/]+", location.strip())
    if any(t.upper() in _US_STATE_ABBR for t in tokens):
        return True
    if "remote" in low:
        return True  # bare "Remote" → keep, Claude checks
    return True  # default keep; prefilter only drops on explicit non-US hint
