# Daily Job Scan & Ranking Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manual-trigger pipeline that scrapes jobright.ai + jobright.ai (and the SWElist digest email), auto-drops clear non-fits, and surfaces ~15 ranked picks with reasoning on a new `/picks` page in the tracker app, each with a one-click path to an `applications` row.

**Architecture:** A new `jobscan/` Python package does all mechanical work: pure filter/score functions, a `seen_jobs` cache, Playwright adapters (driving system Google Chrome via `channel="chrome"`) that parse each source, and a `run.py` orchestrator that writes a JSON run artifact. `scripts/scan_jobs.py` is the entry point Claude runs from chat. Claude then reads the artifact, dedupes/ranks/writes reasoning, and `POST`s the picks to the Flask app. The app gains two tables (`seen_jobs`, `daily_picks`), four JSON endpoints, and a vanilla-JS `/picks` page with Today / Carried-over / Applied-today sections and Applied + Delete buttons.

**Tech Stack:** Flask + SQLite + vanilla JS (unchanged), plus `playwright` (Python, sync API) driving system Google Chrome. No `pytest-playwright`; tests use the sync API directly through a conftest fixture. SWElist link extraction and all ranking judgment stay with Claude-in-chat (no server-side AI, consistent with commit `f99c293`).

**Spec:** [docs/superpowers/specs/2026-09-02-daily-job-scan-design.md](../specs/2026-09-02-daily-job-scan-design.md)

## Global Constraints

- **No server-side AI / API key.** The scan script does only mechanical work. Ranking, reasoning, dedupe judgment, and SWElist link extraction are done by Claude in a chat session reading the run artifact.
- **Review-before-write.** Nothing reaches the `applications` table except through Allen's explicit click of **Applied** on the `/picks` page.
- **`tracker.db` holds real user data.** All schema changes are non-destructive migrations following the existing `db._migrate` pattern (see `tests/test_db.py`).
- **Existing tables and endpoints are unchanged.** `STATUS_VALUES = {"Applied","Interviewing","Accepted","Rejected","Incomplete"}` and `TYPE_VALUES = {"Intern","Entry","Other"}` in `app.py` stay as-is.
- **Playwright uses `channel="chrome"`** (system Google Chrome at `/Applications/Google Chrome.app`) — never bundled Chromium, no `playwright install` download step required. Scraper runs headed (`headless=False`).
- **Dedicated Chrome profile** at `~/.jobtracker/chrome-profile` (persistent context) — never Allen's everyday Chrome profile.
- **`salary` is display-only** — never an input to `prefilter`, `hardfilter`, or `score`.
- **`job_key` format:** `f"{source}:{external_id}"` where `source ∈ {jobright, jobright, swelist}`. For SWElist, `external_id` comes from the *resolved* posting URL (post simplify.jobs redirect).
- **Server on port 8080.** Tests use Flask's `test_client()` and never bind a port. The dev server has no auto-reload — after editing `app.py`/`db.py` a manual restart is needed for live use (not for tests).
- Python 3.14, `playwright==1.62.0` already installed. Run tests with `python3 -m pytest -v`.
- Frontend JS follows `static/app.js` conventions: vanilla `fetch`, `async` functions, no framework, `document.createElement` (no `innerHTML` string building except clearing with `""`).

---

## Task 1: DB migration — `seen_jobs` and `daily_picks` tables

**Files:**
- Modify: `db.py`
- Modify: `tests/test_db.py`

