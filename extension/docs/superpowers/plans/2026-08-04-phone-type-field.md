# Phone Type Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `personal.phoneType` profile field (Mobile/Home/Work/Other) that the extension can autofill, closing Bug 3 from `docs/QA-FINDINGS.md`.

**Architecture:** Follows the existing `workAuthorization` yes/no select-field pattern exactly — a new `ProfileFieldKey`, a synonym dictionary entry, an options-page `<select>`, and profile-form serialization. No changes to the fill engine's matching logic; `selectOptionByText` and `resolveProfileValue` already handle any dotted `section.field` key generically.

**Tech Stack:** TypeScript, Vitest + jsdom (existing project conventions — no new tooling).

## Global Constraints

- No AI/LLM calls or network requests at runtime.
- Profile data lives only in `chrome.storage.local`.
- TypeScript throughout; tested with Vitest in a jsdom environment.
- `personal.phoneType` synonyms MUST be checked before `personal.phone`'s synonyms in the `SYNONYMS` map — `lookupFieldKey` returns on first match in iteration order, and `personal.phone`'s existing `'phone'` synonym would otherwise wrongly match a "Phone Type" label (word-boundary matching alone doesn't prevent this, since `'phone'` is a real whole word inside "phone type").

---

### Task 1: Schema, synonym dictionary, and fill-engine verification

**Files:**
- Modify: `src/storage/profile-schema.ts`
- Modify: `src/fill-engine/synonym-dictionary.ts`
- Test: `tests/synonym-dictionary.test.ts`
- Test: `tests/fill-engine.test.ts`

**Interfaces:**
- Consumes: `matchesWholeWord`, `normalize` (already exist in `synonym-dictionary.ts`); `fillFields`, `FieldDescriptor` (already exist in `fill-engine.ts`/`types.ts`).
- Produces: `'personal.phoneType'` added to the `ProfileFieldKey` union and to `Profile.personal` (typed `'mobile' | 'home' | 'work' | 'other' | ''`), defaulted to `'mobile'` in `DEFAULT_PROFILE`. Task 2 depends on this type existing to add the options-page UI for it.

- [ ] **Step 1: Write the failing synonym-lookup tests**

Add to `tests/synonym-dictionary.test.ts`, inside the existing `describe('lookupFieldKey', ...)` block (after the `'Full Name'` test):

```ts
  it('matches phone type phrasing variants', () => {
    expect(lookupFieldKey('Phone Type')).toBe('personal.phoneType');
    expect(lookupFieldKey('Phone Device Type')).toBe('personal.phoneType');
    expect(lookupFieldKey('Device Type')).toBe('personal.phoneType');
  });

  it('still resolves plain phone labels to personal.phone, not personal.phoneType', () => {
    expect(lookupFieldKey('Phone')).toBe('personal.phone');
    expect(lookupFieldKey('Phone Number')).toBe('personal.phone');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/synonym-dictionary.test.ts`
Expected: FAIL — the first new test's assertions receive `null` instead of `'personal.phoneType'` (the key doesn't exist in `SYNONYMS` yet).

- [ ] **Step 3: Add the field to the schema**

In `src/storage/profile-schema.ts`, add `'personal.phoneType'` to the `ProfileFieldKey` union, right after `'personal.zip'`:

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
  | 'workAuthorization.authorizedToWork'
  | 'workAuthorization.requiresSponsorship'
  | 'links.linkedin'
  | 'links.portfolio'
  | 'links.github';
```

Add `phoneType` to the `personal` object in the `Profile` interface:

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
  },
  workAuthorization: { authorizedToWork: '', requiresSponsorship: '' },
  links: { linkedin: '', portfolio: '', github: '' },
  workHistory: [],
  education: [],
  overrides: {},
};
```

- [ ] **Step 4: Add the synonym entry, positioned before `personal.phone`**

In `src/fill-engine/synonym-dictionary.ts`, insert `'personal.phoneType'` immediately before the existing `'personal.phone'` line in `SYNONYMS`:

