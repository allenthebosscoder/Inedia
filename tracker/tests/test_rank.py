"""jobscan.rank — turn a run artifact's candidates into a ranked /picks list."""
from jobscan.adapters.base import dedup_key
import jobscan.rank as rank_module
from jobscan.rank import rank, RELEVANT, OFF_DOMAIN


def _key(company, role):
    a, _, b = dedup_key(company, role).partition("|")
    return (a, b)


def _c(company, role, term="Unknown", score=50, **extra):
    d = dict(company=company, role=role, term=term, heuristic_score=score,
             url=f"https://x/{role}", source="jobnotifier", location="Austin, TX",
             description="", locations=[])
    d.update(extra)
    return d


def test_drops_off_field_and_applied_and_deleted_and_military():
    cands = [
        _c("Acme", "Firmware Engineer Intern", term="Summer 2027", score=60),
        _c("BigBank", "Investment Analyst Intern", term="Summer 2027", score=90),   # off-domain
        _c("Micron", "DOW SkillsBridge Intern", score=70,                            # military
           description="civilian or military transition SkillsBridge program"),
        _c("Acme", "SWE Intern", score=55),
    ]
    ranked, dropped = rank(cands,
                           applied_keys={_key("Acme", "SWE Intern")},
                           deleted_keys=set())
    kept = {r["company"] for r in ranked}
    assert kept == {"Acme"}  # only "Firmware Engineer Intern" survives
    reasons = {d["company"]: d["reason"] for d in dropped}
    assert reasons["BigBank"] == "off-domain"
    assert "military" in reasons["Micron"]
    assert reasons["Acme"] == "already-applied"  # the SWE Intern one


def test_drops_past_summer_term():
    import datetime
    past = f"Summer {datetime.date.today().year - 1}"
    cands = [_c("Acme", "Software Engineer Intern", term=past, score=80),
             _c("Beta", "Firmware Engineer Intern", term="Summer 2099", score=40)]
    ranked, dropped = rank(cands, applied_keys=set(), deleted_keys=set())
    assert [r["company"] for r in ranked] == ["Beta"]
    assert dropped[0]["reason"] == "term:past"


def test_no_company_sponsorship_blocklist():
    # Sponsorship is filtered from the posting text by hardfilter, never by
    # a company name here -- a plain SWE role at a company that historically
    # doesn't sponsor still survives rank().
    for co in ("Palantir", "Capital One", "Marvell", "Texas Instruments"):
        cands = [_c(co, "Software Engineer New Grad", term="New Grad", score=40)]
        ranked, _ = rank(cands, applied_keys=set(), deleted_keys=set())
        assert [r["company"] for r in ranked] == [co], co


def test_defense_prime_companies_dropped():
    for co in ["L3Harris Technologies", "General Dynamics Mission Systems", "RTX",
               "Raytheon", "CACI International", "Anduril Industries", "Saronic",
               "Lockheed Martin", "Northrop Grumman", "Booz Allen Hamilton",
               "Bascom Hunter"]:
        cands = [_c(co, "Software Engineer Intern", term="Summer 2027", score=80)]
        ranked, dropped = rank(cands, applied_keys=set(), deleted_keys=set())
        assert ranked == [], co
        assert dropped[0]["reason"] == "defense", co
    # not a defense prime -- a plain SWE role survives
    ok = rank([_c("Datadog", "Software Engineer Intern", term="Summer 2027", score=50)],
              applied_keys=set(), deleted_keys=set())[0]
    assert [r["company"] for r in ok] == ["Datadog"]
    # "General Motors" must NOT hit "general dynamics"
    gm = rank([_c("General Motors", "Software Engineer Intern", term="Summer 2027", score=50)],
              applied_keys=set(), deleted_keys=set())[0]
    assert [r["company"] for r in gm] == ["General Motors"]


def test_temp_company_hold_drops_bytedance_and_tiktok_until_the_hold_date():
    # A dated hold: exclude ByteDance/TikTok postings until a set date --
    # unlike DEFENSE_COMPANIES this is temporary/dated, not a permanent block.
    for co in ["ByteDance", "TikTok"]:
        cands = [_c(co, "Software Engineer Intern", term="Summer 2027", score=80)]
        ranked, dropped = rank(cands, applied_keys=set(), deleted_keys=set())
        assert ranked == [], co
        assert dropped[0]["reason"] == "temp-hold", co


def test_undated_company_hold_drops_lunar_outpost_indefinitely():
    # An undated hold: a company suspected of auto-rejecting, no end date
    # given, unlike the ByteDance hold, so this entry has until=None and
    # never expires on its own.
    cands = [_c("Lunar Outpost", "Software Engineer Intern", term="Summer 2027", score=80)]
    ranked, dropped = rank(cands, applied_keys=set(), deleted_keys=set())
    assert ranked == []
    assert dropped[0]["reason"] == "temp-hold"


