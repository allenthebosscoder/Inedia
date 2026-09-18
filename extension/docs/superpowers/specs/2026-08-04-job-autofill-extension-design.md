# Job Application Autofill Extension — Design

## Context

Simplify is a Chrome/Firefox extension that autofills job applications across 100+ ATS platforms and includes AI-generated essay answers and a job tracker. Users (including the requester) report it as laggy to the point of being unusable at times — reviews attribute this partly to unoptimized Firefox extension APIs and, plausibly, to its AI features running in the background.

The goal here is a lightweight, Chrome-only replacement that autofills known form fields (name, contact info, work history, visa/work-authorization status, etc.) without any AI/LLM calls, leaving essay-style questions for the user to answer manually. A job-application tracker is a likely future phase but is explicitly out of scope for v1.

## Architecture

**Adapter pattern with a generic fallback, injected on demand.**

Each supported ATS gets a small adapter module (`GreenhouseAdapter`, `LeverAdapter`, `WorkdayAdapter`, `LinkedInAdapter`) implementing a shared interface: detect this site, extract form fields, map them to the user's profile. A registry tries each adapter's `detect()` against the current page and falls back to a `GenericAdapter` if none match. The generic adapter walks the DOM, reads label/name/placeholder text, normalizes it, and looks it up in a synonym dictionary (e.g. "sponsorship," "work authorization," "visa" all resolve to one profile field). Adding a new site later means writing one new adapter file and registering it.

Autofill is **manually triggered** (toolbar button), not run automatically on page load. Because of this, no content script needs to run persistently or scan pages in the background — the popup injects the fill script on demand via `chrome.scripting.executeScript` (activeTab permission) only at the moment the user clicks "Autofill." This directly targets the suspected lag cause (background scanning/AI calls), independent of dropping the AI features.

Two alternatives considered:
- **Data-driven config instead of adapter code** (JSON selectors per site, one generic engine) — faster to add simple sites, but too weak for sites like Workday with multi-step wizards/shadow DOM that need real logic.
- **Manifest-scoped content scripts per adapter** — Chrome loads only the matching adapter's code per URL pattern. Superseded by the on-demand injection approach, which loads nothing until the user acts at all.

## Components

- **Popup** (`popup.html`/`.js`) — the only UI touched per session. Shows a detected-site label (cheap hostname check, no injection yet) and an "Autofill this page" button. After filling, shows a one-line summary: "Filled 14 fields, 3 need your input."
- **Options page** (`options.html`/`.js`) — one-time profile setup: Personal Info, Work Authorization/EEO (visa, sponsorship, self-ID questions), Work History (repeatable entries), Education (repeatable), Links (LinkedIn/portfolio/GitHub), and a **Custom Q&A overrides** table — an escape hatch for when a site phrases a question in a way the synonym dictionary doesn't catch. Overrides are checked first, before any adapter-specific or generic matching, so a user-defined mapping always wins.
- **Fill script** (bundled, injected on click via `chrome.scripting.executeScript`) — contains the `SiteDetector`, the adapter registry (`GreenhouseAdapter`, `LeverAdapter`, `WorkdayAdapter`, `LinkedInAdapter`, `GenericAdapter`), and the `FillEngine` that sets values and flags anything it can't confidently fill (essays, unmatched fields).
- **Synonym dictionary** — a maintained data file mapping normalized label phrases to profile field keys. Used by `GenericAdapter` and consulted as a base layer by the specific adapters.
- **Storage layer** — thin wrapper over `chrome.storage.local`, with a versioned Profile schema so a future tracker feature can extend it without migrating existing users' data.

No background service worker is needed — the popup calls `chrome.scripting.executeScript` directly, so nothing runs until the user clicks the button.

## Data Flow

1. User navigates to a job application page.
2. Clicks the toolbar icon → popup opens, does a cheap `location.hostname` check to show which adapter would run (or "generic").
3. Clicks "Autofill" → popup calls `chrome.scripting.executeScript` to inject the fill script into the current tab.
4. Fill script: `SiteDetector` picks the adapter → adapter extracts field descriptors from the DOM → maps them to the stored Profile (specific adapters use their own field mapping, `GenericAdapter` uses the synonym dictionary) → `FillEngine` sets values and dispatches the right DOM events → unmatched/essay/free-text fields get visually flagged (e.g. yellow outline), not filled.
5. Script reports a summary back to the popup; injected code has no persistent listeners, so it's effectively discarded once done.
6. User reviews, manually completes flagged fields, submits normally — the extension never submits on the user's behalf.

## Error Handling

- No adapter matches *and* the generic matcher finds nothing recognizable → summary reads "0 fields recognized, this site isn't supported yet" instead of silently doing nothing.
- A field is matched but the profile has no data for it (e.g. no LinkedIn URL saved) → skip and flag, don't leave a false-negative silent blank.
- React-controlled inputs (common on Greenhouse/Lever/Workday) don't always pick up a plain `.value =` assignment → fill engine uses the native value setter + dispatches `input`/`change` events, a known workaround for React-controlled forms.
- Multi-step applications (Workday especially) — autofill only fills the current visible step; the user re-clicks "Autofill" on each subsequent page. No auto-chaining across steps, consistent with the manual-trigger, review-before-submit philosophy.
- Some ATS forms embed the application in an iframe — flagged as a known v1 limitation; may need `allFrames: true` on injection, worth validating during adapter development rather than assuming upfront.

## Testing

- Unit tests (Vitest) for the synonym dictionary matcher and `GenericAdapter` field normalization — given a set of label-text variants, confirm they resolve to the right profile key.
- Unit tests per adapter's `extractFields()` against saved fixture HTML captured from real application pages (jsdom), so ATS DOM changes surface as test failures rather than silent breakage.
- Manual QA checklist: run one real application through each of the 4 target sites (Greenhouse, Lever, Workday, LinkedIn Easy Apply) before calling v1 done — confirm correct fills, correct flagging of essay fields, no console errors, accurate popup summary.
- No automated E2E browser testing for v1 — deferred deliberately given single-developer scope, not an oversight.

## Out of Scope (Future Phases)

- Job application tracker (logging what was applied to, when, status). The Profile storage schema is versioned so this can be added without migrating existing data.
- Additional ATS adapters beyond the initial four (iCIMS, Taleo, SmartRecruiters, Indeed, etc.) — the adapter registry is designed to make this additive.
- Firefox/Edge support.
- Any AI/LLM-based features (essay generation, resume parsing).
