# ARIA Combobox Fill Mechanism — Design

## Context

Manual QA (`docs/QA-FINDINGS.md`, Bug 2) found that Workday's State field — and, confirmed during this session, its Phone Device Type field too — aren't native `<select>` elements. They're custom widgets: a `<button aria-haspopup="listbox" aria-controls="...">` that, when clicked, opens a popup containing `<li role="option">` elements. The extension's field scanner (`extractFields`) only queries `input, select, textarea`, so these fields are completely invisible to it — not detected, not flagged, nothing.

This pattern is a standard WAI-ARIA combobox/listbox convention, not something Workday-specific in how it's exposed, which means a fix built around the ARIA semantics (rather than Workday's specific markup/class names) has a chance of working on any site using the same accessible-widget pattern, not just Workday.

The state-value-matching work already shipped (multi-candidate select matching, abbreviation ↔ full-name expansion) is directly reusable here — this design's job is to get the *interaction* (click, wait, find, click) working, not to reinvent matching.

## Architecture

`extractFields` gains a second detection pass for `[aria-haspopup="listbox"]` elements, producing a new `kind: 'combobox'` field descriptor (these are typically `<button>`s, not covered by the existing input/select/textarea classification). A new async module handles just these fields: click the trigger, wait for its popup (located via `aria-controls`) to render, find the best-matching option among its `[role="option"]` children, and click it.

Two pieces of logic currently inline in `fillFields`'s select branch — the two-tier (exact-then-whole-word, across all candidates) text matcher, and the "build candidate strings for a profile value" logic (including state's abbreviation/full-name expansion) — get extracted into small shared functions, so the new combobox path reuses them exactly rather than reimplementing matching a second time. This is a deliberate small refactor of already-working code, done because the alternative is a second, divergent copy of matching logic that state's fix would then not benefit from here.

The orchestrator (`run()` in `fill-engine/index.ts`) splits extracted fields into combobox vs. everything else. It runs the existing, unmodified synchronous `fillFields` for the rest, then awaits the new async pass for comboboxes, and sums the two `FillSummary` results. The existing synchronous path is not touched beyond the two small extractions above — this keeps the well-tested native-field behavior at essentially zero risk.

## Components

- **`src/fill-engine/types.ts`** — add `'combobox'` to the `FieldKind` union.
- **`src/fill-engine/generic-adapter.ts`** — `extractFields` also queries `[aria-haspopup="listbox"]`, producing `kind: 'combobox'` descriptors. No change needed to label resolution: the captured Workday markup's `aria-label="State North Carolina Required"` already resolves correctly through the existing `aria-label` check and whole-word synonym matching.
- **`src/fill-engine/fill-engine.ts`** — extract `findMatchIndex(texts: string[], candidates: string[]): number | null` (the existing two-tier matcher) and `buildCandidates(profileKey, value): string[]` (the existing state-expansion logic) as exported functions; `selectOptionByText` becomes a thin wrapper using both, behavior unchanged.
- **`src/fill-engine/combobox-fill.ts`** *(new)* — `fillComboboxFields(fields: FieldDescriptor[], profile: Profile): Promise<FillSummary>`. Processes fields **sequentially** (never more than one popup open at a time):
  1. No profile value for the field → flag, don't click, next field.
  2. If not already `aria-expanded="true"`, click the trigger.
  3. Poll for the `aria-controls` target's `[role="option"]` children to appear (bounded: 50ms × 20 attempts = 1s max).
  4. Match option text against candidates via `findMatchIndex`/`buildCandidates`.
  5. Match found → click it, count as filled. No match, or popup never appeared → press Escape (dispatch a keydown), flag, count as flagged.
- **`src/fill-engine/index.ts`** — `run()` partitions extracted fields by `kind === 'combobox'`, calls `fillFields` on the rest, awaits `fillComboboxFields` on the comboboxes, sums the two summaries.

## Data Flow

Detect trigger → no profile value? flag and stop → click to open (skip if already open) → poll for popup content → match → click the match (filled) or Escape + flag (unmatched) → next combobox field, sequentially.

## Error Handling

- No profile value → flagged without ever opening the popup (avoids pointless UI disturbance).
- Popup never renders within the timeout → Escape, flag — same "don't guess" philosophy as every other unmatched field in this codebase.
- No option matches the candidates → Escape, flag.
- Trigger already expanded → skip the click (avoids accidentally toggling it closed).

## Testing

Unit tests cover what's actually verifiable without a real browser: the matching-logic reuse (already proven by existing `selectOptionByText`/state tests), sequencing (comboboxes don't run in parallel; non-combobox fields fill normally alongside them through the orchestrator), and logic edge cases — no profile value skips the click, an already-expanded trigger isn't re-clicked, the bounded polling loop terminates and flags rather than hanging if nothing ever appears.

These tests verify our own logic has no bugs. They do **not** verify the mechanism works against real Workday — popup timing, whether `aria-controls` really points where assumed across different Workday field types, and whether a dispatched click behaves like a real user click against Workday's actual handlers are all unverifiable in jsdom. This is a deliberate, stated limitation, not an oversight: the project's one shipped, fully-broken-on-arrival bug (a wrong file path that 41 passing unit tests never caught) happened precisely because manual browser verification was treated as optional. It isn't here — **manual testing against real Workday (a State field and a Phone Device Type field, confirming both actually get selected) is the actual acceptance test for this feature**, not a nice-to-have last step.

## Out of Scope

- New profile fields for gender, veteran status, disability status, or country — none exist in the `Profile` schema yet. Once this mechanism ships, adding any of those is cheap (a profile field + synonym entry, same shape as the phone-type fix) and needs no combobox-specific work.
- Non-Workday sites using this same ARIA pattern — the detection is written generically (keyed off standard ARIA attributes, not Workday-specific markup), so it may already work elsewhere, but this design is only validated against the one site with confirmed real captured markup.
- The Education/School-style type-then-Enter search widget (a different trigger mechanism from the click-to-open pattern this design covers) — noted in `docs/QA-FINDINGS.md` as related but distinct; a future design.
