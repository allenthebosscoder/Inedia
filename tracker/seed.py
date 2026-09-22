from db import get_db
from seed_data import SEED_ROWS


def run_seed(db_path):
    conn = get_db(db_path)
    count = conn.execute("SELECT COUNT(*) AS c FROM applications").fetchone()["c"]
    if count > 0:
        conn.close()
        return 0

    for row in SEED_ROWS:
        (date_applied, company, role, type_, status,
         referred, outreach_sent, reply_received, notes) = row
        conn.execute(
            """
            INSERT INTO applications
                (date_applied, company, role, type, status, referred, outreach_sent, reply_received, resume_used, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?)
            """,
            (date_applied, company, role, type_, status, referred, outreach_sent, reply_received, notes),
        )
    conn.commit()
    conn.close()
    return len(SEED_ROWS)
