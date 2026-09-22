# ADP Recruiting (`recruiting.adp.com`) Adapter — Design

## Context

The extension has an ADP adapter (`src/fill-engine/adp-adapter.ts` +
`adp-fill.ts`), but it only activates on `workforcenow.adp.com` — ADP's
React-based "Workforce Now" product. Manual QA on a real application
(Holden Industries, hosted at
`recruiting.adp.com/srccar/public/nghome.guid?...`) found that this is a
**completely different ADP product** — the older "Recruiting
Management / SRCCAR" career site — and the extension does essentially
nothing on it. The popup reports "1 filled, 0 need your input" while the
form is untouched and dozens of required fields are blank.

`recruiting.adp.com` is built on **Dojo / Dijit** (`dojo.js` with
`dojoConfig async:true`, AMD `require`). Form fields are Dijit widgets:

- Text: `dijit/form/ValidationTextBox` — real `<input class="dijitInputInner"
  name="firstName_RTiCandidate">` nested inside widget wrappers.
- Dropdowns: `dijit/form/Select` — a `<table role="listbox">` widget with a
  hidden `valueNode` holding a coded value (`"USA"`, `"NC"`, `"true"`,
  `"00001000"`); **no native `<select>`**.
- Dates: `dijit/form/DateTextBox`.
- Long text: `dijit/form/Textarea` (`dijitExpandingTextArea`).

Every field is wrapped in
`<div class="dojositeFld" data-dojosite-fld="<url-encoded JSON>"
widgetid="<id>">`, where the JSON carries `name` (e.g. `$$employerName_1`)
and `teName` (e.g. `SourcingCandidate_employerName_1`). The inner control
carries `name="$$employerName_1_RTiCandidate"`.

Setting `input.value` directly is reverted by Dojo — the widget owns its
state. **But the fill engine already runs in the page's MAIN world**
(`background.ts` injects `dist/fill-engine.js` with `world: 'MAIN'`), so
it can reach `window.require`, load `dijit/registry`, and call
`widget.set('value', …)` directly. That is the approach chosen here (over
simulated keystrokes) because it is the reliable way to drive Dijit and
the loader is present on the page.

The application is a multi-section "eForm": **Personal Information**,
**General Information**, and a repeatable **Employment History** section
(up to 6 employer rows, added via an "Add Employer" button —
`EFormRepeatSectionButton`). Education / EEO / eSignature sections exist
but are out of scope for this increment.

**Priority (from the user): Employment History is the most valuable part
— it is the most tedious to re-enter on every application.** Personal
Information and the clean-mapping General Information questions are
included because they fall out of the same Dojo bridge almost for free.

## Architecture

A new adapter, `adpRecruitingAdapter`, matches `recruiting.adp.com`. Like
`adpAdapter`, its `extractFields` returns `[]` so the generic
synchronous engine never touches these controls (it would set
`input.value` and have Dojo revert it, and mis-count the result). The
existing `workforcenow.adp.com` adapter and `adp-fill.ts` are **not
touched**.

All writing goes through one small **Dojo bridge** module that
encapsulates "find the widget for this field name" and "set its value
through the Dijit API, firing change". Two fill passes consume the
bridge: a **flat field pass** (Personal + General Information, driven by
a `name → ProfileFieldKey` map) and a **repeatable pass** (Employment
History, driven by `profile.workHistory`).

The orchestrator (`run()` in `fill-engine/index.ts`) gains one branch,
mirroring the existing `adapter.id === 'adp'` branch: `adapter.id ===
'adp-recruiting' ? await fillAdpRecruitingForm(profile) : {filled:0,
flagged:0}`, summed into the totals.

`WorkHistoryEntry` gains four optional fields so the repeatable pass has
real data for ADP's required columns, and the options UI (work-history
editor) is extended to capture them.

## Components

- **`src/storage/profile-schema.ts`** — `WorkHistoryEntry` gains
  `supervisorName?: string`, `supervisorPhone?: string`,
  `mayContact?: 'yes' | 'no' | ''`, `reasonForLeaving?: string`. All
  optional; no `version` bump needed (additive, `profile-store`
  normalizes missing keys to defaults).
- **`src/storage/profile-store.ts`** — normalization fills the four new
  `WorkHistoryEntry` keys with `''` when absent on load.
- **`src/options/profile-lists.ts`** — `renderWorkHistoryEntry` adds
  inputs for Supervisor Name, Supervisor/Employer Phone, "May we contact
  this employer?" (yes/no/blank select), and Reason for Leaving
  (textarea); `parseWorkHistory` reads them back.
