"""Turn a run artifact's `candidates` into the ranked list that goes on
`/picks`. Codifies the curation rules that were re-derived by hand every
run: drop what isn't in-field / won't sponsor / already actioned, then
order hardware-and-embedded before general SWE, Summer 2027 before
everything, freshest first.

`heuristic_score` already folds in recency (score.py penalizes stale
postings) and role/keyword fit, so it's the final tie-breaker."""
from __future__ import annotations

import datetime
import re

from jobscan.adapters.base import dedup_key

_PAST_SUMMER_RX = re.compile(r"summer\s+(\d{4})", re.I)

# In-field titles. A role title must match one of these to stay.
RELEVANT = re.compile(
    r"\b(fpga|firmware|embedded|verilog|vhdl|rtl|asic|soc|dsp|analog|photonic|"
    r"semiconductor|microcontroller|vlsi|dft|mems|pcb|electronics|hbm|dram)\b"
    r"|signal process|radio frequency|physical design|ic design|design verification|"
    r"design evaluation engineer|design for test|"
    r"electronic design|electronics design|electronic control|\belectrical\b|"
    r"application engineer|applications engineer|"
    r"hardware engineer|hardware design|hardware test|hardware validation|post.?silicon|"
    r"lab test engineer|product test engineer|reliability engineer|reliability testing|failure analysis|"
    r"server platform|"
    r"systems? integration engineer|"
    r"power electronics|power system|controls engineer|control systems engineer|\bsilicon\b|\brf\b"
    r"|software engineer|software developer|software development intern|software development engineer|"
    r"computer science|\bswe\b|backend|"
    r"back.end|full.?stack|platform engineer|systems software|flight software|"
    r"software integration|android platform", re.I)

# Unambiguously not-his-field titles (checked first -- an "AI/ML Data
# Platform Engineer" matches RELEVANT on "engineer" but is off-domain).
OFF_DOMAIN = re.compile(
    r"data scien|data analy|\banalytics\b|\bquant\b|quantitative|machine learning "
    r"(research|scientist|infra)|research scientist|applied scientist|\bml infra|"
    r"\bbusiness\b|consult|\bsales\b|marketing|\bgis\b|bioinformatics|\bmba\b|"
    r"supply chain|risk management|actuar|product strateg|product manage|industrial "
    r"engineer|civil (intern|engineer)|chemical engineer|technical art|instructor|"
    r"apprentice|graduate student|student researcher|analyst intern|trading|"
    r"investment analyst|capital markets analyst|designer intern|servicenow|"
    r"data integration|data migration|data services|enterprise data|\bit intern|"
    r"help ?desk|front.?end (developer|ux)|web development intern|\bdata engineer\b",
    re.I)

HARDWARE = re.compile(
    r"\b(fpga|firmware|embedded|verilog|rtl|asic|dsp|analog|silicon|mems|pcb|hbm|dram)\b"
    r"|\belectrical\b|electronic|hardware eng|hardware design|"
    r"hardware test|hardware validation|post.?silicon|lab test engineer|product test engineer|reliability engineer|"
    r"reliability testing|failure analysis|server platform|design for test|"
    r"power electronics|power system|controls eng|physical design|ic design|design verification|"
    r"\brf\b", re.I)

# NOT a sponsorship blocklist (sponsorship is JD-text-only, checked
# elsewhere). This is the short list of pure-defense primes where ITAR /
# US-person is legally mandated for essentially every role, not a
# discretionary HR policy -- their intern JDs often omit the clause, so
# they flood /picks via jobright/jobnotifier otherwise. Add a company here
# ONLY when it's an unambiguous defense prime; when in doubt, leave it out
# and let hardfilter's JD-text clearance check handle it instead.
DEFENSE_COMPANIES = (
    "l3harris", "l3 harris", "raytheon", "rtx", "lockheed", "lockheed martin",
    "northrop", "northrop grumman", "general dynamics", "gdms", "gd mission",
    "anduril", "saronic", "caci", "booz allen", "leidos", "peraton",
    "bae systems", "sierra nevada", "general atomics",
    "bascom hunter",  # Frederick, MD SIGINT/IC contractor -- clearance-track roles
)


def _company_hit(company: str, names) -> bool:
    c = (company or "").strip().lower()
    return any(c == n or c.startswith(n + " ") or c.startswith(n + ",") for n in names)


# Temporary company holds -- unlike DEFENSE_COMPANIES (a permanent block),
# each entry here is a personal call about the current situation with that
# company, not a fixed rule about the company itself, so it lives in the
# gitignored search_preferences_private.py (see .example for the template
# and format: `until` is a date the hold expires on its own, or None for an
# indefinite hold removed by hand later).
try:
    from search_preferences_private import TEMP_COMPANY_HOLDS as _TEMP_COMPANY_HOLDS
except ImportError:
    _TEMP_COMPANY_HOLDS = ()


