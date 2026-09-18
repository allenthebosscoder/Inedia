# Search-Combobox Fallback Mechanism — Design

## Context

Manual QA (`docs/QA-FINDINGS.md`, Bug 2b) found that some Workday dropdown-style fields — School, Field of Study, and a "phone country code" field the user has also seen this behavior on — don't behave like the State field's click-to-open listbox. Clicking them opens a popup that says "no items" until the user types a search term and presses Enter, at which point real results appear.

Further investigation during brainstorming revealed this isn't a genuinely separate widget type requiring its own detection logic — it's the *same* widget, with the type-then-Enter step only needed when the click-only interaction comes up empty. The user has also observed this behavior isn't consistent across different companies' Workday instances, which makes a fallback (try the simple interaction, escalate to typing only if needed) the right design: it adapts to whichever behavior a given instance actually has, rather than requiring us to detect which one applies in advance.

This work also surfaced a real defect in already-shipped code: the fix for double-processing (an element matching both the native-field query and the combobox query) chose to treat such elements as their native kind rather than as a combobox. That was the wrong choice for search-style widgets like School, whose trigger is an `<input>` — it meant School was silently being treated as a plain text box, filled with raw text, and never interacted with as a combobox at all (no Enter press, no option selection). This design corrects that.

Since the concrete fields that use this pattern (School, Field of Study) are both inside Education, which isn't autofilled at all yet (Bug 4, not built), this design also adds a `personal.phoneCountryCode` profile field — independent of Bug 4 — so there's a real, currently-fillable target to manually verify the new mechanism against, rather than shipping it provable only by unit tests.

## Architecture

`fillComboboxFields` (in `src/fill-engine/combobox-fill.ts`) gains a fallback round. After the existing click-and-wait attempt, if no options rendered *and* the trigger element is typeable (an `<input>`), the value gets typed into it (via the existing `setNativeValue` native-setter helper, consistent with how every other field in this codebase sets values on React-controlled inputs), an Enter keydown is dispatched, and the existing polling wait runs again. Both rounds reuse the same `waitForOptions` and matching logic — there is no separate "search combobox" code path, just one additional attempt before giving up.

Separately, `generic-adapter.ts`'s field classification is corrected: the native-field query (`input, select, textarea`) now excludes any element with `aria-haspopup="listbox"`, so such elements are always classified as `combobox` by the second query, never misclassified as plain text. This removes the need for the dedup check that query previously had, since the exclusion now happens upstream instead.

A new `personal.phoneCountryCode` field is added to the profile, following the exact same five-file pattern used for `personal.phoneType`: schema, synonym dictionary, options-page input, profile-form serialization, and the overrides dropdown list. Unlike `personal.state`, this is plain free text, not a dropdown — there's no known fixed enumeration to validate against yet, and international phone/country-code formats vary too much to guess without real captured markup from a search-style widget.

## Components

- **`src/storage/profile-schema.ts`** — add `'personal.phoneCountryCode'` to `ProfileFieldKey`, add `phoneCountryCode: string` to `Profile.personal`, default `'United States'` in `DEFAULT_PROFILE`.
- **`src/fill-engine/synonym-dictionary.ts`** — add a `'personal.phoneCountryCode'` entry with phrases like `'country code'`, `'phone country code'`, `'dialing code'`.
- **`src/options/options.html`** / **`profile-form.ts`** / **`profile-lists.ts`** — a new free-text input and its serialize/populate wiring and overrides-dropdown entry, same shape as every other `personal.*` field.
- **`src/fill-engine/generic-adapter.ts`** — the `input, select, textarea` query gains an exclusion for `[aria-haspopup="listbox"]` elements; the combobox query's dedup check (`fields.some(...)`) is removed since it's no longer reachable.
- **`src/fill-engine/combobox-fill.ts`** — a new `isTypeable(element): element is HTMLInputElement` helper, and the fallback round inserted between the first `waitForOptions` call and the existing "no options → flag" branch: if the first attempt is empty and the trigger is typeable, type the value, dispatch Enter, and call `waitForOptions` a second time before falling through to the existing flag logic.

## Data Flow

Click trigger → wait for options → found? match and click, done (unchanged from today). Empty, and trigger is typeable? Type the value, press Enter, wait again → found? match and click. Still empty, or wasn't typeable to begin with? Escape and flag, unchanged from today. A match-not-found result in either round still falls through to the same existing Escape-and-flag path.

## Error Handling

- No profile value → flag without ever clicking, unchanged.
- Button-style triggers (State) that come back empty still just flag — no typing is attempted on an element that can't be typed into.
- Input-style triggers (School, Phone Country Code) get one additional typing attempt before giving up — never more than one retry round, keeping the interaction bounded and predictable.
- No option matches the candidates, in either round → Escape and flag, reusing the exact existing logic, not duplicated.

## Testing

New unit tests simulate an input-based trigger whose popup only populates after text is typed and Enter is pressed, mirroring the real behavior described during QA. A regression test confirms button-based triggers (State) are unaffected — no typing is attempted on them even when their popup comes back empty, since a `<button>` is not a typeable widget. The classification-fix regression test currently in `generic-adapter.test.ts` (an input with `aria-haspopup="listbox"` asserting `kind: 'text'`) gets its expectation flipped to `kind: 'combobox'`, since that's the specific misclassification this design corrects.

As established by prior work on this project, unit tests verify this design's own logic, not real Workday behavior — the timing of when Workday attaches attributes, whether Enter needs `keydown` alone or also `keyup`, and whether typed text needs to exactly match an option's visible text are all things that can only be confirmed by manually testing the new Phone Country Code field against a real Workday application, which is why that field is included in this design rather than deferred.

## Out of Scope

- School and Field of Study themselves — both are inside Education, which isn't autofilled at all until Bug 4 (work history/education) is built. This design makes the *mechanism* ready for them; wiring Education's repeated entries to actually use it is separate future work.
- Any country-code lookup table or format normalization (unlike State's abbreviation/full-name expansion) — deferred until real captured markup shows what format a search-style widget actually expects.
- Retrying more than once if the second (type + Enter) attempt also comes back empty — a single fallback round is the current scope; if real-world testing shows this insufficient, that's a follow-up informed by evidence, not speculation now.