```ts
const SYNONYMS: Record<ProfileFieldKey, string[]> = {
  'personal.firstName': ['first name', 'given name', 'legal first name'],
  'personal.lastName': ['last name', 'family name', 'surname', 'legal last name'],
  'personal.fullName': ['full name', 'your name', 'legal name'],
  'personal.email': ['email', 'email address'],
  'personal.phoneType': ['phone type', 'phone device type', 'device type'],
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

(Object key order matters here: `personal.phoneType` must come before `personal.phone` so a "Phone Type" label is checked against the more specific phrase set first — `lookupFieldKey` returns on the first match found while iterating `Object.entries`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/synonym-dictionary.test.ts`
Expected: PASS (all tests in the file, including the 2 new ones)

- [ ] **Step 6: Add an end-to-end fill-engine verification test**

The fill engine's `fillFields`/`selectOptionByText`/`resolveProfileValue` are already fully generic over any `ProfileFieldKey` — no production code in `fill-engine.ts` needs to change for the new field to be fillable. This step adds a test proving that, not introducing new behavior, so there's no red/green cycle for this one — write it and confirm it passes immediately.

Add to `tests/fill-engine.test.ts`, inside the existing `describe('fillFields', ...)` block (after the `'dispatches both input and change events...'` test):

```ts
  it('fills a phone type select field from personal.phoneType', () => {
    document.body.innerHTML = `
      <select id="phoneType">
        <option value="m">Mobile</option>
        <option value="h">Home</option>
        <option value="w">Work</option>
      </select>
    `;
    const element = document.getElementById('phoneType') as HTMLSelectElement;
    const phoneProfile = { ...profile, personal: { ...profile.personal, phoneType: 'mobile' as const } };
    const summary = fillFields(
      [{ element, label: 'Phone Type', kind: 'select', profileKey: 'personal.phoneType' }],
      phoneProfile
    );
    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(element.value).toBe('m');
  });
```

Run: `npx vitest run tests/fill-engine.test.ts`
Expected: PASS (all tests in the file, including the new one)

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS (all tests, no regressions)

- [ ] **Step 8: Commit**

```bash
git add src/storage/profile-schema.ts src/fill-engine/synonym-dictionary.ts tests/synonym-dictionary.test.ts tests/fill-engine.test.ts
git commit -m "feat: add personal.phoneType field to schema and synonym dictionary"
```

---

### Task 2: Options page UI and profile form wiring

**Files:**
- Modify: `src/options/options.html`
- Modify: `src/options/profile-form.ts`
- Modify: `src/options/profile-lists.ts`
- Test: `tests/profile-form.test.ts`

