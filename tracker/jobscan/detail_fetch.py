"""Fetch a job posting's detail text without a browser where possible.

The generic path (Playwright ``body.innerText``) trips bot-walls on
Workday, gets SPA shells from some ATSs, and -- worse -- never sees the
sponsorship / clearance clause, which lives in a separate description
field or in the application *questions*, not the JD body. Most career
sites expose an unprotected JSON API with all of that. ``fetch_ats_detail``
resolves a ``simplify.jobs`` link to its real ATS URL, hits that API, and
returns the JD with the application questions appended as a
``--- Application questions ---`` block so ``hardfilter`` can read them.
"""
from __future__ import annotations

import json
import re
import urllib.request
from html import unescape
from urllib.parse import urlsplit

_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

_BLOCK_MARKERS = (
    "access denied", "you don't have permission", "verify you are human",
    "are you a robot", "just a moment", "attention required", "enable javascript",
    "please turn javascript on", "unusual traffic", "currently unavailable",
    "service interruption", "request blocked", "captcha",
    # a removed/expired Workday posting -- the site chrome around this
    # generic message easily clears the 300-char floor (HPE 2026-09-12,
    # Intel 2026-09-14).
    "the page you are looking for doesn't exist",
    # same problem, a different ATS's phrasing (Dell/Oracle Cloud, 2026-09-15).
    "this job is no longer available",
    # a third ATS's phrasing (Greenhouse, 2026-09-15) -- the page redirects
    # to the board's full job list, wrapping the dead-posting message in
    # plenty of real-looking site chrome.
    "the job you are looking for is no longer open",
)

QUESTIONS_HEADER = "--- Application questions ---"

# Question labels that disqualify Allen (Singaporean, needs sponsorship).
# NOT "require sponsorship?" / "authorized to work?" -- every posting asks
# those, and asking means they consider sponsored candidates.
_RESTRICTED_Q_RX = re.compile(
    r"clearance\s+eligibility|active\s+(?:security\s+)?clearance|security\s+clearance"
    r"|able\s+to\s+obtain[^?]*clearance"
    r"|(?:are\s+you\s+a\s+)?u\.?s\.?\s+citizen[^?]*\b(?:required|only)\b"
    r"|export\s+control[^?]*u\.?s\.?\s+person", re.I)


def looks_blocked(text: str) -> bool:
    """True for a bot-wall block page, an ATS outage page, or near-empty
    content -- anything that isn't a real JD."""
    t = (text or "").strip()
    if len(t) < 300:
        return True
    head = t[:600].lower()
    if any(m in head for m in _BLOCK_MARKERS):
        return True
    # linkedin.com/jobs/view sign-in wall: our browser profile has no
    # LinkedIn login, so every fetch there lands on this page, never a real
    # JD -- and it clears the 300-char floor easily (sometimes even echoing
    # the role/company title near the bottom), so a caller could mistake it
    # for a real, if short, posting. "LinkedIn" as the page's own top-of-page
    # branding (right after the accessibility skip-link) is the signal; a
    # real JD hosted elsewhere wouldn't open with that.
    return "linkedin" in t[:50].lower()


def restricted_by_questions(labels: list[str]) -> str | None:
    """A disqualifying reason ("clearance") if any application-question
    label screens for clearance / citizens-only / export-control US-person."""
    for lbl in labels:
        if _RESTRICTED_Q_RX.search(lbl or ""):
            return "clearance"
    return None


# --- URL helpers ---------------------------------------------------------

def simplify_click_url(url: str) -> str | None:
    """`simplify.jobs/p/{uuid}/...` -> `simplify.jobs/jobs/click/{uuid}`
    (which 302s to the real ATS posting). None for non-simplify URLs."""
    p = urlsplit(url)
    if "simplify.jobs" not in p.netloc:
        return None
    m = re.search(r"/p/([0-9a-f-]{36})", p.path)
    return f"https://simplify.jobs/jobs/click/{m.group(1)}" if m else None


def resolve_source_url(url: str) -> str:
    """Follow a simplify.jobs link to the real ATS URL (tracking params
    stripped). Any other URL, or a failure, returns the input unchanged."""
    click = simplify_click_url(url)
    if not click:
        return url
    try:
        req = urllib.request.Request(click, method="HEAD", headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=15) as r:  # noqa: S310
            final = r.geturl()
    except Exception:  # noqa: BLE001
        return url
    sp = urlsplit(final)
    return f"{sp.scheme}://{sp.netloc}{sp.path}" if sp.scheme else url