- **`src/options/options.html` / `profile-form.ts`** — only if the
  work-history editor needs wiring changes for the new controls; no new
  top-level sections.
- **`src/fill-engine/adp-recruiting-adapter.ts`** *(new)* —
  `adpRecruitingAdapter: Adapter`, `id: 'adp-recruiting'`,
  `matchesHostname: /(^|\.)recruiting\.adp\.com$/i`, `extractFields: () => []`.
- **`src/fill-engine/adapter-registry.ts`** — import and append
  `adpRecruitingAdapter`.
- **`src/fill-engine/adp-recruiting-dojo.ts`** *(new)* — the bridge, all
  MAIN-world:
  - `getRegistry(): DijitRegistry | null` — try
    `window.require('dijit/registry')`; fall back to
    `window.dijit?.registry`; return `null` if neither resolves.
  - `widgetForName(name: string, registry): DijitWidget | null` —
    `document.querySelector('[name="' + CSS.escape(name) + '"]')` →
    `registry.getEnclosingWidget(node)`. Fallback: locate the
    `.dojositeFld` whose decoded `data-dojosite-fld.name` matches the
    base name, read its `widgetid`, `registry.byId(widgetid)`.
  - `setText(widget, value: string): boolean` —
    `widget.set('value', value)`, then fire change
    (`widget._handleOnChange?.(value, true)` ?? `widget.onChange?.(value)`);
    verify `widget.get('value') === value`.
  - `setSelect(widget, value: string, profileKey): boolean` — read
    options (`widget.getOptions?.()` → `[{value,label}]`); match `label`
    against `buildCandidates(profileKey, value)` via `findMatchIndex`
    (reused from `fill-engine.ts`); `widget.set('value', match.value)`;
    verify.
  - `setDate(widget, raw: string): boolean` — parse `raw` (accepts
    `MM/DD/YYYY`, `YYYY-MM`, `YYYY-MM-DD`, `Mon YYYY`) to a `Date`;
    `widget.set('value', date)`; verify a non-null widget value.
  - `clickAndWait(button, predicate, {intervalMs, maxAttempts}):
    Promise<boolean>` — dispatch a real click, poll `predicate` (bounded,
    same 50 ms × 20 style as `combobox-fill.ts`).
- **`src/fill-engine/adp-recruiting-fill.ts`** *(new)* —
  `fillAdpRecruitingForm(profile, root = document): Promise<FillSummary>`:
  1. `const registry = getRegistry(); if (!registry) return {filled:0, flagged:0};`
  2. **Flat pass** — for each entry in `ADP_RECRUITING_FIELD_MAP`
     (`{ 'firstName': 'personal.firstName', 'address1': 'personal.address',
     'city': 'personal.city', 'state': 'personal.state', 'zip':
     'personal.zip', 'country': 'personal.country', 'phone':
     'personal.phone', '$$willingToRelocate':
     'jobPreferences.willingToRelocate', '$$authorizedToWork':
     'workAuthorization.authorizedToWork', '$$18yearsOfAge':
     'jobPreferences.atLeast18', … }`): resolve name to
     `<base>_RTiCandidate`, find widget, resolve profile value, dispatch
     to `setText` / `setSelect` / `setDate` by widget type. Empty profile
     value → flag iff required (`aria-required` / `**` in label), else
     `clearFlag`.
  3. **Repeatable pass** — `fillAdpRecruitingEmployment(profile,
     registry)`: bail unless `[name="$$employerName_1_RTiCandidate"]`
     exists. Determine rendered rows by scanning
     `[name^="$$employerName_"][name$="_RTiCandidate"]`. For `i` in
     `0..min(workHistory.length, 6)`: if row `i+1` not rendered, click
     the "Add Employer" button and `clickAndWait` for
     `[name="$$employerName_" + (i+1) + "_RTiCandidate"]` to register.
     Then per row map:
     | Row field (`$$…_N`) | Source | Bridge call |
     |---|---|---|
     | `employerType` | `currentlyWorksHere ? 'Current' : 'Previous'` | `setSelect` |
     | `employerName` | `company` | `setText` |
     | `employerSupvPhone` | `supervisorPhone` | `setText` |
     | `employerCity` | `location` (before comma, or whole) | `setText` |
     | `employerCountry` | `location` country token if present, else `personal.country` | `setSelect` |
     | `employerState` | `location` state token if present | `setSelect` |
     | `employerStartDate` | `startDate` | `setDate` |
     | `employerStartTitle` | `title` | `setText` |
     | `employerEndDate` | `currentlyWorksHere ? '' : endDate` | `setDate` |
     | `employerEndTitle` | `currentlyWorksHere ? '' : title` | `setText` |
     | `employerSupvName` | `supervisorName` | `setText` |
     | `employerReference` (May We Contact?) | `mayContact` | `setSelect` |
     | `employerJobDuties` | `description` | `setText` |
     | `employerReasonForLeaving` | `reasonForLeaving` | `setText` |
     Empty source + required column → flag; empty + optional → skip.
  4. Return summed `{filled, flagged}`.
