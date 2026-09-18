"""Save the current DOM of a page to a fixture file, using the dedicated
Chrome profile (so you stay logged in).

    python3 scripts/capture_fixture.py <url> <output_path>

Opens headed; waits for you to press Enter so you can log in / dismiss
modals / let the feed load before it snapshots.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jobscan.profile import launch


def main(url: str, out_path: str) -> None:
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with launch(headless=False) as (context, page):
        page.goto(url, wait_until="domcontentloaded")
        input(
            f"Navigated to {url}\n"
            "Click into the job / open the full description (new tabs are fine), "
            "then press Enter to snapshot the frontmost page..."
        )
        # Capture whatever tab is now in front — clicking a job may open a new one.
        target = context.pages[-1] if context.pages else page
        try:
            target.bring_to_front()
        except Exception:
            pass
        html = target.content()
        out.write_text(html)
        print(f"wrote {out} from {target.url} ({len(html)} bytes)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        raise SystemExit(2)
    main(sys.argv[1], sys.argv[2])
