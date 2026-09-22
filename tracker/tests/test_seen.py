from db import init_db, get_db
from jobscan import seen


def conn_for(tmp_path):
    db_path = str(tmp_path / "t.db")
    init_db(db_path)
    return get_db(db_path)


def test_record_then_is_seen(tmp_path):
    c = conn_for(tmp_path)
    assert seen.is_seen(c, "jobright:1") is False
    seen.record(c, key="jobright:1", source="jobright", url="u", disposition="candidate")
    assert seen.is_seen(c, "jobright:1") is True
    assert seen.disposition_of(c, "jobright:1") == "candidate"


def test_record_upserts_disposition(tmp_path):
    c = conn_for(tmp_path)
    seen.record(c, key="jobright:1", source="jobright", url="u", disposition="candidate")
    seen.record(c, key="jobright:1", source="jobright", url="u",
                disposition="dropped", drop_reason="term:Fall/Spring")
    assert seen.disposition_of(c, "jobright:1") == "dropped"
    row = c.execute("SELECT drop_reason FROM seen_jobs WHERE job_key='jobright:1'").fetchone()
    assert row["drop_reason"] == "term:Fall/Spring"


def test_record_fills_company_role_when_nonempty(tmp_path):
    c = conn_for(tmp_path)
    seen.record(c, key="jobright:1", source="jobright", url="u", disposition="dropped")
    seen.record(c, key="jobright:1", source="jobright", url="u", disposition="dropped",
                company="Acme", role="SWE Intern")
    row = c.execute("SELECT company, role FROM seen_jobs WHERE job_key='jobright:1'").fetchone()
    assert row["company"] == "Acme" and row["role"] == "SWE Intern"


def test_bump_updates_last_seen_only(tmp_path):
    c = conn_for(tmp_path)
    seen.record(c, key="jobright:1", source="jobright", url="u", disposition="candidate")
    seen.bump(c, "jobright:1")
    assert seen.disposition_of(c, "jobright:1") == "candidate"


def test_record_stores_dedup_key(tmp_path):
    c = conn_for(tmp_path)
    seen.record(c, key="jobright:1", source="jobright", url="u",
                disposition="applied", dedup_key="acme|swe intern")
    row = c.execute("SELECT dedup_key FROM seen_jobs WHERE job_key='jobright:1'").fetchone()
    assert row["dedup_key"] == "acme|swe intern"


def test_terminal_dedup_disposition_matches_across_sources(tmp_path):
    c = conn_for(tmp_path)
    # applied on jobright
    seen.record(c, key="jobright:1", source="jobright", url="u",
                disposition="applied", dedup_key="acme|swe intern")
    # the jobright twin, same dedup_key, not yet seen under its own job_key
    assert seen.is_seen(c, "jobright:acme-swe-intern") is False
    assert seen.terminal_dedup_disposition(c, "acme|swe intern") == "applied"
    assert seen.terminal_dedup_disposition(c, "other|role") is None


def test_terminal_dedup_disposition_ignores_non_terminal(tmp_path):
    c = conn_for(tmp_path)
    seen.record(c, key="jobright:1", source="jobright", url="u",
                disposition="candidate", dedup_key="acme|swe intern")
    seen.record(c, key="jobright:2", source="jobright", url="u",
                disposition="dropped", dedup_key="acme|swe intern")
    assert seen.terminal_dedup_disposition(c, "acme|swe intern") is None


def test_terminal_dedup_disposition_empty_key_never_matches(tmp_path):
    c = conn_for(tmp_path)
    seen.record(c, key="jobright:1", source="jobright", url="u",
                disposition="applied", dedup_key="")
    assert seen.terminal_dedup_disposition(c, "") is None