def test_undated_company_hold_drops_zipline_indefinitely():
    # Zipline's ATS caps total applications in a window and that cap's
    # already been used for this cycle, so any new Zipline posting is a
    # dead end regardless of role fit. No end date given.
    cands = [_c("Zipline", "Test Equipment Design Engineer", term="Unknown", score=80)]
    ranked, dropped = rank(cands, applied_keys=set(), deleted_keys=set())
    assert ranked == []
    assert dropped[0]["reason"] == "temp-hold"


def test_dedup_collision_loser_is_reported_not_silently_discarded():
    # Two sources found the same real posting under different job_keys.
    # rank() must keep the higher-scoring one and report the OTHER as an
    # explicit "dedup:superseded" drop -- not silently vanish it -- so a
    # caller (rerank_picks.py) can clean it up WITHOUT marking it a genuine
    # deletion, which would poison the dedup_key and take the survivor down
    # too on the next pass (the recurring bug from 2026-09-16 through
    # 2026-09-21: Amazon/ADI/Apple, Lazard/Fable/Together AI/Stripe,
    # Capgemini, Lazard/Interstates/Fable/Illinois Tool Works).
    cands = [
        _c("Acme", "Firmware Engineer Intern", score=40, source="jobright", external_id="lo"),
        _c("Acme", "Firmware Engineer Intern", score=90, source="swelist", external_id="hi"),
    ]
    ranked, dropped = rank(cands, applied_keys=set(), deleted_keys=set())
    assert [(r["source"], r["external_id"]) for r in ranked] == [("swelist", "hi")]
    assert len(dropped) == 1
    loser = dropped[0]
    assert loser["reason"] == "dedup:superseded"
    assert (loser["source"], loser["external_id"]) == ("jobright", "lo")


def test_defense_and_clearance_titles_dropped_at_any_company():
    cands = [
        _c("Acme", "Software Engineer New Grad - Defense", score=70),
        _c("Widgets Inc", "Forward Deployed Software Engineer New Grad", score=70),
        _c("GDIT", "Junior Software Developer - Active TS/SCI with Poly Required", score=70),
        _c("Acme", "Embedded Software Engineer New Grad", score=40),  # kept
    ]
    ranked, dropped = rank(cands, applied_keys=set(), deleted_keys=set())
    reasons = {d["role"]: d["reason"] for d in dropped}
    assert reasons["Software Engineer New Grad - Defense"] == "defense"
    assert reasons["Forward Deployed Software Engineer New Grad"] == "defense"
    assert reasons["Junior Software Developer - Active TS/SCI with Poly Required"] == "defense"
    assert [r["role"] for r in ranked] == ["Embedded Software Engineer New Grad"]


def test_hardware_and_preferred_term_rank_above_generic_swe(monkeypatch):
    monkeypatch.setattr(rank_module, "_PREFERRED_TERM_PREFIX", "summer 2027")
    cands = [
        _c("A", "Software Engineer Intern", term="Summer 2027", score=80),
        _c("B", "Embedded Firmware Engineer Intern", term="Unknown", score=40),
        _c("C", "Electrical Engineer Intern", term="Summer 2027", score=50),
    ]
    ranked, _ = rank(cands, applied_keys=set(), deleted_keys=set())
    order = [r["company"] for r in ranked]
    # hardware first (C then B), then SWE (A)
    assert order == ["C", "B", "A"]
    assert [r["rank"] for r in ranked] == [1, 2, 3]


def test_dedup_keeps_highest_score():
    cands = [
        _c("Acme", "SWE Intern (Summer 2027)", score=30, source="jobright"),
        _c("Acme", "SWE Intern - Summer 2027", score=70, source="jobnotifier"),
    ]
    ranked, _ = rank(cands, applied_keys=set(), deleted_keys=set())
    assert len(ranked) == 1 and ranked[0]["heuristic_score"] == 70


def test_regexes_are_sane():
    assert RELEVANT.search("Embedded Software Engineer Intern")
    assert RELEVANT.search("Software Engineer Intern")
    assert not RELEVANT.search("Marketing Coordinator")
    assert OFF_DOMAIN.search("Data Scientist Intern")
    assert not OFF_DOMAIN.search("Firmware Engineer Intern")


