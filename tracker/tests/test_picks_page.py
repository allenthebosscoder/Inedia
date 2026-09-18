import threading
import pytest
from werkzeug.serving import make_server
from app import create_app


@pytest.fixture
def live_server(tmp_path):
    app = create_app(db_path=str(tmp_path / "t.db"))
    srv = make_server("127.0.0.1", 0, app)
    port = srv.socket.getsockname()[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{port}", app.config["DATABASE"]
    srv.shutdown()


def _seed(db_path):
    from db import get_db
    import datetime
    today = datetime.date.today().isoformat()
    y = (datetime.date.today() - datetime.timedelta(days=2)).isoformat()
    conn = get_db(db_path)
    def ins(**o):
        row = dict(job_key="k", source="jobright", url="https://x", company="Acme",
                   role="Firmware Intern", location="Austin, TX", salary="$40/hr",
                   term="Summer 2027", app_type="Intern", heuristic_score=1, rank=1,
                   reasoning="r", description="d", first_run_date=today, last_run_date=today,
                   status="new", updated_at=today)
        row.update(o)
        conn.execute(f"INSERT INTO daily_picks ({', '.join(row)}) VALUES ({', '.join('?' for _ in row)})",
                     list(row.values()))
    ins(job_key="t1")
    ins(job_key="c1", first_run_date=y, last_run_date=y)
    ins(job_key="a1", status="applied")
    conn.commit()
    conn.close()


@pytest.mark.live
def test_sections_render(live_server, chrome_page):
    base, db_path = live_server
    _seed(db_path)
    chrome_page.goto(f"{base}/picks")
    chrome_page.wait_for_selector("#today .pick-list .pick-card")
    assert chrome_page.query_selector("#today .pick-list .pick-card") is not None
    assert chrome_page.query_selector("#carried .pick-list .pick-card") is not None
    assert chrome_page.query_selector("#applied .pick-list .pick-card") is not None


@pytest.mark.live
def test_priority_pick_moves_to_priority_section(live_server, chrome_page):
    base, db_path = live_server
    _seed(db_path)
    chrome_page.goto(f"{base}/picks")
    chrome_page.wait_for_selector("#today .pick-card")
    chrome_page.click("#today .pick-card [data-act='priority']")
    chrome_page.wait_for_selector("#priority .pick-card")
    assert chrome_page.query_selector("#today .pick-card") is None
    assert chrome_page.query_selector("#priority .pick-card [data-act='priority']") is not None


@pytest.mark.live
def test_delete_button_removes_card(live_server, chrome_page):
    base, db_path = live_server
    _seed(db_path)
    chrome_page.goto(f"{base}/picks")
    chrome_page.wait_for_selector("#today .pick-card")
    chrome_page.on("dialog", lambda d: d.accept())
    chrome_page.click("#today .pick-card [data-act='delete']")
    chrome_page.wait_for_function(
        "document.querySelectorAll('#today .pick-list .pick-card').length === 0")


@pytest.mark.live
def test_apply_failure_surfaces_a_visible_error(live_server, chrome_page):
    # Simulate a race: the button is there (status='new'), but by the time
    # the click lands the pick has already been applied elsewhere -- the
    # server 409s. The button handler must not silently no-op.
    base, db_path = live_server
    _seed(db_path)
    chrome_page.goto(f"{base}/picks")
    chrome_page.wait_for_selector("#today .pick-card")

    # After the page has rendered the button, someone else applies to this
    # pick first (another tab, another device) -- the click that follows
    # must hit the server's 409, not silently succeed client-side.
    from db import get_db
    conn = get_db(db_path)
    conn.execute("UPDATE daily_picks SET status='applied' WHERE job_key='t1'")
    conn.commit()
    conn.close()

    messages = []
    chrome_page.on("dialog", lambda d: (messages.append(d.message), d.accept()))
    chrome_page.click("#today .pick-card [data-act='apply']")
    chrome_page.wait_for_timeout(500)
    assert any("applied" in m.lower() or "error" in m.lower() or "couldn't" in m.lower()
              for m in messages), messages


@pytest.mark.live
def test_javascript_url_is_not_rendered_as_a_real_link(live_server, chrome_page):
    base, db_path = live_server
    _seed(db_path)
    from db import get_db
    conn = get_db(db_path)
    conn.execute("UPDATE daily_picks SET url='javascript:alert(1)' WHERE job_key='t1'")
    conn.commit()
    conn.close()

    chrome_page.goto(f"{base}/picks")
    chrome_page.wait_for_selector("#today .pick-card")
    href = chrome_page.eval_on_selector("#today .pick-card a", "el => el.getAttribute('href')")
    assert href is None or not href.lower().startswith("javascript:")


@pytest.mark.live
def test_description_not_in_dom_until_details_opened(live_server, chrome_page):
    # Cmd+F / native find-in-page auto-opens a closed <details> whenever its
    # hidden content matches the search text. Every pick embeds its full JD
    # in a <details><pre>, and a JD routinely restates the same company/
    # role/location words Allen is actually searching for -- so a plain
    # title search force-opened every card's JD block at once, burying the
    # small always-visible title/pills text he was looking for underneath a
    # wall of expanded descriptions (told 2026-09-12). The JD text must not
    # exist in the DOM at all until the user actually opens the details.
    base, db_path = live_server
    _seed(db_path)
    from db import get_db
    conn = get_db(db_path)
    conn.execute("UPDATE daily_picks SET description='UNIQUEMARKERTEXT' WHERE job_key='t1'")
    conn.commit()
    conn.close()

    chrome_page.goto(f"{base}/picks")
    chrome_page.wait_for_selector("#today .pick-card")
    assert "UNIQUEMARKERTEXT" not in chrome_page.content()
    chrome_page.click("#today .pick-card details summary")
    # the "toggle" event (which lazily renders the .jd body) fires as its own
    # task after the open attribute is set, not synchronously with the click
    chrome_page.wait_for_selector("#today .pick-card .jd")
    assert "UNIQUEMARKERTEXT" in chrome_page.content()
