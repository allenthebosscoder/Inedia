# ARIA Combobox Fill Mechanism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extension able to detect and fill Workday-style custom dropdown widgets (a `[aria-haspopup="listbox"]` trigger that opens a popup of `[role="option"]` elements) — closing the remaining half of Bug 2, which affects both the State and Phone Device Type fields.

**Architecture:** `extractFields` gains a second detection pass for ARIA combobox triggers, producing a new `combobox` field kind. A new async module handles just those fields — click, wait for the popup, match, click the match — reusing the exact matching logic already built for state, extracted out of `fill-engine.ts` into shared functions. The orchestrator runs the existing synchronous fill path for everything else, then awaits the new async pass for comboboxes, and sums the two summaries.

**Tech Stack:** TypeScript, Vitest + jsdom (existing project conventions).

## Global Constraints

- No AI/LLM calls or network requests at runtime.
- TypeScript throughout; tested with Vitest in a jsdom environment.
- Comboboxes are processed sequentially, never more than one popup open at a time.
- No profile value for a combobox field → flag without ever clicking the trigger.
- No matching option found, or the popup never renders within the timeout → press Escape and flag, same "don't guess" philosophy as every other unmatched field.
- Unit tests verify this plan's own logic (matching reuse, sequencing, edge cases). They do **not** verify the mechanism works against real Workday — that can only be confirmed by loading the built extension and testing it there, which is why this plan ends with an explicit manual verification task rather than treating the test suite as sufficient proof.

---

### Task 1: Extract shared matching and candidate-building functions

**Files:**
- Modify: `src/fill-engine/fill-engine.ts`
- Test: `tests/fill-engine.test.ts`

**Interfaces:**
- Consumes: `matchesWholeWord`, `normalize` (existing, `synonym-dictionary.ts`); `expandStateAbbreviation` (existing, `us-states.ts`).
- Produces: `findMatchIndex(texts: string[], candidates: string[]): number | null` and `buildCandidates(profileKey: string | null, value: string): string[]`, both newly exported from `fill-engine.ts`, plus `resolveProfileValue(profile: Profile, key: string): string | null` becoming exported (it already exists, currently private). Task 3's combobox-fill module consumes all three.

This is a pure refactor — `selectOptionByText`'s and `fillFields`'s existing behavior must not change. There's no red/green cycle for the extraction itself (the behavior already works and is already tested); the new tests here test the extracted functions directly.

- [ ] **Step 1: Confirm the baseline is green before refactoring**

Run: `npx vitest run tests/fill-engine.test.ts`
Expected: PASS (all existing tests)

- [ ] **Step 2: Extract `findMatchIndex` and `buildCandidates`, refactor `selectOptionByText` and `fillFields` to use them**

Replace the full contents of `src/fill-engine/fill-engine.ts` with:

```ts
import { Profile } from '../storage/profile-schema';
import { matchesWholeWord, normalize } from './synonym-dictionary';
import { expandStateAbbreviation } from './us-states';
import { FieldDescriptor, FillSummary } from './types';

export function setNativeValue(element: HTMLElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

export function flagField(element: HTMLElement): void {
  element.style.outline = '2px solid #f5a623';
  element.dataset.autofillFlag = 'needs-input';
}

export function resolveProfileValue(profile: Profile, key: string): string | null {
  if (key === 'personal.fullName') {
    const fullName = `${profile.personal.firstName} ${profile.personal.lastName}`.trim();
    return fullName.length > 0 ? fullName : null;
  }
  const [section, field] = key.split('.') as [keyof Profile, string];
  const sectionValue = profile[section] as Record<string, unknown>;
  const value = sectionValue?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function buildCandidates(profileKey: string | null, value: string): string[] {
  if (profileKey === 'personal.state') {
    return [value, expandStateAbbreviation(value)].filter((c): c is string => Boolean(c));
  }
  return [value];
}

export function findMatchIndex(texts: string[], candidates: string[]): number | null {
  const normalizedTexts = texts.map(normalize);
  const normalizedCandidates = candidates.map(normalize);

  for (const candidate of normalizedCandidates) {
    const index = normalizedTexts.findIndex((text) => text === candidate);
    if (index !== -1) return index;
  }

  const byLengthDesc = [...normalizedCandidates].sort((a, b) => b.length - a.length);
  for (const candidate of byLengthDesc) {
    const index = normalizedTexts.findIndex((text) => matchesWholeWord(text, candidate));
    if (index !== -1) return index;
  }

  return null;
}

function selectOptionByText(select: HTMLSelectElement, candidates: string[]): boolean {
  const options = Array.from(select.options);
  const optionTexts = options.map((opt) => opt.textContent ?? '');
  const index = findMatchIndex(optionTexts, candidates);
  if (index === null) return false;
  setNativeValue(select, options[index].value);
  return true;
}

export function fillFields(fields: FieldDescriptor[], profile: Profile): FillSummary {
  let filled = 0;
  let flagged = 0;

  for (const field of fields) {
    const value = field.profileKey ? resolveProfileValue(profile, field.profileKey) : null;

    if (value && (field.kind === 'text' || field.kind === 'textarea')) {
      setNativeValue(field.element, value);
      filled++;
    } else if (value && field.kind === 'select') {
      const select = field.element as HTMLSelectElement;
      const candidates = buildCandidates(field.profileKey, value);
      if (selectOptionByText(select, candidates)) {
        filled++;
      } else {
        flagField(field.element);
        flagged++;
      }
    } else {
      flagField(field.element);
      flagged++;
    }
  }

  return { filled, flagged };
}
```

- [ ] **Step 3: Run the existing tests to confirm the refactor changed nothing observable**

Run: `npx vitest run tests/fill-engine.test.ts`
Expected: PASS (all the same tests as Step 1, unchanged)

- [ ] **Step 4: Write tests for the newly-extracted functions**

Add to `tests/fill-engine.test.ts` (new top-level `describe` blocks, alongside the existing ones):

Change the existing import line at the top of the file from:

```ts
import { fillFields, setNativeValue, flagField } from '../src/fill-engine/fill-engine';
```

to:

```ts
import { fillFields, setNativeValue, flagField, findMatchIndex, buildCandidates } from '../src/fill-engine/fill-engine';
```

Then add these new `describe` blocks:

```ts
describe('findMatchIndex', () => {
  it('finds an exact match across multiple candidates', () => {
    expect(findMatchIndex(['Yes', 'No'], ['no'])).toBe(1);
  });

  it('finds a whole-word match, preferring longer candidates first', () => {
    expect(findMatchIndex(['-- Select State or Province --', 'OR - Oregon'], ['or', 'oregon'])).toBe(1);
  });

  it('returns null when nothing matches', () => {
    expect(findMatchIndex(['Yes', 'No'], ['maybe'])).toBeNull();
  });
});

describe('buildCandidates', () => {
  it('expands state abbreviations', () => {
    expect(buildCandidates('personal.state', 'NC')).toEqual(['NC', 'North Carolina']);
  });

  it('returns a single-item list for non-state fields', () => {
    expect(buildCandidates('workAuthorization.authorizedToWork', 'yes')).toEqual(['yes']);
  });
});
```