def workday_api_url(url: str) -> str | None:
    """`https://{t}.wdN.myworkdayjobs.com[/en-US]/{site}/job/{rest}`
    -> `https://{t}.wdN.myworkdayjobs.com/wday/cxs/{t}/{site}/job/{rest}`."""
    p = urlsplit(url)
    if not p.netloc.endswith(".myworkdayjobs.com"):
        return None
    tenant = p.netloc.split(".", 1)[0]
    path = re.sub(r"^/[a-z]{2}-[A-Za-z]{2}(?=/)", "", p.path)  # drop /en-US locale
    m = re.match(r"^/([^/]+)/job/(.+)$", path)
    if not m:
        return None
    return f"{p.scheme}://{p.netloc}/wday/cxs/{tenant}/{m.group(1)}/job/{m.group(2)}"


_TRACKING_PARAMS = {
    "source", "src", "jr_id", "jr-id", "gh_src", "ref", "referrer",
    "recruiter", "utm_source", "utm_medium", "utm_campaign", "utm_content",
    "utm_term", "dcr_cmi",
}


def strip_tracking(url: str) -> str:
    """Drop the aggregator's tracking query params (?source=jobright, &jr_id=,
    &gh_src=Simplify, utm_*) but keep functional ones (token, for, id)."""
    from urllib.parse import parse_qsl, urlencode, urlunsplit
    p = urlsplit(url or "")
    kept = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
            if k.lower() not in _TRACKING_PARAMS]
    return urlunsplit((p.scheme, p.netloc, p.path, urlencode(kept), ""))


def greenhouse_api_url(url: str, company: str = "") -> str | None:
    p = urlsplit(url)
    if "greenhouse.io" not in p.netloc:
        return None
    m = re.search(r"/([^/]+)/jobs/(\d+)", p.path)
    if m:
        board, jid = m.group(1), m.group(2)
    else:  # embed form: /embed/job_app?for=<slug>&token=NNN
        tok = re.search(r"[?&]token=(\d+)", url)
        forp = re.search(r"[?&]for=([A-Za-z0-9_-]+)", url)
        slug = (forp.group(1).lower() if forp
                else re.sub(r"[^a-z0-9]", "", (company or "").lower()))
        if not (tok and slug):
            return None
        board, jid = slug, tok.group(1)
    return f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{jid}?questions=true"


def smartrecruiters_api_url(url: str) -> str | None:
    """`jobs.smartrecruiters.com/{Company}/{postingId}` ->
    `api.smartrecruiters.com/v1/companies/{Company}/postings/{postingId}`."""
    p = urlsplit(url)
    if "smartrecruiters.com" not in p.netloc:
        return None
    m = re.match(r"^/([^/]+)/(\d+)", p.path)
    return (f"https://api.smartrecruiters.com/v1/companies/{m.group(1)}/postings/{m.group(2)}"
            if m else None)


def workable_api_url(url: str) -> str | None:
    """`apply.workable.com/{co}/j/{shortcode}` ->
    `apply.workable.com/api/v1/accounts/{co}/jobs/{shortcode}`."""
    p = urlsplit(url)
    if "workable.com" not in p.netloc:
        return None
    m = re.match(r"^/([^/]+)/j/([^/]+)", p.path)
    return (f"https://apply.workable.com/api/v1/accounts/{m.group(1)}/jobs/{m.group(2)}"
            if m else None)


def lever_api_url(url: str) -> str | None:
    p = urlsplit(url)
    if "lever.co" not in p.netloc:
        return None
    m = re.match(r"^/([^/]+)/([0-9a-f-]{36}|[\w-]+)", p.path)
    if not m:
        return None
    # jobs.eu.lever.co postings need api.eu.lever.co -- api.lever.co (no
    # "eu.") 404s on them. Swap only the "jobs" host label so any regional
    # subdomain (jobs.eu.lever.co, jobs.lever.co, ...) is preserved.
    api_host = re.sub(r"^jobs\.", "api.", p.netloc)
    return f"https://{api_host}/v0/postings/{m.group(1)}/{m.group(2)}?mode=json"


def ashby_api_url(url: str) -> str | None:
    """`jobs.ashbyhq.com/{org}/{uuid}` -> the org's job-board API (a list;
    fetch_ats_detail picks the row whose id is {uuid})."""
    p = urlsplit(url)
    if "ashbyhq.com" not in p.netloc:
        return None
    m = re.match(r"^/([^/]+)/([0-9a-f-]{36})", p.path)
    return (f"https://api.ashbyhq.com/posting-api/job-board/{m.group(1)}#{m.group(2)}"
            if m else None)


