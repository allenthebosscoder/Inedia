# Moniker Combobox Fill Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the fill engine correctly select an option (instead of just typing free-text) on Workday's non-ARIA "moniker search box" widget, confirmed on the Phone Country Code field (Bug 7 in `docs/QA-FINDINGS.md`).

**Architecture:** Detect the widget via a new query in `generic-adapter.ts` keyed on `data-uxi-widget-type="selectinput"` combined with the *absence* of `aria-haspopup` (which distinguishes it from the already-handled ARIA-pattern School field, which shares that same `data-uxi-widget-type` attribute). Classify matches as the existing `kind: 'combobox'` — no new `FieldKind`. In `combobox-fill.ts`, branch the option-finding step per-field based on the trigger's own attributes at fill time: the existing `aria-controls`-scoped `[role="option"]` lookup for the ARIA path, or a new global `document.querySelectorAll('[data-automation-id="promptOption"]')` lookup for the moniker path (confirmed via live DOM tracing to render as a portal with no containment relationship to the trigger). Every other step — trigger-click-first, type-then-Enter fallback, match-scoring, mousedown+mouseup+click selection, flag-on-no-match, flag-and-clear-on-no-options — is shared unchanged between both paths.

**Tech Stack:** TypeScript, Vitest + jsdom, esbuild (via existing `build.mjs`).

## Global Constraints

- No network requests, no AI/LLM calls — this is a fully local, static-logic fix (from the project's founding constraint).
- Full `npx vitest run` suite must stay green throughout — this project has shipped a Critical bug past passing unit tests before, so every task ends with the full suite run, not just the new test file.
- Manual real-Workday verification only happens after merge to `main` — the loaded unpacked extension always points at `main`, so testing before merge tests stale code (established project rule).

---

### Task 1: Detect the moniker widget in `generic-adapter.ts`

**Files:**
- Modify: `src/fill-engine/generic-adapter.ts:43-71` (the `extractFields` function)
- Test: `tests/generic-adapter.test.ts`

**Interfaces:**
- Consumes: nothing new — uses existing `resolveLabel`, `lookupFieldKey`, `isFillable`, and the existing `FieldDescriptor { element, label, kind, profileKey }` shape from `src/fill-engine/types.ts`.
- Produces: `extractFields` now also returns `FieldDescriptor` entries with `kind: 'combobox'` for `data-uxi-widget-type="selectinput"` inputs that lack `aria-haspopup` — later tasks (`combobox-fill.ts`) rely on being able to distinguish these from ARIA-pattern combobox fields purely by re-reading `trigger.hasAttribute('data-uxi-widget-type')` / `trigger.hasAttribute('aria-haspopup')` on the `element` at fill time (no new field is added to `FieldDescriptor`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/generic-adapter.test.ts`, right after the existing test `'classifies an input with aria-haspopup="listbox" as a combobox, not a plain text field'` (currently ending at line 117, just before the closing `});` of the `describe` block):

```ts
  it('classifies a moniker-search-box input (data-uxi-widget-type=selectinput, no aria-haspopup) as a combobox', () => {
    document.body.innerHTML = `<input type="text" aria-label="Country Phone Code" data-uxi-widget-type="selectinput" data-automation-id="searchBox" />`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe('combobox');
    expect(fields[0].profileKey).toBe('personal.phoneCountryCode');
  });

  it('still classifies a data-uxi-widget-type=selectinput input WITH aria-haspopup as a combobox (the already-handled ARIA path, not double-counted)', () => {
    document.body.innerHTML = `<input type="text" aria-label="School" data-uxi-widget-type="selectinput" aria-haspopup="listbox" />`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe('combobox');
  });

  it('excludes a disabled moniker-search-box input', () => {
    document.body.innerHTML = `<input type="text" aria-label="Country Phone Code" data-uxi-widget-type="selectinput" disabled />`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(0);
  });
