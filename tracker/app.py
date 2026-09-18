import json
from datetime import date, datetime, timedelta

from flask import Flask, jsonify, render_template, request

from db import init_db, get_db
from seed import run_seed
from profile_data import build_profile
from jobscan.adapters.base import dedup_key

STATUS_VALUES = {"Applied", "Interviewing", "Accepted", "Rejected", "Incomplete"}
TYPE_VALUES = {"Intern", "Entry", "Other"}
PICK_REQUIRED_FIELDS = ["job_key", "source", "url", "company", "role"]


def _parse_date_applied(value):
    """Parse a date_applied value defensively -- rows may have empty or
    malformed strings; those are skipped rather than raising."""
    if not value:
        return None
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def compute_stats(rows, today=None):
    """Counts used by the top-of-page counters: total Applied, total
    Rejected, how many rows have a date_applied inside the current Mon-Sun
    week, and how many are dated today (server local time). `rows` is any
    iterable of dict-like objects (sqlite3.Row or dict) exposing 'status'
    and 'date_applied'. `today` is injectable for tests."""
    today = today or date.today()
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)

    applied = rejected = this_week = today_count = 0
    for row in rows:
        status = row["status"]
        if status == "Applied":
            applied += 1
        elif status == "Rejected":
            rejected += 1

        applied_on = _parse_date_applied(row["date_applied"])
        if applied_on is not None and monday <= applied_on <= sunday:
            this_week += 1
        if applied_on is not None and applied_on == today:
            today_count += 1

    return {"applied": applied, "rejected": rejected, "this_week": this_week, "today": today_count}


def _cross_origin_request() -> bool:
    """True if the request carries an Origin header pointing somewhere other
    than this same local dev server -- a cross-origin page's fetch() would
    still send one even for a same-site-cookie-less POST like these."""
    origin = request.headers.get("Origin")
    return bool(origin) and not (origin.startswith("http://localhost")
                                 or origin.startswith("http://127.0.0.1"))


