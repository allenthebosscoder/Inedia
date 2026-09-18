"""Orchestrates a scan: walk feeds + resolve SWElist links, apply prefilter
and hardfilter, score survivors, update seen_jobs, write a run artifact.
Browser-agnostic — the caller passes an already-open Playwright page."""
from __future__ import annotations

import dataclasses
import datetime
import json
import os
from pathlib import Path

from db import get_db, init_db
from jobscan import seen
from jobscan.adapters.base import BlockedError, dedup_key
from jobscan.adapters.jobright import LoginRequired as JobrightLogin
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


def _dedup_terminal_skip(item, conn, key, dropped) -> str | None:
    """If this posting's cross-source twin was already applied/deleted, record
    it directly under this key with the same disposition and return it — so the
    scanner skips it (and skips the detail-page fetch, when called at card level)."""
    dk = dedup_key(item.company, item.role)
    disp = seen.terminal_dedup_disposition(conn, dk)
    if disp:
        seen.record(conn, key=key, source=item.source, url=item.url,
                    disposition=disp, drop_reason=f"dedup:{disp}",
                    company=item.company, role=item.role, dedup_key=dk)
        dropped.append({"job_key": key, "reason": f"dedup:{disp}",
                        "company": item.company, "role": item.role})
    return disp


def _applied_externally_skip(item, conn, key, applied_keys, dropped) -> bool:
    """If Allen already applied to this (company, role) outside the pipeline
    -- it's in the applications table but not seen_jobs -- record it as
    applied and skip it (and the detail fetch, when called at card level)."""
    dk = dedup_key(item.company, item.role)
    if dk not in applied_keys:
        return False
    seen.record(conn, key=key, source=item.source, url=item.url,
                disposition="applied", drop_reason="dedup:applied-external",
                company=item.company, role=item.role, dedup_key=dk)
    dropped.append({"job_key": key, "reason": "dedup:applied-external",
                    "company": item.company, "role": item.role})
    return True


def _process(posting, conn, today, candidates, dropped, applied_keys=frozenset()):
    """Returns (outcome, reason): outcome is "dropped" | "candidate"; reason
    is the drop reason string (None for a candidate) so the caller can bucket
    it correctly -- "dedup:*" / "prefilter:*" / anything else (a hardfilter
    reason)."""
    key = f"{posting.source}:{posting.external_id}"
    dk = dedup_key(posting.company, posting.role)
    dedup_disp = _dedup_terminal_skip(posting, conn, key, dropped)
    if dedup_disp:
        return "dropped", f"dedup:{dedup_disp}"
    if _applied_externally_skip(posting, conn, key, applied_keys, dropped):
        return "dropped", "dedup:applied-external"
    pf = prefilter(posting)
    if pf:
        seen.record(conn, key=key, source=posting.source, url=posting.url,
                    disposition="dropped", drop_reason=pf, dedup_key=dk,
                    company=posting.company, role=posting.role)
        dropped.append({"job_key": key, "reason": pf,
                        "company": posting.company, "role": posting.role})
        return "dropped", pf
    hf = hardfilter(posting, today)
    if hf:
        seen.record(conn, key=key, source=posting.source, url=posting.url,
                    disposition="dropped", drop_reason=hf, dedup_key=dk,
                    company=posting.company, role=posting.role)
        dropped.append({"job_key": key, "reason": hf,
                        "company": posting.company, "role": posting.role})
        return "dropped", hf
    term = resolve_term(posting, today)
    sc = score(posting, today)
    seen.record(conn, key=key, source=posting.source, url=posting.url,
                disposition="candidate", dedup_key=dk,
                company=posting.company, role=posting.role)
    candidates.append(_candidate_dict(posting, term, sc))
    return "candidate", None


def _bucket_for(reason: str) -> str:
    if reason.startswith("dedup:"):
        return "deduped"
    if reason.startswith("prefilter:"):
        return "prefiltered"
    return "hardfiltered"


def _group_by_dedup_key(candidates: list[dict]) -> list[dict]:
    """Collapse cross-source / multi-location twins into one candidate per
    dedup_key, keeping the first (feeds before swelist) as primary and folding
    every twin's location into `locations`."""
    groups: dict[str, dict] = {}
    for c in candidates:
        dk = dedup_key(c["company"], c["role"])
        entry = {"location": c.get("location", ""), "url": c.get("url", ""),
                 "source": c["source"]}
        if dk not in groups:
            primary = dict(c)
            primary["locations"] = [entry]
            groups[dk] = primary
        elif entry not in groups[dk]["locations"]:
            groups[dk]["locations"].append(entry)
    return list(groups.values())


def _noop(*_a, **_k):
    pass


