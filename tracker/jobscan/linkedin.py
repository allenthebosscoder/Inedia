"""Dedicated, persistent browser profile for READ-ONLY LinkedIn lookups
(contact finding, reply detection). Separate from the jobright/runway profile
so a LinkedIn flag can never affect the job scans. Never sends, connects, or
clicks anything that writes. Headed by default: headless is a stronger bot
signal. Uses Playwright's bundled Chromium (see jobscan/profile.py for why
channel="chrome" is not used)."""
from __future__ import annotations

import contextlib
import random
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

LINKEDIN_PROFILE_DIR = Path.home() / ".jobtracker" / "linkedin-profile"

BLOCK_MARKERS = ("/checkpoint", "/authwall", "/login", "/uas/")


class LinkedInBlocked(RuntimeError):
    """LinkedIn redirected to a login wall / checkpoint. Stop, do not retry."""


def is_blocked_url(url: str) -> bool:
    return any(marker in url for marker in BLOCK_MARKERS)


def check_not_blocked(page) -> None:
    if is_blocked_url(page.url):
        raise LinkedInBlocked(f"LinkedIn redirected to {page.url} -- sign in again with "
                              "scripts/linkedin_login.py or clear the checkpoint by hand")


def pace(lo: float = 2.0, hi: float = 5.0, sleep=time.sleep) -> None:
    """Human-ish random pause between page loads."""
    sleep(random.uniform(lo, hi))


@contextlib.contextmanager
def launch(headless: bool = False):
    LINKEDIN_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(LINKEDIN_PROFILE_DIR),
            headless=headless,
            viewport={"width": 1440, "height": 900},
        )
        page = context.pages[0] if context.pages else context.new_page()
        try:
            yield context, page
        finally:
            context.close()
