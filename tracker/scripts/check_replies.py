"""Read the LinkedIn inbox (READ-ONLY) and mark Sent contacts as Replied.

Usage (from the tracker root, tracker server running):
    python3 scripts/check_replies.py [--api http://localhost:8080] [--dry-run]

Opens only the messaging list page; never opens a thread, never types or
sends. The stored reply text is the inbox preview line. It updates the
CONTACT only -- the application's reply_received/referred flags are left for
Claude to confirm with Test. Exits 2 on a login wall / checkpoint.
"""
import argparse
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jobscan.linkedin import LinkedInBlocked, check_not_blocked, launch, pace
from jobscan.linkedin_extract import extract_conversations


def _norm(name: str) -> str:
    return " ".join(name.casefold().split())


def match_replies(contacts: list[dict], conversations: list[dict]) -> list[dict]:
    by_name = {_norm(c["name"]): c for c in contacts}
    out = []
    for conv in conversations:
        contact = by_name.get(_norm(conv["name"]))
        if contact and not conv["from_me"]:
            out.append({"id": contact["id"], "name": contact["name"], "snippet": conv["snippet"]})
    return out


def fetch_sent(api: str) -> list[dict]:
    return json.loads(urllib.request.urlopen(f"{api}/api/contacts?status=sent").read())


def patch_replied(api: str, contact_id: int, snippet: str) -> None:
    req = urllib.request.Request(
        f"{api}/api/contacts/{contact_id}",
        data=json.dumps({"status": "replied", "reply_text": snippet}).encode(),
        headers={"Content-Type": "application/json"}, method="PATCH",
    )
    urllib.request.urlopen(req).read()


def read_inbox() -> list[dict]:
    with launch(headless=False) as (_, page):
        page.goto("https://www.linkedin.com/messaging/", wait_until="domcontentloaded")
        check_not_blocked(page)
        try:
            page.wait_for_selector('a[href*="/messaging/thread/"]', timeout=15000)
        except Exception:
            return []
        pace(1.0, 2.0)
        return extract_conversations(page)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8080")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    sent = fetch_sent(args.api)
    if not sent:
        print("No contacts are in 'sent' status.")
        return 0
    try:
        conversations = read_inbox()
    except LinkedInBlocked as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 2

    replies = match_replies(sent, conversations)
    for r in replies:
        print(f"REPLY from {r['name']}: {r['snippet']}")
    if not replies:
        print("No new replies.")
    if not args.dry_run:
        for r in replies:
            patch_replied(args.api, r["id"], r["snippet"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
