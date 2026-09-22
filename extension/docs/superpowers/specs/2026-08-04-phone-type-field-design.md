# Phone Type Field — Design

## Context

Manual QA against real job applications (see `docs/QA-FINDINGS.md`, Bug 3) found that Workday and other ATS platforms commonly ask for a "Phone Device Type" dropdown (Mobile / Home / Work / Other) alongside the phone number field. The extension currently has no profile field for this, so it always gets flagged for manual entry rather than filled. This is a straightforward missing-field gap, not a bug in existing matching logic.

The goal is to add phone type as a filled field, following the same pattern already established by `workAuthorization`'s yes/no select fields, rather than introducing new matching logic.

## Architecture

Add `personal.phoneType` as a new `ProfileFieldKey`, stored as `'mobile' | 'home' | 'work' | 'other' | ''` in `Profile.personal`. Unlike `workAuthorization`, which defaults blank since it's legally sensitive and shouldn't be guessed, `phoneType` defaults to `'mobile'` in `DEFAULT_PROFILE` — a sensible default for the common case that saves the user a step, while still being changeable in the options page.

No new matching logic is needed. The fill engine's existing `selectOptionByText` (added during the final-review fix wave) already does exact-normalized-match-then-whole-word-match against a select's visible option text — `normalize('Mobile') === 'mobile'` handles the case-folding for free. `resolveProfileValue` already walks any `section.field` dotted key generically via `key.split('.')`, so `personal.phoneType` needs no special-casing the way `personal.fullName` did (which is a computed field spanning two stored properties, not a real one).

## Components

- **`src/storage/profile-schema.ts`** — add `'personal.phoneType'` to the `ProfileFieldKey` union, add `phoneType: 'mobile' | 'home' | 'work' | 'other' | ''` to the `personal` section of `Profile`, and set `phoneType: 'mobile'` in `DEFAULT_PROFILE`.
- **`src/fill-engine/synonym-dictionary.ts`** — add `'personal.phoneType': ['phone type', 'phone device type', 'device type']` to `SYNONYMS`.
- **`src/options/profile-form.ts`** — `serializeProfile` and `populateForm` read/write `personal.phoneType` the same way they already handle every other `personal.*` field.
- **`src/options/options.html`** — add a `<select name="personal.phoneType">` directly under the existing phone number `<input>`, with options `-- / Mobile / Home / Work / Other` (values `'' / mobile / home / work / other'`).
- **`src/options/profile-lists.ts`** — add `{ key: 'personal.phoneType', label: 'Phone Type' }` to `PROFILE_FIELD_KEYS` so it's selectable in the custom Q&A overrides table too.

## Data Flow

Identical to the existing `workAuthorization` select fields: on the options page, the user picks a value (or leaves the default "Mobile"); `serializeProfile` saves it to `chrome.storage.local` as part of the `Profile`. At fill time, if a page has a select field whose label matches one of the `personal.phoneType` synonyms, `selectOptionByText` looks for an option whose visible text matches `'mobile'`/`'home'`/`'work'`/`'other'` (exact match first, then whole-word) and selects it via the existing native-setter path.

## Error Handling

No new error handling needed — this reuses the existing select-fill path (already covers "no matching option found → flag, don't guess" from the final-review fix wave) and the existing profile-form round-trip (already covers missing/empty fields).

## Testing

- `tests/synonym-dictionary.test.ts` — `lookupFieldKey('Phone Device Type')` and `lookupFieldKey('Phone Type')` resolve to `'personal.phoneType'`.
- `tests/profile-form.test.ts` — extend the round-trip test's form fixture with the new `<select name="personal.phoneType">`, confirm `serializeProfile`/`populateForm` carry it correctly.
- `tests/fill-engine.test.ts` — one case confirming a `FieldDescriptor` with `profileKey: 'personal.phoneType'` and a profile value of `'mobile'` selects the option whose text is "Mobile" (this exercises the existing generic select-matching path, not new logic).

## Out of Scope

- Any change to the select-matching algorithm itself (already fixed during the final-review pass).
- Bugs 1, 2, and 4 from `docs/QA-FINDINGS.md` — each gets its own design pass.
