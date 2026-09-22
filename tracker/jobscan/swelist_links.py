"""Pull job-posting links out of a SWElist digest email. SWElist wraps each
posting as a simplify.jobs URL; everything else in the email is nav/social."""
from __future__ import annotations

from html.parser import HTMLParser
from html import unescape

_JOB_HOSTS = ("simplify.jobs/p/", "app.simplify.jobs/p/")
_SKIP = ("unsubscribe", "swelist.com", "mailto:", "twitter.com", "linkedin.com/company",
         "instagram.com", "facebook.com")


class _LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links: list[dict] = []
        self._href: str | None = None
        self._text: list[str] = []
        self._strong_text: str = ""
        self._in_strong = False

    def handle_starttag(self, tag, attrs):
        if tag == "p":
            self._strong_text = ""
        elif tag == "a":
            self._href = dict(attrs).get("href", "")
            self._text = []
        elif tag in ("strong", "b") and self._href is None:
            self._in_strong = True
            self._text = []

    def handle_data(self, data):
        if self._href is not None or self._in_strong:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            self._flush()
            self._href = None
            self._strong_text = ""
        elif tag in ("strong", "b") and self._in_strong:
            self._strong_text = " ".join("".join(self._text).split()).strip()
            self._text = []
            self._in_strong = False

    def _flush(self):
        href = (self._href or "").strip()
        low = href.lower()
        if not any(h in low for h in _JOB_HOSTS):
            return
        if any(s in low for s in _SKIP):
            return
        role_hint = " ".join("".join(self._text).split()).strip()
        role_hint = unescape(role_hint)
        # Use strong text as company_hint, stripping trailing ':' and spaces
        company_hint = self._strong_text.rstrip(": ").strip()
        # Fallback: if no company_hint, try to extract from role_hint with @ separator
        if not company_hint and " @ " in role_hint:
            role_hint, company_hint = role_hint.split(" @ ", 1)
            role_hint = role_hint.strip()
            company_hint = company_hint.strip()
        self.links.append({"url": href, "company_hint": company_hint, "role_hint": role_hint})


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
