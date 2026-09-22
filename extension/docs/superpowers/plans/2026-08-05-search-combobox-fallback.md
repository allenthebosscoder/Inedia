# Search-Combobox Fallback Mechanism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the combobox fill mechanism handle Workday's type-then-Enter search widgets (School, Field of Study, Phone Country Code), not just click-to-open ones (State) — and fix a real misclassification bug where input-based comboboxes were being silently treated as plain text fields.

**Architecture:** `fillComboboxFields` gains a fallback round: if the first click-and-wait attempt finds no options and the trigger is a typeable `<input>`, type the value and press Enter, then wait again using the same polling logic. `generic-adapter.ts`'s field classification is corrected so `aria-haspopup="listbox"` always wins over native input/select/textarea classification. A new `personal.phoneCountryCode` profile field gives the fallback mechanism a real, currently-fillable target to manually verify against, since the other known fields (School, Field of Study) are inside Education, which isn't autofilled at all yet.

**Tech Stack:** TypeScript, Vitest + jsdom (existing project conventions).

## Global Constraints

- No AI/LLM calls or network requests at runtime.
- TypeScript throughout; tested with Vitest in a jsdom environment.
- The type-then-Enter fallback is attempted at most once per field, only when the first click-and-wait attempt finds no options, and only on typeable (`<input>`) triggers — never on `<button>`-style triggers like State.
- Unit tests verify this plan's own logic. They do **not** verify real Workday behavior — the plan ends with a mandatory manual verification step against the new Phone Country Code field, same discipline as every prior plan in this project.
- `personal.phoneCountryCode`'s synonym entry must be positioned before `personal.phone`'s in the `SYNONYMS` map — `lookupFieldKey` returns on first match in iteration order, and `personal.phone`'s `'phone'` synonym would otherwise wrongly match a "Phone Country Code" label (the same ordering requirement `personal.phoneType` already has, for the same reason).

---

### Task 1: Phone country code schema and synonym entry

**Files:**
- Modify: `src/storage/profile-schema.ts`
- Modify: `src/fill-engine/synonym-dictionary.ts`
- Test: `tests/synonym-dictionary.test.ts`

