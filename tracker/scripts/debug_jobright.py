"""One-shot diagnostic for the jobright feed's infinite scroll. Opens the
logged-in feed headed, tries several scroll strategies, and prints how many
cards each one surfaces — so we can tell which one actually works.
Run from the repo root:  python3 scripts/debug_jobright.py
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jobscan.profile import launch
from jobscan.adapters.jobright import SELECTORS, feed_url, parse_cards

DIMS_JS = """() => {
    const doc = document.scrollingElement || document.documentElement;
    const out = {
        window: [doc.scrollTop, doc.scrollHeight, doc.clientHeight],
    };
    for (const el of document.querySelectorAll('[class*="scroll"], [class*="Scroll"]')) {
        if (el.scrollHeight > el.clientHeight + 4) {
            const cls = el.className.toString().slice(0, 60);
            out[cls] = [el.scrollTop, el.scrollHeight, el.clientHeight];
        }
    }
    return out;
}"""


def main():
    with launch(headless=False) as (ctx, page):
        page.goto(feed_url(), wait_until="domcontentloaded")
        time.sleep(4)
        print("landed on:", page.url)

        cards = parse_cards(page)
        print(f"initial: dom_cards={len(page.query_selector_all(SELECTORS['card']))} parsed={len(cards)}")
        print("candidate scrollable elements (scrollTop, scrollHeight, clientHeight):")
        for name, dims in page.evaluate(DIMS_JS).items():
            print(f"    {name!r}: {dims}")

        print("\n--- strategy: window.scrollBy ---")
        for i in range(4):
            page.evaluate("() => window.scrollBy(0, 3000)")
            time.sleep(1.5)
            n = len(page.query_selector_all(SELECTORS["card"]))
            print(f"  after scrollBy #{i}: dom_cards={n}")

        print("\n--- strategy: mouse wheel over the card list ---")
        first_card = page.query_selector(SELECTORS["card"])
        if first_card:
            box = first_card.bounding_box()
            if box:
                page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        for i in range(4):
            page.mouse.wheel(0, 2500)
            time.sleep(1.5)
            n = len(page.query_selector_all(SELECTORS["card"]))
            print(f"  after wheel #{i}: dom_cards={n}")

        print("\n--- strategy: scroll last card into view + End key ---")
        for i in range(4):
            els = page.query_selector_all(SELECTORS["card"])
            if els:
                els[-1].scroll_into_view_if_needed(timeout=3000)
            page.keyboard.press("End")
            time.sleep(1.5)
            n = len(page.query_selector_all(SELECTORS["card"]))
            print(f"  after scroll_into_view+End #{i}: dom_cards={n}")

        print("\nfinal candidate scrollable elements:")
        for name, dims in page.evaluate(DIMS_JS).items():
            print(f"    {name!r}: {dims}")

        input("\nDone. Press Enter to close the browser...")


if __name__ == "__main__":
    main()