_ATS_HOST_RX = re.compile(
    r"https://[a-z0-9.-]+\.myworkdayjobs\.com/[^\s\"'<>\\)]+"
    r"|https://(?:boards|job-boards)\.greenhouse\.io/(?:embed/job_app\?token=\d+|[a-z0-9_-]+/jobs/\d+)"
    r"|https://jobs\.smartrecruiters\.com/[A-Za-z0-9_-]+/\d+"
    r"|https://[a-z0-9-]+\.oraclecloud\.com/[^\s\"'<>\\)]*?/job/\d+"
    r"|https://apply\.workable\.com/[a-z0-9-]+/j/[A-Za-z0-9]+"
    r"|https://jobs\.lever\.co/[a-z0-9_-]+/[0-9a-f-]{8,}", re.I)


def posted_at_from_ats_text(text: str) -> str:
    """The `Posted: <date>` line _assemble() prepends, or ""."""
    m = re.search(r"^Posted:\s*(.+)$", text or "", re.M)
    return m.group(1).strip() if m else ""


def ats_url_in_text(text: str) -> str | None:
    """The first recognized-ATS posting URL embedded in an HTML page or
    text blob (jobright / runway render the real Apply link in the DOM).
    Prefers an explicit applyUrl/originalUrl field over a loose scan."""
    text = text or ""
    for fm in re.finditer(r'"(?:applyUrl|originalUrl|apply_url|externalUrl|jobUrl|sourceUrl)"\s*:\s*"([^"]+)"', text):
        cand = fm.group(1).replace("\\/", "/")
        if _ATS_HOST_RX.match(cand):
            return cand
    m = _ATS_HOST_RX.search(text)
    return m.group(0).rstrip('",;)') if m else None


def oracle_api_url(url: str) -> str | None:
    """Oracle Cloud HCM (`*.oraclecloud.com/.../job/{id}`) -> the
    recruitingCEJobRequisitionDetails REST finder."""
    p = urlsplit(url)
    if "oraclecloud.com" not in p.netloc:
        return None
    m = re.search(r"/job/(\d+)", p.path)
    if not m:
        return None
    return (f"{p.scheme}://{p.netloc}/hcmRestApi/resources/latest/"
            f"recruitingCEJobRequisitionDetails?expand=all&onlyData=true"
            f'&finder=ById;Id="{m.group(1)}",siteNumber=CX')


# --- HTTP + text -------------------------------------------------------

def _get_json(url: str, timeout: float = 15.0) -> dict | None:
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept": "application/json"})
    for attempt in range(2):  # Oracle Cloud in particular blips intermittently
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - fixed https hosts
                if r.status != 200:
                    return None
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001 - any failure -> retry once, then fall back
            if attempt:
                return None
    return None


def _strip_html(s: str) -> str:
    s = unescape(s or "")
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = re.sub(r"[ \t]+", " ", s)
    return re.sub(r"\s*\n\s*", "\n", s).strip()


def _assemble(title: str, posted: str, body: str, labels: list[str], location: str = "") -> str:
    parts = [title, f"Location: {location}" if location else "",
             f"Posted: {posted}" if posted else "", body]
    if labels:
        parts += ["", QUESTIONS_HEADER, *labels]
    return "\n".join(p for p in parts if p).strip()


# --- per-ATS parsers (pure; take the API JSON, return (text, posted, labels)) ---

def parse_workday(d: dict) -> tuple[str, str, list[str]]:
    info = (d or {}).get("jobPostingInfo") or {}
    body = _strip_html(info.get("jobDescription", ""))
    # `postedOn` is an unambiguous "Posted N Days Ago"; `startDate` is
    # sometimes the internship start, not the posting date.
    posted = info.get("postedOn", "") or info.get("startDate", "")
    loc = info.get("location", "") or info.get("jobPostingLocation", "")
    return _assemble(info.get("title", ""), posted, body, [], loc), posted, []


def parse_greenhouse(d: dict) -> tuple[str, str, list[str]]:
    d = d or {}
    body = _strip_html(d.get("content", ""))
    labels = [q.get("label", "").strip() for q in (d.get("questions") or []) if q.get("label")]
    posted = (d.get("updated_at") or d.get("first_published") or "")[:10]
    loc = (d.get("location") or {}).get("name", "")
    return _assemble(d.get("title", ""), posted, body, labels, loc), posted, labels


def parse_smartrecruiters(d: dict) -> tuple[str, str, list[str]]:
    d = d or {}
    sections = (d.get("jobAd") or {}).get("sections") or {}
    body = _strip_html(" ".join(
        (sections.get(k) or {}).get("text", "") for k in
        ("companyDescription", "jobDescription", "qualifications", "additionalInformation")))
    posted = (d.get("releasedDate") or "")[:10]
    lo = d.get("location") or {}
    loc = ", ".join(x for x in (lo.get("city"), lo.get("region"), lo.get("country")) if x)
    return _assemble(d.get("name", ""), posted, body, [], loc), posted, []