**Interfaces:**
- Produces: `'personal.phoneCountryCode'` added to `ProfileFieldKey` and to `Profile.personal` (typed plain `string`, unlike the union-typed `phoneType`/`workAuthorization` fields — there's no fixed enumeration to validate against), defaulted to `'United States'` in `DEFAULT_PROFILE`. Task 2 depends on this type existing to add the options-page UI for it.

- [ ] **Step 1: Write the failing tests**

Add to `tests/synonym-dictionary.test.ts`, inside the existing `describe('lookupFieldKey', ...)` block:

```ts
  it('matches phone country code phrasing variants', () => {
    expect(lookupFieldKey('Phone Country Code')).toBe('personal.phoneCountryCode');
    expect(lookupFieldKey('Country Code')).toBe('personal.phoneCountryCode');
    expect(lookupFieldKey('Dialing Code')).toBe('personal.phoneCountryCode');
  });

  it('still resolves plain phone labels to personal.phone, not personal.phoneCountryCode', () => {
    expect(lookupFieldKey('Phone')).toBe('personal.phone');
    expect(lookupFieldKey('Phone Number')).toBe('personal.phone');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/synonym-dictionary.test.ts`
Expected: FAIL — the first new test's assertions receive `null` instead of `'personal.phoneCountryCode'`.

- [ ] **Step 3: Add the field to the schema**

In `src/storage/profile-schema.ts`, add `'personal.phoneCountryCode'` to the `ProfileFieldKey` union, right after `'personal.phoneType'`:

```ts
export type ProfileFieldKey =
  | 'personal.firstName'
  | 'personal.lastName'
  | 'personal.fullName'
  | 'personal.email'
  | 'personal.phone'
  | 'personal.address'
  | 'personal.city'
  | 'personal.state'
  | 'personal.zip'
  | 'personal.phoneType'
  | 'personal.phoneCountryCode'
  | 'workAuthorization.authorizedToWork'
  | 'workAuthorization.requiresSponsorship'
  | 'links.linkedin'
  | 'links.portfolio'
  | 'links.github';
```

Add `phoneCountryCode` to the `personal` object in the `Profile` interface:

```ts
  personal: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    address: string;
    city: string;
    state: string;
    zip: string;
    phoneType: 'mobile' | 'home' | 'work' | 'other' | '';
    phoneCountryCode: string;
  };
```

Add the default in `DEFAULT_PROFILE`:

```ts
export const DEFAULT_PROFILE: Profile = {
  version: 1,
  personal: {
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    phoneType: 'mobile',
    phoneCountryCode: 'United States',
  },
  workAuthorization: { authorizedToWork: '', requiresSponsorship: '' },
  links: { linkedin: '', portfolio: '', github: '' },
  workHistory: [],
  education: [],
  overrides: {},
};
```

- [ ] **Step 4: Add the synonym entry, positioned before `personal.phone`**

In `src/fill-engine/synonym-dictionary.ts`, insert `'personal.phoneCountryCode'` into `SYNONYMS` immediately before the existing `'personal.phone'` line:

```ts
const SYNONYMS: Record<ProfileFieldKey, string[]> = {
  'personal.firstName': ['first name', 'given name', 'legal first name'],
  'personal.lastName': ['last name', 'family name', 'surname', 'legal last name'],
  'personal.fullName': ['full name', 'your name', 'legal name'],
  'personal.email': ['email', 'email address'],
  'personal.phoneType': ['phone type', 'phone device type', 'device type'],
  'personal.phoneCountryCode': ['phone country code', 'country code', 'dialing code', 'country calling code'],
  'personal.phone': ['phone', 'phone number', 'mobile number'],
  'personal.address': ['address', 'street address'],
  'personal.city': ['city'],
  'personal.state': ['state', 'state province'],
  'personal.zip': ['zip', 'zip code', 'postal code'],
  'workAuthorization.authorizedToWork': [
    'are you legally authorized to work',
    'authorized to work',
    'work authorization',
    'legally eligible to work',
  ],
  'workAuthorization.requiresSponsorship': [
    'require sponsorship',
    'require visa sponsorship',
    'need sponsorship',
    'visa status',
    'will you now or in the future require sponsorship',
  ],
  'links.linkedin': ['linkedin', 'linkedin url', 'linkedin profile'],
  'links.portfolio': ['portfolio', 'website', 'personal website'],
  'links.github': ['github', 'github url'],
};
```

(`personal.phoneCountryCode` must come before `personal.phone` so a "Phone Country Code" label is checked against the more specific phrase set first — `lookupFieldKey` returns on the first match found while iterating `Object.entries`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/synonym-dictionary.test.ts`
Expected: PASS (all tests in the file, including the 2 new ones)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (all tests, no regressions)

- [ ] **Step 7: Commit**

```bash
git add src/storage/profile-schema.ts src/fill-engine/synonym-dictionary.ts tests/synonym-dictionary.test.ts
git commit -m "feat: add personal.phoneCountryCode field to schema and synonym dictionary"
```

---

### Task 2: Options page UI and profile form wiring

**Files:**
- Modify: `src/options/options.html`
- Modify: `src/options/profile-form.ts`
- Modify: `src/options/profile-lists.ts`
- Test: `tests/profile-form.test.ts`

**Interfaces:**
- Consumes: `'personal.phoneCountryCode'` (Task 1's `ProfileFieldKey`/`Profile` addition).
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Write the failing test**

In `tests/profile-form.test.ts`, add a phone-country-code input to the `FORM_HTML` fixture, right after the `personal.phoneType` select:

```ts
    <input name="personal.phoneCountryCode" />
```

Add a new test in the `describe('serializeProfile', ...)` block:

```ts
  it('reads phoneCountryCode from the form into a Profile', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    (form.elements.namedItem('personal.phoneCountryCode') as HTMLInputElement).value = 'Canada';

    const profile = serializeProfile(form, DEFAULT_PROFILE);

    expect(profile.personal.phoneCountryCode).toBe('Canada');
  });
```

Add a new test in the `describe('populateForm', ...)` block:

```ts
  it('writes phoneCountryCode back into the form', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'Canada' } };

    populateForm(form, profile);

    expect((form.elements.namedItem('personal.phoneCountryCode') as HTMLInputElement).value).toBe('Canada');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/profile-form.test.ts`
Expected: FAIL — `profile.personal.phoneCountryCode` is `undefined`, not `'Canada'` (`serializeProfile` doesn't read it yet); `populateForm` doesn't write it yet either.

- [ ] **Step 3: Wire phoneCountryCode into serializeProfile and populateForm**

In `src/options/profile-form.ts`, add `phoneCountryCode` to the `personal` object `serializeProfile` returns (no type cast needed — unlike `phoneType`, this is a plain `string` field):

```ts
    personal: {
      firstName: get('personal.firstName'),
      lastName: get('personal.lastName'),
      email: get('personal.email'),
      phone: get('personal.phone'),
      phoneType: get('personal.phoneType') as 'mobile' | 'home' | 'work' | 'other' | '',
      phoneCountryCode: get('personal.phoneCountryCode'),
      address: get('personal.address'),
      city: get('personal.city'),
      state: get('personal.state'),
      zip: get('personal.zip'),
    },