(Add the `findMatchIndex, buildCandidates` names to the existing `import { ... } from '../src/fill-engine/fill-engine'` line at the top of the file rather than a second import statement, if one already exists.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/fill-engine.test.ts`
Expected: PASS (all tests, including the 5 new ones)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (all tests, no regressions)

- [ ] **Step 7: Commit**

```bash
git add src/fill-engine/fill-engine.ts tests/fill-engine.test.ts
git commit -m "refactor: extract findMatchIndex and buildCandidates for reuse"
```

---

### Task 2: Detect ARIA combobox triggers in the generic adapter

**Files:**
- Modify: `src/fill-engine/types.ts`
- Modify: `src/fill-engine/generic-adapter.ts`
- Test: `tests/generic-adapter.test.ts`

**Interfaces:**
- Consumes: `lookupFieldKey` (existing, `synonym-dictionary.ts`); `isFillable` (existing, private to `generic-adapter.ts` — reused as-is, no changes needed, since it already handles `disabled`/`readOnly`/`hidden`/inline-hidden checks generically for any element, buttons included).
- Produces: `'combobox'` added to the `FieldKind` union (`types.ts`). `extractFields` now also returns `kind: 'combobox'` descriptors for ARIA combobox triggers. Task 3's combobox-fill module and Task 4's orchestrator consume these via the same `FieldDescriptor[]` array `extractFields` already returns — no new return type.

- [ ] **Step 1: Write the failing tests**

Add to `tests/generic-adapter.test.ts`, inside the existing `describe('extractFields', ...)` block (after the last existing test):

```ts
  it('detects an ARIA combobox trigger via aria-haspopup="listbox"', () => {
    document.body.innerHTML = `<button aria-haspopup="listbox" aria-label="State North Carolina Required">North Carolina</button>`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe('combobox');
    expect(fields[0].profileKey).toBe('personal.state');
  });

  it('excludes a disabled combobox trigger', () => {
    document.body.innerHTML = `<button aria-haspopup="listbox" aria-label="State" disabled>--</button>`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(0);
  });

  it('detects a combobox trigger with no recognized label, leaving profileKey null', () => {
    document.body.innerHTML = `<button aria-haspopup="listbox" aria-label="Preferred Pronouns">--</button>`;
    const fields = extractFields(document);
    expect(fields[0].kind).toBe('combobox');
    expect(fields[0].profileKey).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/generic-adapter.test.ts`
Expected: FAIL — `fields` has length 0 for the first two tests (nothing currently queries `[aria-haspopup="listbox"]`), and the third test's `fields[0]` is `undefined`.

- [ ] **Step 3: Add `'combobox'` to `FieldKind`**

In `src/fill-engine/types.ts`, change:

```ts
export type FieldKind = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox';
```

to:

```ts
export type FieldKind = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'combobox';
```

- [ ] **Step 4: Add combobox detection to `extractFields`**

In `src/fill-engine/generic-adapter.ts`, replace the `extractFields` function:

```ts
export function extractFields(root: ParentNode = document): FieldDescriptor[] {
  const elements = root.querySelectorAll('input, select, textarea');
  const fields: FieldDescriptor[] = [];

  elements.forEach((el) => {
    const element = el as HTMLElement;
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

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/generic-adapter.test.ts`
Expected: PASS (all tests in the file, including the 3 new ones)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (all tests, no regressions)

- [ ] **Step 7: Commit**

```bash
git add src/fill-engine/types.ts src/fill-engine/generic-adapter.ts tests/generic-adapter.test.ts
git commit -m "feat: detect ARIA combobox triggers in the generic adapter"
```

---

### Task 3: Async combobox fill module

**Files:**
- Create: `src/fill-engine/combobox-fill.ts`
- Test: `tests/combobox-fill.test.ts`

**Interfaces:**
- Consumes: `flagField`, `resolveProfileValue`, `buildCandidates`, `findMatchIndex` (Task 1, all exported from `fill-engine.ts`); `FieldDescriptor`, `FillSummary` (existing, `types.ts`); `Profile` (existing, `profile-schema.ts`).
- Produces: `fillComboboxFields(fields: FieldDescriptor[], profile: Profile, options?: ComboboxFillOptions): Promise<FillSummary>` and the `ComboboxFillOptions` interface (`{ pollIntervalMs?: number; maxAttempts?: number }`), both exported from `combobox-fill.ts`. Task 4's orchestrator calls `fillComboboxFields` directly.

The `options` parameter exists so tests can use short poll intervals/attempt counts instead of the production defaults (50ms × 20 attempts = up to 1 second) — without it, the timeout and delayed-render tests below would be slow or flaky.

- [ ] **Step 1: Write the failing tests**

`tests/combobox-fill.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { fillComboboxFields } from '../src/fill-engine/combobox-fill';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';
import { FieldDescriptor } from '../src/fill-engine/types';

function makeField(element: HTMLElement, profileKey: FieldDescriptor['profileKey']): FieldDescriptor {
  return { element, label: 'test', kind: 'combobox', profileKey };
}

describe('fillComboboxFields', () => {
  it('fills a combobox by clicking the trigger, then the matching option', async () => {
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>
      <div id="state-listbox"></div>
    `;
    const trigger = document.getElementById('state-trigger')!;
    const listbox = document.getElementById('state-listbox')!;
    const clickedOptions: string[] = [];

    trigger.addEventListener('click', () => {
      listbox.innerHTML = `
        <li role="option" data-value="NC">North Carolina</li>
        <li role="option" data-value="CA">California</li>
      `;
      listbox.querySelectorAll('[role="option"]').forEach((opt) => {
        opt.addEventListener('click', () => clickedOptions.push(opt.getAttribute('data-value') ?? ''));
      });
    });

    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'NC' } };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.state')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(clickedOptions).toEqual(['NC']);
  });

  it('waits for the popup to render asynchronously before matching', async () => {
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>
      <div id="state-listbox"></div>
    `;
    const trigger = document.getElementById('state-trigger')!;
    const listbox = document.getElementById('state-listbox')!;

    trigger.addEventListener('click', () => {
      setTimeout(() => {
        listbox.innerHTML = '<li role="option" data-value="NC">North Carolina</li>';
      }, 15);
    });

    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'NC' } };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.state')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 10,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
  });

  it('flags the field and closes the popup when no option matches', async () => {
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>
      <div id="state-listbox"></div>
    `;
    const trigger = document.getElementById('state-trigger')!;
    const listbox = document.getElementById('state-listbox')!;
    const escapePressed = vi.fn();
    trigger.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') escapePressed();
    });
    trigger.addEventListener('click', () => {
      listbox.innerHTML = '<li role="option" data-value="TX">Texas</li>';
    });

    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'NC' } };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.state')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect(escapePressed).toHaveBeenCalledOnce();
    expect(trigger.dataset.autofillFlag).toBe('needs-input');
  });

  it('flags the field if the popup never renders within the timeout', async () => {
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>
      <div id="state-listbox"></div>
    `;
    const trigger = document.getElementById('state-trigger')!;

    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'NC' } };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.state')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 3,
    });

    expect(summary).toEqual({ filled: 0, flagged: 1 });
  });

  it('flags without clicking when there is no profile value', async () => {
    document.body.innerHTML = `<button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>`;
    const trigger = document.getElementById('state-trigger')!;
    const clickHandler = vi.fn();
    trigger.addEventListener('click', clickHandler);

    const summary = await fillComboboxFields([makeField(trigger, 'personal.state')], DEFAULT_PROFILE);

    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect(clickHandler).not.toHaveBeenCalled();
  });

  it('does not re-click an already-expanded trigger', async () => {
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox" aria-expanded="true" aria-controls="state-listbox">--</button>
      <div id="state-listbox"><li role="option" data-value="NC">North Carolina</li></div>
    `;
    const trigger = document.getElementById('state-trigger')!;
    const clickHandler = vi.fn();
    trigger.addEventListener('click', clickHandler);

    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'NC' } };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.state')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 3,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(clickHandler).not.toHaveBeenCalled();
  });

  it('processes multiple combobox fields sequentially and sums the results', async () => {
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>
      <div id="state-listbox"></div>
      <button id="phone-trigger" aria-haspopup="listbox" aria-controls="phone-listbox">--</button>
      <div id="phone-listbox"></div>
    `;
    const stateTrigger = document.getElementById('state-trigger')!;
    const stateListbox = document.getElementById('state-listbox')!;
    const phoneTrigger = document.getElementById('phone-trigger')!;
    const phoneListbox = document.getElementById('phone-listbox')!;

    stateTrigger.addEventListener('click', () => {
      stateListbox.innerHTML = '<li role="option" data-value="NC">North Carolina</li>';
    });
    phoneTrigger.addEventListener('click', () => {
      phoneListbox.innerHTML = '<li role="option" data-value="m">Mobile</li>';
    });

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, state: 'NC', phoneType: 'mobile' as const },
    };
    const summary = await fillComboboxFields(
      [makeField(stateTrigger, 'personal.state'), makeField(phoneTrigger, 'personal.phoneType')],
      profile,
      { pollIntervalMs: 5, maxAttempts: 5 }
    );

    expect(summary).toEqual({ filled: 2, flagged: 0 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/combobox-fill.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the combobox fill module**

`src/fill-engine/combobox-fill.ts`:
```ts
import { Profile } from '../storage/profile-schema';
import { flagField, resolveProfileValue, buildCandidates, findMatchIndex } from './fill-engine';
import { FieldDescriptor, FillSummary } from './types';

export interface ComboboxFillOptions {
  pollIntervalMs?: number;
  maxAttempts?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_MAX_ATTEMPTS = 20;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOptions(
  controlsId: string,
  pollIntervalMs: number,
  maxAttempts: number
): Promise<HTMLElement[]> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const container = document.getElementById(controlsId);
    const options = container ? Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')) : [];
    if (options.length > 0) return options;
    await wait(pollIntervalMs);
  }
  return [];
}

function closePopup(trigger: HTMLElement): void {
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

export async function fillComboboxFields(
  fields: FieldDescriptor[],
  profile: Profile,
  options: ComboboxFillOptions = {}
): Promise<FillSummary> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let filled = 0;
  let flagged = 0;

  for (const field of fields) {
    const value = field.profileKey ? resolveProfileValue(profile, field.profileKey) : null;

    if (!value) {
      flagField(field.element);
      flagged++;
      continue;
    }

    const trigger = field.element;
    const controlsId = trigger.getAttribute('aria-controls');

    if (!controlsId) {
      flagField(trigger);
      flagged++;
      continue;
    }

    if (trigger.getAttribute('aria-expanded') !== 'true') {
      trigger.click();
    }

    const optionElements = await waitForOptions(controlsId, pollIntervalMs, maxAttempts);

    if (optionElements.length === 0) {
      closePopup(trigger);
      flagField(trigger);
      flagged++;
      continue;
    }

    const candidates = buildCandidates(field.profileKey, value);
    const optionTexts = optionElements.map((opt) => opt.textContent ?? '');
    const matchIndex = findMatchIndex(optionTexts, candidates);

    if (matchIndex === null) {
      closePopup(trigger);
      flagField(trigger);
      flagged++;
      continue;
    }

    optionElements[matchIndex].click();
    filled++;
  }

  return { filled, flagged };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/combobox-fill.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (all tests, no regressions)

- [ ] **Step 6: Commit**

```bash
git add src/fill-engine/combobox-fill.ts tests/combobox-fill.test.ts
git commit -m "feat: add async fill mechanism for ARIA combobox widgets"
```

---

### Task 4: Wire into the orchestrator, and manually verify against real Workday

**Files:**
- Modify: `src/fill-engine/index.ts`
- Test: `tests/fill-orchestrator.test.ts`

**Interfaces:**
- Consumes: `fillComboboxFields` (Task 3); `fillFields` (existing, `fill-engine.ts`); everything else `index.ts` already imports.
- Produces: nothing consumed by a later task — this is the last task in the plan.

- [ ] **Step 1: Write the failing test**

Add to `tests/fill-orchestrator.test.ts`, inside the existing `describe('run', ...)` block (after the last existing test):

```ts
  it('fills an ARIA combobox field alongside ordinary fields', async () => {
    await saveProfile({
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, firstName: 'Jorge', state: 'NC' },
    });
    document.body.innerHTML = `
      <label for="fname">First Name</label>
      <input id="fname" type="text" />
      <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox" aria-label="State">--</button>
      <div id="state-listbox"></div>
    `;
    const trigger = document.getElementById('state-trigger')!;
    const listbox = document.getElementById('state-listbox')!;
    trigger.addEventListener('click', () => {
      listbox.innerHTML = '<li role="option" data-value="NC">North Carolina</li>';
    });

    const summary = await run();

    expect(summary).toEqual({ filled: 2, flagged: 0 });
    expect((document.getElementById('fname') as HTMLInputElement).value).toBe('Jorge');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/fill-orchestrator.test.ts`
Expected: FAIL — `summary` is `{ filled: 1, flagged: 1 }` (the combobox trigger currently falls into `fillFields`'s catch-all `else` branch and gets flagged instead of filled, since `fillFields` doesn't know how to handle `kind: 'combobox'`).

- [ ] **Step 3: Split fields by kind in the orchestrator**

In `src/fill-engine/index.ts`, replace the file's contents:

```ts
import { getProfile } from '../storage/profile-store';
import { pickAdapter } from './site-detector';
import { ADAPTERS } from './adapter-registry';
import { fillFields } from './fill-engine';
import { fillComboboxFields } from './combobox-fill';
import { normalize } from './synonym-dictionary';
import { FillSummary } from './types';

export async function run(): Promise<FillSummary> {
  const profile = await getProfile();
  const adapter = pickAdapter(location.hostname, ADAPTERS);
  const fields = adapter.extractFields(document);

  for (const field of fields) {
    const key = normalize(field.label);
    const overrideKey = Object.hasOwn(profile.overrides, key) ? profile.overrides[key] : undefined;
    if (overrideKey) field.profileKey = overrideKey;
  }

  const comboboxFields = fields.filter((field) => field.kind === 'combobox');
  const otherFields = fields.filter((field) => field.kind !== 'combobox');

  const syncSummary = fillFields(otherFields, profile);
  const comboboxSummary = await fillComboboxFields(comboboxFields, profile);

  return {
    filled: syncSummary.filled + comboboxSummary.filled,
    flagged: syncSummary.flagged + comboboxSummary.flagged,
  };
}

(window as unknown as Record<string, unknown>).__jobAutofillRun = run;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/fill-orchestrator.test.ts`
Expected: PASS (all tests in the file, including the new one)

- [ ] **Step 5: Run the full suite and build**

Run: `npm test`
Expected: PASS (all tests, no regressions)

Run: `npm run build`
Expected: succeeds, no errors

- [ ] **Step 6: Commit**

```bash
git add src/fill-engine/index.ts tests/fill-orchestrator.test.ts
git commit -m "feat: fill ARIA combobox fields alongside native fields in the orchestrator"
```

- [ ] **Step 7: Manually verify against real Workday**

This is the step that actually proves the feature works — the unit tests in Tasks 1-4 verify this plan's own logic, not real Workday behavior (see this plan's Global Constraints). Do not skip it:

1. Run `npm run build`.
2. Reload the unpacked extension in `chrome://extensions`.
3. Open a real Workday job application that has a State field and a Phone Device Type field.
4. Click "Autofill." Confirm:
   - The State field's popup opens and the correct state gets selected (not left blank, not a wrong state).
   - The Phone Device Type field's popup opens and the correct type gets selected.
   - Fields that were already working (name, email, etc.) still work — no regression.
   - The popup summary count in the extension popup matches what's visibly filled/flagged on the page.
5. If a field doesn't fill correctly, inspect its actual DOM in Chrome DevTools (same technique used to originally diagnose Bug 2) — the assumptions this plan is built on (exact `aria-haspopup`/`aria-controls`/`role="option"` structure, and the ~1 second timeout) came from one captured example and may not hold for every Workday field. Capture what's different and treat it as a new, scoped follow-up fix rather than guessing at a change here.

---

## Self-Review Notes

- **Spec coverage:** The design's Architecture (extend detection, extract shared matching, new async pass, orchestrator wiring) maps to Tasks 2, 1, 3, and 4 respectively. The Testing section's explicit split between "verifies our logic" and "does not verify real Workday behavior" is enforced by Task 4 Step 7's mandatory manual verification, not left as an implied afterthought.
- **Type consistency:** `FieldDescriptor`, `FillSummary` (existing) are used identically across all 4 tasks. `findMatchIndex`, `buildCandidates`, `resolveProfileValue` (Task 1) are consumed with matching signatures in Task 3. `ComboboxFillOptions` (Task 3) is used only internally to that module and by its own tests — Task 4's orchestrator calls `fillComboboxFields` without options, correctly relying on production defaults.
- **Placeholder scan:** No TBD/TODO. Task 4 Step 7 is deliberately prose instructions (a manual QA checklist), not code — consistent with how the first plan in this project (`2026-08-04-job-autofill-extension.md`, Task 15) handled its own manual verification step.
- **Sequencing note:** Task 3's `fillComboboxFields` processes fields with a plain `for...of` loop with `await` inside, which is sequential by construction — no separate "not parallel" test is needed beyond the multi-field test already included, which would fail if two fields' option-matching interfered with each other.
