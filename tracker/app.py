import json
from datetime import date, datetime, timedelta

from flask import Flask, jsonify, render_template, request

from db import init_db, get_db
from contacts import CATEGORIES, STATUSES, normalize_profile_url
from seed import run_seed
from profile_data import build_profile
from jobscan.adapters.base import dedup_key

STATUS_VALUES = {"Applied", "Interviewing", "Accepted", "Rejected", "Incomplete", "Reaching Out"}
TYPE_VALUES = {"Intern", "Entry", "Other"}
PICK_REQUIRED_FIELDS = ["job_key", "source", "url", "company", "role"]
# seen_jobs dispositions a DELETE may write. 'deleted' = a real user
# rejection (poisons the dedup_key for every source, on purpose). 'superseded'
# = rerank_picks.py cleaning up a losing duplicate of a pick it's keeping
# under a different job_key -- must NOT poison the shared dedup_key.
DELETE_DISPOSITIONS = {"deleted", "superseded"}


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

        # Reaching Out rows aren't applications yet -- date_applied on them
        # is just "row created", not "applied", so they don't belong in
        # counters that mean "jobs applied to".
        if status == "Reaching Out":
            continue

        applied_on = _parse_date_applied(row["date_applied"])
        if applied_on is not None and monday <= applied_on <= sunday:
            this_week += 1
        if applied_on is not None and applied_on == today:
            today_count += 1

    return {"applied": applied, "rejected": rejected, "this_week": this_week, "today": today_count}


def _apply_by_date(latest_outreach_date: str) -> str:
    """5 days after the given date, in the same YYYY-MM-DD shape."""
    return (datetime.strptime(latest_outreach_date, "%Y-%m-%d").date() + timedelta(days=5)).isoformat()