def create_app(db_path="tracker.db", seed=False):
    app = Flask(__name__)
    app.config["DATABASE"] = db_path
    init_db(db_path)
    if seed:
        run_seed(db_path)

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/api/profile", methods=["GET"])
    def get_profile():
        return jsonify(build_profile())

    @app.route("/api/applications", methods=["GET"])
    def list_applications():
        conn = get_db(app.config["DATABASE"])

        sortable_fields = {
            "id", "date_applied", "company", "role", "type", "status",
            "referred", "outreach_sent", "reply_received", "created_at",
        }
        sort = request.args.get("sort", "date_applied")
        if sort not in sortable_fields:
            sort = "date_applied"
        direction = "ASC" if request.args.get("dir", "desc").lower() == "asc" else "DESC"

        query = "SELECT * FROM applications WHERE 1=1"
        params = []

        status = request.args.get("status")
        if status:
            query += " AND status = ?"
            params.append(status)

        company = request.args.get("company")
        if company:
            query += " AND company LIKE ?"
            params.append(f"%{company}%")

        query += f" ORDER BY {sort} {direction}"
        rows = conn.execute(query, params).fetchall()
        conn.close()
        return jsonify([dict(row) for row in rows])

    @app.route("/api/stats", methods=["GET"])
    def get_stats():
        conn = get_db(app.config["DATABASE"])
        rows = conn.execute("SELECT status, date_applied FROM applications").fetchall()
        conn.close()
        return jsonify(compute_stats(rows))

    @app.route("/picks")
    def picks_page():
        return render_template("picks.html")

    @app.route("/reminders")
    def reminders_page():
        return render_template("reminders.html")

    @app.route("/api/reminders", methods=["GET"])
    def list_reminders():
        conn = get_db(app.config["DATABASE"])
        if request.args.get("all"):
            rows = conn.execute(
                "SELECT * FROM reminders ORDER BY done ASC, due_date ASC, id ASC"
            ).fetchall()
        else:
            # Default view: only what's still pending, so a growing pile of
            # long-done reminders never has to be paged through by hand.
            rows = conn.execute(
                "SELECT * FROM reminders WHERE done = 0 ORDER BY due_date ASC, id ASC"
            ).fetchall()
        conn.close()
        return jsonify([dict(row) for row in rows])

    @app.route("/api/reminders", methods=["POST"])
    def create_reminder():
        if _cross_origin_request():
            return jsonify({"error": "cross-origin request rejected"}), 403
        data = request.get_json(force=True) or {}
        due_date = data.get("due_date")
        message = data.get("message")
        if not due_date or not message:
            return jsonify({"error": "missing fields: due_date, message"}), 400

        application_id = data.get("application_id")
        conn = get_db(app.config["DATABASE"])
        if application_id is not None:
            exists = conn.execute(
                "SELECT 1 FROM applications WHERE id = ?", (application_id,)
            ).fetchone()
            if exists is None:
                conn.close()
                return jsonify({"error": f"no application with id {application_id}"}), 400

        cursor = conn.execute(
            "INSERT INTO reminders (due_date, message, application_id) VALUES (?, ?, ?)",
            (due_date, message, application_id),
        )
        conn.commit()
        new_id = cursor.lastrowid
        conn.close()
        return jsonify({"id": new_id}), 201

    @app.route("/api/reminders/<int:reminder_id>", methods=["PATCH"])
    def update_reminder(reminder_id):
        if _cross_origin_request():
            return jsonify({"error": "cross-origin request rejected"}), 403
        data = request.get_json(force=True) or {}
        conn = get_db(app.config["DATABASE"])
        existing = conn.execute(
            "SELECT id FROM reminders WHERE id = ?", (reminder_id,)
        ).fetchone()
        if existing is None:
            conn.close()
            return jsonify({"error": "not found"}), 404

        allowed_fields = {"due_date", "message", "done"}
        updates = {k: v for k, v in data.items() if k in allowed_fields}
        if not updates:
            conn.close()
            return jsonify({"error": "no valid fields to update"}), 400
        if "done" in updates:
            updates["done"] = bool(updates["done"])

        set_clause = ", ".join(f"{field} = ?" for field in updates)
        values = list(updates.values()) + [reminder_id]
        conn.execute(
            f"UPDATE reminders SET {set_clause}, updated_at = datetime('now') WHERE id = ?",
            values,
        )
        conn.commit()
        conn.close()
        return jsonify({"ok": True})

    @app.route("/api/reminders/<int:reminder_id>", methods=["DELETE"])
    def delete_reminder(reminder_id):
        if _cross_origin_request():
            return jsonify({"error": "cross-origin request rejected"}), 403
        conn = get_db(app.config["DATABASE"])
        existing = conn.execute(
            "SELECT id FROM reminders WHERE id = ?", (reminder_id,)
        ).fetchone()
        if existing is None:
            conn.close()
            return jsonify({"error": "not found"}), 404
        conn.execute("DELETE FROM reminders WHERE id = ?", (reminder_id,))
        conn.commit()
        conn.close()
        return jsonify({"ok": True})

    @app.route("/api/picks", methods=["GET"])
    def list_picks():
        conn = get_db(app.config["DATABASE"])
        if request.args.get("all"):
            rows = conn.execute(
                "SELECT * FROM daily_picks ORDER BY rank IS NULL, rank ASC, id ASC"
            ).fetchall()
        else:
            # Bounded payload: the page only ever renders today's/carried-over
            # new picks plus today's applied ones — everything older is History
            # `daily_picks` still holds it; pass ?all=1 to fetch it.
            rows = conn.execute(
                """SELECT * FROM daily_picks
                   WHERE status = 'new'
                      OR (status = 'applied' AND date(updated_at) = date('now'))
                   ORDER BY rank IS NULL, rank ASC, id ASC"""
            ).fetchall()
        conn.close()
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["locations"] = json.loads(d.get("locations") or "[]")
            except (TypeError, ValueError):
                d["locations"] = []
            out.append(d)
        return jsonify(out)

    @app.route("/api/picks/bulk", methods=["POST"])
    def bulk_picks():
        if _cross_origin_request():
            return jsonify({"error": "cross-origin request rejected"}), 403

        data = request.get_json(force=True) or {}
        run_date = data.get("run_date")
        picks = data.get("picks") or []
        if not run_date:
            return jsonify({"error": "missing run_date"}), 400
        for p in picks:
            missing = [f for f in PICK_REQUIRED_FIELDS if not p.get(f)]
            if missing:
                return jsonify({"error": f"pick missing fields: {', '.join(missing)}"}), 400
            if p.get("app_type", "Other") not in TYPE_VALUES:
                return jsonify({"error": f"invalid app_type: {p.get('app_type')}"}), 400

        conn = get_db(app.config["DATABASE"])
        try:
            inserted = updated = ignored = 0
            for p in picks:
                srow = conn.execute(
                    "SELECT disposition FROM seen_jobs WHERE job_key = ?", (p["job_key"],)
                ).fetchone()
                if srow is not None and srow["disposition"] == "deleted":
                    # Allen deleted this job_key for good; a stale scan result
                    # (or a re-run before the scanner's own skip catches up)
                    # must not resurrect it on the page.
                    ignored += 1
                    continue

                existing = conn.execute(
                    "SELECT id, status FROM daily_picks WHERE job_key = ?", (p["job_key"],)
                ).fetchone()
                locations_json = json.dumps(p.get("locations", []))
                dk = dedup_key(p["company"], p["role"])
                if existing is None:
                    conn.execute(
                        """INSERT INTO daily_picks
                           (job_key, source, url, company, role, location, salary, term,
                            app_type, heuristic_score, rank, reasoning, description,
                            first_run_date, last_run_date, status, locations)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'new', ?)""",
                        (p["job_key"], p["source"], p["url"], p["company"], p["role"],
                         p.get("location", ""), p.get("salary", ""), p.get("term", ""),
                         p.get("app_type", "Other"), p.get("heuristic_score", 0),
                         p.get("rank"), p.get("reasoning", ""), p.get("description", ""),
                         run_date, run_date, locations_json),
                    )
                    inserted += 1
                elif existing["status"] == "new":
                    conn.execute(
                        """UPDATE daily_picks SET rank=?, reasoning=?, heuristic_score=?,
                           term=?, app_type=?, salary=?, location=?, description=?,
                           locations=?, last_run_date=?, updated_at=datetime('now') WHERE id=?""",
                        (p.get("rank"), p.get("reasoning", ""), p.get("heuristic_score", 0),
                         p.get("term", ""), p.get("app_type", "Other"), p.get("salary", ""),
                         p.get("location", ""), p.get("description", ""), locations_json,
                         run_date, existing["id"]),
                    )
                    updated += 1
                else:
                    ignored += 1
                    continue

                if srow is None:
                    conn.execute(
                        """INSERT INTO seen_jobs (job_key, source, url, company, role, disposition, dedup_key)
                           VALUES (?,?,?,?,?, 'candidate', ?)""",
                        (p["job_key"], p["source"], p["url"], p["company"], p["role"], dk),
                    )
                elif srow["disposition"] != "applied":
                    conn.execute(
                        "UPDATE seen_jobs SET disposition='candidate', dedup_key=?, last_seen=datetime('now') WHERE job_key=?",
                        (dk, p["job_key"]),
                    )
            conn.commit()
        finally:
            conn.close()
        return jsonify({"inserted": inserted, "updated": updated, "ignored": ignored})

    @app.route("/api/picks/<int:pick_id>/apply", methods=["POST"])
    def apply_pick(pick_id):
        if _cross_origin_request():
            return jsonify({"error": "cross-origin request rejected"}), 403
        conn = get_db(app.config["DATABASE"])
        pick = conn.execute("SELECT * FROM daily_picks WHERE id = ?", (pick_id,)).fetchone()
        if pick is None:
            conn.close()
            return jsonify({"error": "not found"}), 404
        if pick["status"] == "applied":
            conn.close()
            return jsonify({"error": "already applied"}), 409

        app_type = pick["app_type"] if pick["app_type"] in TYPE_VALUES else "Other"
        cur = conn.execute(
            """INSERT INTO applications
               (date_applied, company, role, type, status, referred, outreach_sent,
                reply_received, resume_used, notes)
               VALUES (date('now'), ?, ?, ?, 'Applied', 0, 0, 0, '', ?)""",
            (pick["company"], pick["role"], app_type, f"From Daily Picks: {pick['url']}"),
        )
        app_id = cur.lastrowid
        conn.execute(
            "UPDATE daily_picks SET status='applied', application_id=?, updated_at=datetime('now') WHERE id=?",
            (app_id, pick_id),
        )
        conn.execute(
            "UPDATE seen_jobs SET disposition='applied', dedup_key=?, last_seen=datetime('now') WHERE job_key=?",
            (dedup_key(pick["company"], pick["role"]), pick["job_key"]),
        )
        conn.commit()
        conn.close()
        return jsonify({"application_id": app_id})

    @app.route("/api/picks/<int:pick_id>/priority", methods=["POST"])
    def toggle_pick_priority(pick_id):
        if _cross_origin_request():
            return jsonify({"error": "cross-origin request rejected"}), 403
        conn = get_db(app.config["DATABASE"])
        pick = conn.execute("SELECT priority FROM daily_picks WHERE id = ?", (pick_id,)).fetchone()
        if pick is None:
            conn.close()
            return jsonify({"error": "not found"}), 404
        priority = 0 if pick["priority"] else 1
        conn.execute("UPDATE daily_picks SET priority=?, updated_at=datetime('now') WHERE id=?", (priority, pick_id))
        conn.commit()
        conn.close()
        return jsonify({"ok": True, "priority": priority})

    @app.route("/api/picks/<int:pick_id>", methods=["DELETE"])
    def delete_pick(pick_id):
        if _cross_origin_request():
            return jsonify({"error": "cross-origin request rejected"}), 403
        conn = get_db(app.config["DATABASE"])
        pick = conn.execute("SELECT * FROM daily_picks WHERE id = ?", (pick_id,)).fetchone()
        if pick is None:
            conn.close()
            return jsonify({"error": "not found"}), 404

        conn.execute("DELETE FROM daily_picks WHERE id = ?", (pick_id,))
        srow = conn.execute(
            "SELECT 1 FROM seen_jobs WHERE job_key = ?", (pick["job_key"],)
        ).fetchone()
        dk = dedup_key(pick["company"], pick["role"])
        if srow is None:
            conn.execute(
                """INSERT INTO seen_jobs (job_key, source, url, company, role, disposition, drop_reason, dedup_key)
                   VALUES (?,?,?,?,?, 'deleted', 'user-deleted', ?)""",
                (pick["job_key"], pick["source"], pick["url"], pick["company"], pick["role"], dk),
            )
        else:
            conn.execute(
                "UPDATE seen_jobs SET disposition='deleted', drop_reason='user-deleted', dedup_key=?, last_seen=datetime('now') WHERE job_key=?",
                (dk, pick["job_key"]),
            )
        conn.commit()
        conn.close()
        return jsonify({"ok": True})

    @app.route("/api/applications", methods=["POST"])
    def create_application():
        data = request.get_json(force=True) or {}
        required = ["date_applied", "company", "role", "type", "status"]
        missing = [f for f in required if not data.get(f)]
        if missing:
            return jsonify({"error": f"missing fields: {', '.join(missing)}"}), 400
        if data["type"] not in TYPE_VALUES:
            return jsonify({"error": f"invalid type: {data['type']}"}), 400
        if data["status"] not in STATUS_VALUES:
            return jsonify({"error": f"invalid status: {data['status']}"}), 400

        conn = get_db(app.config["DATABASE"])
        cursor = conn.execute(
            """
            INSERT INTO applications
                (date_applied, company, role, type, status, referred, outreach_sent, reply_received, resume_used, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["date_applied"],
                data["company"],
                data["role"],
                data["type"],
                data["status"],
                bool(data.get("referred", False)),
                bool(data.get("outreach_sent", False)),
                bool(data.get("reply_received", False)),
                data.get("resume_used", ""),
                data.get("notes", ""),
            ),
        )
        conn.commit()
        new_id = cursor.lastrowid
        conn.close()
        return jsonify({"id": new_id}), 201

    @app.route("/api/applications/<int:app_id>", methods=["PATCH"])
    def update_application(app_id):
        data = request.get_json(force=True) or {}
        conn = get_db(app.config["DATABASE"])
        existing = conn.execute(
            "SELECT id FROM applications WHERE id = ?", (app_id,)
        ).fetchone()
        if existing is None:
            conn.close()
            return jsonify({"error": "not found"}), 404

        if "type" in data and data["type"] not in TYPE_VALUES:
            conn.close()
            return jsonify({"error": f"invalid type: {data['type']}"}), 400
        if "status" in data and data["status"] not in STATUS_VALUES:
            conn.close()
            return jsonify({"error": f"invalid status: {data['status']}"}), 400

        allowed_fields = {
            "date_applied", "company", "role", "type", "status",
            "referred", "outreach_sent", "reply_received", "resume_used", "notes",
            "contact_name", "drafted_email",
        }
        updates = {k: v for k, v in data.items() if k in allowed_fields}
        if not updates:
            conn.close()
            return jsonify({"error": "no valid fields to update"}), 400

        set_clause = ", ".join(f"{field} = ?" for field in updates)
        values = list(updates.values()) + [app_id]
        conn.execute(
            f"UPDATE applications SET {set_clause}, updated_at = datetime('now') WHERE id = ?",
            values,
        )
        conn.commit()
        conn.close()
        return jsonify({"ok": True})

    @app.route("/api/applications/<int:app_id>", methods=["DELETE"])
    def delete_application(app_id):
        conn = get_db(app.config["DATABASE"])
        existing = conn.execute(
            "SELECT id FROM applications WHERE id = ?", (app_id,)
        ).fetchone()
        if existing is None:
            conn.close()
            return jsonify({"error": "not found"}), 404
        conn.execute("DELETE FROM applications WHERE id = ?", (app_id,))
        conn.commit()
        conn.close()
        return jsonify({"ok": True})

    @app.route("/api/applications/paste", methods=["POST"])
    def paste_applications():
        data = request.get_json(force=True) or {}
        text = data.get("text", "")
        lines = [line for line in text.splitlines() if line.strip()]

        inserted = 0
        skipped = 0
        conn = get_db(app.config["DATABASE"])
        for line in lines:
            fields = line.split("\t")
            if len(fields) < 5:
                skipped += 1
                continue
            padded = fields + [""] * (9 - len(fields))
            (date_applied, company, role, type_, status,
             referred, outreach_sent, reply_received, notes) = padded[:9]

            if type_ not in TYPE_VALUES or status not in STATUS_VALUES:
                skipped += 1
                continue

            conn.execute(
                """
                INSERT INTO applications
                    (date_applied, company, role, type, status, referred, outreach_sent, reply_received, resume_used, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?)
                """,
                (
                    date_applied, company, role, type_, status,
                    referred.strip().lower() == "yes",
                    outreach_sent.strip().lower() == "yes",
                    reply_received.strip().lower() == "yes",
                    notes,
                ),
            )
            inserted += 1
        conn.commit()
        conn.close()
        return jsonify({"inserted": inserted, "skipped": skipped})

    return app


if __name__ == "__main__":
    flask_app = create_app(seed=True)
    flask_app.run(debug=True, port=8080)