```

- [ ] **Step 2: Run tests to verify the first two fail**

Run: `npx vitest run tests/generic-adapter.test.ts`

Expected: The new `'classifies a moniker-search-box input...'` test FAILS — the field is currently found by the native `input, select, textarea` query (since it has no `aria-haspopup` to skip it) and classified via `classifyKind` as `kind: 'text'`, not `'combobox'`. The `'still classifies... WITH aria-haspopup'` test should already PASS (no regression — that's the currently-shipped path). The disabled-field test should already PASS too (existing `isFillable` check already excludes it via the native-query path). Confirm exactly which of the three fails before moving on.

- [ ] **Step 3: Implement the detection query**

In `src/fill-engine/generic-adapter.ts`, update the native-query skip condition and add the new query. Replace:

```ts
export function extractFields(root: ParentNode = document): FieldDescriptor[] {
  const elements = root.querySelectorAll('input, select, textarea');
  const fields: FieldDescriptor[] = [];

  elements.forEach((el) => {
    const element = el as HTMLElement;
    if (element.getAttribute('aria-haspopup') === 'listbox') return;
    const kind = classifyKind(element);
    if (!kind) return;
    if (!isFillable(element)) return;

    const label = resolveLabel(element);
    const profileKey = label ? lookupFieldKey(label) : null;
    fields.push({ element, label, kind, profileKey });
  });

  const comboboxTriggers = root.querySelectorAll('[aria-haspopup="listbox"]');

  comboboxTriggers.forEach((el) => {
    const element = el as HTMLElement;
    if (!isFillable(element)) return;

    const label = resolveLabel(element);
    const profileKey = label ? lookupFieldKey(label) : null;
    fields.push({ element, label, kind: 'combobox', profileKey });
  });

  return fields;
}
```

with:

```ts
export function extractFields(root: ParentNode = document): FieldDescriptor[] {
  const elements = root.querySelectorAll('input, select, textarea');
  const fields: FieldDescriptor[] = [];

  elements.forEach((el) => {
    const element = el as HTMLElement;
    if (element.getAttribute('aria-haspopup') === 'listbox') return;
    if (element.hasAttribute('data-uxi-widget-type')) return;
    const kind = classifyKind(element);
    if (!kind) return;
    if (!isFillable(element)) return;

    const label = resolveLabel(element);
    const profileKey = label ? lookupFieldKey(label) : null;
    fields.push({ element, label, kind, profileKey });
  });

  const comboboxTriggers = root.querySelectorAll(
    '[aria-haspopup="listbox"], input[data-uxi-widget-type="selectinput"]'
  );

  comboboxTriggers.forEach((el) => {
    const element = el as HTMLElement;
    if (!isFillable(element)) return;

    const label = resolveLabel(element);
    const profileKey = label ? lookupFieldKey(label) : null;
    fields.push({ element, label, kind: 'combobox', profileKey });
  });

  return fields;
}
```

Note the skip condition uses the broader `element.hasAttribute('data-uxi-widget-type')` (not scoped to `selectinput`) — this keeps the native-query skip and the combobox-query match in sync without duplicating the `selectinput` string check, and there's no evidence any other `data-uxi-widget-type` value is ever used on a plain fillable input. The combobox query itself is scoped to `input[data-uxi-widget-type="selectinput"]` specifically (not just any element with that attribute), since only inputs are relevant here — Workday buttons never carry this attribute in any captured sample.

- [ ] **Step 4: Run tests to verify all three pass**

Run: `npx vitest run tests/generic-adapter.test.ts`

Expected: All tests in the file PASS, including all three new ones and every pre-existing test (in particular, re-check `'detects an ARIA combobox trigger via aria-haspopup="listbox"'` and `'classifies an input with aria-haspopup="listbox" as a combobox...'` still pass — the combobox query is now a comma-separated selector list, not a replacement).

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`

Expected: All test files pass (127 existing + 3 new = 130 total).

- [ ] **Step 6: Commit**

```bash
git add src/fill-engine/generic-adapter.ts tests/generic-adapter.test.ts
git commit -m "feat: detect Workday's non-ARIA moniker-search-box inputs as combobox fields"
```

---

### Task 2: Add the moniker option-lookup strategy to `combobox-fill.ts`

**Files:**
- Modify: `src/fill-engine/combobox-fill.ts`
- Test: `tests/combobox-fill.test.ts`

