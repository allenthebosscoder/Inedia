import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "check_replies", Path(__file__).parent.parent / "scripts/check_replies.py")
cr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cr)


def test_match_replies_only_matches_sent_contacts_with_incoming_last_message():
    contacts = [{"id": 1, "name": "Pat Lee"}, {"id": 2, "name": "Sam Roe"}, {"id": 3, "name": "Zed"}]
    convs = [
        {"name": "pat  lee", "snippet": "Sure, send me the job ID", "from_me": False},
        {"name": "Sam Roe", "snippet": "You: Hi Sam", "from_me": True},
        {"name": "Nobody", "snippet": "hello", "from_me": False},
    ]
    assert cr.match_replies(contacts, convs) == [
        {"id": 1, "name": "Pat Lee", "snippet": "Sure, send me the job ID"},
    ]


def test_match_replies_empty():
    assert cr.match_replies([], []) == []
    assert cr.match_replies([{"id": 1, "name": "A"}], []) == []


def test_main_exits_2_when_blocked_and_patches_nothing(monkeypatch):
    patched = []
    monkeypatch.setattr(cr, "fetch_sent", lambda api: [{"id": 1, "name": "A"}])
    monkeypatch.setattr(cr, "patch_replied", lambda *a: patched.append(a))

    def blocked():
        raise cr.LinkedInBlocked("checkpoint")

    monkeypatch.setattr(cr, "read_inbox", blocked)
    assert cr.main([]) == 2
    assert patched == []


def test_main_dry_run_patches_nothing(monkeypatch):
    patched = []
    monkeypatch.setattr(cr, "fetch_sent", lambda api: [{"id": 1, "name": "Pat Lee"}])
    monkeypatch.setattr(cr, "read_inbox",
                        lambda: [{"name": "Pat Lee", "snippet": "yes", "from_me": False}])
    monkeypatch.setattr(cr, "patch_replied", lambda *a: patched.append(a))
    assert cr.main(["--dry-run"]) == 0
    assert patched == []
    assert cr.main([]) == 0
    assert patched == [("http://localhost:8080", 1, "yes")]


def test_read_inbox_raises_blocked_when_wall_appears_during_wait(monkeypatch):
    import contextlib
    import pytest

    class Page:
        url = "https://www.linkedin.com/messaging/"

        def goto(self, *a, **k):
            pass

        def wait_for_selector(self, *a, **k):
            self.url = "https://www.linkedin.com/login"  # late redirect
            raise TimeoutError("no conversations")

    @contextlib.contextmanager
    def fake_launch(headless=False):
        yield None, Page()

    monkeypatch.setattr(cr, "launch", fake_launch)
    monkeypatch.setattr(cr, "pace", lambda *a, **k: None)
    with pytest.raises(cr.LinkedInBlocked):
        cr.read_inbox()
