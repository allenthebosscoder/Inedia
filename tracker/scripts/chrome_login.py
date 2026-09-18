"""Open the dedicated Playwright Chrome profile (headed) so you can sign into
jobright.ai and joinrunway.io. The session persists in ~/.jobtracker/chrome-profile
for later scraping. Sign into BOTH sites, then close the browser (or Ctrl-C
this script) when done — either way the login is already saved.

Usage (from the repo root):  python3 scripts/chrome_login.py
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from playwright.sync_api import sync_playwright

from jobscan.profile import PROFILE_DIR


def main():
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            viewport={"width": 1440, "height": 900},
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto("https://jobright.ai/jobs", wait_until="domcontentloaded")
        second = ctx.new_page()
        second.goto("https://app.joinrunway.io", wait_until="domcontentloaded")

        print(f"Browser open with profile {PROFILE_DIR}", flush=True)
        print("Sign into jobright.ai AND app.joinrunway.io in this window.", flush=True)
        print("Close the browser (or press Ctrl-C here) when done.", flush=True)

        browser = ctx.browser  # None for a persistent context on some builds
        try:
            while True:
                if browser is not None and not browser.is_connected():
                    break
                try:
                    if not ctx.pages:  # all tabs closed
                        break
                except Exception:
                    break  # context/browser went away
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            try:
                ctx.close()
            except Exception:
                pass
    print("Done — session saved to the profile.", flush=True)


if __name__ == "__main__":
    main()