**Interfaces:**
- Produces: `db.init_db(db_path)` also creates `seen_jobs` and `daily_picks` (full schema below) on both fresh and pre-existing databases. Idempotent.
- Produces: `db.get_db(db_path)` unchanged — `sqlite3.Connection` with `row_factory = sqlite3.Row`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_db.py`:

```python
def test_init_db_creates_seen_jobs_and_daily_picks(tmp_path):
    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    conn = get_db(db_path)
    tables = {r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    seen_cols = {r["name"] for r in conn.execute("PRAGMA table_info(seen_jobs)").fetchall()}
    pick_cols = {r["name"] for r in conn.execute("PRAGMA table_info(daily_picks)").fetchall()}
    conn.close()
    assert {"seen_jobs", "daily_picks"} <= tables
    assert seen_cols == {
        "job_key", "source", "url", "company", "role",
        "first_seen", "last_seen", "disposition", "drop_reason",
    }
    assert pick_cols == {
        "id", "job_key", "source", "url", "company", "role", "location",
        "salary", "term", "app_type", "heuristic_score", "rank", "reasoning",
        "description", "first_run_date", "last_run_date", "status",
        "application_id", "created_at", "updated_at",
    }


def test_init_db_adds_new_tables_to_legacy_db(tmp_path):
    db_path = str(tmp_path / "legacy.db")
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date_applied TEXT NOT NULL, company TEXT NOT NULL, role TEXT NOT NULL,
            type TEXT NOT NULL, status TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()

    init_db(db_path)

    conn = get_db(db_path)
    tables = {r["name"] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    conn.close()
    assert {"seen_jobs", "daily_picks"} <= tables


def test_init_db_new_tables_idempotent(tmp_path):
    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    init_db(db_path)  # must not raise
    conn = get_db(db_path)
    n = conn.execute("SELECT COUNT(*) AS c FROM seen_jobs").fetchone()["c"]
    conn.close()
    assert n == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_db.py -v -k "seen_jobs or new_tables or legacy"`
Expected: FAIL — `sqlite3.OperationalError: no such table: seen_jobs`

- [ ] **Step 3: Implement the schema + migration**

In `db.py`, append both tables to `SCHEMA` (the `executescript` in `init_db` already runs `CREATE TABLE IF NOT EXISTS`, so this covers fresh AND legacy DBs — no separate migration code needed for whole new tables):

```python
SCHEMA = """
CREATE TABLE IF NOT EXISTS applications (
    ... (unchanged) ...
);

CREATE TABLE IF NOT EXISTS seen_jobs (
    job_key      TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    url          TEXT NOT NULL,
    company      TEXT DEFAULT '',
    role         TEXT DEFAULT '',
    first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen    TEXT NOT NULL DEFAULT (datetime('now')),
    disposition  TEXT NOT NULL,
    drop_reason  TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS daily_picks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    job_key         TEXT NOT NULL UNIQUE,
    source          TEXT NOT NULL,
    url             TEXT NOT NULL,
    company         TEXT NOT NULL,
    role            TEXT NOT NULL,
    location        TEXT DEFAULT '',
    salary          TEXT DEFAULT '',
    term            TEXT DEFAULT '',
    app_type        TEXT DEFAULT 'Other',
    heuristic_score INTEGER DEFAULT 0,
    rank            INTEGER,
    reasoning       TEXT DEFAULT '',
    description     TEXT DEFAULT '',
    first_run_date  TEXT NOT NULL,
    last_run_date   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'new',
    application_id  INTEGER,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
"""
```

Leave `MIGRATION_COLUMNS` and `_migrate` untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_db.py -v`
Expected: PASS (all, including the pre-existing tests)

- [ ] **Step 5: Commit**

```bash
git add db.py tests/test_db.py
git commit -m "feat: add seen_jobs and daily_picks tables"
```

---

## Task 2: `jobscan` package skeleton + data models

**Files:**
- Create: `jobscan/__init__.py` (empty)
- Create: `jobscan/adapters/__init__.py` (empty)
- Create: `jobscan/adapters/base.py`
- Create: `tests/test_jobscan_models.py`

**Interfaces:**
- Produces: `jobscan.adapters.base.JobCard` — frozen dataclass with fields `source: str, external_id: str, url: str, company: str, role: str, location: str, salary_hint: str, posted_at: str`.
- Produces: `jobscan.adapters.base.JobPosting` — dataclass subclass of `JobCard` adding `description: str, employment_type_hint: str, requirements_text: str`.
- Produces: `jobscan.adapters.base.job_key(source: str, external_id: str) -> str` → `f"{source}:{external_id}"`.
- Produces: `jobscan.adapters.base.external_id_from_url(url: str) -> str` — last non-empty path segment of the URL, query string stripped (e.g. `https://jobright.ai/jobs/abc123?ref=x` → `abc123`; trailing slash tolerated).

- [ ] **Step 1: Write the failing test**

Create `tests/test_jobscan_models.py`:

```python
from jobscan.adapters.base import JobCard, JobPosting, job_key, external_id_from_url


def test_job_key():
    assert job_key("jobright", "abc123") == "jobright:abc123"


def test_external_id_from_url_strips_query_and_slash():
    assert external_id_from_url("https://jobright.ai/jobs/abc123?ref=x") == "abc123"
    assert external_id_from_url("https://jobright.ai/p/xyz/") == "xyz"


def test_jobposting_is_a_jobcard():
    p = JobPosting(
        source="swelist", external_id="1", url="u", company="Acme", role="SWE Intern",
        location="Durham, NC", salary_hint="", posted_at="",
        description="full text", employment_type_hint="Internship", requirements_text="",
    )
    assert isinstance(p, JobCard)
    assert p.description == "full text"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_jobscan_models.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jobscan'`

- [ ] **Step 3: Implement**

Create `jobscan/__init__.py` and `jobscan/adapters/__init__.py` empty. Create `jobscan/adapters/base.py`:

```python
"""Data models and helpers shared by all source adapters."""
from __future__ import annotations

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


def job_key(source: str, external_id: str) -> str:
    return f"{source}:{external_id}"


def external_id_from_url(url: str) -> str:
    path = urlsplit(url).path.rstrip("/")
    return path.rsplit("/", 1)[-1] if path else url


class FeedAdapter(Protocol):
    source: str
    def feed_url(self) -> str: ...
    def walk_feed(self, page) -> Iterator[JobCard]: ...
    def extract_detail(self, page, card: JobCard) -> JobPosting: ...


class LinkAdapter(Protocol):
    source: str
    def resolve_and_extract(self, page, url: str) -> JobPosting: ...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_jobscan_models.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add jobscan/ tests/test_jobscan_models.py
git commit -m "feat: add jobscan package skeleton and data models"
```

---

## Task 3: `criteria.py` + `prefilter.py`

**Files:**
- Create: `jobscan/criteria.py`
- Create: `jobscan/prefilter.py`
- Create: `tests/test_prefilter.py`

**Interfaces:**
- Consumes: `jobscan.adapters.base.JobCard`, `JobPosting`.
- Produces: `jobscan.criteria` module-level constants: `INTEREST_KEYWORDS: list[str]`, `SENIORITY_EXCLUDE: list[str]`, `SENIORITY_BYPASS: list[str]`, `SPONSORSHIP_NEGATIVE: list[str]` (regex source strings), `CLEARANCE_NEGATIVE: list[str]`, `DEGREE_NEGATIVE: list[str]`, `PREFERRED_NEGATION: list[str]`, `FALL_SPRING_TERMS: list[str]`, `SUMMER_TERMS: list[str]`.
- Produces: `jobscan.criteria.is_us_location(location: str) -> bool`.
- Produces: `jobscan.prefilter.prefilter(item) -> str | None` where `item` is a `JobCard` or `JobPosting`; returns `"prefilter:location"` / `"prefilter:seniority"` / `"prefilter:role"` to drop, or `None` to keep. Uses `item.location` and `item.role`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_prefilter.py`:

```python
from jobscan.adapters.base import JobCard
from jobscan.prefilter import prefilter


def card(role="Firmware Engineer Intern", location="Austin, TX"):
    return JobCard("jobright", "1", "u", "Acme", role, location, "", "")


def test_keeps_relevant_us_intern():
    assert prefilter(card()) is None


def test_drops_non_us_location():
    assert prefilter(card(location="London, UK")) == "prefilter:location"


def test_keeps_remote_us():
    assert prefilter(card(location="Remote - US")) is None


def test_drops_senior_titles():
    assert prefilter(card(role="Senior Embedded Engineer")) == "prefilter:seniority"
    assert prefilter(card(role="Staff Hardware Engineer")) == "prefilter:seniority"


def test_seniority_bypass_for_new_grad():
    assert prefilter(card(role="Software Engineer, New Grad (University)")) is None


def test_drops_unrelated_role():
    assert prefilter(card(role="Marketing Coordinator")) == "prefilter:role"


def test_keeps_generic_swe():
    assert prefilter(card(role="Software Engineer Intern")) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_prefilter.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jobscan.prefilter'`

- [ ] **Step 3: Implement**

Create `jobscan/criteria.py`:

```python
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
    r"no\s+(?:visa\s+)?sponsorship",
    r"without\s+(?:the\s+need\s+for\s+)?(?:current\s+or\s+future\s+)?sponsorship",
    r"must\s+be\s+(?:a\s+)?u\.?s\.?\s+(?:citizen|person)",
    r"u\.?s\.?\s+citizen(?:ship)?\s+(?:is\s+)?required",
    r"citizens?\s+only",
    r"\bitar\b",
    r"export\s+control",
]

CLEARANCE_NEGATIVE = [
    r"security\s+clearance", r"ts/sci", r"active\s+(?:secret|clearance)",
    r"ability\s+to\s+obtain\s+a\s+clearance",
]

DEGREE_NEGATIVE = [
    r"(?:ph\.?d|master'?s|m\.?s\.?|m\.?eng)\s+(?:degree\s+)?(?:is\s+)?required",
    r"must\s+(?:be\s+)?(?:enrolled\s+in|pursuing|have)\s+a\s+(?:ph\.?d|master)",
    r"require[sd]?\s+a\s+(?:ph\.?d|master'?s|graduate\s+degree)",
]

# If any of these appears within ~60 chars of a DEGREE_NEGATIVE hit, don't drop.
PREFERRED_NEGATION = ["preferred", "a plus", "nice to have", "bonus", "or equivalent"]

SUMMER_TERMS = ["summer", "summer 2027", "summer 2026", "may 2027 start", "june start"]
FALL_SPRING_TERMS = [
    "fall 2026", "fall 2027", "spring 2027", "spring 2026", "winter 2027",
    "autumn 2026", "fall internship", "spring internship", "spring co-op", "fall co-op",
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
]


def is_us_location(location: str) -> bool:
    if not location:
        return True  # unknown → keep, let hardfilter/Claude judge
    low = location.lower()
    if any(h in low for h in _NON_US_HINTS):
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
```

Create `jobscan/prefilter.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_prefilter.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add jobscan/criteria.py jobscan/prefilter.py tests/test_prefilter.py
git commit -m "feat: add jobscan criteria vocabulary and prefilter"
```

---

## Task 4: `hardfilter.py` + term resolution

**Files:**
- Create: `jobscan/hardfilter.py`
- Create: `tests/test_hardfilter.py`

**Interfaces:**
- Consumes: `jobscan.criteria`, `jobscan.adapters.base.JobPosting`.
- Produces: `jobscan.hardfilter.resolve_term(posting: JobPosting, today: datetime.date | None = None) -> str` → one of `"Summer <year>"`, `"New Grad"`, `"Unknown"`. Full-time non-intern roles → `"New Grad"`. Internship with a summer signal → `"Summer <year>"` (year = next summer relative to `today`). Internship with only fall/spring signal → `"Fall/Spring"`. Else `"Unknown"`.
- Produces: `jobscan.hardfilter.hardfilter(posting: JobPosting, today=None) -> str | None` → drop reason string (`"no-sponsorship"`, `"clearance"`, `"degree"`, `"term:Fall/Spring"`) or `None`. Scans `posting.description + " " + posting.requirements_text`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_hardfilter.py`:

```python
import datetime
from jobscan.adapters.base import JobPosting
from jobscan.hardfilter import hardfilter, resolve_term

TODAY = datetime.date(2026, 9, 2)


def posting(desc="", role="Firmware Engineer Intern", etype="Internship", reqs=""):
    return JobPosting(
        source="jobright", external_id="1", url="u", company="Acme", role=role,
        location="Austin, TX", salary_hint="", posted_at="",
        description=desc, employment_type_hint=etype, requirements_text=reqs,
    )


def test_clean_posting_passes():
    assert hardfilter(posting(desc="Great summer internship for ECE students."), today=TODAY) is None


def test_drops_no_sponsorship():
    assert hardfilter(posting(desc="We do not sponsor visas for this role."), today=TODAY) == "no-sponsorship"
    assert hardfilter(posting(desc="Candidates must be a U.S. Citizen."), today=TODAY) == "no-sponsorship"


def test_drops_clearance():
    assert hardfilter(posting(desc="Active security clearance required."), today=TODAY) == "clearance"


def test_drops_phd_required():
    assert hardfilter(posting(desc="PhD in EE is required."), today=TODAY) == "degree"


def test_masters_preferred_not_dropped():
    assert hardfilter(posting(desc="Master's degree preferred but not required."), today=TODAY) is None


def test_drops_fall_only_internship():
    p = posting(desc="This is a Fall 2026 internship, no summer option.")
    assert hardfilter(p, today=TODAY) == "term:Fall/Spring"


def test_resolve_term_summer():
    assert resolve_term(posting(desc="Summer 2027 internship"), today=TODAY) == "Summer 2027"


def test_resolve_term_new_grad_fulltime():
    p = posting(role="Software Engineer, New Grad", etype="Full-time",
                desc="Join our team full time.")
    assert resolve_term(p, today=TODAY) == "New Grad"


def test_resolve_term_unknown():
    assert resolve_term(posting(desc="An internship."), today=TODAY) == "Unknown"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_hardfilter.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jobscan.hardfilter'`

- [ ] **Step 3: Implement**

Create `jobscan/hardfilter.py`:

```python
"""Full-text auto-drop. Conservative: only drops on explicit language;
anything ambiguous is kept and tagged term='Unknown' for Claude to judge."""
from __future__ import annotations

import datetime
import re

from jobscan import criteria
from jobscan.adapters.base import JobPosting

_SPONSOR = [re.compile(p, re.I) for p in criteria.SPONSORSHIP_NEGATIVE]
_CLEAR = [re.compile(p, re.I) for p in criteria.CLEARANCE_NEGATIVE]
_DEGREE = [re.compile(p, re.I) for p in criteria.DEGREE_NEGATIVE]


def _is_internship(posting: JobPosting) -> bool:
    blob = f"{posting.role} {posting.employment_type_hint}".lower()
    return "intern" in blob or "co-op" in blob or "coop" in blob


def _degree_dropped(text: str) -> bool:
    for rx in _DEGREE:
        m = rx.search(text)
        if not m:
            continue
        window = text[max(0, m.start() - 60): m.end() + 60].lower()
        if any(neg in window for neg in criteria.PREFERRED_NEGATION):
            continue
        return True
    return False


def resolve_term(posting: JobPosting, today: datetime.date | None = None) -> str:
    today = today or datetime.date.today()
    text = f"{posting.role} {posting.description} {posting.requirements_text}".lower()

    if not _is_internship(posting):
        return "New Grad"

    has_summer = any(t in text for t in criteria.SUMMER_TERMS)
    has_fall_spring = any(t in text for t in criteria.FALL_SPRING_TERMS)

    if has_summer:
        summer_year = today.year if today.month <= 5 else today.year + 1
        return f"Summer {summer_year}"
    if has_fall_spring:
        return "Fall/Spring"
    return "Unknown"


def hardfilter(posting: JobPosting, today: datetime.date | None = None) -> str | None:
    text = f"{posting.description}\n{posting.requirements_text}"

    if any(rx.search(text) for rx in _SPONSOR):
        return "no-sponsorship"
    if any(rx.search(text) for rx in _CLEAR):
        return "clearance"
    if _degree_dropped(text):
        return "degree"
    if resolve_term(posting, today) == "Fall/Spring":
        return "term:Fall/Spring"
    return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_hardfilter.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add jobscan/hardfilter.py tests/test_hardfilter.py
git commit -m "feat: add jobscan hardfilter and term resolution"
```

---

## Task 5: `score.py`

**Files:**
- Create: `jobscan/score.py`
- Create: `tests/test_score.py`

**Interfaces:**
- Consumes: `jobscan.criteria`, `jobscan.hardfilter.resolve_term`, `jobscan.adapters.base.JobPosting`.
- Produces: `jobscan.score.score(posting: JobPosting, today=None) -> int` in `[0, 100]`. Weighted: interest-keyword hits in role (×6, cap 30) + in description (×2, cap 20); term bonus (`Summer *` or `New Grad` → +25, `Unknown` → +5, `Fall/Spring` → 0); hardware/embedded/ECE bonus in role → +15; recency (`posted_at` within 2 days → +10, within 7 → +5). Salary is never used. Clamp to 100.

- [ ] **Step 1: Write the failing test**

Create `tests/test_score.py`:

```python
import datetime
from jobscan.adapters.base import JobPosting
from jobscan.score import score

TODAY = datetime.date(2026, 9, 2)


def p(role, desc="", posted_at="", etype="Internship"):
    return JobPosting("jobright", "1", "u", "Acme", role, "Austin, TX", "", posted_at,
                      desc, etype, "")


def test_summer_ece_intern_outranks_generic_unknown_swe():
    strong = p("Embedded Firmware Engineer Intern",
               "Summer 2027 internship working on RTOS and microcontrollers", "2026-09-01")
    weak = p("Software Engineer Intern", "Build web features.")
    assert score(strong, TODAY) > score(weak, TODAY)


def test_score_is_bounded():
    maxed = p("Embedded Hardware Firmware ECE FPGA Engineer Intern",
              "embedded firmware hardware fpga rtl pcb analog " * 10 + " summer 2027",
              "2026-09-02")
    assert 0 <= score(maxed, TODAY) <= 100


def test_fall_spring_gets_no_term_bonus():
    fall = p("Firmware Intern", "Fall 2026 internship")
    unknown = p("Firmware Intern", "An internship")
    assert score(unknown, TODAY) > score(fall, TODAY)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_score.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jobscan.score'`

- [ ] **Step 3: Implement**

Create `jobscan/score.py`:

```python
"""Rough 0-100 heuristic. Only used to bound how many survivors Claude
hand-reviews; Claude sets the final rank. Salary is not an input."""
from __future__ import annotations

import datetime

from jobscan import criteria
from jobscan.adapters.base import JobPosting
from jobscan.hardfilter import resolve_term

_HW_HINTS = ["embedded", "firmware", "hardware", "ece", "electrical", "fpga", "asic", "rtl", "pcb"]


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

    if posting.posted_at:
        try:
            d = datetime.date.fromisoformat(posting.posted_at[:10])
            age = (today - d).days
            if age <= 2:
                total += 10
            elif age <= 7:
                total += 5
        except ValueError:
            pass

    return max(0, min(total, 100))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_score.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add jobscan/score.py tests/test_score.py
git commit -m "feat: add jobscan heuristic score"
```

---

## Task 6: `seen.py` — the `seen_jobs` cache

**Files:**
- Create: `jobscan/seen.py`
- Create: `tests/test_seen.py`

**Interfaces:**
- Consumes: `db.get_db`, `db.init_db`.
- Produces: `jobscan.seen.is_seen(conn, key: str) -> bool` — True if a `seen_jobs` row with that `job_key` exists.
- Produces: `jobscan.seen.disposition_of(conn, key: str) -> str | None`.
- Produces: `jobscan.seen.record(conn, *, key, source, url, disposition, drop_reason="", company="", role="") -> None` — upsert: insert if absent (sets `first_seen`/`last_seen` = now); if present, update `disposition`, `drop_reason`, `last_seen` = now, and fill `company`/`role` if the new value is non-empty. Commits.
- Produces: `jobscan.seen.bump(conn, key: str) -> None` — sets `last_seen` = now if the row exists. Commits.
- Produces: `jobscan.seen.TERMINAL = {"applied", "deleted"}` — dispositions the scanner must never overwrite.

- [ ] **Step 1: Write the failing test**

Create `tests/test_seen.py`:

```python
from db import init_db, get_db
from jobscan import seen


def conn_for(tmp_path):
    db_path = str(tmp_path / "t.db")
    init_db(db_path)
    return get_db(db_path)


def test_record_then_is_seen(tmp_path):
    c = conn_for(tmp_path)
    assert seen.is_seen(c, "jobright:1") is False
    seen.record(c, key="jobright:1", source="jobright", url="u", disposition="candidate")
    assert seen.is_seen(c, "jobright:1") is True
    assert seen.disposition_of(c, "jobright:1") == "candidate"


def test_record_upserts_disposition(tmp_path):
    c = conn_for(tmp_path)
    seen.record(c, key="jobright:1", source="jobright", url="u", disposition="candidate")
    seen.record(c, key="jobright:1", source="jobright", url="u",
                disposition="dropped", drop_reason="term:Fall/Spring")
    assert seen.disposition_of(c, "jobright:1") == "dropped"
    row = c.execute("SELECT drop_reason FROM seen_jobs WHERE job_key='jobright:1'").fetchone()
    assert row["drop_reason"] == "term:Fall/Spring"


def test_record_fills_company_role_when_nonempty(tmp_path):
    c = conn_for(tmp_path)
    seen.record(c, key="jobright:1", source="jobright", url="u", disposition="dropped")
    seen.record(c, key="jobright:1", source="jobright", url="u", disposition="dropped",
                company="Acme", role="SWE Intern")
    row = c.execute("SELECT company, role FROM seen_jobs WHERE job_key='jobright:1'").fetchone()
    assert row["company"] == "Acme" and row["role"] == "SWE Intern"


def test_bump_updates_last_seen_only(tmp_path):
    c = conn_for(tmp_path)
    seen.record(c, key="jobright:1", source="jobright", url="u", disposition="candidate")
    seen.bump(c, "jobright:1")
    assert seen.disposition_of(c, "jobright:1") == "candidate"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_seen.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jobscan.seen'`

- [ ] **Step 3: Implement**

Create `jobscan/seen.py`:

```python
"""Read/write helpers for the seen_jobs cache. The scanner skips any job_key
already present, so repeat scans do almost no work and deleted/applied jobs
never resurface."""
from __future__ import annotations

import sqlite3

TERMINAL = {"applied", "deleted"}


def is_seen(conn: sqlite3.Connection, key: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM seen_jobs WHERE job_key = ?", (key,)
    ).fetchone() is not None


def disposition_of(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute(
        "SELECT disposition FROM seen_jobs WHERE job_key = ?", (key,)
    ).fetchone()
    return row["disposition"] if row else None


def record(conn, *, key, source, url, disposition, drop_reason="", company="", role=""):
    existing = conn.execute(
        "SELECT company, role FROM seen_jobs WHERE job_key = ?", (key,)
    ).fetchone()
    if existing is None:
        conn.execute(
            """INSERT INTO seen_jobs
               (job_key, source, url, company, role, disposition, drop_reason)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (key, source, url, company, role, disposition, drop_reason),
        )
    else:
        conn.execute(
            """UPDATE seen_jobs
               SET disposition = ?, drop_reason = ?, last_seen = datetime('now'),
                   company = ?, role = ?
               WHERE job_key = ?""",
            (
                disposition,
                drop_reason,
                company or existing["company"],
                role or existing["role"],
                key,
            ),
        )
    conn.commit()


def bump(conn, key: str) -> None:
    conn.execute(
        "UPDATE seen_jobs SET last_seen = datetime('now') WHERE job_key = ?", (key,)
    )
    conn.commit()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_seen.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add jobscan/seen.py tests/test_seen.py
git commit -m "feat: add seen_jobs cache helpers"
```

---

## Task 7: `swelist_links.py` — extract posting links from the digest email

**Files:**
- Create: `jobscan/swelist_links.py`
- Create: `tests/fixtures/swelist/digest_email.html`
- Create: `tests/test_swelist_links.py`

**Interfaces:**
- Produces: `jobscan.swelist_links.extract_job_links(html: str) -> list[dict]` — each dict `{"url": str, "company_hint": str, "role_hint": str}`. Returns links to `simplify.jobs` / `app.simplify.jobs` job URLs only; skips `unsubscribe`, `swelist.com` nav, `mailto:`, and social links. De-duplicates by URL, preserving order. `company_hint`/`role_hint` come from the link's visible text or nearest heading; `""` if not determinable.

- [ ] **Step 1: Create the fixture**

Create `tests/fixtures/swelist/digest_email.html` — a minimal stand-in for the SWElist digest structure (a real captured digest replaces this in Task 16's manual step; this fixture locks the parsing contract):

```html
<html><body>
  <h1>SWElist — Today's Internships</h1>
  <table>
    <tr><td>
      <a href="https://simplify.jobs/p/abc123/Firmware-Engineer-Intern">Anduril — Firmware Engineer Intern</a>
    </td></tr>
    <tr><td>
      <a href="https://app.simplify.jobs/p/def456">Software Engineer Intern @ Ramp</a>
    </td></tr>
    <tr><td>
      <a href="https://simplify.jobs/p/abc123/Firmware-Engineer-Intern">Anduril — Firmware Engineer Intern</a>
    </td></tr>
  </table>
  <a href="https://swelist.com/unsubscribe?u=1">Unsubscribe</a>
  <a href="https://twitter.com/swelist">Follow us</a>
  <a href="mailto:hi@swelist.com">Contact</a>
</body></html>
```

- [ ] **Step 2: Write the failing test**

Create `tests/test_swelist_links.py`:

```python
from pathlib import Path
from jobscan.swelist_links import extract_job_links

FIXTURE = (Path(__file__).parent / "fixtures/swelist/digest_email.html").read_text()


def test_extracts_only_simplify_job_links_deduped():
    links = extract_job_links(FIXTURE)
    urls = [l["url"] for l in links]
    assert urls == [
        "https://simplify.jobs/p/abc123/Firmware-Engineer-Intern",
        "https://app.simplify.jobs/p/def456",
    ]


def test_skips_unsubscribe_social_mailto():
    links = extract_job_links(FIXTURE)
    assert all("unsubscribe" not in l["url"] and "twitter" not in l["url"] for l in links)


def test_captures_visible_text_as_hint():
    links = extract_job_links(FIXTURE)
    assert "Anduril" in links[0]["company_hint"] or "Anduril" in links[0]["role_hint"]
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python3 -m pytest tests/test_swelist_links.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jobscan.swelist_links'`

- [ ] **Step 4: Implement**

Create `jobscan/swelist_links.py` (uses only the stdlib `html.parser` — no new dependency):

```python
"""Pull job-posting links out of a SWElist digest email. SWElist wraps each
posting as a simplify.jobs URL; everything else in the email is nav/social."""
from __future__ import annotations

from html.parser import HTMLParser

_JOB_HOSTS = ("simplify.jobs/p/", "app.simplify.jobs/p/")
_SKIP = ("unsubscribe", "swelist.com", "mailto:", "twitter.com", "linkedin.com/company",
         "instagram.com", "facebook.com")


class _LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links: list[dict] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href", "")
            self._href = href
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            self._flush()
            self._href = None

    def _flush(self):
        href = (self._href or "").strip()
        low = href.lower()
        if not any(h in low for h in _JOB_HOSTS):
            return
        if any(s in low for s in _SKIP):
            return
        text = " ".join("".join(self._text).split()).strip()
        company_hint, role_hint = _split_hint(text)
        self.links.append({"url": href, "company_hint": company_hint, "role_hint": role_hint})


def _split_hint(text: str) -> tuple[str, str]:
    for sep in (" — ", " – ", " - ", " @ "):
        if sep in text:
            a, b = text.split(sep, 1)
            if sep == " @ ":
                return b.strip(), a.strip()  # "Role @ Company"
            return a.strip(), b.strip()      # "Company - Role"
    return "", text


def extract_job_links(html: str) -> list[dict]:
    p = _LinkParser()
    p.feed(html)
    seen: set[str] = set()
    out: list[dict] = []
    for link in p.links:
        if link["url"] in seen:
            continue
        seen.add(link["url"])
        out.append(link)
    return out
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python3 -m pytest tests/test_swelist_links.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add jobscan/swelist_links.py tests/fixtures/swelist/digest_email.html tests/test_swelist_links.py
git commit -m "feat: add SWElist digest link extraction"
```

---

## Task 8: Playwright test harness + `jobscan/profile.py`

**Files:**
- Create: `jobscan/profile.py`
- Create: `tests/conftest.py`
- Modify: `requirements.txt`
- Modify: `pytest.ini`
- Create: `tests/test_playwright_harness.py`

**Interfaces:**
- Consumes: `playwright.sync_api`.
- Produces: `jobscan.profile.PROFILE_DIR: pathlib.Path` = `~/.jobtracker/chrome-profile`.
- Produces: `jobscan.profile.launch(headless: bool = False)` — context manager yielding `(context, page)` from a **persistent** Chrome context at `PROFILE_DIR`, `channel="chrome"`. Caller uses `page` for scraping; closing the context on exit persists cookies/session.
- Produces: `tests/conftest.py` fixture `chrome_page` — yields a `Page` from a **fresh, non-persistent** Chrome context (`channel="chrome"`, headless), for loading HTML fixtures via `page.set_content(...)`. Function-scoped.
- Produces: `pytest.ini` registers marker `live` (tests hitting real logged-in sites; skipped unless `--run-live`) and a `--run-live` CLI option.

- [ ] **Step 1: Add the dependency and marker**

`requirements.txt`:

```
Flask>=3.0
pytest>=8.0
playwright>=1.62
```

`pytest.ini`:

```
[pytest]
pythonpath = .
markers =
    live: hits real logged-in job sites; skipped unless --run-live is passed
```

- [ ] **Step 2: Write the failing test**

Create `tests/test_playwright_harness.py`:

```python
def test_chrome_page_can_load_content(chrome_page):
    chrome_page.set_content("<h1 id='x'>hello</h1>")
    assert chrome_page.text_content("#x") == "hello"


def test_profile_dir_is_under_home():
    from jobscan.profile import PROFILE_DIR
    assert PROFILE_DIR.name == "chrome-profile"
    assert ".jobtracker" in str(PROFILE_DIR)
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python3 -m pytest tests/test_playwright_harness.py -v`
Expected: FAIL — `fixture 'chrome_page' not found` / `ModuleNotFoundError: jobscan.profile`

- [ ] **Step 4: Implement**

Create `jobscan/profile.py`:

```python
"""Dedicated, persistent Chrome profile for the scraper. Allen logs into
jobright + jobright once in this profile; the session persists across runs.
Never touches Allen's everyday Chrome profile."""
from __future__ import annotations

import contextlib
from pathlib import Path

from playwright.sync_api import sync_playwright

PROFILE_DIR = Path.home() / ".jobtracker" / "chrome-profile"


@contextlib.contextmanager
def launch(headless: bool = False):
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            channel="chrome",
            headless=headless,
            viewport={"width": 1440, "height": 900},
        )
        page = context.pages[0] if context.pages else context.new_page()
        try:
            yield context, page
        finally:
            context.close()
```

Create `tests/conftest.py`:

```python
import pytest


def pytest_addoption(parser):
    parser.addoption("--run-live", action="store_true", default=False,
                     help="run tests marked 'live' against real logged-in sites")


def pytest_collection_modifyitems(config, items):
    if config.getoption("--run-live"):
        return
    skip_live = pytest.mark.skip(reason="needs --run-live")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip_live)


@pytest.fixture
def chrome_page():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)
        page = browser.new_page()
        try:
            yield page
        finally:
            browser.close()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python3 -m pytest tests/test_playwright_harness.py -v`
Expected: PASS (Chrome launches headless; if it errors with "channel 'chrome' not found", install Google Chrome or run `playwright install chrome`)

- [ ] **Step 6: Commit**

```bash
git add jobscan/profile.py tests/conftest.py requirements.txt pytest.ini tests/test_playwright_harness.py
git commit -m "feat: add Playwright chrome harness and dedicated profile"
```

---

## Task 9: jobright.ai adapter

**Files:**
- Create: `jobscan/adapters/jobright.py`
- Create: `tests/fixtures/jobright/feed.html` (captured — see Step 1)
- Create: `tests/fixtures/jobright/detail_clean.html`, `detail_sponsorship.html`, `detail_fall_term.html` (captured)
- Create: `tests/test_adapter_jobright.py`
- Create: `scripts/capture_fixture.py`

**Interfaces:**
- Consumes: `jobscan.adapters.base` (`JobCard`, `JobPosting`, `job_key`, `external_id_from_url`).
- Produces: `jobscan.adapters.jobright.JobrightAdapter` with `source = "jobright"`, `feed_url() -> str`, `walk_feed(page) -> Iterator[JobCard]`, `extract_detail(page, card) -> JobPosting`.
- Produces: `jobscan.adapters.jobright.parse_cards(page) -> list[JobCard]` — pure parse of whatever is currently in the DOM (no scrolling). `walk_feed` wraps this with a scroll loop and the stop conditions.
- Produces: `jobscan.adapters.jobright.parse_detail(page, card) -> JobPosting`.
- Produces module constant `SELECTORS: dict[str, str]` — every CSS selector the adapter uses, in one dict, so selector drift is a one-line fix.
- Produces `jobscan.adapters.jobright.LoginRequired` exception; `walk_feed` raises it when the feed shows a login wall.

- [ ] **Step 1: Capture real fixtures (manual, needs Allen logged in)**

Create `scripts/capture_fixture.py`:

```python
"""Save the current DOM of a page to a fixture file, using the dedicated
Chrome profile (so you stay logged in). Usage:
    python3 scripts/capture_fixture.py <url> <output_path>
Opens headed; waits for you to press Enter so you can log in / dismiss
modals before it snapshots."""
import sys
from jobscan.profile import launch


def main(url, out_path):
    with launch(headless=False) as (context, page):
        page.goto(url, wait_until="domcontentloaded")
        input(f"Navigated to {url}. Log in / load the page, then press Enter to snapshot...")
        html = page.content()
        with open(out_path, "w") as f:
            f.write(html)
        print(f"wrote {out_path} ({len(html)} bytes)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
```

Run these (Allen present to log in the first time):

```bash
python3 scripts/capture_fixture.py "https://jobright.ai/jobs/recommend" tests/fixtures/jobright/feed.html
# then open 3 individual postings and capture each:
python3 scripts/capture_fixture.py "<a clean US intern posting URL>"        tests/fixtures/jobright/detail_clean.html
python3 scripts/capture_fixture.py "<a posting with a no-sponsorship line>" tests/fixtures/jobright/detail_sponsorship.html
python3 scripts/capture_fixture.py "<a Fall/Spring-only internship URL>"    tests/fixtures/jobright/detail_fall_term.html
```

Then open each fixture and identify the selectors: the element repeated per job card, and within it the company, role, location, salary, posted-date, and the link to the detail page; on a detail page, the container holding the full description and (if separable) the requirements section. Record them in `SELECTORS`.

- [ ] **Step 2: Write the failing test**

Create `tests/test_adapter_jobright.py`:

```python
from pathlib import Path
from jobscan.adapters.jobright import JobrightAdapter, parse_cards, parse_detail
from jobscan.adapters.base import JobCard
from jobscan.hardfilter import hardfilter

FX = Path(__file__).parent / "fixtures/jobright"


def load(chrome_page, name):
    chrome_page.set_content((FX / name).read_text())
    return chrome_page


def test_parse_cards_returns_jobcards(chrome_page):
    cards = parse_cards(load(chrome_page, "feed.html"))
    assert len(cards) >= 1
    c = cards[0]
    assert c.source == "jobright"
    assert c.company and c.role and c.url
    assert c.external_id  # non-empty


def test_parse_detail_clean(chrome_page):
    card = JobCard("jobright", "x", "u", "Acme", "Firmware Intern", "Austin, TX", "", "")
    posting = parse_detail(load(chrome_page, "detail_clean.html"), card)
    assert len(posting.description) > 100
    assert hardfilter(posting) is None


def test_parse_detail_sponsorship_is_dropped(chrome_page):
    card = JobCard("jobright", "x", "u", "Acme", "SWE Intern", "Austin, TX", "", "")
    posting = parse_detail(load(chrome_page, "detail_sponsorship.html"), card)
    assert hardfilter(posting) == "no-sponsorship"


def test_parse_detail_fall_term_is_dropped(chrome_page):
    card = JobCard("jobright", "x", "u", "Acme", "SWE Intern", "Austin, TX", "", "")
    posting = parse_detail(load(chrome_page, "detail_fall_term.html"), card)
    assert hardfilter(posting) == "term:Fall/Spring"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python3 -m pytest tests/test_adapter_jobright.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jobscan.adapters.jobright'`

- [ ] **Step 4: Implement**

Create `jobscan/adapters/jobright.py`. Fill `SELECTORS` from Step 1. The parsing logic, stop conditions, and `JobPosting` assembly are fixed:

```python
"""jobright.ai adapter. All site-specific CSS lives in SELECTORS so drift is
a one-line fix; run tests/test_adapter_jobright.py against fresh fixtures
after any change."""
from __future__ import annotations

import time
from typing import Iterator

from jobscan.adapters.base import JobCard, JobPosting, external_id_from_url

MAX_CARDS = 300
CONSECUTIVE_SEEN_STOP = 15

# >>> Fill each value by inspecting tests/fixtures/jobright/*.html (Task 9 Step 1). <<<
SELECTORS = {
    "login_wall": "",     # a selector present ONLY on the logged-out page
    "card": "",           # repeated per job card
    "card_company": "",
    "card_role": "",
    "card_location": "",
    "card_salary": "",
    "card_posted": "",
    "card_link": "",      # <a> to the detail page (href)
    "detail_description": "",
    "detail_requirements": "",  # "" if not separable
}


class LoginRequired(RuntimeError):
    pass


def feed_url() -> str:
    return "https://jobright.ai/jobs/recommend"


def _text(el) -> str:
    return (el.inner_text() if el else "").strip()


def parse_cards(page) -> list[JobCard]:
    cards: list[JobCard] = []
    for node in page.query_selector_all(SELECTORS["card"]):
        link = node.query_selector(SELECTORS["card_link"])
        href = link.get_attribute("href") if link else None
        if not href:
            continue
        url = href if href.startswith("http") else f"https://jobright.ai{href}"
        cards.append(JobCard(
            source="jobright",
            external_id=external_id_from_url(url),
            url=url,
            company=_text(node.query_selector(SELECTORS["card_company"])),
            role=_text(node.query_selector(SELECTORS["card_role"])),
            location=_text(node.query_selector(SELECTORS["card_location"])),
            salary_hint=_text(node.query_selector(SELECTORS["card_salary"])),
            posted_at=_text(node.query_selector(SELECTORS["card_posted"])),
        ))
    return cards


class JobrightAdapter:
    source = "jobright"

    def feed_url(self) -> str:
        return feed_url()

    def walk_feed(self, page, is_seen=lambda key: False) -> Iterator[JobCard]:
        page.goto(self.feed_url(), wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        if SELECTORS["login_wall"] and page.query_selector(SELECTORS["login_wall"]):
            raise LoginRequired("jobright")

        emitted: set[str] = set()
        consecutive_seen = 0
        last_count = -1
        while len(emitted) < MAX_CARDS:
            for card in parse_cards(page):
                key = f"{card.source}:{card.external_id}"
                if key in emitted:
                    continue
                emitted.add(key)
                if is_seen(key):
                    consecutive_seen += 1
                    if consecutive_seen >= CONSECUTIVE_SEEN_STOP:
                        return
                    continue
                consecutive_seen = 0
                yield card
            page.mouse.wheel(0, 20000)
            page.wait_for_timeout(1500)
            count = len(page.query_selector_all(SELECTORS["card"]))
            if count == last_count:  # no new cards loaded → feed exhausted
                return
            last_count = count

    def extract_detail(self, page, card: JobCard) -> JobPosting:
        return parse_detail_via_goto(page, card)


def parse_detail(page, card: JobCard) -> JobPosting:
    desc_el = page.query_selector(SELECTORS["detail_description"])
    req_el = page.query_selector(SELECTORS["detail_requirements"]) if SELECTORS["detail_requirements"] else None
    return JobPosting(
        source=card.source, external_id=card.external_id, url=card.url,
        company=card.company, role=card.role, location=card.location,
        salary_hint=card.salary_hint, posted_at=card.posted_at,
        description=_text(desc_el),
        employment_type_hint="",
        requirements_text=_text(req_el),
    )


def parse_detail_via_goto(page, card: JobCard) -> JobPosting:
    page.goto(card.url, wait_until="domcontentloaded")
    page.wait_for_timeout(1500)
    return parse_detail(page, card)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python3 -m pytest tests/test_adapter_jobright.py -v`
Expected: PASS. If a selector is wrong, fix that one `SELECTORS` value and re-run.

- [ ] **Step 6: Commit**

```bash
git add jobscan/adapters/jobright.py scripts/capture_fixture.py tests/fixtures/jobright/ tests/test_adapter_jobright.py
git commit -m "feat: add jobright.ai adapter"
```

---

## Task 10: jobright.ai adapter

**Files:**
- Create: `jobscan/adapters/jobright.py`
- Create: `tests/fixtures/jobright/feed.html`, `detail_clean.html`, `detail_sponsorship.html`, `detail_fall_term.html` (captured)
- Create: `tests/test_adapter_jobright.py`

**Interfaces:**
- Consumes: `jobscan.adapters.base`, `scripts/capture_fixture.py` (from Task 9).
- Produces: `jobscan.adapters.jobright.RunwayAdapter` with `source = "jobright"`, same method set as `JobrightAdapter` (`feed_url`, `walk_feed(page, is_seen=...)`, `extract_detail(page, card)`).
- Produces: `jobscan.adapters.jobright.parse_cards(page) -> list[JobCard]`, `parse_detail(page, card) -> JobPosting`, `SELECTORS: dict[str,str]`, `LoginRequired`.

- [ ] **Step 1: Capture real fixtures (manual, needs Allen logged in)**

```bash
python3 scripts/capture_fixture.py "<jobright.ai recommended-jobs feed URL>" tests/fixtures/jobright/feed.html
python3 scripts/capture_fixture.py "<clean US intern posting>"             tests/fixtures/jobright/detail_clean.html
python3 scripts/capture_fixture.py "<no-sponsorship posting>"              tests/fixtures/jobright/detail_sponsorship.html
python3 scripts/capture_fixture.py "<Fall/Spring-only internship>"         tests/fixtures/jobright/detail_fall_term.html
```

Inspect each and record the per-card and detail selectors in `SELECTORS`.

- [ ] **Step 2: Write the failing test**

Create `tests/test_adapter_jobright.py`:

```python
from pathlib import Path
from jobscan.adapters.jobright import parse_cards, parse_detail
from jobscan.adapters.base import JobCard
from jobscan.hardfilter import hardfilter

FX = Path(__file__).parent / "fixtures/jobright"


def load(chrome_page, name):
    chrome_page.set_content((FX / name).read_text())
    return chrome_page


def test_parse_cards_returns_jobcards(chrome_page):
    cards = parse_cards(load(chrome_page, "feed.html"))
    assert len(cards) >= 1
    assert cards[0].source == "jobright"
    assert cards[0].company and cards[0].role and cards[0].url and cards[0].external_id


def test_parse_detail_clean(chrome_page):
    card = JobCard("jobright", "x", "u", "Acme", "Firmware Intern", "Austin, TX", "", "")
    posting = parse_detail(load(chrome_page, "detail_clean.html"), card)
    assert len(posting.description) > 100
    assert hardfilter(posting) is None


def test_parse_detail_sponsorship_is_dropped(chrome_page):
    card = JobCard("jobright", "x", "u", "Acme", "SWE Intern", "Austin, TX", "", "")
    posting = parse_detail(load(chrome_page, "detail_sponsorship.html"), card)
    assert hardfilter(posting) == "no-sponsorship"


def test_parse_detail_fall_term_is_dropped(chrome_page):
    card = JobCard("jobright", "x", "u", "Acme", "SWE Intern", "Austin, TX", "", "")
    posting = parse_detail(load(chrome_page, "detail_fall_term.html"), card)
    assert hardfilter(posting) == "term:Fall/Spring"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python3 -m pytest tests/test_adapter_jobright.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jobscan.adapters.jobright'`

- [ ] **Step 4: Implement**

Create `jobscan/adapters/jobright.py` with the same structure as `jobscan/adapters/jobright.py` (Task 9 Step 4): module-level `MAX_CARDS = 300`, `CONSECUTIVE_SEEN_STOP = 15`, `SELECTORS` dict with the same keys, `LoginRequired`, `feed_url()`, `_text(el)`, `parse_cards(page)`, `parse_detail(page, card)`, `parse_detail_via_goto(page, card)`, and:

```python
class RunwayAdapter:
    source = "jobright"

    def feed_url(self) -> str:
        return feed_url()

    def walk_feed(self, page, is_seen=lambda key: False):
        page.goto(self.feed_url(), wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        if SELECTORS["login_wall"] and page.query_selector(SELECTORS["login_wall"]):
            raise LoginRequired("jobright")

        emitted: set[str] = set()
        consecutive_seen = 0
        last_count = -1
        while len(emitted) < MAX_CARDS:
            for card in parse_cards(page):
                key = f"{card.source}:{card.external_id}"
                if key in emitted:
                    continue
                emitted.add(key)
                if is_seen(key):
                    consecutive_seen += 1
                    if consecutive_seen >= CONSECUTIVE_SEEN_STOP:
                        return
                    continue
                consecutive_seen = 0
                yield card
            page.mouse.wheel(0, 20000)
            page.wait_for_timeout(1500)
            count = len(page.query_selector_all(SELECTORS["card"]))
            if count == last_count:
                return
            last_count = count

    def extract_detail(self, page, card):
        return parse_detail_via_goto(page, card)
```

Set `feed_url()` to the jobright.ai recommended-jobs URL found in Step 1. In `parse_cards`, build absolute URLs against `https://jobright.ai` if hrefs are relative.

- [ ] **Step 5: Run test to verify it passes**

Run: `python3 -m pytest tests/test_adapter_jobright.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add jobscan/adapters/jobright.py tests/fixtures/jobright/ tests/test_adapter_jobright.py
git commit -m "feat: add jobright.ai adapter"
```

---

## Task 11: SWElist adapter (`resolve_and_extract`)

**Files:**
- Create: `jobscan/adapters/swelist.py`
- Create: `tests/fixtures/swelist/simplify_posting.html` (captured)
- Create: `tests/test_adapter_swelist.py`

**Interfaces:**
- Consumes: `jobscan.adapters.base`.
- Produces: `jobscan.adapters.swelist.SwelistAdapter` with `source = "swelist"` and `resolve_and_extract(page, url: str, company_hint="", role_hint="") -> JobPosting`. Navigates to `url`, waits for the simplify.jobs redirect/render to settle, extracts company/role/location/description; `external_id` from `page.url` (the resolved URL). Raises `jobscan.adapters.swelist.ResolveError` if the posting page has no description container (dead link / removed posting).
- Produces: `jobscan.adapters.swelist.parse_posting(page, url, company_hint, role_hint) -> JobPosting` — pure parse of current DOM (fixture-testable).
- Produces `SELECTORS: dict[str,str]`.

- [ ] **Step 1: Capture a real resolved posting (manual)**

```bash
python3 scripts/capture_fixture.py "<a simplify.jobs/p/... URL from a recent SWElist email>" tests/fixtures/swelist/simplify_posting.html
```

Inspect it: find the company, role, location, and full-description selectors on the simplify.jobs posting page. Record in `SELECTORS`.

- [ ] **Step 2: Write the failing test**

Create `tests/test_adapter_swelist.py`:

```python
from pathlib import Path
from jobscan.adapters.swelist import parse_posting
from jobscan.hardfilter import hardfilter

FX = Path(__file__).parent / "fixtures/swelist"


def test_parse_posting_extracts_fields(chrome_page):
    chrome_page.set_content((FX / "simplify_posting.html").read_text())
    p = parse_posting(chrome_page, "https://simplify.jobs/p/abc123", "Anduril", "Firmware Engineer Intern")
    assert p.source == "swelist"
    assert p.external_id == "abc123"
    assert p.company  # from page or hint
    assert p.role
    assert len(p.description) > 50


def test_hint_fills_missing_company(chrome_page):
    chrome_page.set_content("<div id='jd'>Some job description text that is long enough here.</div>")
    # SELECTORS must point company at something absent here so the hint is used
    p = parse_posting(chrome_page, "https://simplify.jobs/p/zzz", "HintCo", "Hint Role")
    assert p.company == "HintCo"
    assert p.role == "Hint Role"
```

(If the second test's assumptions don't hold given the real DOM, adjust the fixture in Step 1 — the contract is: page value wins, hint fills a blank.)

- [ ] **Step 3: Run test to verify it fails**

Run: `python3 -m pytest tests/test_adapter_swelist.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jobscan.adapters.swelist'`

- [ ] **Step 4: Implement**

Create `jobscan/adapters/swelist.py`:

```python
"""SWElist source: Claude extracts the simplify.jobs links from the digest
email (jobscan/swelist_links.py) and writes them to
daily_run/swelist_links.json. This adapter resolves each link and extracts
the posting."""
from __future__ import annotations

from jobscan.adapters.base import JobPosting, external_id_from_url

# >>> Fill from tests/fixtures/swelist/simplify_posting.html (Task 11 Step 1). <<<
SELECTORS = {
    "company": "",
    "role": "",
    "location": "",
    "description": "",
}


class ResolveError(RuntimeError):
    pass


def _text(el) -> str:
    return (el.inner_text() if el else "").strip()


def parse_posting(page, url: str, company_hint: str = "", role_hint: str = "") -> JobPosting:
    desc = _text(page.query_selector(SELECTORS["description"]))
    if not desc:
        raise ResolveError(f"no description container at {url}")
    company = _text(page.query_selector(SELECTORS["company"])) or company_hint
    role = _text(page.query_selector(SELECTORS["role"])) or role_hint
    location = _text(page.query_selector(SELECTORS["location"]))
    return JobPosting(
        source="swelist",
        external_id=external_id_from_url(url),
        url=url,
        company=company,
        role=role,
        location=location,
        salary_hint="",
        posted_at="",
        description=desc,
        employment_type_hint="",
        requirements_text="",
    )


class SwelistAdapter:
    source = "swelist"

    def resolve_and_extract(self, page, url: str, company_hint: str = "", role_hint: str = "") -> JobPosting:
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_timeout(2500)  # let simplify.jobs SPA render / redirect settle
        return parse_posting(page, page.url or url, company_hint, role_hint)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python3 -m pytest tests/test_adapter_swelist.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add jobscan/adapters/swelist.py tests/fixtures/swelist/simplify_posting.html tests/test_adapter_swelist.py
git commit -m "feat: add SWElist simplify.jobs adapter"
```

---

## Task 12: `run.py` — orchestrator + run artifact

**Files:**
- Create: `jobscan/run.py`
- Modify: `.gitignore`
- Create: `tests/test_run.py`

**Interfaces:**
- Consumes: `db.get_db`, `jobscan.seen`, `jobscan.prefilter.prefilter`, `jobscan.hardfilter.hardfilter`, `jobscan.hardfilter.resolve_term`, `jobscan.score.score`, adapter classes.
- Produces: `jobscan.run.run(db_path: str, feed_adapters: list, swelist_adapter, swelist_links: list[dict], page, out_dir: str, today=None) -> dict` — the orchestration, browser-agnostic (takes an already-open `page`). Returns the run-artifact dict and also writes it to `<out_dir>/<UTC ISO timestamp>.json`. Structure:
  ```python
  {
    "generated_at": "2026-09-02T13:30:00Z",
    "summary": {"jobright": {"scanned": N, "prefiltered": N, "hardfiltered": N, "candidates": N},
                "jobright": {...}, "swelist": {...}},
    "candidates": [ {**JobPosting fields, "term": str, "app_type": str, "heuristic_score": int} ],
    "dropped": [ {"job_key": str, "reason": str, "company": str, "role": str} ],
    "errors": [ {"url": str, "error": str} ],
  }
  ```
- Produces: `jobscan.run.app_type_for(term: str, posting) -> str` — `"Intern"` if term startswith `"Summer"` or role/type says intern; `"Entry"` if term == `"New Grad"`; else `"Other"`.
- Behavior: for each feed adapter — `walk_feed(page, is_seen=lambda k: seen.is_seen(conn, k))`; per card: `prefilter` → on drop `seen.record(dropped, reason)`, add to `dropped`; else `extract_detail` → `hardfilter` → on drop record + append; else compute `term`/`score`/`app_type`, `seen.record(candidate)`, append to `candidates`. Wrap each posting in try/except → `errors`. For SWElist — for each link whose resolved key isn't seen: `resolve_and_extract` → same prefilter/hardfilter/score path; `ResolveError` → `errors`. Dedupe `candidates` by `job_key` before returning.

- [ ] **Step 1: Update `.gitignore`**

Append:

```
daily_run/
```

- [ ] **Step 2: Write the failing test**

Create `tests/test_run.py` using fake adapters and a fake page (no browser):

```python
import json
from pathlib import Path
import datetime

from db import init_db, get_db
from jobscan import seen, run as runmod
from jobscan.adapters.base import JobCard, JobPosting

TODAY = datetime.date(2026, 9, 2)


class FakePage:
    url = "https://x"
    def goto(self, *a, **k): pass
    def wait_for_timeout(self, *a, **k): pass


class FakeFeed:
    source = "jobright"
    def __init__(self, cards, details): self._cards, self._details = cards, details
    def feed_url(self): return "u"
    def walk_feed(self, page, is_seen=lambda k: False):
        for c in self._cards:
            if not is_seen(f"{c.source}:{c.external_id}"):
                yield c
    def extract_detail(self, page, card): return self._details[card.external_id]


def _card(eid, role="Firmware Engineer Intern", loc="Austin, TX"):
    return JobCard("jobright", eid, f"https://jobright.ai/jobs/{eid}", "Acme", role, loc, "", "2026-09-01")


def _detail(card, desc="Summer 2027 internship for ECE students. " * 5):
    return JobPosting(card.source, card.external_id, card.url, card.company, card.role,
                      card.location, "", card.posted_at, desc, "Internship", "")


def test_run_produces_candidates_and_drops(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path)
    good = _card("g1")
    badloc = _card("b1", loc="London, UK")
    sponsor = _card("s1")
    feed = FakeFeed(
        [good, badloc, sponsor],
        {"g1": _detail(good),
         "b1": _detail(badloc),
         "s1": _detail(sponsor, desc="We do not sponsor visas. " * 5)},
    )
    artifact = runmod.run(db_path, [feed], None, [], FakePage(), str(tmp_path / "daily_run"), today=TODAY)

    keys = {c["external_id"] for c in artifact["candidates"]}
    assert keys == {"g1"}
    reasons = {d["job_key"]: d["reason"] for d in artifact["dropped"]}
    assert reasons["jobright:b1"] == "prefilter:location"
    assert reasons["jobright:s1"] == "no-sponsorship"

    conn = get_db(db_path)
    assert seen.disposition_of(conn, "jobright:g1") == "candidate"
    assert seen.disposition_of(conn, "jobright:s1") == "dropped"
    conn.close()

    files = list((tmp_path / "daily_run").glob("*.json"))
    assert len(files) == 1
    assert json.loads(files[0].read_text())["summary"]["jobright"]["candidates"] == 1


def test_run_skips_already_seen(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path)
    conn = get_db(db_path)
    seen.record(conn, key="jobright:g1", source="jobright", url="u", disposition="deleted")
    conn.close()
    good = _card("g1")
    feed = FakeFeed([good], {"g1": _detail(good)})
    artifact = runmod.run(db_path, [feed], None, [], FakePage(), str(tmp_path / "daily_run"), today=TODAY)
    assert artifact["candidates"] == []


def test_run_swelist_path(tmp_path):
    db_path = str(tmp_path / "t.db"); init_db(db_path)

    class FakeSwelist:
        source = "swelist"
        def resolve_and_extract(self, page, url, company_hint="", role_hint=""):
            return JobPosting("swelist", "abc123", url, company_hint or "Anduril",
                              role_hint or "Firmware Engineer Intern", "Irvine, CA", "", "",
                              "Summer 2027 embedded internship. " * 5, "Internship", "")

    links = [{"url": "https://simplify.jobs/p/abc123", "company_hint": "Anduril", "role_hint": "Firmware Engineer Intern"}]
    artifact = runmod.run(db_path, [], FakeSwelist(), links, FakePage(), str(tmp_path / "daily_run"), today=TODAY)
    assert len(artifact["candidates"]) == 1
    assert artifact["candidates"][0]["source"] == "swelist"
    assert artifact["candidates"][0]["term"] == "Summer 2027"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python3 -m pytest tests/test_run.py -v`
Expected: FAIL — `AttributeError: module 'jobscan.run' has no attribute 'run'`

- [ ] **Step 4: Implement**

Create `jobscan/run.py`:

```python
"""Orchestrates a scan: walk feeds + resolve SWElist links, apply prefilter
and hardfilter, score survivors, update seen_jobs, write a run artifact.
Browser-agnostic — the caller passes an already-open Playwright page."""
from __future__ import annotations

import dataclasses
import datetime
import json
import os
from pathlib import Path

from db import get_db
from jobscan import seen
from jobscan.hardfilter import hardfilter, resolve_term
from jobscan.prefilter import prefilter
from jobscan.score import score


def app_type_for(term: str, posting) -> str:
    role_blob = f"{posting.role} {posting.employment_type_hint}".lower()
    if term.startswith("Summer") or "intern" in role_blob or "co-op" in role_blob:
        return "Intern"
    if term == "New Grad":
        return "Entry"
    return "Other"


def _candidate_dict(posting, term, sc) -> dict:
    d = dataclasses.asdict(posting)
    d["term"] = term
    d["app_type"] = app_type_for(term, posting)
    d["heuristic_score"] = sc
    return d


def _process(posting, conn, today, candidates, dropped):
    key = f"{posting.source}:{posting.external_id}"
    pf = prefilter(posting)
    if pf:
        seen.record(conn, key=key, source=posting.source, url=posting.url,
                    disposition="dropped", drop_reason=pf,
                    company=posting.company, role=posting.role)
        dropped.append({"job_key": key, "reason": pf,
                        "company": posting.company, "role": posting.role})
        return "dropped"
    hf = hardfilter(posting, today)
    if hf:
        seen.record(conn, key=key, source=posting.source, url=posting.url,
                    disposition="dropped", drop_reason=hf,
                    company=posting.company, role=posting.role)
        dropped.append({"job_key": key, "reason": hf,
                        "company": posting.company, "role": posting.role})
        return "dropped"
    term = resolve_term(posting, today)
    sc = score(posting, today)
    seen.record(conn, key=key, source=posting.source, url=posting.url,
                disposition="candidate", company=posting.company, role=posting.role)
    candidates.append(_candidate_dict(posting, term, sc))
    return "candidate"


def run(db_path, feed_adapters, swelist_adapter, swelist_links, page, out_dir, today=None):
    today = today or datetime.date.today()
    conn = get_db(db_path)
    candidates: list[dict] = []
    dropped: list[dict] = []
    errors: list[dict] = []
    summary: dict = {}

    for adapter in feed_adapters:
        s = {"scanned": 0, "prefiltered": 0, "hardfiltered": 0, "candidates": 0}
        try:
            cards = adapter.walk_feed(page, is_seen=lambda k: seen.is_seen(conn, k))
            for card in cards:
                s["scanned"] += 1
                key = f"{card.source}:{card.external_id}"
                pf = prefilter(card)
                if pf:
                    seen.record(conn, key=key, source=card.source, url=card.url,
                                disposition="dropped", drop_reason=pf,
                                company=card.company, role=card.role)
                    dropped.append({"job_key": key, "reason": pf,
                                    "company": card.company, "role": card.role})
                    s["prefiltered"] += 1
                    continue
                try:
                    posting = adapter.extract_detail(page, card)
                except Exception as e:  # noqa: BLE001 - log and continue
                    errors.append({"url": card.url, "error": repr(e)})
                    continue
                outcome = _process(posting, conn, today, candidates, dropped)
                if outcome == "dropped":
                    s["hardfiltered"] += 1
                else:
                    s["candidates"] += 1
        except Exception as e:  # noqa: BLE001
            errors.append({"url": adapter.feed_url(), "error": repr(e)})
        summary[adapter.source] = s

    if swelist_adapter and swelist_links:
        s = {"scanned": 0, "prefiltered": 0, "hardfiltered": 0, "candidates": 0}
        for link in swelist_links:
            s["scanned"] += 1
            try:
                posting = swelist_adapter.resolve_and_extract(
                    page, link["url"],
                    company_hint=link.get("company_hint", ""),
                    role_hint=link.get("role_hint", ""),
                )
            except Exception as e:  # noqa: BLE001
                errors.append({"url": link["url"], "error": repr(e)})
                continue
            key = f"{posting.source}:{posting.external_id}"
            if seen.is_seen(conn, key):
                continue
            outcome = _process(posting, conn, today, candidates, dropped)
            if outcome == "dropped":
                s["hardfiltered"] += 1
            else:
                s["candidates"] += 1
        summary["swelist"] = s

    # dedupe candidates by job_key, keep first (richest source order: feeds then swelist)
    seen_keys: set[str] = set()
    deduped = []
    for c in candidates:
        k = f"{c['source']}:{c['external_id']}"
        if k in seen_keys:
            continue
        seen_keys.add(k)
        deduped.append(c)

    artifact = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc)
                        .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "summary": summary,
        "candidates": deduped,
        "dropped": dropped,
        "errors": errors,
    }
    conn.close()

    os.makedirs(out_dir, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    Path(out_dir, f"{stamp}.json").write_text(json.dumps(artifact, indent=2))
    return artifact
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python3 -m pytest tests/test_run.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add jobscan/run.py .gitignore tests/test_run.py
git commit -m "feat: add scan orchestrator and run artifact"
```

---

## Task 13: `scripts/scan_jobs.py` — entry point

**Files:**
- Create: `scripts/scan_jobs.py`
- Create: `tests/test_scan_jobs_cli.py`

**Interfaces:**
- Consumes: `jobscan.profile.launch`, `jobscan.run.run`, adapter classes, `jobscan.adapters.jobright.LoginRequired`, `jobscan.adapters.jobright.LoginRequired`.
- Produces: `scripts/scan_jobs.py` runnable as `python3 scripts/scan_jobs.py [--db tracker.db] [--out daily_run] [--headless] [--no-swelist]`. Reads `daily_run/swelist_links.json` if present (a JSON list of `{url, company_hint, role_hint}`). Launches the persistent Chrome context, calls `run.run(...)`, prints a one-line-per-source summary + the artifact path. On `LoginRequired`, prints which site needs login and exits 2 without writing.
- Produces: `scripts.scan_jobs.load_swelist_links(path) -> list[dict]` — `[]` if the file is missing; validates each entry has a `url`.
- Produces: `scripts.scan_jobs.format_summary(artifact: dict) -> str` — the human summary string.

- [ ] **Step 1: Write the failing test**

Create `tests/test_scan_jobs_cli.py`:

```python
import json
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "scan_jobs", Path(__file__).parent.parent / "scripts/scan_jobs.py")
scan_jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan_jobs)


def test_load_swelist_links_missing_file(tmp_path):
    assert scan_jobs.load_swelist_links(str(tmp_path / "nope.json")) == []


def test_load_swelist_links_reads_and_validates(tmp_path):
    p = tmp_path / "links.json"
    p.write_text(json.dumps([
        {"url": "https://simplify.jobs/p/1", "company_hint": "A", "role_hint": "R"},
        {"company_hint": "no url"},
    ]))
    links = scan_jobs.load_swelist_links(str(p))
    assert len(links) == 1 and links[0]["url"].endswith("/1")


def test_format_summary_mentions_each_source():
    artifact = {
        "summary": {"jobright": {"scanned": 10, "prefiltered": 6, "hardfiltered": 2, "candidates": 2},
                    "swelist": {"scanned": 3, "prefiltered": 1, "hardfiltered": 0, "candidates": 2}},
        "candidates": [1, 2, 3, 4], "dropped": [1] * 9, "errors": [],
    }
    out = scan_jobs.format_summary(artifact)
    assert "jobright" in out and "swelist" in out and "4" in out
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_scan_jobs_cli.py -v`
Expected: FAIL — `FileNotFoundError` / module load error (script doesn't exist)

- [ ] **Step 3: Implement**

Create `scripts/scan_jobs.py`:

```python
"""Entry point for a daily job scan. Claude runs this from chat, then reads
the printed artifact path.

    python3 scripts/scan_jobs.py

First run: Chrome opens to a login wall — log into jobright.ai and jobright.ai
in that window, then rerun. The session persists in ~/.jobtracker/chrome-profile.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from jobscan.adapters.jobright import JobrightAdapter, LoginRequired as JobrightLogin
from jobscan.adapters.jobright import RunwayAdapter, LoginRequired as RunwayLogin
from jobscan.adapters.swelist import SwelistAdapter
from jobscan.profile import launch
from jobscan.run import run


def load_swelist_links(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    data = json.loads(open(path).read())
    return [d for d in data if isinstance(d, dict) and d.get("url")]


def format_summary(artifact: dict) -> str:
    lines = []
    for src, s in artifact["summary"].items():
        lines.append(
            f"  {src:9s} scanned {s['scanned']:3d} · "
            f"prefilter -{s['prefiltered']} · hardfilter -{s['hardfiltered']} · "
            f"candidates {s['candidates']}"
        )
    lines.append(f"  total candidates: {len(artifact['candidates'])} · "
                 f"dropped: {len(artifact['dropped'])} · errors: {len(artifact['errors'])}")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="tracker.db")
    ap.add_argument("--out", default="daily_run")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--no-swelist", action="store_true")
    args = ap.parse_args(argv)

    links = [] if args.no_swelist else load_swelist_links(os.path.join(args.out, "swelist_links.json"))
    if links:
        print(f"SWElist: {len(links)} link(s) queued")

    feeds = [JobrightAdapter(), RunwayAdapter()]
    try:
        with launch(headless=args.headless) as (context, page):
            artifact = run(args.db, feeds, SwelistAdapter(), links, page, args.out)
    except (JobrightLogin, RunwayLogin) as e:
        print(f"NOT LOGGED IN: {e}. Open Chrome (rerun without --headless), "
              f"log into that site, then run again.")
        return 2

    print(format_summary(artifact))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_scan_jobs_cli.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/scan_jobs.py tests/test_scan_jobs_cli.py
git commit -m "feat: add scan_jobs entry point"
```

---

## Task 14: `GET /api/picks` + `GET /picks` page route

**Files:**
- Modify: `app.py`
- Create: `templates/picks.html` (skeleton — filled in Task 18)
- Create: `tests/test_picks_api.py`

**Interfaces:**
- Consumes: `db.get_db`.
- Produces: `GET /api/picks` → JSON list of all `daily_picks` rows as dicts, ordered by `rank ASC` with `NULL` ranks last, then `id ASC`.
- Produces: `GET /picks` → renders `templates/picks.html`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_picks_api.py`:

```python
import pytest
from app import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(db_path=str(tmp_path / "t.db"))
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


def _insert_pick(client, **over):
    from db import get_db
    conn = get_db(client.application.config["DATABASE"])
    row = dict(job_key="jobright:1", source="jobright", url="u", company="Acme",
               role="Firmware Intern", location="Austin, TX", salary="", term="Summer 2027",
               app_type="Intern", heuristic_score=50, rank=1, reasoning="good",
               description="d", first_run_date="2026-09-02", last_run_date="2026-09-02",
               status="new")
    row.update(over)
    cols = ", ".join(row)
    conn.execute(f"INSERT INTO daily_picks ({cols}) VALUES ({', '.join('?' for _ in row)})",
                 list(row.values()))
    conn.commit()
    conn.close()


def test_get_picks_empty(client):
    assert client.get("/api/picks").get_json() == []


def test_get_picks_orders_by_rank_nulls_last(client):
    _insert_pick(client, job_key="j:1", rank=2)
    _insert_pick(client, job_key="j:2", rank=None)
    _insert_pick(client, job_key="j:3", rank=1)
    keys = [p["job_key"] for p in client.get("/api/picks").get_json()]
    assert keys == ["j:3", "j:1", "j:2"]


def test_picks_page_renders(client):
    resp = client.get("/picks")
    assert resp.status_code == 200
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_picks_api.py -v`
Expected: FAIL — 404 on `/api/picks`

- [ ] **Step 3: Implement**

Create `templates/picks.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Daily Picks — Job Tracker</title>
    <link rel="stylesheet" href="{{ url_for('static', filename='style.css') }}">
    <link rel="stylesheet" href="{{ url_for('static', filename='picks.css') }}">
</head>
<body>
    <h1>Daily Picks</h1>
    <p><a href="/">&larr; Tracker</a></p>
    <section id="today"><h2>Today's picks</h2><div class="pick-list"></div>
        <details class="more"><summary>More candidates</summary><div class="pick-list"></div></details>
    </section>
    <section id="carried"><h2>Carried over</h2><div class="pick-list"></div></section>
    <section id="applied"><h2>Applied today</h2><div class="pick-list"></div></section>
    <script src="{{ url_for('static', filename='picks.js') }}"></script>
</body>
</html>
```

Create empty `static/picks.css` and `static/picks.js` (filled in Task 18) so the page renders now.

In `app.py`, after the `list_applications` route add:

```python
    @app.route("/picks")
    def picks_page():
        return render_template("picks.html")

    @app.route("/api/picks", methods=["GET"])
    def list_picks():
        conn = get_db(app.config["DATABASE"])
        rows = conn.execute(
            "SELECT * FROM daily_picks ORDER BY rank IS NULL, rank ASC, id ASC"
        ).fetchall()
        conn.close()
        return jsonify([dict(r) for r in rows])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_picks_api.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app.py templates/picks.html static/picks.css static/picks.js tests/test_picks_api.py
git commit -m "feat: add GET /api/picks and /picks page route"
```

---

## Task 15: `POST /api/picks/bulk`

**Files:**
- Modify: `app.py`
- Modify: `tests/test_picks_api.py`

**Interfaces:**
- Consumes: `db.get_db`, `TYPE_VALUES` (`{"Intern","Entry","Other"}`) from `app.py`.
- Produces: `POST /api/picks/bulk`. Body: `{"run_date": "YYYY-MM-DD", "picks": [ {job_key, source, url, company, role, location, salary, term, app_type, heuristic_score, rank, reasoning, description} ]}`. Per pick, by `job_key`:
  - not in `daily_picks` → INSERT with `status='new'`, `first_run_date = last_run_date = run_date`.
  - exists, `status='new'` → UPDATE `rank, reasoning, heuristic_score, term, app_type, salary, location, description, last_run_date = run_date, updated_at`; leave `first_run_date`, `status`.
  - exists, `status='applied'` → ignore.
  Also `INSERT OR IGNORE` a `seen_jobs` row `(job_key, source, url, disposition='candidate')`, and if an existing `seen_jobs` row is not in `{'applied','deleted'}`, set it to `'candidate'`.
  Rejects a pick whose `app_type` ∉ `TYPE_VALUES` with 400 (no partial write — validate all first). Returns `{"inserted": n, "updated": n, "ignored": n}`.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_picks_api.py`:

```python
def _bulk_body(**over):
    pick = dict(job_key="jobright:1", source="jobright", url="u", company="Acme",
                role="Firmware Intern", location="Austin, TX", salary="$40/hr",
                term="Summer 2027", app_type="Intern", heuristic_score=60, rank=1,
                reasoning="strong ECE match", description="desc")
    pick.update(over)
    return {"run_date": "2026-09-02", "picks": [pick]}


def test_bulk_inserts_new_pick(client):
    resp = client.post("/api/picks/bulk", json=_bulk_body())
    assert resp.status_code == 200
    assert resp.get_json() == {"inserted": 1, "updated": 0, "ignored": 0}
    picks = client.get("/api/picks").get_json()
    assert picks[0]["reasoning"] == "strong ECE match"
    assert picks[0]["first_run_date"] == "2026-09-02"

    from db import get_db
    conn = get_db(client.application.config["DATABASE"])
    disp = conn.execute("SELECT disposition FROM seen_jobs WHERE job_key='jobright:1'").fetchone()["disposition"]
    conn.close()
    assert disp == "candidate"


def test_bulk_updates_existing_new_pick_keeps_first_run_date(client):
    client.post("/api/picks/bulk", json=_bulk_body())
    r2 = client.post("/api/picks/bulk", json={
        "run_date": "2026-09-03",
        "picks": [dict(_bulk_body()["picks"][0], rank=5, reasoning="reranked")],
    })
    assert r2.get_json() == {"inserted": 0, "updated": 1, "ignored": 0}
    p = client.get("/api/picks").get_json()[0]
    assert p["rank"] == 5 and p["reasoning"] == "reranked"
    assert p["first_run_date"] == "2026-09-02" and p["last_run_date"] == "2026-09-03"


def test_bulk_ignores_applied_pick(client):
    client.post("/api/picks/bulk", json=_bulk_body())
    pid = client.get("/api/picks").get_json()[0]["id"]
    client.post(f"/api/picks/{pid}/apply")
    r = client.post("/api/picks/bulk", json=_bulk_body(reasoning="should not overwrite"))
    assert r.get_json() == {"inserted": 0, "updated": 0, "ignored": 1}


def test_bulk_rejects_bad_app_type(client):
    r = client.post("/api/picks/bulk", json=_bulk_body(app_type="Bogus"))
    assert r.status_code == 400
    assert client.get("/api/picks").get_json() == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_picks_api.py -v -k bulk`
Expected: FAIL — 404 on `/api/picks/bulk`

- [ ] **Step 3: Implement**

In `app.py` add:

```python
    @app.route("/api/picks/bulk", methods=["POST"])
    def bulk_picks():
        data = request.get_json(force=True) or {}
        run_date = data.get("run_date")
        picks = data.get("picks", [])
        if not run_date:
            return jsonify({"error": "missing run_date"}), 400
        for p in picks:
            if p.get("app_type", "Other") not in TYPE_VALUES:
                return jsonify({"error": f"invalid app_type: {p.get('app_type')}"}), 400

        conn = get_db(app.config["DATABASE"])
        inserted = updated = ignored = 0
        for p in picks:
            existing = conn.execute(
                "SELECT id, status FROM daily_picks WHERE job_key = ?", (p["job_key"],)
            ).fetchone()
            if existing is None:
                conn.execute(
                    """INSERT INTO daily_picks
                       (job_key, source, url, company, role, location, salary, term,
                        app_type, heuristic_score, rank, reasoning, description,
                        first_run_date, last_run_date, status)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'new')""",
                    (p["job_key"], p["source"], p["url"], p["company"], p["role"],
                     p.get("location", ""), p.get("salary", ""), p.get("term", ""),
                     p.get("app_type", "Other"), p.get("heuristic_score", 0),
                     p.get("rank"), p.get("reasoning", ""), p.get("description", ""),
                     run_date, run_date),
                )
                inserted += 1
            elif existing["status"] == "new":
                conn.execute(
                    """UPDATE daily_picks SET rank=?, reasoning=?, heuristic_score=?,
                       term=?, app_type=?, salary=?, location=?, description=?,
                       last_run_date=?, updated_at=datetime('now') WHERE id=?""",
                    (p.get("rank"), p.get("reasoning", ""), p.get("heuristic_score", 0),
                     p.get("term", ""), p.get("app_type", "Other"), p.get("salary", ""),
                     p.get("location", ""), p.get("description", ""), run_date, existing["id"]),
                )
                updated += 1
            else:
                ignored += 1
                continue

            srow = conn.execute(
                "SELECT disposition FROM seen_jobs WHERE job_key = ?", (p["job_key"],)
            ).fetchone()
            if srow is None:
                conn.execute(
                    """INSERT INTO seen_jobs (job_key, source, url, company, role, disposition)
                       VALUES (?,?,?,?,?, 'candidate')""",
                    (p["job_key"], p["source"], p["url"], p["company"], p["role"]),
                )
            elif srow["disposition"] not in ("applied", "deleted"):
                conn.execute(
                    "UPDATE seen_jobs SET disposition='candidate', last_seen=datetime('now') WHERE job_key=?",
                    (p["job_key"],),
                )

        conn.commit()
        conn.close()
        return jsonify({"inserted": inserted, "updated": updated, "ignored": ignored})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_picks_api.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_picks_api.py
git commit -m "feat: add POST /api/picks/bulk upsert endpoint"
```

---

## Task 16: `POST /api/picks/<id>/apply`

**Files:**
- Modify: `app.py`
- Modify: `tests/test_picks_api.py`

**Interfaces:**
- Consumes: `db.get_db`, existing `applications` INSERT shape from `create_application`.
- Produces: `POST /api/picks/<int:pick_id>/apply` — creates an `applications` row (`date_applied` = `date('now')` server-side, `company`/`role` from the pick, `type` = pick `app_type`, `status='Applied'`, `resume_used=''`, `notes` = `f"From Daily Picks: {url}"`). Sets pick `status='applied'`, `application_id` = new id, `updated_at`. Sets `seen_jobs.disposition='applied'`. Returns `{"application_id": n}`. 404 if the pick doesn't exist; 409 if pick `status` already `'applied'`.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_picks_api.py`:

```python
def test_apply_creates_application_and_flips_state(client):
    client.post("/api/picks/bulk", json=_bulk_body())
    pid = client.get("/api/picks").get_json()[0]["id"]

    r = client.post(f"/api/picks/{pid}/apply")
    assert r.status_code == 200
    app_id = r.get_json()["application_id"]

    apps = client.get("/api/applications").get_json()
    match = [a for a in apps if a["id"] == app_id][0]
    assert match["company"] == "Acme"
    assert match["role"] == "Firmware Intern"
    assert match["type"] == "Intern"
    assert match["status"] == "Applied"

    pick = client.get("/api/picks").get_json()[0]
    assert pick["status"] == "applied" and pick["application_id"] == app_id

    from db import get_db
    conn = get_db(client.application.config["DATABASE"])
    disp = conn.execute("SELECT disposition FROM seen_jobs WHERE job_key='jobright:1'").fetchone()["disposition"]
    conn.close()
    assert disp == "applied"


def test_apply_twice_is_409(client):
    client.post("/api/picks/bulk", json=_bulk_body())
    pid = client.get("/api/picks").get_json()[0]["id"]
    client.post(f"/api/picks/{pid}/apply")
    assert client.post(f"/api/picks/{pid}/apply").status_code == 409


def test_apply_missing_pick_is_404(client):
    assert client.post("/api/picks/999/apply").status_code == 404
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_picks_api.py -v -k apply`
Expected: FAIL — 404 (route missing)

- [ ] **Step 3: Implement**

In `app.py` add:

```python
    @app.route("/api/picks/<int:pick_id>/apply", methods=["POST"])
    def apply_pick(pick_id):
        conn = get_db(app.config["DATABASE"])
        pick = conn.execute("SELECT * FROM daily_picks WHERE id = ?", (pick_id,)).fetchone()
        if pick is None:
            conn.close()
            return jsonify({"error": "not found"}), 404
        if pick["status"] == "applied":
            conn.close()
            return jsonify({"error": "already applied"}), 409

        app_type = pick["app_type"] if pick["app_type"] in TYPE_VALUES else "Other"
        cur = conn.execute(
            """INSERT INTO applications
               (date_applied, company, role, type, status, referred, outreach_sent,
                reply_received, resume_used, notes)
               VALUES (date('now'), ?, ?, ?, 'Applied', 0, 0, 0, '', ?)""",
            (pick["company"], pick["role"], app_type, f"From Daily Picks: {pick['url']}"),
        )
        app_id = cur.lastrowid
        conn.execute(
            "UPDATE daily_picks SET status='applied', application_id=?, updated_at=datetime('now') WHERE id=?",
            (app_id, pick_id),
        )
        conn.execute(
            "UPDATE seen_jobs SET disposition='applied', last_seen=datetime('now') WHERE job_key=?",
            (pick["job_key"],),
        )
        conn.commit()
        conn.close()
        return jsonify({"application_id": app_id})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_picks_api.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_picks_api.py
git commit -m "feat: add POST /api/picks/<id>/apply"
```

---

## Task 17: `DELETE /api/picks/<id>`

**Files:**
- Modify: `app.py`
- Modify: `tests/test_picks_api.py`

**Interfaces:**
- Consumes: `db.get_db`.
- Produces: `DELETE /api/picks/<int:pick_id>` — hard-deletes the `daily_picks` row. Upserts `seen_jobs` for that `job_key` to `disposition='deleted'`, `drop_reason='user-deleted'` (INSERT if the row is somehow absent, using the pick's `source`/`url` captured before delete). Returns `{"ok": true}`. 404 if the pick doesn't exist.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_picks_api.py`:

```python
def test_delete_removes_pick_and_marks_seen_deleted(client):
    client.post("/api/picks/bulk", json=_bulk_body())
    pid = client.get("/api/picks").get_json()[0]["id"]

    r = client.delete(f"/api/picks/{pid}")
    assert r.status_code == 200
    assert client.get("/api/picks").get_json() == []

    from db import get_db
    conn = get_db(client.application.config["DATABASE"])
    row = conn.execute("SELECT disposition, drop_reason FROM seen_jobs WHERE job_key='jobright:1'").fetchone()
    conn.close()
    assert row["disposition"] == "deleted" and row["drop_reason"] == "user-deleted"


def test_delete_missing_pick_is_404(client):
    assert client.delete("/api/picks/999").status_code == 404


def test_deleted_job_key_is_ignored_by_future_bulk(client):
    client.post("/api/picks/bulk", json=_bulk_body())
    pid = client.get("/api/picks").get_json()[0]["id"]
    client.delete(f"/api/picks/{pid}")
    # a later run re-surfaces the same job_key
    r = client.post("/api/picks/bulk", json=_bulk_body())
    # it re-inserts the daily_picks row (bulk keys on daily_picks, which was deleted)
    # but seen_jobs stays 'deleted'
    from db import get_db
    conn = get_db(client.application.config["DATABASE"])
    disp = conn.execute("SELECT disposition FROM seen_jobs WHERE job_key='jobright:1'").fetchone()["disposition"]
    conn.close()
    assert disp == "deleted"
```

Note: the scanner (Task 12) is what skips deleted `job_key`s — it checks `seen.is_seen` before a card ever reaches `bulk`. `bulk` itself does not re-check, but it must not *downgrade* a `deleted` seen_jobs row (the `srow["disposition"] not in ("applied","deleted")` guard from Task 15 already handles this — this test locks it).

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_picks_api.py -v -k delete`
Expected: FAIL — 404/405 (route missing)

- [ ] **Step 3: Implement**

In `app.py` add:

```python
    @app.route("/api/picks/<int:pick_id>", methods=["DELETE"])
    def delete_pick(pick_id):
        conn = get_db(app.config["DATABASE"])
        pick = conn.execute("SELECT * FROM daily_picks WHERE id = ?", (pick_id,)).fetchone()
        if pick is None:
            conn.close()
            return jsonify({"error": "not found"}), 404

        conn.execute("DELETE FROM daily_picks WHERE id = ?", (pick_id,))
        srow = conn.execute(
            "SELECT 1 FROM seen_jobs WHERE job_key = ?", (pick["job_key"],)
        ).fetchone()
        if srow is None:
            conn.execute(
                """INSERT INTO seen_jobs (job_key, source, url, company, role, disposition, drop_reason)
                   VALUES (?,?,?,?,?, 'deleted', 'user-deleted')""",
                (pick["job_key"], pick["source"], pick["url"], pick["company"], pick["role"]),
            )
        else:
            conn.execute(
                "UPDATE seen_jobs SET disposition='deleted', drop_reason='user-deleted', last_seen=datetime('now') WHERE job_key=?",
                (pick["job_key"],),
            )
        conn.commit()
        conn.close()
        return jsonify({"ok": True})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_picks_api.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_picks_api.py
git commit -m "feat: add DELETE /api/picks/<id>"
```

---

## Task 18: `/picks` page — `picks.js` + `picks.css`

**Files:**
- Modify: `static/picks.js`
- Modify: `static/picks.css`
- Modify: `templates/index.html` (add a nav link)
- Create: `tests/test_picks_page.py`

**Interfaces:**
- Consumes: `GET /api/picks`, `POST /api/picks/<id>/apply`, `DELETE /api/picks/<id>`.
- Produces: `static/picks.js` — on load, `fetch('/api/picks')`, then bucket rows: **applied** = `status === 'applied'`; **carried** = `status === 'new'` && `first_run_date < todayISO`; **today** = `status === 'new'` && `first_run_date === todayISO` (rows with `first_run_date > today` — shouldn't happen — go in "today"). Within "today", the first 15 by array order render in `#today > .pick-list`, the rest in `#today .more .pick-list` (and the `<details>` is hidden if empty). Each card: rank badge, `company — role`, pills (`location`, `salary` if non-empty, `term` with class `pill-unknown` when `term === 'Unknown'`), `reasoning` paragraph, `<details>` with `description`, an `<a target="_blank">` to `url`, and **Applied** / **Delete** buttons. Buttons call the endpoints then re-render. `todayISO` = `new Date().toISOString().slice(0,10)`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_picks_page.py`:

```python
import threading
import pytest
from werkzeug.serving import make_server
from app import create_app


@pytest.fixture
def live_server(tmp_path):
    app = create_app(db_path=str(tmp_path / "t.db"))
    srv = make_server("127.0.0.1", 0, app)
    port = srv.socket.getsockname()[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{port}", app.config["DATABASE"]
    srv.shutdown()


def _seed(db_path):
    from db import get_db
    import datetime
    today = datetime.date.today().isoformat()
    y = (datetime.date.today() - datetime.timedelta(days=2)).isoformat()
    conn = get_db(db_path)
    def ins(**o):
        row = dict(job_key="k", source="jobright", url="https://x", company="Acme",
                   role="Firmware Intern", location="Austin, TX", salary="$40/hr",
                   term="Summer 2027", app_type="Intern", heuristic_score=1, rank=1,
                   reasoning="r", description="d", first_run_date=today, last_run_date=today,
                   status="new")
        row.update(o)
        conn.execute(f"INSERT INTO daily_picks ({', '.join(row)}) VALUES ({', '.join('?' for _ in row)})",
                     list(row.values()))
    ins(job_key="t1")
    ins(job_key="c1", first_run_date=y, last_run_date=y)
    ins(job_key="a1", status="applied")
    conn.commit()
    conn.close()


@pytest.mark.live
def test_sections_render(live_server, chrome_page):
    base, db_path = live_server
    _seed(db_path)
    chrome_page.goto(f"{base}/picks")
    chrome_page.wait_for_selector("#today .pick-list .pick-card")
    assert chrome_page.query_selector("#today .pick-list .pick-card") is not None
    assert chrome_page.query_selector("#carried .pick-list .pick-card") is not None
    assert chrome_page.query_selector("#applied .pick-list .pick-card") is not None


@pytest.mark.live
def test_delete_button_removes_card(live_server, chrome_page):
    base, db_path = live_server
    _seed(db_path)
    chrome_page.goto(f"{base}/picks")
    chrome_page.wait_for_selector("#today .pick-card")
    chrome_page.on("dialog", lambda d: d.accept())
    chrome_page.click("#today .pick-card [data-act='delete']")
    chrome_page.wait_for_function(
        "document.querySelectorAll('#today .pick-list .pick-card').length === 0")
```

These are `@pytest.mark.live` (they need a real browser + server) — run with `python3 -m pytest tests/test_picks_page.py --run-live -v`.

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_picks_page.py --run-live -v`
Expected: FAIL — no `.pick-card` elements (JS is empty)

- [ ] **Step 3: Implement**

`static/picks.js`:

```javascript
const TODAY = new Date().toISOString().slice(0, 10);

async function load() {
    const picks = await (await fetch("/api/picks")).json();
    const today = [], carried = [], applied = [];
    for (const p of picks) {
        if (p.status === "applied") applied.push(p);
        else if (p.first_run_date < TODAY) carried.push(p);
        else today.push(p);
    }
    renderInto(document.querySelector("#today > .pick-list"), today.slice(0, 15));
    const moreWrap = document.querySelector("#today .more");
    renderInto(moreWrap.querySelector(".pick-list"), today.slice(15));
    moreWrap.hidden = today.length <= 15;
    renderInto(document.querySelector("#carried .pick-list"), carried, true);
    document.querySelector("#carried").hidden = carried.length === 0;
    renderInto(document.querySelector("#applied .pick-list"), applied, false, true);
    document.querySelector("#applied").hidden = applied.length === 0;
}

function renderInto(container, picks, showFrom = false, compact = false) {
    container.innerHTML = "";
    for (const p of picks) container.appendChild(card(p, showFrom, compact));
}

function pill(text, cls) {
    const s = document.createElement("span");
    s.className = "pill" + (cls ? " " + cls : "");
    s.textContent = text;
    return s;
}

function card(p, showFrom, compact) {
    const el = document.createElement("div");
    el.className = "pick-card";

    const head = document.createElement("div");
    head.className = "pick-head";
    if (p.rank != null) {
        const b = document.createElement("span");
        b.className = "rank";
        b.textContent = "#" + p.rank;
        head.appendChild(b);
    }
    const title = document.createElement("strong");
    title.textContent = `${p.company} — ${p.role}`;
    head.appendChild(title);
    el.appendChild(head);

    if (compact) return el;

    const pills = document.createElement("div");
    pills.className = "pills";
    if (p.location) pills.appendChild(pill(p.location));
    if (p.salary) pills.appendChild(pill(p.salary));
    if (p.term) pills.appendChild(pill(p.term, p.term === "Unknown" ? "pill-unknown" : ""));
    if (showFrom) pills.appendChild(pill("from " + p.first_run_date, "pill-from"));
    el.appendChild(pills);

    if (p.reasoning) {
        const r = document.createElement("p");
        r.className = "reasoning";
        r.textContent = p.reasoning;
        el.appendChild(r);
    }

    if (p.description) {
        const d = document.createElement("details");
        const sm = document.createElement("summary");
        sm.textContent = "Full description";
        d.appendChild(sm);
        const body = document.createElement("pre");
        body.className = "jd";
        body.textContent = p.description;
        d.appendChild(body);
        el.appendChild(d);
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    const link = document.createElement("a");
    link.href = p.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Open posting";
    actions.appendChild(link);

    const applyBtn = document.createElement("button");
    applyBtn.dataset.act = "apply";
    applyBtn.textContent = "Applied";
    applyBtn.addEventListener("click", async () => {
        applyBtn.disabled = true;
        await fetch(`/api/picks/${p.id}/apply`, { method: "POST" });
        load();
    });
    actions.appendChild(applyBtn);

    const delBtn = document.createElement("button");
    delBtn.dataset.act = "delete";
    delBtn.className = "danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
        if (!confirm("Delete this pick? It won't come back.")) return;
        await fetch(`/api/picks/${p.id}`, { method: "DELETE" });
        load();
    });
    actions.appendChild(delBtn);

    el.appendChild(actions);
    return el;
}

load();
```

`static/picks.css`:

```css
section { margin-top: 1.5rem; }
.pick-card {
    border: 1px solid #ccc; border-radius: 6px; padding: 0.8rem 1rem;
    margin-bottom: 0.8rem; background: #fff;
}
.pick-head { display: flex; align-items: baseline; gap: 0.5rem; }
.rank {
    background: #333; color: #fff; border-radius: 4px;
    padding: 0.05rem 0.4rem; font-size: 0.8rem;
}
.pills { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.5rem 0; }
.pill {
    background: #eef; border-radius: 12px; padding: 0.1rem 0.6rem; font-size: 0.85rem;
}
.pill-unknown { background: #fff3cd; }
.pill-from { background: #e2e3e5; }
.reasoning { margin: 0.4rem 0; }
pre.jd { white-space: pre-wrap; font-family: inherit; background: #f7f7f7; padding: 0.6rem; }
.actions { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.5rem; }
.actions button { padding: 0.3rem 0.8rem; cursor: pointer; }
.actions button.danger { color: #a00; }
```

In `templates/index.html`, add under the `<h1>`:

```html
    <p><a href="/picks">Daily Picks &rarr;</a></p>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/test_picks_page.py --run-live -v`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `python3 -m pytest -v`
Expected: PASS (live-marked tests skipped without `--run-live`)

- [ ] **Step 6: Commit**

```bash
git add static/picks.js static/picks.css templates/index.html tests/test_picks_page.py
git commit -m "feat: render the /picks page with Applied and Delete actions"
```

---

## Task 19: README + operator runbook

**Files:**
- Modify: `README.md`
- Create: `docs/daily-scan-runbook.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Update `README.md`**

Add a section:

```markdown
## Daily job scan

`jobscan/` scrapes jobright.ai + jobright.ai (and SWElist digest links) and
surfaces ~15 ranked picks at http://localhost:8080/picks.

One-time setup:

    pip3 install -r requirements.txt
    # Chrome channel: uses your installed Google Chrome (no download).
    python3 scripts/scan_jobs.py     # opens Chrome; log into both sites, then rerun

Each run is triggered from a Claude Code chat ("scan jobs"). Claude:
1. checks Gmail for a new SWElist digest, writes its links to
   `daily_run/swelist_links.json`
2. runs `python3 scripts/scan_jobs.py`
3. reads the newest `daily_run/*.json`, dedupes against the tracker, ranks,
   and POSTs the picks to `/api/picks/bulk`

On the page: **Applied** creates a tracker row; **Delete** removes a pick for
good. Unactioned picks carry over to the next run under "Carried over".

Tuning: edit the keyword/regex lists in `jobscan/criteria.py`, then rerun.

Selector drift: if a run returns 0 candidates from a site, its HTML changed —
recapture fixtures with `scripts/capture_fixture.py` and fix the `SELECTORS`
dict in that adapter, guided by `tests/test_adapter_*.py`.
```

- [ ] **Step 2: Write the runbook**

Create `docs/daily-scan-runbook.md` with the Claude-in-chat procedure:

```markdown
# Daily scan — Claude runbook

When Allen says "scan jobs":

1. **SWElist digest.** Gmail search `from:noreply@swelist.com newer_than:3d`.
   For each digest, compute `swelist-digest:<message-id>`; skip if that key is
   already in `seen_jobs` (query the DB). For a new one, read the HTML body,
   run its links through `jobscan.swelist_links.extract_job_links`, and write
   the combined list to `daily_run/swelist_links.json`.
   If Gmail tools are missing, note it and continue feed-only.

2. **Run the scraper.** `python3 scripts/scan_jobs.py`. If it prints
   "NOT LOGGED IN", tell Allen to log into that site in the open Chrome
   window and rerun.

3. **Rank.** Read the newest `daily_run/*.json`.
   - Drop any candidate that fuzzy-matches an existing `applications` row
     (company + role) — mark its `seen_jobs` row `applied`.
   - Load current carryover: `GET /api/picks` rows with `status='new'`.
   - Apply `job_tracker_swelist_filter` judgment to swelist candidates
     (strict Summer, per-company cap, verify individually).
   - Rank the merged set; write a 1-2 sentence `reasoning` for the top 15.
   - `POST /api/picks/bulk` `{run_date: today, picks: [...]}`.
   - For each SWElist digest processed, insert a `seen_jobs` row
     `swelist-digest:<message-id>` (disposition `dropped`,
     drop_reason `email-processed`).

4. **Report.** One line per source (counts) + the `/picks` URL.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/daily-scan-runbook.md
git commit -m "docs: daily scan setup and Claude runbook"
```

---

## Task 20: End-to-end live shakedown (manual)

**Files:** none (may produce small selector fixes in `jobscan/adapters/*.py`).

**Interfaces:** none.

- [ ] **Step 1: Full run against live sites**

With Allen logged into both sites in the dedicated profile:

```bash
python3 scripts/scan_jobs.py
```

Confirm: it finishes without an unhandled exception, prints per-source counts, and writes `daily_run/<ts>.json` with a non-empty `candidates` list and sane `dropped` reasons. If a source shows `scanned 0` or all-prefiltered, fix that adapter's `SELECTORS` (recapture fixture, adjust, re-run `tests/test_adapter_*.py`).

- [ ] **Step 2: Rank + publish a real batch**

Follow `docs/daily-scan-runbook.md` steps 3-4 by hand: dedupe, rank ~15, `POST /api/picks/bulk`. Open `http://localhost:8080/picks` and verify the three sections, pills, reasoning, and the collapsed description.

- [ ] **Step 3: Exercise the buttons**

Click **Applied** on one pick → confirm a new row appears at `/` with `status=Applied`, `type` matching, and the pick moves to "Applied today". Click **Delete** on another → confirm it's gone and, re-running `scripts/scan_jobs.py`, that job is not rescraped (its `seen_jobs` row is `deleted`).

- [ ] **Step 4: Repeat-scan check**

Run `python3 scripts/scan_jobs.py` again immediately. Confirm the summary shows almost everything skipped (already in `seen_jobs`) and the run finishes in a fraction of the first run's time.

- [ ] **Step 5: Commit any selector fixes**

```bash
git add jobscan/adapters/ tests/fixtures/
git commit -m "fix: adapter selector adjustments from live shakedown"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task(s) |
|---|---|
| `seen_jobs` / `daily_picks` schema + in-place migration | 1 |
| `JobCard` / `JobPosting` / `job_key` | 2 |
| `criteria.py` single source of tunables | 3 |
| `prefilter` (location/seniority/role; runs on card or posting) | 3 |
| `hardfilter` (sponsorship/clearance/degree/term; conservative) | 4 |
| term resolution → Summer/New Grad/Unknown | 4 |
| `score` (no salary input) | 5 |
| `seen_jobs` read/write, skip-if-seen, terminal dispositions | 6, 12 |
| SWElist link extraction (Claude step 0, testable pure fn) | 7 |
| dedicated persistent Chrome profile, `channel="chrome"` | 8 |
| Playwright + Chrome fixture testing | 8, 9, 10, 11, 18 |
| jobright / jobright feed adapters (walk_feed stop conditions) | 9, 10 |
| SWElist adapter (`resolve_and_extract`, simplify.jobs redirect) | 11 |
| `run.py` orchestration + run artifact JSON | 12 |
| dedupe within batch across sources | 12 (by job_key) + runbook (fuzzy company/role) |
| `scripts/scan_jobs.py` entry point, NotLoggedIn handling | 13 |
| `GET /picks`, `GET /api/picks` | 14 |
| `POST /api/picks/bulk` upsert (new/carryover/applied) | 15 |
| `POST /api/picks/<id>/apply` → applications row | 16 |
| `DELETE /api/picks/<id>` → hard delete + seen_jobs deleted | 17 |
| three-section page, top-15 + More, pills, reasoning, buttons | 18 |
| carryover labeling ("from <date>") | 18 |
| error handling: login wall, selector drift, dead swelist link, no Gmail | 9/10 (LoginRequired), 11 (ResolveError), 12 (errors[]), 13, runbook |
| `.gitignore` `daily_run/`, `requirements.txt` playwright, README | 12, 8, 19 |
| SWElist digest de-dup via `seen_jobs` key | runbook (step 3) + 7 |
| Claude-in-loop ranking / review-before-write | runbook + 16 (explicit button only) |

No uncovered spec requirements. The cross-source fuzzy (company, role) dedupe and the SWElist-specific ranking judgment are Claude-in-chat steps by design (no server-side AI) and live in `docs/daily-scan-runbook.md`, which Task 19 creates and Task 20 exercises.

**2. Placeholder scan:** The three adapter `SELECTORS` dicts (Tasks 9/10/11) ship with empty string values filled during that task's Step 1 from captured HTML — this is inherent to scraping an external DOM, is explicitly scoped as a task step (not deferred), and is guarded by fixture tests. No other TODO/TBD/"handle errors appropriately" placeholders. All test code and implementation code is spelled out.

**3. Type consistency:**
- `job_key` string form `"{source}:{external_id}"` — consistent across base.py, seen.py, run.py, endpoints.
- `prefilter(item)` accepts `JobCard | JobPosting` — Task 3 defines it, Task 12 calls it with both.
- `walk_feed(page, is_seen=...)` — signature defined in Task 9, matched in Task 10, called in Task 12.
- `resolve_and_extract(page, url, company_hint="", role_hint="")` — Task 11 defines, Task 12 calls with kwargs.
- `run(db_path, feed_adapters, swelist_adapter, swelist_links, page, out_dir, today=None)` — Task 12 defines, Task 13 calls positionally with matching order.
- `daily_picks` columns — identical list in Task 1 schema, Task 14 SELECT, Task 15 INSERT, Task 18 field reads.
- Run artifact keys (`summary`/`candidates`/`dropped`/`errors`, per-source `scanned`/`prefiltered`/`hardfiltered`/`candidates`) — Task 12 produces, Task 13 `format_summary` consumes.
- `app_type` ∈ `{"Intern","Entry","Other"}` = `TYPE_VALUES` — Task 12 `app_type_for`, Task 15 validation, Task 16 apply mapping.

No inconsistencies found.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-02-daily-job-scan-pipeline.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

Note: Tasks 9, 10, 11, and 20 have manual capture/login steps that need you present (logged into jobright.ai, jobright.ai, and a recent SWElist email handy). Tasks 1–8 and 14–17 are fully automated and can run start to finish without you.