_MILITARY = re.compile(r"skillsbridge|skillbridge|military\s+transition|"
                       r"transitioning\s+service\s*member", re.I)
# Role TITLES that mean US-person / clearance -- a signal from the posting
# itself, not a guess about the employer. Catches defense business units
# and primes across every company.
_DEFENSE_ROLE = re.compile(
    r"\bdefense\b|forward\s+deployed|\bfederal\b|national\s+security|\bgov(?:ernment|t)\b|"
    r"\bTS/?SCI\b|\bclearance\b|\bpolygraph\b|\bpoly\s+required\b|\bDoD\b|\bclassified\b|"
    r"\bsecret\s+clearance\b", re.I)

# Internships only, not co-ops. A co-op (esp. a multi-semester one, e.g.
# Waystar's "3-Semester Application Engineer Co-Op") is a bigger commitment
# than a summer internship -- it often means time away from school and its
# own CPT/leave-of-absence review, not worth the logistics case-by-case
# right now.
_COOP_RX = re.compile(r"\bco.?op\b", re.I)


def _term_weight(term: str) -> int:
    t = (term or "").lower()
    if t.startswith("summer 2027"):
        return 0
    if not t or "unknown" in t:
        return 1
    if "new grad" in t or "2028" in t:
        return 2
    return 3  # summer 2026 etc.


def _drop_reason(c: dict, applied_keys: set, deleted_keys: set,
                 capped_companies: frozenset) -> str | None:
    dk = (dedup_key(c["company"], c["role"]).split("|", 1))  # (norm_company, norm_role)
    key = (dk[0], dk[1])
    role, company, blob = c["role"] or "", c["company"] or "", c.get("description", "") or ""
    if key in applied_keys:
        return "already-applied"
    if key in deleted_keys:
        return "deleted"
    if dk[0] in capped_companies:
        return "company-app-cap"
    today = datetime.date.today()
    for names, until in _TEMP_COMPANY_HOLDS:
        if (until is None or today < until) and _company_hit(company, names):
            return "temp-hold"
    pm = _PAST_SUMMER_RX.search(c.get("term") or "")
    if pm:
        if (today.year, today.month) >= (int(pm.group(1)), 9):  # Sept of that year = over
            return "term:past"
    if _MILITARY.search(role) or _MILITARY.search(blob):
        return "military-transition"
    if _COOP_RX.search(role):
        return "co-op"
    if _company_hit(company, DEFENSE_COMPANIES):
        return "defense"
    if _DEFENSE_ROLE.search(role):
        return "defense"
    if OFF_DOMAIN.search(role) or not RELEVANT.search(role):
        return "off-domain"
    return None


def capped_companies(applications: list, threshold: int = 3) -> frozenset:
    """Normalized company names applied to `threshold`+ times -- several
    ATSs (Zipline, Shure) cap total applications in a window."""
    from collections import Counter
    counts = Counter(dedup_key(co, "").split("|", 1)[0] for co, _ in applications)
    return frozenset(c for c, n in counts.items() if c and n >= threshold)


def rank(candidates: list[dict], applied_keys: set, deleted_keys: set,
         capped: frozenset = frozenset()) -> tuple[list[dict], list[dict]]:
    """Returns (ranked, dropped). `applied_keys` / `deleted_keys` are sets of
    ``(norm_company, norm_role)`` tuples (dedup_key halves)."""
    def _dropped_entry(cand: dict, reason: str) -> dict:
        return {"company": cand["company"], "role": cand["role"], "reason": reason,
                "source": cand.get("source", ""), "external_id": cand.get("external_id", "")}

    kept: dict[str, dict] = {}
    dropped: list[dict] = []
    for c in candidates:
        reason = _drop_reason(c, applied_keys, deleted_keys, capped)
        if reason:
            dropped.append(_dropped_entry(c, reason))
            continue
        dk = dedup_key(c["company"], c["role"])
        score = c.get("heuristic_score") or 0
        if dk not in kept:
            kept[dk] = c
        elif score > (kept[dk].get("heuristic_score") or 0):
            # Two sources found the same real posting under different
            # job_keys -- keep the higher-scoring one and report the other
            # as an explicit dedup casualty, not a rule-based drop, so a
            # caller can clean it up without marking it a genuine deletion
            # (that would poison the shared dedup_key and take the survivor
            # down too on the next rerank).
            dropped.append(_dropped_entry(kept[dk], "dedup:superseded"))
            kept[dk] = c
        else:
            dropped.append(_dropped_entry(c, "dedup:superseded"))

    ranked = sorted(kept.values(), key=lambda c: (
        0 if HARDWARE.search(c["role"] or "") else 1,
        _term_weight(c.get("term")),
        -(c.get("heuristic_score") or 0),
        c["company"],
    ))
    for i, c in enumerate(ranked, 1):
        c["rank"] = i
    return ranked, dropped
