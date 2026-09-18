"""Dedicated, persistent browser profile for the scraper. Allen logs into
jobright + runway once in this profile; the session persists across runs.
Never touches Allen's everyday Chrome profile.

Uses Playwright's bundled Chromium rather than channel="chrome": the system
Google Chrome fails to launch under Playwright on this setup ("Trying to
load the allocator multiple times" — a Chrome 151 / Playwright 1.62
incompatibility), on both the sandbox and a normal terminal. Bundled
Chromium (same engine version) launches fine. The scraper only needs a
persistent logged-in session, not Chrome branding.
"""
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
            headless=headless,
            viewport={"width": 1440, "height": 900},
        )
        page = context.pages[0] if context.pages else context.new_page()
        try:
            yield context, page
        finally:
            context.close()