def _log_outreach_contact(conn, app_id, name, date_sent) -> bool:
    """Append a contact to an application's outreach log and recompute the
    apply-by deadline. The ONLY writer of latest_outreach_date/apply_by_date
    for contacts. Returns False if the application doesn't exist. Does not
    commit."""
    existing = conn.execute(
        "SELECT status, outreach_contacts, latest_outreach_date FROM applications WHERE id = ?",
        (app_id,),
    ).fetchone()
    if existing is None:
        return False

    contacts = json.loads(existing["outreach_contacts"] or "[]")
    contacts.append({"name": name, "date_sent": date_sent})

    # A row created straight into Reaching Out already has a baseline
    # latest_outreach_date (its own creation date) -- a backdated
    # contact must not pull the deadline earlier than that baseline.
    candidates = [c["date_sent"] for c in contacts]
    if existing["latest_outreach_date"]:
        candidates.append(existing["latest_outreach_date"])
    latest = max(candidates)
    apply_by = _apply_by_date(latest) if existing["status"] == "Reaching Out" else ""

    conn.execute(
        """UPDATE applications
           SET outreach_contacts = ?, latest_outreach_date = ?, apply_by_date = ?,
               updated_at = datetime('now')
           WHERE id = ?""",
        (json.dumps(contacts), latest, apply_by, app_id),
    )
    return True


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
            "referred", "reply_received", "created_at", "apply_by_date",
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
                      OR (status = 'reaching_out' AND date(updated_at) = date('now'))
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
                    # This job_key was deleted for good; a stale scan result
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
        if pick["status"] in ("applied", "reaching_out"):
            conn.close()
            return jsonify({"error": "already applied"}), 409

        app_type = pick["app_type"] if pick["app_type"] in TYPE_VALUES else "Other"
        cur = conn.execute(
            """INSERT INTO applications
               (date_applied, company, role, type, status, referred,
                reply_received, resume_used, notes)
               VALUES (date('now'), ?, ?, ?, 'Applied', 0, 0, '', ?)""",
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

    @app.route("/api/picks/<int:pick_id>/outreach", methods=["POST"])
    def outreach_pick(pick_id):
        if _cross_origin_request():
            return jsonify({"error": "cross-origin request rejected"}), 403
        conn = get_db(app.config["DATABASE"])
        pick = conn.execute("SELECT * FROM daily_picks WHERE id = ?", (pick_id,)).fetchone()
        if pick is None:
            conn.close()
            return jsonify({"error": "not found"}), 404
        if pick["status"] in ("applied", "reaching_out"):
            conn.close()
            return jsonify({"error": "already applied"}), 409

        app_type = pick["app_type"] if pick["app_type"] in TYPE_VALUES else "Other"
        today = date.today().isoformat()
        cur = conn.execute(
            """INSERT INTO applications
               (date_applied, company, role, type, status, referred, reply_received,
                resume_used, notes, latest_outreach_date, apply_by_date)
               VALUES (date('now'), ?, ?, ?, 'Reaching Out', 0, 0, '', ?, ?, ?)""",
            (pick["company"], pick["role"], app_type, f"From Daily Picks: {pick['url']}",
             today, _apply_by_date(today)),
        )
        app_id = cur.lastrowid
        conn.execute(
            "UPDATE daily_picks SET status='reaching_out', application_id=?, updated_at=datetime('now') WHERE id=?",
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
        # A real Delete-button click means "this exact posting won't come
        # back" -- disposition='deleted' correctly poisons the dedup_key for
        # every source. But rerank_picks.py also reuses this endpoint to
        # clean up a losing duplicate that lost a same-run dedup collision
        # to a candidate it's KEEPING under a different job_key -- that's
        # internal bookkeeping, not a real rejection, so it must use
        # disposition='superseded' instead: still blocks this exact job_key
        # from being rescanned, but doesn't make the dedup_key look
        # terminally deleted and take the surviving duplicate down with it
        # on the next rerank (recurring bug hit 2026-09-16 through
        # 2026-09-21 across Amazon/ADI/Apple, Lazard/Fable/Together AI/
        # Stripe, Capgemini, Lazard/Interstates/Fable/Illinois Tool Works).
        body = request.get_json(silent=True) or {}
        disposition = body.get("disposition", "deleted")
        drop_reason = body.get("drop_reason", "user-deleted" if disposition == "deleted" else "")
        if disposition not in DELETE_DISPOSITIONS:
            return jsonify({"error": f"invalid disposition: {disposition}"}), 400

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
                   VALUES (?,?,?,?,?, ?, ?, ?)""",
                (pick["job_key"], pick["source"], pick["url"], pick["company"], pick["role"],
                 disposition, drop_reason, dk),
            )
        else:
            conn.execute(
                "UPDATE seen_jobs SET disposition=?, drop_reason=?, dedup_key=?, last_seen=datetime('now') WHERE job_key=?",
                (disposition, drop_reason, dk, pick["job_key"]),
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

        # A row created straight into Reaching Out counts its own creation
        # date as day zero of outreach, so Apply By is populated immediately
        # instead of staying blank until a contact is logged.
        latest_outreach_date = data["date_applied"] if data["status"] == "Reaching Out" else ""
        try:
            apply_by_date = _apply_by_date(latest_outreach_date) if latest_outreach_date else ""
        except ValueError:
            return jsonify({"error": f"invalid date_applied: {data['date_applied']}"}), 400

        conn = get_db(app.config["DATABASE"])
        cursor = conn.execute(
            """
            INSERT INTO applications
                (date_applied, company, role, type, status, referred, reply_received, resume_used, notes,
                 latest_outreach_date, apply_by_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["date_applied"],
                data["company"],
                data["role"],
                data["type"],
                data["status"],
                bool(data.get("referred", False)),
                bool(data.get("reply_received", False)),
                data.get("resume_used", ""),
                data.get("notes", ""),
                latest_outreach_date,
                apply_by_date,
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
            "referred", "reply_received", "resume_used", "notes",
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

    @app.route("/api/applications/<int:app_id>/outreach-contact", methods=["POST"])
    def add_outreach_contact(app_id):
        data = request.get_json(force=True) or {}
        conn = get_db(app.config["DATABASE"])
        ok = _log_outreach_contact(
            conn, app_id, data.get("name", ""),
            data.get("date_sent") or date.today().isoformat(),
        )
        if not ok:
            conn.close()
            return jsonify({"error": "not found"}), 404
        conn.commit()
        conn.close()
        return jsonify({"ok": True})

    def _reaching_out_app_id(conn, company):
        row = conn.execute(
            "SELECT id FROM applications WHERE lower(company) = lower(?) "
            "AND status = 'Reaching Out' ORDER BY id DESC LIMIT 1",
            (company,),
        ).fetchone()
        return row["id"] if row else None

    @app.route("/api/contacts", methods=["GET"])
    def list_contacts():
        conn = get_db(app.config["DATABASE"])
        query = "SELECT * FROM contacts WHERE 1=1"
        params = []
        if request.args.get("company"):
            query += " AND lower(company) = lower(?)"
            params.append(request.args["company"])
        if request.args.get("status"):
            query += " AND status = ?"
            params.append(request.args["status"])
        if request.args.get("application_id"):
            query += " AND application_id = ?"
            params.append(request.args["application_id"])
        query += " ORDER BY CASE category WHEN 'duke' THEN 0 WHEN 'engineer' THEN 1 ELSE 2 END, id"
        rows = [dict(r) for r in conn.execute(query, params).fetchall()]
        conn.close()
        return jsonify(rows)

    @app.route("/api/contacts/bulk", methods=["POST"])
    def bulk_contacts():
        if _cross_origin_request():
            return jsonify({"error": "cross-origin request rejected"}), 403
        data = request.get_json(force=True) or {}
        company = (data.get("company") or "").strip()
        items = data.get("contacts")
        if not company or not isinstance(items, list):
            return jsonify({"error": "company and contacts[] are required"}), 400

        cleaned = []
        for item in items:
            if not isinstance(item, dict):
                return jsonify({"error": f"invalid contact: {item!r}"}), 400
            url = normalize_profile_url(item.get("profile_url"))
            name = (item.get("name") or "").strip()
            category = item.get("category", "engineer")
            if not url or not name or category not in CATEGORIES:
                return jsonify({"error": f"invalid contact: {item!r}"}), 400
            cleaned.append((name, (item.get("title") or "").strip(), url, category))

        conn = get_db(app.config["DATABASE"])
        app_id = _reaching_out_app_id(conn, company)
        inserted = 0
        for name, title, url, category in cleaned:
            cur = conn.execute(
                """INSERT OR IGNORE INTO contacts
                   (company, application_id, name, title, profile_url, category)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (company, app_id, name, title, url, category),
            )
            inserted += cur.rowcount
        if app_id is not None:
            conn.execute(
                "UPDATE contacts SET application_id = ? "
                "WHERE lower(company) = lower(?) AND application_id IS NULL",
                (app_id, company),
            )
        conn.commit()
        conn.close()
        return jsonify({"inserted": inserted, "skipped": len(cleaned) - inserted})

    @app.route("/api/contacts/<int:contact_id>", methods=["PATCH"])
    def update_contact(contact_id):
        if _cross_origin_request():
            return jsonify({"error": "cross-origin request rejected"}), 403
        data = request.get_json(force=True) or {}
        allowed = {"draft", "status", "reply_text"}
        unknown = set(data) - allowed
        if unknown or not data:
            return jsonify({"error": f"unknown or empty fields: {sorted(unknown)}"}), 400
        if "status" in data:
            if data["status"] not in STATUSES:
                return jsonify({"error": f"invalid status: {data['status']}"}), 400
            if data["status"] == "sent":
                return jsonify({"error": "use POST /api/contacts/<id>/sent"}), 400
        conn = get_db(app.config["DATABASE"])
        if conn.execute("SELECT 1 FROM contacts WHERE id = ?", (contact_id,)).fetchone() is None:
            conn.close()
            return jsonify({"error": "not found"}), 404
        set_clause = ", ".join(f"{f} = ?" for f in data)
        conn.execute(
            f"UPDATE contacts SET {set_clause}, updated_at = datetime('now') WHERE id = ?",
            list(data.values()) + [contact_id],
        )
        conn.commit()
        conn.close()
        return jsonify({"ok": True})

    @app.route("/api/contacts/<int:contact_id>/sent", methods=["POST"])
    def mark_contact_sent(contact_id):
        if _cross_origin_request():
            return jsonify({"error": "cross-origin request rejected"}), 403
        conn = get_db(app.config["DATABASE"])
        row = conn.execute("SELECT * FROM contacts WHERE id = ?", (contact_id,)).fetchone()
        if row is None:
            conn.close()
            return jsonify({"error": "not found"}), 404
        if row["status"] in ("sent", "replied"):
            conn.close()
            return jsonify({"ok": True, "logged": False})

        app_id = row["application_id"] or _reaching_out_app_id(conn, row["company"])
        logged = False
        if app_id is not None:
            logged = _log_outreach_contact(conn, app_id, row["name"], date.today().isoformat())
        conn.execute(
            "UPDATE contacts SET status = 'sent', application_id = COALESCE(application_id, ?), "
            "updated_at = datetime('now') WHERE id = ?",
            (app_id, contact_id),
        )
        conn.commit()
        conn.close()
        return jsonify({"ok": True, "logged": logged})

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
            padded = fields + [""] * (8 - len(fields))
            (date_applied, company, role, type_, status,
             referred, reply_received, notes) = padded[:8]

            if type_ not in TYPE_VALUES or status not in STATUS_VALUES:
                skipped += 1
                continue

            latest_outreach_date = date_applied if status == "Reaching Out" else ""
            try:
                apply_by_date = _apply_by_date(latest_outreach_date) if latest_outreach_date else ""
            except ValueError:
                # date_applied wasn't a parseable YYYY-MM-DD -- still import
                # the row (paste rows are free text), just leave Apply By
                # blank rather than failing the whole import.
                apply_by_date = ""

            conn.execute(
                """
                INSERT INTO applications
                    (date_applied, company, role, type, status, referred, reply_received, resume_used, notes,
                     latest_outreach_date, apply_by_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
                """,
                (
                    date_applied, company, role, type_, status,
                    referred.strip().lower() == "yes",
                    reply_received.strip().lower() == "yes",
                    notes,
                    latest_outreach_date,
                    apply_by_date,
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