def parse_workable(d: dict) -> tuple[str, str, list[str]]:
    d = d or {}
    body = _strip_html(" ".join(d.get(k, "") or "" for k in
                                ("description", "requirements", "benefits")))
    lo = d.get("location") or {}
    loc = ", ".join(x for x in (lo.get("city"), lo.get("region"), lo.get("country")) if x)
    posted = (d.get("published") or d.get("created_at") or "")[:10]
    return _assemble(d.get("title", ""), posted, body, [], loc), posted, []


def parse_ashby(d: dict, job_id: str = "") -> tuple[str, str, list[str]]:
    jobs = (d or {}).get("jobs") or []
    j = next((x for x in jobs if x.get("id") == job_id), None) or (jobs[0] if jobs else {})
    body = _strip_html(j.get("descriptionHtml") or j.get("descriptionPlain") or "")
    posted = (j.get("publishedAt") or "")[:10]
    return _assemble(j.get("title", ""), posted, body, [], j.get("location", "")), posted, []


def parse_lever(d: dict) -> tuple[str, str, list[str]]:
    d = d or {}
    # Each "lists" entry is a section like Required/Preferred Qualifications:
    # `text` is just the heading, `content` is the actual <li> bullets --
    # the heading alone was silently dropping every qualification, including
    # disqualifying clauses (export control, clearance, degree) that live
    # only in that content (Acron Aviation, 2026-09-14).
    list_parts = []
    for s in (d.get("lists") or []):
        list_parts.append(s.get("text") or "")
        list_parts.append(s.get("content") or "")
    body = _strip_html(" ".join(
        [d.get("descriptionPlain") or d.get("description") or ""]
        + list_parts
        + [d.get("additionalPlain") or ""]))
    loc = ((d.get("categories") or {}).get("location") or "")
    posted = ""
    if d.get("createdAt"):
        import datetime as _dt
        posted = _dt.datetime.utcfromtimestamp(d["createdAt"] / 1000).strftime("%Y-%m-%d")
    return _assemble(d.get("text", ""), posted, body, [], loc), posted, []


def parse_oracle(d: dict) -> tuple[str, str, list[str]]:
    items = (d or {}).get("items") or []
    it = items[0] if items else {}
    body = _strip_html(" ".join(it.get(k, "") or "" for k in (
        "ExternalDescriptionStr", "CorporateDescriptionStr",
        "ExternalQualificationsStr", "ExternalResponsibilitiesStr")))
    posted = (it.get("ExternalPostedStartDate") or it.get("PostedDate") or "")[:10]
    loc = it.get("PrimaryLocation", "")
    return _assemble(it.get("Title", ""), posted, body, [], loc), posted, []


def source_jd(page, url: str, company: str = "") -> str:
    """The real posting's JD for a resolved ATS `url`: its JSON API when we
    have one, otherwise the rendered page's body text. "" when neither
    works (bot-wall, unknown host with an empty render)."""
    t = fetch_ats_detail(url, company)
    if t and not looks_blocked(t):
        return t
    return fetch_jd_via_browser(page, url)


def fetch_jd_via_browser(page, url: str) -> str:
    """Navigate `page` to `url` and return its visible body text -- the
    generic fallback for an ATS with no JSON API (iCIMS, Phenom, Eightfold,
    a company careers site). Returns "" on a bot-wall / near-empty page so
    the caller can treat it as "no JD" rather than a garbage candidate."""
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(2500)
        el = page.query_selector("body")
        text = (el.inner_text() if el else "") or ""
    except Exception:  # noqa: BLE001
        return ""
    return "" if looks_blocked(text) else text.strip()


def fetch_ats_detail(url: str, company: str = "") -> str | None:
    """Readable JD text (+ an application-questions block when the ATS
    exposes one) via the posting's JSON API. None when the host isn't one
    we recognize or every call fails. Resolves simplify.jobs links first.
    `company` only helps a Greenhouse embed URL (no board slug in it)."""
    url = resolve_source_url(url)
    ash = ashby_api_url(url)
    if ash:
        board, _, job_id = ash.partition("#")
        d = _get_json(board)
        text = parse_ashby(d, job_id)[0] if d else None
        return text or None
    for api_url, parser in ((workday_api_url(url), parse_workday),
                            (greenhouse_api_url(url, company), parse_greenhouse),
                            (smartrecruiters_api_url(url), parse_smartrecruiters),
                            (workable_api_url(url), parse_workable),
                            (lever_api_url(url), parse_lever),
                            (oracle_api_url(url), parse_oracle)):
        if not api_url:
            continue
        d = _get_json(api_url)
        if not d:
            return None
        text, _posted, _labels = parser(d)
        return text or None
    return None
