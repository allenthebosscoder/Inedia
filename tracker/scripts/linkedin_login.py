"""Open the dedicated LinkedIn Playwright profile (headed) so you can sign in
once. The session persists in ~/.jobtracker/linkedin-profile. Close the browser
(or Ctrl-C) when done -- the login is already saved.

Usage (from the tracker root):  python3 scripts/linkedin_login.py
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jobscan.linkedin import launch, LINKEDIN_PROFILE_DIR


def main():
    with launch(headless=False) as (ctx, page):
        page.goto("https://www.linkedin.com/login", wait_until="domcontentloaded")
        print(f"Browser open with profile {LINKEDIN_PROFILE_DIR}", flush=True)
        print("Sign into LinkedIn, then close the browser (or Ctrl-C) when done.", flush=True)
        try:
            while ctx.pages:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        except Exception:
            pass  # context/browser went away
    print("Done -- session saved to the profile.", flush=True)


if __name__ == "__main__":
    main()