```

Add a `setValue` call for it in `populateForm`, alongside the other `personal.*` fields:

```ts
  setValue('personal.phoneCountryCode', profile.personal.phoneCountryCode);
```

- [ ] **Step 4: Add the input to the options page markup**

In `src/options/options.html`, add a phone country code input right after the Phone Type select in the "Personal" fieldset:

```html
        <label>Phone Country Code <input name="personal.phoneCountryCode" /></label>
```

- [ ] **Step 5: Add the field to the overrides dropdown**

In `src/options/profile-lists.ts`, add an entry to `PROFILE_FIELD_KEYS`, near the other `personal.*` entries:

```ts
  { key: 'personal.phoneCountryCode', label: 'Phone Country Code' },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/profile-form.test.ts`
Expected: PASS (all tests in the file, including the 2 new ones)

- [ ] **Step 7: Run the full suite and build**

Run: `npm test`
Expected: PASS (all tests, no regressions)

Run: `npm run build`
Expected: succeeds, no errors

- [ ] **Step 8: Commit**

```bash
git add src/options/options.html src/options/profile-form.ts src/options/profile-lists.ts tests/profile-form.test.ts
git commit -m "feat: add phone country code input to options page and profile form"
```

---

### Task 3: Fix combobox classification precedence

**Files:**
- Modify: `src/fill-engine/generic-adapter.ts`
- Test: `tests/generic-adapter.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no interface change — `extractFields`'s signature and return type are unchanged. This task only changes which `kind` an `aria-haspopup="listbox"` element that's also an `<input>`/`<select>`/`<textarea>` gets classified as.