- **`src/fill-engine/index.ts`** — add the `adapter.id === 'adp-recruiting'`
  branch and include its summary in the `filled` / `flagged` totals.
- **`src/fill-engine/synonym-dictionary.ts`** — only if label-based
  resolution is used anywhere; the field map is name-based so likely
  untouched.

## Data Flow

`run()` picks `adpRecruitingAdapter` for `recruiting.adp.com` →
`fillAdpRecruitingForm` → `getRegistry()` (null → no-op) → flat pass
walks the name→key map, per field: find widget → resolve value → typed
bridge call → verify or flag → repeatable pass walks `workHistory`, adds
rows as needed, fills each row's columns the same way → summaries summed
into the popup's counts.

## Error Handling

- Dojo loader / registry unreachable → whole module returns
  `{filled:0, flagged:0}` (no throw, no partial DOM poking).
- Widget not found for a mapped name → skip that field (the tenant may
  not expose it); do not flag (nothing on screen to flag).
- `widget.set` throws or post-set verification fails → `flagField` the
  widget's DOM node, count `flagged`.
- "Add Employer" button missing or new row never registers within the
  bounded poll → stop adding rows; fill the rows that do exist; remaining
  `workHistory` entries are simply not filled (logged intent, not a
  throw).
- Required-but-no-data columns (common: Employer Phone, Supervisor Name,
  May We Contact, Reason for Leaving when the user hasn't filled those
  profile fields) → `flagField` + `flagged++`, so the popup's "N need
  your input" tells the user exactly what to finish.
- Date parse failure → treated as empty (flag iff required).

## Testing

Unit tests (vitest), mirroring `tests/adp-fill.test.ts`:

- **Bridge** — mock `window.require`/`dijit/registry` and fake widget
  objects (`get`/`set`/`getOptions`/`onChange`). Verify `setText` writes
  and fires change, `setSelect` matches label→coded-value through
  `buildCandidates`/`findMatchIndex` (incl. state abbreviation and
  yes/no), `setDate` parses the supported formats, `getRegistry` returns
  `null` cleanly when the loader is absent (→ module no-ops).
- **Flat pass** — mount representative `.dojositeFld` wrappers for
  first name (text), country (select), relocate (yes/no select);
  confirm each widget's `set` is called with the right value, empty
  required field is flagged, empty optional field is not.
- **Repeatable pass** — one rendered row + a 2-entry `workHistory`:
  confirm row 1 fills from entry 0, the "Add Employer" button is clicked
  once, row 2 fills from entry 1 after it registers; `currentlyWorksHere`
  leaves End Date / End Title blank and sets Type = Current; a required
  column with no profile data is flagged.
- **Orchestrator** — `adapter.id === 'adp-recruiting'` routes to
  `fillAdpRecruitingForm` and its counts land in the totals; other hosts
  are unaffected.
- **Schema/options** — `parseWorkHistory` round-trips the four new
  fields; `profile-store` normalization defaults them on legacy
  profiles.

These verify our logic, **not** that it drives real ADP. As with every
prior fill module in this repo, **the acceptance test is manual: load
the unpacked extension from `main`, open a real `recruiting.adp.com`
application, run autofill, and confirm the Employment History rows,
Personal Information, and the mapped General Information dropdowns are
actually populated and committed (survive a section change / blur).**
Widget API shape (`getOptions`, `_handleOnChange`), the "Add Employer"
timing, and coded select values are all assumptions from one captured
page until confirmed live.

## Out of Scope

- Education, EEO / voluntary self-identification, and eSignature
  sections. The Dojo bridge makes each a later field-map addition.
- The conditional / company-specific General Information questions with
  no clean profile source (prior employment at *this* company, relatives
  at *this* company, work-authorization free-text description, previous
  work location/dates). Flagged if required, never guessed.
- `dijit/form/Select` "Willingness to Travel" percentage field — no
  matching profile key; deferred with the rest of General Information's
  long tail.
- `workforcenow.adp.com` behavior — untouched.
- Simulated-keystroke fallback for when the Dojo loader is absent — the
  loader is present on the captured page; if a future tenant strips it,
  that is a separate design.
