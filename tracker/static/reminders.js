// Local date (YYYY-MM-DD) — matches picks.js's convention so "due today"
// lines up with the server's local-time due_date values instead of rolling
// over a day early via toISOString()'s UTC conversion.
const TODAY = new Date().toLocaleDateString("en-CA");

async function load() {
    const reminders = await (await fetch("/api/reminders?all=1")).json();
    const due = [], upcoming = [], done = [];
    for (const r of reminders) {
        if (r.done) done.push(r);
        else if (r.due_date <= TODAY) due.push(r);
        else upcoming.push(r);
    }
    renderInto(document.querySelector("#due .reminder-list"), due, "No reminders due right now.");
    renderInto(document.querySelector("#upcoming .reminder-list"), upcoming, "Nothing scheduled.");
    renderInto(document.querySelector("#done .reminder-list"), done, "Nothing completed yet.");
}

function renderInto(container, reminders, emptyText) {
    container.innerHTML = "";
    if (reminders.length === 0) {
        const p = document.createElement("p");
        p.className = "reminder-empty";
        p.textContent = emptyText;
        container.appendChild(p);
        return;
    }
    for (const r of reminders) container.appendChild(card(r));
}

function card(r) {
    const el = document.createElement("div");
    el.className = "reminder-card" + (r.done ? " done" : r.due_date <= TODAY ? " overdue" : "");

    const due = document.createElement("span");
    due.className = "reminder-due";
    due.textContent = r.due_date;
    el.appendChild(due);

    const message = document.createElement("span");
    message.className = "reminder-message";
    message.textContent = r.message;
    el.appendChild(message);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = r.done ? "Reopen" : "Done";
    toggle.addEventListener("click", async () => {
        await fetch(`/api/reminders/${r.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ done: !r.done }),
        });
        load();
    });
    el.appendChild(toggle);

    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
        await fetch(`/api/reminders/${r.id}`, { method: "DELETE" });
        load();
    });
    el.appendChild(del);

    return el;
}

document.querySelector("#reminder-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const due_date = form.due_date.value;
    const message = form.message.value.trim();
    if (!due_date || !message) return;
    await fetch("/api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ due_date, message }),
    });
    form.reset();
    load();
});

load();
