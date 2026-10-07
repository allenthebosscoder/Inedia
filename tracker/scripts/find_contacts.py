"""Find alumni, relevant engineers, and recruiters at a company on
LinkedIn (READ-ONLY) and store them via the tracker API.

Usage (from the tracker root, tracker server running):
    python3 scripts/find_contacts.py "Acme" [--role-keywords "firmware engineer"]
        [--max 15] [--api http://localhost:8080] [--dry-run] [--save-html DIR]

Never clicks Message/Connect/Follow. Exits 2 (posting nothing) if LinkedIn
shows a login wall or checkpoint. Requires scripts/linkedin_login.py once.
"""
import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jobscan.linkedin import LinkedInBlocked, check_not_blocked, launch, pace
from jobscan.linkedin_extract import extract_people

CATEGORY_ORDER = ("alumni", "engineer", "recruiter")
PER_SEARCH_CAP = 8
RECRUITER_WORDS = ("recruit", "talent acquisition", "sourcer")


def search_queries(company: str, role_keywords: str):
    return [
        ("alumni", f"{company} alumni"),
        ("engineer", f"{company} {role_keywords}"),
        ("recruiter", f"{company} university recruiter"),
    ]


def search_url(query: str) -> str:
    return ("https://www.linkedin.com/search/results/people/?keywords="
            + urllib.parse.quote(query, safe=""))


def collect(results_by_category: dict, company: str, max_total: int) -> list[dict]:
    """Merge per-search people into one capped, deduped, categorized list.
    Drops anyone whose card text never mentions the company (LinkedIn keyword
    search is fuzzy). A recruiter-looking title always wins the category."""
    needle = re.compile(r"(?<!\w)" + re.escape(company) + r"(?!\w)", re.I)
    seen, out = set(), []
    for category in CATEGORY_ORDER:
        for person in results_by_category.get(category, [])[:PER_SEARCH_CAP]:
            if person["profile_url"] in seen or not needle.search(person["blob"]):
                continue
            seen.add(person["profile_url"])
            is_recruiter = any(w in person["title"].casefold() for w in RECRUITER_WORDS)
            out.append({
                "name": person["name"], "title": person["title"],
                "profile_url": person["profile_url"],
                "category": "recruiter" if is_recruiter else category,
            })
    return out[:max_total]


def post_bulk(api: str, company: str, contacts: list[dict]) -> dict:
    req = urllib.request.Request(
        f"{api}/api/contacts/bulk",
        data=json.dumps({"company": company, "contacts": contacts}).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    return json.loads(urllib.request.urlopen(req).read())


def search_all(company: str, role_keywords: str, save_html: str | None = None) -> dict:
    results = {}
    with launch(headless=False) as (_, page):
        for category, query in search_queries(company, role_keywords):
            page.goto(search_url(query), wait_until="domcontentloaded")
            check_not_blocked(page)
            try:
                page.wait_for_selector('a[href*="/in/"]', timeout=15000)
            except Exception:
                check_not_blocked(page)  # a late wall looks like "no results"
                results[category] = []   # zero results is normal, not an error
                pace()
                continue
            page.mouse.wheel(0, 1200)    # one scroll to load lazy cards
            pace(1.0, 2.0)
            check_not_blocked(page)
            if save_html:
                Path(save_html).mkdir(parents=True, exist_ok=True)
                (Path(save_html) / f"{category}.html").write_text(page.content())
            results[category] = extract_people(page)
            pace()
    return results


def _parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser()
    ap.add_argument("company")
    ap.add_argument("--role-keywords", default="engineer")
    ap.add_argument("--max", type=int, default=15)
    ap.add_argument("--api", default="http://localhost:8080")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--save-html", default=None)
    return ap


def main(argv=None) -> int:
    args = _parser().parse_args(argv)
    try:
        results = search_all(args.company, args.role_keywords, args.save_html)
    except LinkedInBlocked as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 2
    contacts = collect(results, args.company, args.max)
    for c in contacts:
        print(f"[{c['category']:9}] {c['name']} -- {c['title']}  {c['profile_url']}")
    if not contacts:
        print("No matching people found.")
        return 0
    if args.dry_run:
        return 0
    print(post_bulk(args.api, args.company, contacts))
    return 0


if __name__ == "__main__":
    sys.exit(main())
