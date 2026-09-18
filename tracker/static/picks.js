// Local date (YYYY-MM-DD). run_date / first_run_date / updated_at are written
// as local dates, so TODAY must be local too — toISOString() is UTC and rolls
// over a day early in US evening hours.
const TODAY = new Date().toLocaleDateString("en-CA");

async function load() {
    const picks = await (await fetch("/api/picks")).json();
    const priority = [], today = [], carried = [], applied = [];
    for (const p of picks) {
        if (p.priority) {
            priority.push(p);
        } else if (p.status === "applied") {
            // Only picks applied *today* — older applied picks stay in the DB
            // (still linked to their applications row) but drop off this view.
            if ((p.updated_at || "").slice(0, 10) === TODAY) applied.push(p);
        } else if (p.first_run_date < TODAY) {
            carried.push(p);
        } else {
            today.push(p);
        }
    }
    renderInto(document.querySelector("#priority .pick-list"), priority);
    document.querySelector("#priority").hidden = priority.length === 0;
    renderInto(document.querySelector("#today > .pick-list"), today.slice(0, 15));
    const moreWrap = document.querySelector("#today .more");
    renderInto(moreWrap.querySelector(".pick-list"), today.slice(15));
    moreWrap.hidden = today.length <= 15;
    renderInto(document.querySelector("#carried .pick-list"), carried, true);
    document.querySelector("#carried").hidden = carried.length === 0;
    renderInto(document.querySelector("#applied .pick-list"), applied, false, true);
    document.querySelector("#applied").hidden = applied.length === 0;
}

function renderInto(container, picks, showFrom = false, compact = false) {
    container.innerHTML = "";
    for (const p of picks) container.appendChild(card(p, showFrom, compact));
}

function pill(text, cls) {
    const s = document.createElement("span");
    s.className = "pill" + (cls ? " " + cls : "");
    s.textContent = text;
    return s;
}

function card(p, showFrom, compact) {
    const el = document.createElement("div");
    el.className = "pick-card";

    const head = document.createElement("div");
    head.className = "pick-head";
    if (p.rank != null) {
        const b = document.createElement("span");
        b.className = "rank";
        b.textContent = "#" + p.rank;
        head.appendChild(b);
    }
    const title = document.createElement("strong");
    title.textContent = `${p.company} — ${p.role}`;
    head.appendChild(title);
    el.appendChild(head);

    if (compact) return el;

    const pills = document.createElement("div");
    pills.className = "pills";
    if (p.location) pills.appendChild(pill(p.location));
    if (p.salary) pills.appendChild(pill(p.salary));
    if (p.term) pills.appendChild(pill(p.term, p.term === "Unknown" ? "pill-unknown" : ""));
    if (showFrom) pills.appendChild(pill("from " + p.first_run_date, "pill-from"));
    el.appendChild(pills);

    if (p.reasoning) {
        const r = document.createElement("p");
        r.className = "reasoning";
        r.textContent = p.reasoning;
        el.appendChild(r);
    }

    if (p.description) {
        // Lazy-render the JD text only once the details is actually opened.
        // Left in the DOM up front, this huge blob routinely restates the
        // same company/role/location words as a plain title search, and
        // Cmd+F auto-opens any closed <details> whose hidden content
        // matches -- so every card's JD block would pop open at once,
        // burying the small always-visible title/pills text being searched
        // for (told 2026-09-12).
        const d = document.createElement("details");
        const sm = document.createElement("summary");
        sm.textContent = "Full description";
        d.appendChild(sm);
        d.addEventListener("toggle", () => {
            if (!d.open || d.querySelector(".jd")) return;
            const body = document.createElement("pre");
            body.className = "jd";
            body.textContent = p.description;
            d.appendChild(body);
        });
        el.appendChild(d);
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    const link = document.createElement("a");
    if (/^https?:\/\//i.test(p.url || "")) link.href = p.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Open posting";
    actions.appendChild(link);

    const applyBtn = document.createElement("button");
    applyBtn.dataset.act = "apply";
    applyBtn.textContent = "Applied";
    applyBtn.addEventListener("click", async () => {
        applyBtn.disabled = true;
        const res = await fetch(`/api/picks/${p.id}/apply`, { method: "POST" });
        if (!res.ok) {
            alert("Couldn't mark this applied (it may already be applied or deleted).");
            applyBtn.disabled = false;
            return;
        }
        load();
    });
    actions.appendChild(applyBtn);

    const priorityBtn = document.createElement("button");
    priorityBtn.dataset.act = "priority";
    priorityBtn.textContent = p.priority ? "Unpriority" : "★ Priority";
    priorityBtn.addEventListener("click", async () => {
        priorityBtn.disabled = true;
        const res = await fetch(`/api/picks/${p.id}/priority`, { method: "POST" });
        if (!res.ok) {
            alert("Couldn't update priority — try reloading the page.");
            priorityBtn.disabled = false;
            return;
        }
        load();
    });
    actions.appendChild(priorityBtn);

    const delBtn = document.createElement("button");
    delBtn.dataset.act = "delete";
    delBtn.className = "danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
        if (!confirm("Delete this pick? It won't come back.")) return;
        delBtn.disabled = true;
        const res = await fetch(`/api/picks/${p.id}`, { method: "DELETE" });
        if (!res.ok) {
            alert("Couldn't delete this pick — try reloading the page.");
            delBtn.disabled = false;
            return;
        }
        load();
    });
    actions.appendChild(delBtn);

    el.appendChild(actions);
    return el;
}

load();