def test_relevant_matches_hardware_and_systems_titles():
    # real jobright/swelist titles that fell through as "off-domain" (2026-09-09)
    for t in ["Intern, Hardware Design Engineering",
              "Electrical System Integration Engineer - New Grad",
              "Hardware Design Engineer Intern",
              "Systems Integration Engineer",
              "Sensor Hardware Test Engineer Intern",
              "Post-Silicon Hardware Validation Intern",
              "Application Engineer Intern",
              "Lab Test Engineer",  # Wurth Elektronik, 2026-09-12 -- eval-board/PCB power-electronics testing
              "Computer Science Intern - Summer 2027",  # AnaVation, 2026-09-12
              "Power System Engineer",  # ETAP Software, 2026-09-14
              "Electronics & Controls Intern",  # Oshkosh/Pratt Miller, 2026-09-14
              "Intern - Design Engineer, HBM",  # Micron, 2026-09-15
              "Electrical & Optical Engineering Intern",  # VIAVI Solutions, 2026-09-15
              "Test & Reliability Engineering Intern",  # Gecko Robotics, 2026-09-15
              "Design Evaluation Engineer Intern",  # Analog Devices, 2026-09-15
              "Intern - Node Development Product Engineer - DRAM Technology",  # Micron, 2026-09-16
              "Design for Test Engineer",  # Apple, 2026-09-16
              "Reliability Testing and Failure Analysis Intern",  # onsemi, 2026-09-16
              "Server Platform Intern",  # Jabil, 2026-09-16
              "Software Development Engineer Intern - Summer 2027 (USA)",  # Amazon, 2026-09-21 -- SDE title doesn't literally say "software engineer"/"software developer"/"swe"
              "New College Grad - Product Test Engineer",  # Micron, 2026-09-22 -- "test engineer" alone wasn't matched, only "lab test engineer"
              "Hardware Intern",  # Arista Networks, 2026-09-24 -- bare "hardware" title had no match at all
              "Intern - Systems Performance Engineer",  # Micron, 2026-09-24
              "Intern - Signal Integrity",  # Micron, 2026-09-29 -- a distinct EE discipline from "signal process[ing]"
              "Summer 2027 - Probe Test Engineer Intern",  # onsemi, 2026-10-01 -- wafer-probe test, not "lab"/"product" test engineer
              "Summer 2027 - Test Development Engineering Internship",  # onsemi, 2026-10-01
              # example case, 2026-10-01 -- a reviewer confirmed test/validation/
              # systems/manufacturing/power-electronics internships are in
              # scope (distinct from the fab/chemical-process side -- e.g.
              # lithography, metrology, wet process -- which stays out).
              "Summer 2027 - Test Engineer Intern",
              "Summer 2027 - Validation Engineering Intern",
              "Summer 2027 - Integration Engineer Intern",
              "Summer 2027 - Manufacturing Engineer Intern",
              "Summer 2027 - Technology Development LV-MV Internship",
              # General Motors, 2026-10-03 -- bare "verification engineer"
              # had no match at all (only "design verification"/"layout
              # verification" compound phrases were covered); reviewer
              # confirmed software-side verification is in scope too.
              "2027 Summer Intern - Software Verification Engineer, AV/AI Platform"]:
        assert RELEVANT.search(t), t
    # but a customer-facing sales title with the same words still drops
    assert OFF_DOMAIN.search("Sales Application Engineer")


def test_relevant_excludes_fab_process_engineering_titles():
    # example case, 2026-10-01 -- a reviewer explicitly chose to keep these out: the
    # chemical/materials-process side of semiconductor fab work, distinct
    # from the test/validation/systems group confirmed relevant above.
    for t in ["Summer 2027 - Lithography Engineering Intern",
              "Summer 2027 - Metrology Engineering Intern",
              "Summer 2027 - Wet Process Engineering Intern",
              "Summer 2027 - Thin Films, Implant & Diffusion Process Engineering Intern",
              "Summer 2027 - Defect Inspection Intern",
              "Summer 2027 - Module Engineer Intern"]:
        assert not RELEVANT.search(t), t


def test_drops_co_op_titles_internships_only():
    # Co-ops (often multi-semester, away-from-school commitments requiring
    # their own CPT/leave-of-absence review) aren't worth it right now --
    # internships only.
    for role in ["Application Engineer Co-Op", "Software Engineer Co Op",
                 "Firmware Engineer CoOp Intern", "3-Semester Co-op Program"]:
        cands = [_c("Waystar", role, term="Unknown", score=50)]
        ranked, dropped = rank(cands, applied_keys=set(), deleted_keys=set())
        assert ranked == [], role
        assert dropped[0]["reason"] == "co-op", role
    ok = rank([_c("Acme", "Software Engineer Intern", term="Summer 2027", score=50)],
              applied_keys=set(), deleted_keys=set())[0]
    assert [r["company"] for r in ok] == ["Acme"]


def test_capped_companies_drops_roles_at_a_company_over_the_app_limit():
    from jobscan.rank import capped_companies
    apps = [("Zipline", "SWE Intern"), ("Zipline", "Firmware Intern"),
            ("Zipline", "Test Intern"), ("Acme", "SWE Intern")]
    capped = capped_companies(apps, threshold=3)
    assert "zipline" in capped and "acme" not in capped
    cands = [_c("Zipline", "Embedded Firmware Engineer Intern", term="Summer 2027", score=90)]
    ranked, dropped = rank(cands, applied_keys=set(), deleted_keys=set(), capped=capped)
    assert ranked == [] and dropped[0]["reason"] == "company-app-cap"
