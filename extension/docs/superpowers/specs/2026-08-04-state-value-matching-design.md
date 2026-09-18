# State Value Matching — Design

## Context

Manual QA (see `docs/QA-FINDINGS.md`, Bug 2) found that Workday's State field doesn't fill correctly. Investigating the fix surfaced a more fundamental gap: the `personal.state` profile field is free text, but ATS forms represent state as a dropdown whose option text is sometimes the full name ("North Carolina") and sometimes the abbreviation ("NC") — a single free-text value typed once in the user's profile can't match both formats, regardless of how good the surrounding matching logic is.

This is a prerequisite for the larger Bug 2 fix (Workday's custom ARIA combobox widget), since that fix will need the same dual-format matching. It's scoped as its own piece of work because it's independently useful — it also fixes State on any site that already uses a native `<select>` (which some Greenhouse/Lever configurations do), without needing the combobox work at all.

## Architecture

Change the State field in the options page from a free-text `<input>` to a `<select>` listing all 50 states plus DC, with each option's `value` set to the two-letter abbreviation (e.g. `NC`) — that becomes the canonical value stored in `Profile.personal.state`. Add a small static lookup table mapping abbreviations to full names. Extend the fill engine's existing `selectOptionByText` to accept a *list* of acceptable match strings instead of one — for `personal.state`, that list is `[storedAbbreviation, expandedFullName]`; every other field keeps passing a single-item list, so existing behavior is unchanged for everything else.

The type of `Profile.personal.state` stays a plain `string`, not a 50-member string-literal union. Correctness is enforced by only offering valid options in the `<select>`, matching the project's existing preference for simple types over exhaustive unions where the UI already constrains the value.

## Components

- **`src/fill-engine/us-states.ts`** *(new)* — exports `US_STATES: { abbreviation: string; name: string }[]` (50 states + DC) and `expandStateAbbreviation(abbreviation: string): string | null`, which looks up the full name or returns `null` if the abbreviation isn't recognized.
- **`src/fill-engine/fill-engine.ts`** — `selectOptionByText` changes its second parameter from `targetText: string` to `candidates: string[]`. It tries an exact normalized match across all candidates first, then a whole-word match across all candidates, before giving up (generalizing today's two-tier logic rather than replacing it). In `fillFields`, the select branch computes the candidate list: `[value]` for every field, except `personal.state`, where it's `[value, expandStateAbbreviation(value)].filter(Boolean)`.
- **`src/options/options.html`** — the State `<input name="personal.state" />` becomes `<select name="personal.state">` with a `--` placeholder followed by all 50 states + DC, each `<option value="{abbreviation}">{full name}</option>`.
- **`src/options/profile-form.ts`** — no changes needed. `serializeProfile` (via `FormData.get`) and `populateForm` (via its `instanceof HTMLInputElement || instanceof HTMLSelectElement` guard) already handle `<select>` elements identically to `<input>` elements.

## Data Flow

User picks their state from the options-page dropdown; it's stored as the abbreviation (e.g. `"NC"`). At fill time, when a page's State field is a native `<select>` and its label resolves to `personal.state`, `fillFields` builds the candidate list `["NC", "North Carolina"]` and passes it to `selectOptionByText`, which tries both against the target select's option text — covering ATS sites that render either format. If neither candidate matches any option, the field is flagged for manual entry, same as today.

## Error Handling

- `expandStateAbbreviation` returns `null` for an unrecognized abbreviation (shouldn't happen in practice since the value only ever comes from the constrained dropdown, but the function stays defensive); `fillFields` filters out `null`/falsy candidates before matching, so this degrades to matching on the abbreviation alone rather than crashing.
- No matching option found across all candidates → flag, same existing behavior as every other unmatched select field.

## Testing

- `tests/us-states.test.ts` *(new)* — `expandStateAbbreviation('NC')` returns `'North Carolina'`; an unrecognized code returns `null`.
- `tests/fill-engine.test.ts` — two new cases: a stored value of `'NC'` fills a `<select>` whose options are abbreviations (existing single-candidate behavior, still works); the same stored value `'NC'` also fills a `<select>` whose options are full names ("North Carolina") — this is the case that doesn't work today.
- `tests/profile-form.test.ts` — extend the round-trip test's form fixture to use a `<select name="personal.state">` instead of an `<input>`, confirming `serializeProfile`/`populateForm` still work unchanged.

## Out of Scope

- The ARIA combobox interaction mechanism itself (Bug 2's other half) — this spec only fixes matching for native `<select>` elements. The combobox work is a separate, subsequent spec that will reuse `selectOptionByText`'s candidate-list matching logic (or an equivalent) once built.
- US territories (Puerto Rico, Guam, etc.) — only the 50 states + DC are included. Easy to extend the static table later if needed.
- Any change to how `workAuthorization` or other select-backed fields match — those keep passing a single-item candidate list, unaffected.
