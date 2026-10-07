"""Keep posting links separate from editable application notes."""
import re
from urllib.parse import urlsplit, urlunsplit


DAILY_PICK_LINK = re.compile(
    r"(?:From\s+)?Daily\s+Picks?(?:\s+link)?\s*:\s*(https?://[^\s<>]+)",
    re.IGNORECASE,
)


def posting_url(url):
    """Remove a final /apply path segment, preserving query and fragment."""
    if not url:
        return ""
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
        return url
    path = re.sub(r"/apply/?$", "", parts.path, flags=re.IGNORECASE)
    return urlunsplit(parts._replace(path=path)) if path != parts.path else url


def split_posting_notes(notes, url=""):
    """Extract a labeled posting link without consuming other URLs in notes."""
    notes = notes or ""
    match = DAILY_PICK_LINK.search(notes)
    if match:
        extracted = match[1].rstrip(".,;")
        url = url or extracted
        # Remove only this link/label and its adjacent note separator.
        before = notes[:match.start()]
        after = notes[match.end():]
        if not before.strip():
            notes = after.lstrip(" |;\n\r\t")
        elif not after.strip():
            notes = before.rstrip(" |;\n\r\t")
        else:
            notes = before + after.lstrip()
    elif re.fullmatch(r"https?://\S+", notes.strip(), re.IGNORECASE):
        url = url or notes.strip()
        notes = ""
    return notes, posting_url(url)


def migrate_posting_links(conn):
    """Idempotently repair existing rows; retain statuses and history dates."""
    pick_columns = {r["name"] for r in conn.execute("PRAGMA table_info(daily_picks)")}
    linked = {}
    if {"id", "url", "application_id"} <= pick_columns:
        for pick in conn.execute("SELECT id, url, application_id FROM daily_picks ORDER BY id"):
            url = posting_url(pick["url"])
            if pick["application_id"]:
                linked.setdefault(pick["application_id"], url)
    for row in conn.execute("SELECT id, notes, posting_url FROM applications"):
        notes, url = split_posting_notes(row["notes"], row["posting_url"])
        url = url or linked.get(row["id"], "")
        if notes != (row["notes"] or "") or url != (row["posting_url"] or ""):
            conn.execute("UPDATE applications SET notes=?, posting_url=? WHERE id=?",
                         (notes, url, row["id"]))
