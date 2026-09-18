const STATUSES = ["Applied", "Interviewing", "Accepted", "Rejected", "Incomplete"];

async function fetchApplications() {
    const tab = window.currentTab || "applying";
    const company = document.getElementById("filter-company").value;
    const params = new URLSearchParams();
    if (tab === "rejected") params.set("status", "Rejected");
    if (company) params.set("company", company);
    if (window.currentSort) {
        params.set("sort", window.currentSort.field);
        params.set("dir", window.currentSort.dir);
    }
    const resp = await fetch(`/api/applications?${params.toString()}`);
    let rows = await resp.json();
    if (tab === "applying") {
        rows = rows.filter((row) => row.status !== "Rejected");
    }
    renderRows(rows);
    fetchStats();
}

async function fetchStats() {
    // Independent of the (possibly filtered) table fetch above, so these
    // always reflect the true totals across every row, not just what's
    // currently shown in the table.
    const resp = await fetch("/api/stats");
    if (!resp.ok) return;
    const stats = await resp.json();
    document.getElementById("stat-applied").textContent = stats.applied;
    document.getElementById("stat-rejected").textContent = stats.rejected;
    document.getElementById("stat-this-week").textContent = stats.this_week;
    document.getElementById("stat-today").textContent = stats.today;
}

function renderRows(rows) {
    const body = document.getElementById("applications-body");
    body.innerHTML = "";
    for (const row of rows) {
        const tr = document.createElement("tr");

        tr.appendChild(makeCell(row.id));
        tr.appendChild(makeCell(row.date_applied));
        tr.appendChild(makeCell(row.company));
        tr.appendChild(makeCell(row.role));
        tr.appendChild(makeCell(row.type));
        tr.appendChild(makeStatusCell(row));
        tr.appendChild(makeToggleCell(row, "outreach_sent"));
        tr.appendChild(makeToggleCell(row, "reply_received", "outreach_sent"));
        tr.appendChild(makeToggleCell(row, "referred", "outreach_sent"));
        tr.appendChild(makeEditableCell(row, "notes"));
        tr.appendChild(makeDeleteCell(row));

        body.appendChild(tr);
    }
}

function makeCell(text) {
    const td = document.createElement("td");
    td.textContent = text;
    return td;
}

function makeStatusCell(row) {
    const td = document.createElement("td");
    const select = document.createElement("select");
    select.className = `status-select status-${row.status}`;
    for (const status of STATUSES) {
        const option = document.createElement("option");
        option.value = status;
        option.textContent = status;
        if (status === row.status) option.selected = true;
        select.appendChild(option);
    }
    select.addEventListener("change", async () => {
        const ok = await updateApplication(row.id, { status: select.value });
        if (ok) {
            select.className = `status-select status-${select.value}`;
        }
    });
    td.appendChild(select);
    return td;
}

function makeToggleCell(row, field, gateField) {
    const td = document.createElement("td");
    if (gateField && !row[gateField]) {
        td.className = "toggle-dash";
        td.textContent = "—";
        return td;
    }
    const button = document.createElement("button");
    const value = !!row[field];
    button.className = `toggle-pill ${value ? "toggle-yes" : "toggle-no"}`;
    button.textContent = value ? "Yes" : "No";
    button.addEventListener("click", async () => {
        await updateApplication(row.id, { [field]: !value });
        fetchApplications();
    });
    td.appendChild(button);
    return td;
}

function makeEditableCell(row, field) {
    const td = document.createElement("td");
    td.className = "notes";
    td.textContent = row[field] || "";
    td.contentEditable = "true";
    td.addEventListener("blur", () => {
        row[field] = td.textContent;
        updateApplication(row.id, { [field]: td.textContent });
    });
    return td;
}

function makeDeleteCell(row) {
    const td = document.createElement("td");
    const button = document.createElement("button");
    button.textContent = "Delete";
    button.addEventListener("click", async () => {
        if (!confirm(`Delete ${row.company} - ${row.role}?`)) return;
        const resp = await fetch(`/api/applications/${row.id}`, { method: "DELETE" });
        if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            alert(body.error || "Failed to delete application");
        }
        fetchApplications();
    });
    td.appendChild(button);
    return td;
}

async function updateApplication(id, fields) {
    const resp = await fetch(`/api/applications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
    });
    if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        alert(body.error || "Failed to save change");
        fetchApplications();
    } else {
        // Status/date_applied edits don't always go through fetchApplications()
        // (e.g. the status dropdown just swaps its own class), so refresh the
        // counters directly here too.
        fetchStats();
    }
    return resp.ok;
}

document.getElementById("quick-add-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const data = Object.fromEntries(new FormData(form).entries());
    const resp = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
    if (resp.ok) {
        form.reset();
        fetchApplications();
    } else {
        const body = await resp.json();
        alert(body.error || "Failed to add application");
    }
});

document.getElementById("paste-submit").addEventListener("click", async () => {
    const text = document.getElementById("paste-textarea").value;
    const resp = await fetch("/api/applications/paste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
    });
    const body = await resp.json();
    document.getElementById("paste-result").textContent =
        `Inserted ${body.inserted}, skipped ${body.skipped}`;
    document.getElementById("paste-textarea").value = "";
    fetchApplications();
});

document.getElementById("filter-company").addEventListener("input", fetchApplications);

document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
        document.querySelectorAll(".tab-button").forEach((b) => b.classList.remove("active"));
        button.classList.add("active");
        window.currentTab = button.dataset.tab;
        fetchApplications();
    });
});

document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
        const field = th.dataset.sort;
        const currentDir = window.currentSort && window.currentSort.field === field
            ? window.currentSort.dir
            : "desc";
        const nextDir = currentDir === "asc" ? "desc" : "asc";
        window.currentSort = { field, dir: nextDir };
        fetchApplications();
    });
});

fetchApplications();
