# Coding Guidelines

These apply to all code in this project, not just the initial implementation plan. Follow them when extending the extension later (new adapters, the future job tracker, etc.), not just while executing the current plan.

## Clean Code

- **One responsibility per file.** A file that does DOM extraction shouldn't also touch `chrome.storage`. If a file starts doing two unrelated things, split it.
- **Separate pure logic from browser glue.** Anything that touches `document`, `chrome.*`, or the DOM directly should be a thin wrapper around a pure, testable function — not the other way around. This is why `popup-logic.ts` (testable) is separate from `popup.ts` (glue), and why `profile-form.ts` (testable) is separate from `options.ts` (glue). Keep that split for any new UI code.
- **No dead code.** Delete unused exports, commented-out blocks, and functions nothing calls, rather than leaving them "in case."
- **YAGNI.** Don't add configuration, abstraction layers, or flexibility for requirements that don't exist yet. Three concrete similar lines beat one premature abstraction.
- **Comments explain why, not what.** Only write a comment when the code can't explain itself — a non-obvious constraint, a workaround for a specific site's quirk, a deliberate scope cut. Skip comments that just restate the code.
- **Naming stays consistent with existing types.** Reuse `ProfileFieldKey`, `FieldDescriptor`, `FillSummary`, etc. exactly as defined in `src/fill-engine/types.ts` and `src/storage/profile-schema.ts` — don't introduce a parallel name for the same concept.

## TypeScript

- Keep `strict: true`. Don't loosen it to make an error go away — fix the type.
- Avoid `any`. If a type is genuinely unknown (e.g. `chrome.storage` results), narrow it explicitly rather than casting broadly.
- Exported functions get explicit return types — it documents the contract at the call site without needing to open the file.

## Testing Discipline (TDD)

This project follows the same red-green-commit cycle used throughout the implementation plan:

1. Write a failing test that describes the behavior you want.
2. Run it and confirm it fails for the expected reason (not a typo).
3. Write the minimal code to make it pass.
4. Run it and confirm it passes.
5. Commit test and implementation together.

Concretely:

- **Every function with a logic branch gets a test per branch.** An `if/else` with only one path tested is a bug waiting to happen — see how `fillFields` in Task 4 has a dedicated test for the matched-text-field, unmatched-field, matched-select, and matched-radio cases separately.
- **Push logic out until it's testable without a browser.** If you find yourself wanting to mock `chrome.tabs` or `document.querySelector` extensively to test one `if` statement, that logic belongs in a pure function instead (see `popup-logic.ts`, `profile-lists.ts`).
- **DOM-touching code is tested with jsdom fixtures**, not real-browser automation. Build the minimal HTML the function needs via `document.body.innerHTML = ...`, not a full page snapshot, unless you're specifically testing an ATS adapter's field extraction against real captured markup.
- **`chrome.*` APIs are tested via the mock in `tests/chrome-mock.ts`**, not by hand-rolling a new fake per test file. Extend that mock if a new API surface is needed rather than duplicating the pattern.
- **New ATS adapters start conservative.** Add hostname detection + a test for it, delegate extraction to `genericAdapter`, and ship that. Only hand-write site-specific selectors once you've captured a real fixture from that site — never guess at a selector and commit it as if verified.
- **No test skips or `.only` left in committed code.** A skipped or focused test is a silent gap; fix or remove it before committing.

## Commit Hygiene

- One logical change per commit — a test-plus-implementation pair, not a batch of unrelated fixes.
- Commit messages say why the change exists, not just what changed (the diff already shows what).
- Fixes found during manual QA get their own commits, not folded into whichever feature commit happened to be last.

## Pre-Commit Checklist

- [ ] New logic has a test, and the test was watched to fail before the implementation was written.
- [ ] No `TODO`, `TBD`, or commented-out code.
- [ ] No unused exports or dead functions.
- [ ] Naming matches existing types/exports — no parallel names for the same concept.
- [ ] Pure logic is separated from `chrome.*`/DOM glue.