**Interfaces:**
- Consumes: `FieldDescriptor` entries with `kind: 'combobox'` from Task 1, where the `element` may now be a `data-uxi-widget-type="selectinput"` input with no `aria-haspopup`. Also consumes existing exports from `./fill-engine`: `flagField`, `resolveProfileValue`, `buildCandidates`, `findMatchIndex`, `setNativeValue`.
- Produces: `fillComboboxFields(fields, profile, options?): Promise<FillSummary>` — same signature as today, now also correctly fills moniker-widget fields instead of silently leaving them as untouched plain text (they won't reach this function until Task 1's classification change ships, but this task's logic must be correct standalone and is tested directly).

- [ ] **Step 1: Write the failing tests**

Add to `tests/combobox-fill.test.ts`, inside the `describe('fillComboboxFields', ...)` block, after the last existing test (currently the `'does not engage the type-then-Enter fallback...'` test ending just before the closing `});` of the describe block):

```ts
  it('fills a moniker-search-box field (data-uxi-widget-type=selectinput, no aria-haspopup) via a globally-queried portal popup', async () => {
    // Reproduces the real Workday Phone Country Code widget: the trigger has no
    // aria-haspopup/role/aria-controls at all, and the results popup renders as a
    // portal elsewhere in the DOM with no containment relationship to the trigger
    // (confirmed via live ancestor-chain tracing — see docs/QA-FINDINGS.md Bug 7).
    document.body.innerHTML = `
      <input id="country-trigger" data-uxi-widget-type="selectinput" placeholder="Search" />
      <div id="unrelated-portal-root"></div>
    `;
    const trigger = document.getElementById('country-trigger') as HTMLInputElement;
    const portalRoot = document.getElementById('unrelated-portal-root')!;

    trigger.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        portalRoot.innerHTML = `
          <div data-automation-id="promptOption" data-automation-label="United States of America (+1)">United States of America (+1)</div>
        `;
      }
    });

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.phoneCountryCode')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
  });

  it('flags a moniker-search-box field when no rendered option matches the typed value', async () => {
    document.body.innerHTML = `
      <input id="country-trigger" data-uxi-widget-type="selectinput" placeholder="Search" />
      <div id="unrelated-portal-root"></div>
    `;
    const trigger = document.getElementById('country-trigger') as HTMLInputElement;
    const portalRoot = document.getElementById('unrelated-portal-root')!;

    trigger.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        portalRoot.innerHTML = `
          <div data-automation-id="promptOption" data-automation-label="Canada (+1)">Canada (+1)</div>
        `;
      }
    });

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.phoneCountryCode')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 0, flagged: 1 });
  });

  it('flags and clears the typed value for a moniker-search-box field when no options ever render', async () => {
    document.body.innerHTML = `<input id="country-trigger" data-uxi-widget-type="selectinput" placeholder="Search" />`;
    const trigger = document.getElementById('country-trigger') as HTMLInputElement;
    // No keydown listener at all: pressing Enter never produces any promptOption elements
    // anywhere in the document, so the fallback's second waitForOptions call also comes back empty.

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.phoneCountryCode')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 3,
    });

    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect(trigger.value).toBe('');
    expect(trigger.dataset.autofillFlag).toBe('needs-input');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/combobox-fill.test.ts`

Expected: The first two new tests FAIL. Current `waitForOptions` only ever looks inside `document.getElementById(trigger.getAttribute('aria-controls'))` for `[role="option"]` — since this trigger has no `aria-controls` at all, `controlsId` is `null`, `container` is `null`, and `optionElements` stays empty even after the `promptOption` div renders in the unrelated portal root. Both fills end up flagged instead of filled. The third test should already PASS (no options ever render, regardless of query strategy — same end state either way). Confirm exactly which two fail.

- [ ] **Step 3: Implement the moniker-widget lookup strategy**

In `src/fill-engine/combobox-fill.ts`, replace the `waitForOptions` function:

```ts
async function waitForOptions(
  trigger: HTMLElement,
  pollIntervalMs: number,
  maxAttempts: number
): Promise<HTMLElement[]> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Re-read aria-controls on every attempt, not just once up front: some widgets (confirmed
    // on real Workday) don't attach it to the trigger until the popup actually mounts, which
    // can happen asynchronously after the click that opens it.
    const controlsId = trigger.getAttribute('aria-controls');
    const container = controlsId ? document.getElementById(controlsId) : null;
    const options = container ? Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')) : [];
    if (options.length > 0) return options;
    await wait(pollIntervalMs);
  }
  return [];
}
```

with:

```ts
// Workday's "moniker search box" widget (confirmed on the Phone Country Code field, see
// docs/QA-FINDINGS.md Bug 7) has none of the ARIA markers the pattern above relies on — no
// aria-haspopup, role, or aria-controls anywhere in its ancestor chain. It shares
// data-uxi-widget-type="selectinput" with the ARIA-pattern School field, so absence of
// aria-haspopup is what distinguishes this variant. Its results popup was traced live and
// confirmed to render as a portal with no containment relationship to the trigger at all, so
// there's no scoped element to query within — a global lookup is the only option. This is safe
// because fields are processed strictly sequentially (see the "processes fields sequentially"
// test below) and each field's popup is closed or superseded before the next one opens; it
// would need revisiting if that processing model ever became parallel.
function isMonikerWidget(trigger: HTMLElement): boolean {
  return trigger.hasAttribute('data-uxi-widget-type') && !trigger.hasAttribute('aria-haspopup');
}

async function waitForOptions(
  trigger: HTMLElement,
  pollIntervalMs: number,
  maxAttempts: number
): Promise<HTMLElement[]> {
  const findOptions = isMonikerWidget(trigger)
    ? () => Array.from(document.querySelectorAll<HTMLElement>('[data-automation-id="promptOption"]'))
    : () => {
        // Re-read aria-controls on every attempt, not just once up front: some widgets
        // (confirmed on real Workday) don't attach it to the trigger until the popup actually
        // mounts, which can happen asynchronously after the click that opens it.
        const controlsId = trigger.getAttribute('aria-controls');
        const container = controlsId ? document.getElementById(controlsId) : null;
        return container ? Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')) : [];
      };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const options = findOptions();
    if (options.length > 0) return options;
    await wait(pollIntervalMs);
  }
  return [];
}
```

No other function in the file needs to change — `fillComboboxFields`'s loop body (trigger-click-first, the two `waitForOptions` calls, the type-then-Enter fallback, `findMatchIndex` matching, `clickWithoutDefault` selection, and both flag paths) already calls `waitForOptions` generically and works unchanged for either widget variant.

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run tests/combobox-fill.test.ts`

Expected: All tests PASS, including all three new ones and every pre-existing test in the file (in particular, re-check the two School-style ARIA fallback tests — `'falls back to typing the value and pressing Enter...'` and `'does not engage the type-then-Enter fallback...'` — still pass, since those triggers have no `data-uxi-widget-type` attribute at all and so `isMonikerWidget` correctly returns `false` for them, keeping them on the unchanged `aria-controls`-scoped path).

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`

Expected: All test files pass (130 from Task 1 + 3 new = 133 total).

- [ ] **Step 6: Build the extension**

Run: `npm run build`

Expected: `Build complete.` with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/fill-engine/combobox-fill.ts tests/combobox-fill.test.ts
git commit -m "feat: fill Workday's non-ARIA moniker-search-box fields via a global portal query"
```

---

### Task 3: Final verification and QA findings update

**Files:**
- Modify: `docs/QA-FINDINGS.md` (Bug 7 section and summary table)

**Interfaces:**
- Consumes: nothing code-level — this task is verification and documentation only.
- Produces: nothing consumed by other tasks — this is the final task in the plan.

- [ ] **Step 1: Run the full test suite one more time**

Run: `npx vitest run`

Expected: All test files pass, 133 total tests, zero failures.

- [ ] **Step 2: Build the extension**

Run: `npm run build`

Expected: `Build complete.` with no errors. Spot-check the built bundle contains the new logic:

Run: `grep -c "promptOption" dist/fill-engine.js`

Expected: A non-zero count.

- [ ] **Step 3: Update `docs/QA-FINDINGS.md`**

In the Bug 7 section (currently ending with its `**Suggested scope:** ...` paragraph, right before the `---` that precedes `## Summary for planning`), add a status line immediately after the heading `## Bug 7: Phone Country Code (and likely other Workday "moniker search box" fields) get filled as plain text, with no selection ever made`:

```markdown
**Status: ✅ Done — shipped 2026-08-05.** Fixed via a new detection query in `generic-adapter.ts` (`data-uxi-widget-type="selectinput"` inputs lacking `aria-haspopup`) and a per-field option-lookup strategy branch in `combobox-fill.ts` (global `[data-automation-id="promptOption"]` query for this widget family, vs. the existing `aria-controls`-scoped `[role="option"]` query for the ARIA pattern). Pending final manual verification on real Workday.
```

Update the summary table row for Bug 7 from:

```markdown
| 7. Phone Country Code (non-ARIA "moniker search box") filled as plain text | Medium-Large — new widget family, no shared detection with Bug 2/2b | Needs its own `data-automation-id`-based detection + fill logic |
```

to:

```markdown
| 7. Phone Country Code (non-ARIA "moniker search box") filled as plain text | — | ✅ Done — shipped 2026-08-05, pending manual verification |
```

- [ ] **Step 4: Commit**

```bash
git add docs/QA-FINDINGS.md
git commit -m "docs: mark Bug 7 done pending manual Workday verification"
```

---

## After this plan lands

Per the project's established rule, the unpacked extension loaded in Chrome always points at `main` — merge this branch to `main` **before** asking for manual verification, not after, or the manual test will silently exercise stale code. Once merged, reload the extension and re-test the Phone Country Code field on the same real Workday application used to find Bug 7, confirming an actual option gets selected (not just typed text left behind) and no flag appears on success.