**Context for this task:** `extractFields` currently runs two independent queries. An element matching both (an `<input>` that also carries `aria-haspopup="listbox"` — this is a real, documented pattern: Workday's search-style combobox fields, e.g. School) gets classified by whichever query's logic reaches it — currently the native-field pass wins, via a dedup check in the combobox pass that skips elements already added. That was the right fix for the double-processing bug it addressed at the time, but it's the wrong precedence for search-style comboboxes: an `<input>` with `aria-haspopup="listbox"` needs the async combobox interaction (click, wait, possibly type-and-Enter, match, click), not a plain synchronous text-set that never presses Enter or interacts with the resulting dropdown at all. This task flips the precedence: `aria-haspopup="listbox"` now always wins.

- [ ] **Step 1: Write the failing test**

In `tests/generic-adapter.test.ts`, replace the existing test:

```ts
  it('does not double-count an input that also has aria-haspopup="listbox"', () => {
    document.body.innerHTML = `<input type="text" aria-label="School" aria-haspopup="listbox" />`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe('text');
  });
```

with:

```ts
  it('classifies an input with aria-haspopup="listbox" as a combobox, not a plain text field', () => {
    document.body.innerHTML = `<input type="text" aria-label="School" aria-haspopup="listbox" />`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe('combobox');
  });
```

(Still exactly one field — this task doesn't reintroduce double-counting, it changes which kind wins.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/generic-adapter.test.ts`
Expected: FAIL — `fields[0].kind` is currently `'text'`.

- [ ] **Step 3: Flip the classification precedence**

In `src/fill-engine/generic-adapter.ts`, replace the `extractFields` function:

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

(The native-field pass now excludes `aria-haspopup="listbox"` elements outright, so the combobox pass's old dedup check — `if (fields.some((field) => field.element === element)) return;` — is removed as no longer reachable.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/generic-adapter.test.ts`
Expected: PASS (all tests in the file, including the updated one)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (all tests, no regressions)

- [ ] **Step 6: Commit**

```bash
git add src/fill-engine/generic-adapter.ts tests/generic-adapter.test.ts
git commit -m "fix: always classify aria-haspopup=listbox elements as combobox, even when also an input"
```

---

### Task 4: Type-then-Enter fallback, plus manual Workday verification

**Files:**
- Modify: `src/fill-engine/combobox-fill.ts`
- Test: `tests/combobox-fill.test.ts`

**Interfaces:**
- Consumes: `setNativeValue` (existing, exported from `fill-engine.ts`, not previously imported by this file); everything else `combobox-fill.ts` already imports.
- Produces: no signature change to `fillComboboxFields` — same parameters, same return type. This task only changes its internal behavior for typeable triggers whose popup is empty after the initial click.

- [ ] **Step 1: Write the failing tests**

Add to `tests/combobox-fill.test.ts`, inside the `describe('fillComboboxFields', ...)` block:

```ts
  it('falls back to typing the value and pressing Enter when the popup is empty after clicking', async () => {
    document.body.innerHTML = `
      <input id="country-trigger" aria-haspopup="listbox" aria-controls="country-listbox" placeholder="Search" />
      <div id="country-listbox"></div>
    `;
    const trigger = document.getElementById('country-trigger') as HTMLInputElement;
    const listbox = document.getElementById('country-listbox')!;
    let typedValue = '';

    trigger.addEventListener('click', () => {
      listbox.innerHTML = '';
    });
    trigger.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        typedValue = trigger.value;
        listbox.innerHTML = '<li role="option" data-value="US">United States</li>';
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
    expect(typedValue).toBe('United States');
  });

  it('does not attempt to type into a non-typeable (button) trigger when the popup is empty', async () => {
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>
      <div id="state-listbox"></div>
    `;
    const trigger = document.getElementById('state-trigger')!;
    const keydownHandler = vi.fn();
    trigger.addEventListener('keydown', keydownHandler);

    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'NC' } };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.state')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 3,
    });

    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect(keydownHandler).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/combobox-fill.test.ts`
Expected: FAIL — the first new test times out with `{ filled: 0, flagged: 1 }` (no fallback exists yet, so the empty popup after clicking just flags). The second new test passes already by accident (there's no fallback code to dispatch a keydown at all yet) — that's fine, it becomes a real regression test once Step 3 lands.

- [ ] **Step 3: Add the type-then-Enter fallback**

In `src/fill-engine/combobox-fill.ts`, update the import line to add `setNativeValue`:

```ts
import { flagField, resolveProfileValue, buildCandidates, findMatchIndex, setNativeValue } from './fill-engine';
```

Add these two helpers, near the existing `closePopup`/`clickWithoutDefault` helpers:

```ts
function isTypeable(element: HTMLElement): element is HTMLInputElement {
  return element instanceof HTMLInputElement;
}