**Interfaces:**
- Consumes: `'personal.phoneType'` (Task 1's `ProfileFieldKey`/`Profile` addition).
- Produces: nothing new consumed by later tasks — this is the final task in the plan.

- [ ] **Step 1: Write the failing profile-form test**

In `tests/profile-form.test.ts`, add a phone-type `<select>` to the `FORM_HTML` fixture, right after the `personal.phone` input:

```ts
const FORM_HTML = `
  <form id="profile-form">
    <input name="personal.firstName" />
    <input name="personal.lastName" />
    <input name="personal.email" />
    <input name="personal.phone" />
    <select name="personal.phoneType">
      <option value="">--</option>
      <option value="mobile">Mobile</option>
      <option value="home">Home</option>
      <option value="work">Work</option>
      <option value="other">Other</option>
    </select>
    <input name="personal.address" />
    <input name="personal.city" />
    <input name="personal.state" />
    <input name="personal.zip" />
    <select name="workAuthorization.authorizedToWork">
      <option value="">--</option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
    <select name="workAuthorization.requiresSponsorship">
      <option value="">--</option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
    <input name="links.linkedin" />
    <input name="links.portfolio" />
    <input name="links.github" />
  </form>
`;
```

Add a new test in the `describe('serializeProfile', ...)` block:

```ts
  it('reads phoneType from the form into a Profile', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    (form.elements.namedItem('personal.phoneType') as HTMLSelectElement).value = 'work';

    const profile = serializeProfile(form, DEFAULT_PROFILE);

    expect(profile.personal.phoneType).toBe('work');
  });
```

Add a new test in the `describe('populateForm', ...)` block:

```ts
  it('writes phoneType back into the form', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, phoneType: 'home' as const } };

    populateForm(form, profile);

    expect((form.elements.namedItem('personal.phoneType') as HTMLSelectElement).value).toBe('home');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/profile-form.test.ts`
Expected: FAIL — `profile.personal.phoneType` is `undefined`, not `'work'` (serializeProfile doesn't read it yet); `populateForm` doesn't write it yet either.

- [ ] **Step 3: Wire phoneType into serializeProfile and populateForm**

In `src/options/profile-form.ts`, add `phoneType` to the `personal` object `serializeProfile` returns:

```ts
    personal: {
      firstName: get('personal.firstName'),
      lastName: get('personal.lastName'),
      email: get('personal.email'),
      phone: get('personal.phone'),
      address: get('personal.address'),
      city: get('personal.city'),
      state: get('personal.state'),
      zip: get('personal.zip'),
      phoneType: get('personal.phoneType') as 'mobile' | 'home' | 'work' | 'other' | '',
    },
```

Add a `setValue` call for it in `populateForm`, alongside the other `personal.*` fields:

```ts
  setValue('personal.phoneType', profile.personal.phoneType);
```

(Place it anywhere among the other `setValue('personal.*', ...)` calls — order doesn't matter there, unlike the `SYNONYMS` map.)

- [ ] **Step 4: Add the select to the options page markup**

In `src/options/options.html`, add a phone type select right after the phone input in the "Personal" fieldset:

```html
        <label>Phone <input name="personal.phone" /></label>
        <label>Phone Type
          <select name="personal.phoneType">
            <option value="">--</option>
            <option value="mobile">Mobile</option>
            <option value="home">Home</option>
            <option value="work">Work</option>
            <option value="other">Other</option>
          </select>
        </label>
```

- [ ] **Step 5: Add the field to the overrides dropdown**

In `src/options/profile-lists.ts`, add an entry to `PROFILE_FIELD_KEYS` (position doesn't matter for correctness — place it near the other `personal.*` entries for readability):

```ts
  { key: 'personal.phoneType', label: 'Phone Type' },
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
git commit -m "feat: add phone type select to options page and profile form"
```

---

## Self-Review Notes

- **Spec coverage:** The design spec's Components section (schema, synonym dictionary, profile-form, options.html, PROFILE_FIELD_KEYS) maps 1:1 to Task 1 (schema + synonym dictionary) and Task 2 (options.html + profile-form + PROFILE_FIELD_KEYS). The spec's "no new matching logic needed" claim is directly verified by Task 1 Step 6, which adds a test but no fill-engine.ts changes.
- **Ordering requirement:** The critical, easy-to-miss requirement — `personal.phoneType`'s synonyms must be checked before `personal.phone`'s — is called out in Global Constraints, enforced by the exact insertion position specified in Task 1 Step 4, and locked in by the regression test in Task 1 Step 1 (`'Phone'`/`'Phone Number'` must still resolve to `personal.phone`).
- **Type consistency:** `'personal.phoneType'` and the `'mobile' | 'home' | 'work' | 'other' | ''` type are used identically across Task 1 (schema, synonym dictionary, fill-engine test) and Task 2 (profile-form, options.html values, PROFILE_FIELD_KEYS) — same string literals throughout, matching the existing `workAuthorization` field's `'yes' | 'no' | ''` pattern.
- **Placeholder scan:** No TBD/TODO. Task 1 Step 6 explicitly explains why it has no red/green cycle (existing generic code) rather than fabricating a fake failing state.
