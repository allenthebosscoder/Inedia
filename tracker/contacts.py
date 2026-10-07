"""Helpers for the LinkedIn contacts feature (see
docs/superpowers/specs/2026-10-02-contact-finding-design.md)."""
import re
from urllib.parse import urlsplit

CATEGORIES = ("alumni", "engineer", "recruiter")
STATUSES = ("found", "drafted", "sent", "replied", "skipped")

_PROFILE_PATH = re.compile(r"^/in/([^/]+)")


def normalize_profile_url(url) -> str:
    """Canonical https://www.linkedin.com/in/<slug> or "" if not a profile URL.
    Query string, fragment, trailing slash and slug case are discarded so the
    same person always maps to one key."""
    parts = urlsplit((url or "").strip())
    host = (parts.netloc or "").lower()
    if host != "linkedin.com" and not host.endswith(".linkedin.com"):
        return ""
    match = _PROFILE_PATH.match(parts.path)
    if not match:
        return ""
    return f"https://www.linkedin.com/in/{match.group(1).lower()}"
