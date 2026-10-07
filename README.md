# Inedia

Inedia is a local-first job application toolkit: a Flask/SQLite job tracker paired with a browser extension that autofills application forms.

## Privacy

Profile data, resumes, applications, and browser sessions stay on each user's computer. Inedia does not require Google authentication or a hosted account, and nothing is sent anywhere except the job sites and ATS pages you actually apply to. Do not commit personal profiles, resumes, databases, screenshots, or credentials — see "Personalizing your own copy" below for how the repo keeps that out of Git automatically.

## Projects

- `tracker/` — local job tracking, scanning, ranking, and the profile API. See [tracker/README.md](tracker/README.md).
- `extension/` — Chrome extension for local profile management and cautious autofill. Install with `npm install && npm run build` from `extension/`, then load `extension/dist/` as an unpacked extension in Chrome. Once the tracker is running locally, use the extension popup's sync action to pull your profile from `http://localhost:8080/api/profile`.

## Personalizing your own copy

Everything personal to you — your name, contact info, work history, search
preferences, resumes, cover letters, and the application database itself —
is meant to live **only on your machine**, never in a commit. Two
mechanisms make that automatic:

1. **`.example` files you copy, not edit in place.** `tracker/profile_data_private.py.example` and `tracker/search_preferences_private.py.example` contain placeholder values (`"Example User"`, `EARLIEST_GRAD = None`, etc.). Copy each to the same path without `.example` and fill in your own values:

       cp tracker/profile_data_private.py.example tracker/profile_data_private.py
       cp tracker/search_preferences_private.py.example tracker/search_preferences_private.py

   Those two real filenames are gitignored, so `git status` will never show
   them as changed, and a `git pull` of future updates will never touch or
   overwrite them.

2. **Gitignored data directories.** Anything the app generates while you use
   it — `tracker/tracker.db` (your application history), `tracker/resumes/`,
   `tracker/cover_letters/`, `tracker/career_prep/`, `tracker/daily_run/`,
   screenshots, logs, and browser profile directories — is covered by
   `.gitignore` at the root, `tracker/.gitignore`, and `extension/.gitignore`.
   You can run the tool, build up months of real application data, and
   `git status` stays clean; there's nothing to accidentally stage or push.

This means you can `git pull` to get updates to the shared code at any time
without a merge conflict against your own data, and you can safely push your
own fork without re-auditing your history for personal information — as
long as you only ever edit the real (non-`.example`) private-config files and
let the app write to the gitignored data directories, nothing personal is
ever tracked in the first place.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Use fake
data in any new fixtures or examples (synthetic names, `example.com` URLs,
placeholder dates), the same way the existing test fixtures do.

If you're setting up a **separate** public fork rather than using the
`.example`/gitignore mechanism above (for example, hard-forking before this
privacy model existed), inspect the entire Git history — not only the
current checkout — for names, resumes, application URLs, job-search
decisions, contact records, browser captures, and credentials before
pushing. Removing a file in a later commit does not remove it from earlier
commits; see [OPEN_SOURCE_RELEASE.md](OPEN_SOURCE_RELEASE.md) for the full
checklist this repo's own public history was scrubbed against.
