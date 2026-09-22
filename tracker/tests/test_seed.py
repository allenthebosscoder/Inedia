from db import init_db, get_db
from seed import run_seed
from seed_data import SEED_ROWS


def test_run_seed_inserts_all_rows(tmp_path):
    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    inserted = run_seed(db_path)
    assert inserted == len(SEED_ROWS)

    conn = get_db(db_path)
    count = conn.execute("SELECT COUNT(*) AS c FROM applications").fetchone()["c"]
    conn.close()
    assert count == len(SEED_ROWS)


def test_run_seed_is_idempotent(tmp_path):
    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    run_seed(db_path)
    second_run = run_seed(db_path)
    assert second_run == 0

    conn = get_db(db_path)
    count = conn.execute("SELECT COUNT(*) AS c FROM applications").fetchone()["c"]
    conn.close()
    assert count == len(SEED_ROWS)


def test_run_seed_maps_incomplete_statuses(tmp_path):
    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    run_seed(db_path)

    conn = get_db(db_path)
    acme = conn.execute(
        "SELECT status FROM applications WHERE company = ?", ("Acme",)
    ).fetchone()
    beta = conn.execute(
        "SELECT status FROM applications WHERE company = ?", ("Beta",)
    ).fetchone()
    conn.close()
    assert acme["status"] == "Incomplete"
    assert beta["status"] == "Incomplete"


def test_run_seed_no_invalid_statuses_or_types(tmp_path):
    from app import STATUS_VALUES, TYPE_VALUES

    db_path = str(tmp_path / "test.db")
    init_db(db_path)
    run_seed(db_path)

    conn = get_db(db_path)
    rows = conn.execute("SELECT status, type FROM applications").fetchall()
    conn.close()
    for row in rows:
        assert row["status"] in STATUS_VALUES
        assert row["type"] in TYPE_VALUES


def test_create_app_seed_true_populates_db(tmp_path):
    from app import create_app

    db_path = str(tmp_path / "test.db")
    app = create_app(db_path=db_path, seed=True)
    with app.test_client() as client:
        rows = client.get("/api/applications").get_json()
    assert len(rows) == len(SEED_ROWS)


def test_create_app_seed_false_stays_empty(tmp_path):
    from app import create_app

    db_path = str(tmp_path / "test.db")
    app = create_app(db_path=db_path, seed=False)
    with app.test_client() as client:
        rows = client.get("/api/applications").get_json()
    assert rows == []
