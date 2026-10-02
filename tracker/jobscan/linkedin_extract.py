"""Pull people / conversation cards off LinkedIn pages. Two layers on purpose:
a tiny in-page JS snippet that returns raw anchor + card text (the only part
that depends on LinkedIn's markup, which has obfuscated class names, so it keys
on stable things: /in/ and /messaging/thread/ hrefs), and pure-Python parsing
that is unit-tested without a browser. If LinkedIn changes its markup, fix
PEOPLE_JS / CONVERSATIONS_JS and refresh the scrubbed fixtures."""
from __future__ import annotations

import re

from contacts import normalize_profile_url

PEOPLE_JS = """
() => {
  const out = [];
  for (const a of document.querySelectorAll('a[href*="/in/"]')) {
    const card = a.closest('li') || (a.parentElement && a.parentElement.parentElement) || a;
    const lines = (card.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    out.push({href: a.href, name: (a.innerText || '').trim(), lines});
  }
  return out;
}
"""

CONVERSATIONS_JS = """
() => {
  const out = [];
  for (const a of document.querySelectorAll('a[href*="/messaging/thread/"]')) {
    const card = a.closest('li') || a;
    const lines = (card.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    out.push({href: a.getAttribute('href'), lines});
  }
  return out;
}
"""

_DEGREE = re.compile(r"^(•\s*)?(1st|2nd|3rd\+?)$", re.I)
_ACTIONS = {"connect", "message", "follow", "pending", "following", "view profile"}


def _clean_name(raw: str) -> str:
    first = (raw or "").split("\n")[0].strip()
    return re.sub(r"\s*View .*?profile.*$", "", first, flags=re.I).strip()


def parse_people(raw) -> list[dict]:
    seen, people = set(), []
    for item in raw:
        url = normalize_profile_url(item.get("href"))
        name = _clean_name(item.get("name", ""))
        if not url or not name or url in seen:
            continue
        seen.add(url)
        lines = [ln for ln in item.get("lines", []) if ln]
        title = ""
        for ln in lines:
            low = ln.lower()
            if (ln.startswith(name) or _DEGREE.match(ln) or low in _ACTIONS
                    or low.startswith("view ") or ln.startswith("•")):
                continue
            title = ln
            break
        people.append({"name": name, "title": title, "profile_url": url,
                       "blob": " | ".join(lines)})
    return people


def parse_conversations(raw) -> list[dict]:
    convs = []
    for item in raw:
        lines = [ln for ln in item.get("lines", []) if ln]
        if len(lines) < 2:
            continue
        snippet = lines[-1]
        convs.append({"name": lines[0], "snippet": snippet,
                      "from_me": snippet.lower().startswith("you:")})
    return convs


def extract_people(page) -> list[dict]:
    return parse_people(page.evaluate(PEOPLE_JS))


def extract_conversations(page) -> list[dict]:
    return parse_conversations(page.evaluate(CONVERSATIONS_JS))