def run(db_path, feed_adapters, swelist_adapter, swelist_links, page, out_dir,
        today=None, progress=None, detail_page=None):
    """`page` scrolls the feed(s); `detail_page` (defaults to `page`) is used
    for extract_detail/resolve_and_extract calls that navigate away — keeping
    them separate means opening a job's detail page never disturbs the feed
    page's scroll position. An adapter whose extract_detail must run ON the
    feed page itself (e.g. it clicks a row rather than following a URL) opts
    out by setting `uses_separate_detail_page = False`."""
    today = today or datetime.date.today()
    say = progress or _noop
    detail_page = detail_page if detail_page is not None else page
    init_db(db_path)
    conn = get_db(db_path)
    applied_keys = seen.applied_dedup_keys(conn)
    candidates: list[dict] = []
    dropped: list[dict] = []
    errors: list[dict] = []
    summary: dict = {}

    def _fresh_summary() -> dict:
        return {"scanned": 0, "deduped": 0, "prefiltered": 0, "hardfiltered": 0,
                "candidates": 0, "errors": 0, "blocked": 0}

    def _is_seen(key: str) -> bool:
        # Adapters skip a seen card before it ever reaches _process, so this
        # callback is the only place a still-actively-listed job gets its
        # last_seen refreshed on a repeat scan.
        if seen.is_seen(conn, key):
            seen.bump(conn, key)
            return True
        return False

    try:
        for adapter in feed_adapters:
            s = _fresh_summary()
            say(f"[{adapter.source}] walking feed…")
            try:
                cards = adapter.walk_feed(page, is_seen=_is_seen)
                for card in cards:
                    s["scanned"] += 1
                    say(f"[{adapter.source}] {s['scanned']:3d}  {card.company} / {card.role}")
                    key = f"{card.source}:{card.external_id}"
                    if _dedup_terminal_skip(card, conn, key, dropped):
                        s["deduped"] += 1
                        say("      → skip (already applied/deleted)")
                        continue
                    if _applied_externally_skip(card, conn, key, applied_keys, dropped):
                        s["deduped"] += 1
                        say("      → skip (already applied outside pipeline)")
                        continue
                    pf = prefilter(card)
                    if pf:
                        seen.record(conn, key=key, source=card.source, url=card.url,
                                    disposition="dropped", drop_reason=pf,
                                    dedup_key=dedup_key(card.company, card.role),
                                    company=card.company, role=card.role)
                        dropped.append({"job_key": key, "reason": pf,
                                        "company": card.company, "role": card.role})
                        s["prefiltered"] += 1
                        say(f"      → drop ({pf})")
                        continue
                    target = page if getattr(adapter, "uses_separate_detail_page", True) is False else detail_page
                    try:
                        posting = adapter.extract_detail(target, card)
                    except BlockedError as e:
                        errors.append({"url": card.url, "error": str(e), "blocked": True})
                        s["blocked"] += 1
                        say(f"      → blocked ({e})")
                        continue
                    except Exception as e:  # noqa: BLE001 - log and continue
                        errors.append({"url": card.url, "error": repr(e)})
                        s["errors"] += 1
                        say(f"      → error: {e!r}")
                        continue
                    outcome, reason = _process(posting, conn, today, candidates, dropped, applied_keys)
                    if outcome == "dropped":
                        s[_bucket_for(reason)] += 1
                        say(f"      → drop ({reason})")
                    else:
                        s["candidates"] += 1
                        say("      → candidate")
            except JobrightLogin:
                # A dead / logged-out session must abort the whole scan, not
                # be swallowed as a per-adapter error -- scripts/scan_jobs.py
                # catches this and tells Allen to log in again.
                raise
            except Exception as e:  # noqa: BLE001
                errors.append({"url": adapter.feed_url(), "error": repr(e)})
                s["errors"] += 1
                say(f"[{adapter.source}] feed error: {e!r}")
            summary[adapter.source] = s
            say(f"[{adapter.source}] done — {s['candidates']} candidates, "
                f"{s['scanned']} scanned")

        if swelist_adapter and swelist_links:
            s = _fresh_summary()
            for link in swelist_links:
                s["scanned"] += 1
                say(f"[swelist] {s['scanned']}/{len(swelist_links)}  {link['url']}")
                try:
                    posting = swelist_adapter.resolve_and_extract(
                        detail_page, link["url"],
                        company_hint=link.get("company_hint", ""),
                        role_hint=link.get("role_hint", ""),
                    )
                except BlockedError as e:
                    errors.append({"url": link["url"], "error": str(e), "blocked": True})
                    s["blocked"] += 1
                    continue
                except Exception as e:  # noqa: BLE001
                    errors.append({"url": link["url"], "error": repr(e)})
                    s["errors"] += 1
                    continue
                key = f"{posting.source}:{posting.external_id}"
                if seen.is_seen(conn, key):
                    continue
                outcome, reason = _process(posting, conn, today, candidates, dropped, applied_keys)
                if outcome == "dropped":
                    s[_bucket_for(reason)] += 1
                else:
                    s["candidates"] += 1
            summary["swelist"] = s

        # Collapse cross-source / multi-location twins into one candidate
        # each, folding every twin's location into `locations`, then rank by
        # heuristic score (Claude re-ranks on top of this; it only bounds how
        # many survivors get hand-reviewed).
        deduped = _group_by_dedup_key(candidates)
        deduped.sort(key=lambda c: -c["heuristic_score"])
    finally:
        conn.close()

    artifact = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc)
                        .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "summary": summary,
        "candidates": deduped,
        "dropped": dropped,
        "errors": errors,
    }

    os.makedirs(out_dir, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    Path(out_dir, f"{stamp}.json").write_text(json.dumps(artifact, indent=2))
    return artifact
