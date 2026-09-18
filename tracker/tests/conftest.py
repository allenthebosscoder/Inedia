import pytest


def pytest_addoption(parser):
    parser.addoption("--run-live", action="store_true", default=False,
                     help="run tests marked 'live' against real logged-in sites")


def pytest_collection_modifyitems(config, items):
    if config.getoption("--run-live"):
        return
    skip_live = pytest.mark.skip(reason="needs --run-live")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip_live)


@pytest.fixture
def chrome_page():
    """Bundled chromium (ENV1): this fixture only renders static
    page.set_content(...) HTML, where the browser engine is interchangeable.
    Real-browser coverage lives in the --run-live smoke tests and the Task 20
    live shakedown. jobscan.profile.launch() also uses Playwright's bundled
    Chromium (system Google Chrome fails to launch under Playwright on this
    setup); it just adds a persistent logged-in user-data dir."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            yield page
        finally:
            browser.close()
