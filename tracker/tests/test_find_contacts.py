import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "find_contacts", Path(__file__).parent.parent / "scripts/find_contacts.py")
fc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fc)


def _p(name, title, blob=None):
    return {"name": name, "title": title, "profile_url": f"https://www.linkedin.com/in/{name.lower()}",
            "blob": blob if blob is not None else f"{name} | {title}"}


def test_search_queries_three_categories():
    qs = fc.search_queries("Acme", "firmware engineer")
    assert [c for c, _ in qs] == ["duke", "engineer", "recruiter"]
    assert qs[0][1] == "Acme Example University"
    assert qs[1][1] == "Acme firmware engineer"
    assert qs[2][1] == "Acme university recruiter"


def test_search_url_is_people_search_and_encoded():
    url = fc.search_url("Acme Example University")
    assert url == "https://www.linkedin.com/search/results/people/?keywords=Acme%20Duke%20University"


def test_collect_filters_other_employers():
    results = {"duke": [_p("Ann", "Engineer at Acme"), _p("Bob", "Engineer at Globex")]}
    out = fc.collect(results, "Acme", 15)
    assert [c["name"] for c in out] == ["Ann"]


def test_collect_recruiter_title_overrides_category_and_dedupes():
    results = {
        "duke": [_p("Cy", "Technical Recruiter at Acme")],
        "engineer": [_p("Cy", "Technical Recruiter at Acme"), _p("Di", "SWE at Acme")],
    }
    out = fc.collect(results, "Acme", 15)
    assert [(c["name"], c["category"]) for c in out] == [("Cy", "recruiter"), ("Di", "engineer")]


def test_collect_respects_max_total_and_category_priority():
    results = {
        "duke": [_p(f"D{i}", "Eng at Acme") for i in range(5)],
        "engineer": [_p(f"E{i}", "Eng at Acme") for i in range(5)],
        "recruiter": [_p("R0", "Recruiter at Acme")],
    }
    out = fc.collect(results, "Acme", 7)
    assert len(out) == 7
    assert [c["category"] for c in out].count("duke") == 5


def test_collect_empty_results():
    assert fc.collect({"duke": [], "engineer": [], "recruiter": []}, "Acme", 15) == []
    assert fc.collect({}, "Acme", 15) == []


def test_post_bulk_sends_expected_payload(monkeypatch):
    sent = {}

    class Resp:
        def read(self):
            return b'{"inserted": 1, "skipped": 0}'

    def fake_urlopen(req):
        sent["url"] = req.full_url
        sent["body"] = json.loads(req.data)
        return Resp()

    monkeypatch.setattr(fc.urllib.request, "urlopen", fake_urlopen)
    out = fc.post_bulk("http://x", "Acme", [{"name": "A", "title": "", "profile_url": "u", "category": "duke"}])
    assert out == {"inserted": 1, "skipped": 0}
    assert sent["url"] == "http://x/api/contacts/bulk"
    assert sent["body"]["company"] == "Acme"
    assert set(sent["body"]["contacts"][0]) == {"name", "title", "profile_url", "category"}


def test_main_exits_2_and_posts_nothing_when_blocked(monkeypatch):
    posted = []
    monkeypatch.setattr(fc, "post_bulk", lambda *a, **k: posted.append(a))

    def blocked(*a, **k):
        raise fc.LinkedInBlocked("authwall")

    monkeypatch.setattr(fc, "search_all", blocked)
    assert fc.main(["Acme", "--dry-run"]) == 2
    assert fc.main(["Acme"]) == 2
    assert posted == []