function pressEnter(element: HTMLElement): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}
```

In `fillComboboxFields`, replace this block:

```ts
    const optionElements = await waitForOptions(trigger, pollIntervalMs, maxAttempts);

    if (optionElements.length === 0) {
      closePopup(trigger);
      flagField(trigger);
      flagged++;
      continue;
    }
```

with:

```ts
    let optionElements = await waitForOptions(trigger, pollIntervalMs, maxAttempts);

    if (optionElements.length === 0 && isTypeable(trigger)) {
      setNativeValue(trigger, value);
      pressEnter(trigger);
      optionElements = await waitForOptions(trigger, pollIntervalMs, maxAttempts);
    }

    if (optionElements.length === 0) {
      closePopup(trigger);
      flagField(trigger);
      flagged++;
      continue;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/combobox-fill.test.ts`
Expected: PASS (all tests in the file, including the 2 new ones)

- [ ] **Step 5: Run the full suite a few times to check for timing flakiness**

Run: `npx vitest run tests/combobox-fill.test.ts` (repeat 2-3 times)
Expected: PASS every time, no flakiness

Run: `npm test`
Expected: PASS (all tests, no regressions)

- [ ] **Step 6: Run typecheck and build**

Run: `npx tsc --noEmit`
Expected: no errors

Run: `npm run build`
Expected: succeeds, no errors

- [ ] **Step 7: Commit**

```bash
git add src/fill-engine/combobox-fill.ts tests/combobox-fill.test.ts
git commit -m "feat: add type-then-Enter fallback for search-style combobox widgets"
```

- [ ] **Step 8: Manually verify against real Workday**

Unit tests in this plan verify the plan's own logic, not real Workday behavior — this step is the actual acceptance test, same discipline as every prior plan in this project. Do not skip it:

1. Run `npm run build`.
2. Reload the unpacked extension in `chrome://extensions`.
3. In the extension's Options page, fill in a Phone Country Code value (the default is "United States" — confirm it's there, or set it).
4. Open a real Workday job application that has a Phone Country Code field (or the equivalent search-style field you observed this behavior on).
5. Click "Autofill." Confirm:
   - If the field opens with results immediately, it fills correctly (this exercises the existing click-and-wait path, unaffected by this task).
   - If the field opens empty ("no items" or similar), confirm the extension types the value in and the popup then populates and gets selected correctly.
   - Fields that were already working (State, Phone Device Type, name, email, etc.) still work — no regression.
6. If the real widget's Enter-triggered results don't populate the way `waitForOptions` expects (e.g. a different container structure, or `role="option"` isn't used the same way), capture the real DOM the same way Bug 2's original diagnosis did (inspect element, copy outerHTML) and treat it as a new, scoped follow-up fix rather than guessing at a change here.

---

## Self-Review Notes

- **Spec coverage:** The design's four components (phoneCountryCode field, classification fix, fallback mechanism, manual verification target) map 1:1 to Tasks 1, 3, 4, and the field added in Tasks 1-2 respectively. The spec's explicit point that this isn't two separate widget systems but one mechanism with a fallback is reflected in Task 4 modifying the existing `fillComboboxFields` in place, not adding a parallel function.
- **Type consistency:** `'personal.phoneCountryCode'` and its plain `string` type are used identically across Task 1 (schema, synonym dictionary) and Task 2 (profile-form, options.html, PROFILE_FIELD_KEYS) — no union-type cast needed anywhere, correctly matching the design's choice to keep this field free text rather than a dropdown like `state`.
- **Task 3 and Task 4 are independent of each other** (neither task's code depends on the other), but both are needed together for the fallback to matter on a real input-based combobox — Task 3 makes such elements reach `fillComboboxFields` at all, Task 4 makes `fillComboboxFields` handle them correctly once they do. Order between them doesn't matter; this plan does 3 before 4 for no reason other than incidental ordering.
- **Placeholder scan:** No TBD/TODO. Task 4 Step 8 is deliberately prose instructions (manual QA), matching the pattern established in every prior plan in this project.
