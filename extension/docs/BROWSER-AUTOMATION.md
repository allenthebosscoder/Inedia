# Browser automation

The Playwright harness loads the real unpacked Manifest V3 extension into bundled Chromium. It
uses an isolated persistent profile for live ATS sessions and never touches the default Chrome
profile.

## Automated smoke test

```sh
npm run e2e
```

This builds the extension, starts a local application fixture, loads the extension, saves a test
profile through `chrome.storage`, runs the real MAIN-world fill engine, and verifies the results.
Failed tests retain a screenshot, video, and Playwright trace under `test-results/`.

Open an HTML report with:

```sh
npx playwright show-report
```

## Live ATS browser

```sh
npm run e2e:ats -- --url "https://tenant.wd1.myworkdayjobs.com/en-US/job/..."
```

The first run creates `.playwright/ats-profile/`. Log in once in this browser if the site requires
it; cookies remain in this dedicated profile for later sessions. Load or edit the Job Autofill
profile from the extension's options page, then exercise autofill normally.

The automation browser has separate extension storage. To copy an existing profile, press
**Export profile** in the normal extension options and launch with the downloaded file:

```sh
npm run e2e:ats -- --url "https://tenant.wd1.myworkdayjobs.com/en-US/job/..." --profile "/path/to/job-autofill-profile.json"
```

You can also use **Import profile JSON** from the extension options inside the automation browser.
The export includes the saved resume.

For Workday, pass the public job posting URL. The launcher removes trailing `/apply/...` session
paths, which usually cannot be reused in a separate browser profile. If Workday still displays its
temporary error page, the launcher refreshes once and leaves an actionable message in Terminal.

Some iCIMS tenants route **Apply Now** to Universal Login even for a new email. For a disposable
new-candidate test, open the posting with `?mode=prepopulate`; this is iCIMS's direct Candidate
Profile route. For example:

```sh
npm run e2e:ats -- --url "https://careers-company.icims.com/jobs/12345/job?mode=prepopulate"
```

The Candidate Profile page asks the tester to create employer-specific login credentials. Job
Autofill intentionally does not store, invent, or fill passwords.

### Authentication-sensitive sites

The Playwright browser exposes `navigator.webdriver`, and sites protected by hCaptcha or similar
anti-automation services can reject account creation or login. Use the manual launcher for those
authentication steps:

```sh
npm run e2e:ats:manual -- --url "https://careers-company.icims.com/jobs/12345/job?mode=prepopulate"
```

On macOS this starts standard Chrome with the same isolated `.playwright/ats-profile/` and the
unpacked extension, but without attaching Playwright or touching the default Chrome profile.
Close the automated ATS browser before starting manual mode because Chrome profiles cannot be
opened by both processes at once. Autofill must be triggered from the extension UI in manual mode,
and final submission is not blocked by the test harness.

The launcher blocks clicks whose labels indicate final submission. It intentionally permits
intermediate controls such as **Save and Continue** so multi-page applications can be tested.
Always use a test or disposable application when possible.

To deliberately submit a real application yourself, restart the test browser with the explicit
opt-in flag:

```sh
npm run e2e:ats -- --url "https://tenant.wd1.myworkdayjobs.com/en-US/job/..." --allow-submit
```

This only removes the test harness's final-submit guard. Autofill still never clicks Save,
Continue, or Submit for you.

Close the Chromium window to stop the launcher. To start with a completely fresh ATS browser,
move `.playwright/ats-profile/` elsewhere or delete it after confirming no needed test login state
remains.

While the launcher is running it creates a permission-restricted `.playwright/control.json` file.
This local control channel lets the development agent trigger autofill diagnostics against the
currently open application page. Reports and before/after screenshots are written under
`.playwright/reports/`. The token and server disappear when the automation browser closes.
