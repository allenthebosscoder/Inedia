# State Value Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change `personal.state` from free text to a dropdown storing a US state abbreviation, and teach the fill engine to match that abbreviation against either abbreviation- or full-name-style option text.

**Architecture:** A new static lookup table maps abbreviations to full state names. The fill engine's `selectOptionByText` generalizes from matching one target string to matching a list of candidate strings, trying each in order. Everything else about the fill engine is unchanged.

**Tech Stack:** TypeScript, Vitest + jsdom (existing project conventions).

## Global Constraints

- No AI/LLM calls or network requests at runtime.
- TypeScript throughout; tested with Vitest in a jsdom environment.
- `Profile.personal.state` stays typed as `string`, not a 50-member union — correctness is enforced by the options-page dropdown only offering valid values, matching this codebase's existing preference for simple types where the UI already constrains the value.

---

### Task 1: States lookup table and multi-candidate select matching

**Files:**
- Create: `src/fill-engine/us-states.ts`
- Modify: `src/fill-engine/fill-engine.ts`
- Test: `tests/us-states.test.ts`
- Test: `tests/fill-engine.test.ts`

**Interfaces:**
- Consumes: `matchesWholeWord`, `normalize` (existing, from `synonym-dictionary.ts`).
- Produces: `US_STATES: { abbreviation: string; name: string }[]` and `expandStateAbbreviation(abbreviation: string): string | null` (from `us-states.ts`). `selectOptionByText`'s new signature `(select: HTMLSelectElement, candidates: string[]) => boolean` — Task 2 does not call this directly, but the options-page dropdown Task 2 builds is what supplies the abbreviations this task matches against.

- [ ] **Step 1: Write the failing states-table test**

`tests/us-states.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { US_STATES, expandStateAbbreviation } from '../src/fill-engine/us-states';

describe('expandStateAbbreviation', () => {
  it('expands a known abbreviation to its full name', () => {
    expect(expandStateAbbreviation('NC')).toBe('North Carolina');
    expect(expandStateAbbreviation('CA')).toBe('California');
  });

  it('returns null for an unrecognized abbreviation', () => {
    expect(expandStateAbbreviation('ZZ')).toBeNull();
  });
});

describe('US_STATES', () => {
  it('has 51 entries (50 states + DC)', () => {
    expect(US_STATES).toHaveLength(51);
  });

  it('has no duplicate abbreviations', () => {
    const abbreviations = US_STATES.map((s) => s.abbreviation);
    expect(new Set(abbreviations).size).toBe(abbreviations.length);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/us-states.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the states table**

`src/fill-engine/us-states.ts`:
```ts
export const US_STATES: { abbreviation: string; name: string }[] = [
  { abbreviation: 'AL', name: 'Alabama' },
  { abbreviation: 'AK', name: 'Alaska' },
  { abbreviation: 'AZ', name: 'Arizona' },
  { abbreviation: 'AR', name: 'Arkansas' },
  { abbreviation: 'CA', name: 'California' },
  { abbreviation: 'CO', name: 'Colorado' },
  { abbreviation: 'CT', name: 'Connecticut' },
  { abbreviation: 'DE', name: 'Delaware' },
  { abbreviation: 'FL', name: 'Florida' },
  { abbreviation: 'GA', name: 'Georgia' },
  { abbreviation: 'HI', name: 'Hawaii' },
  { abbreviation: 'ID', name: 'Idaho' },
  { abbreviation: 'IL', name: 'Illinois' },
  { abbreviation: 'IN', name: 'Indiana' },
  { abbreviation: 'IA', name: 'Iowa' },
  { abbreviation: 'KS', name: 'Kansas' },
  { abbreviation: 'KY', name: 'Kentucky' },
  { abbreviation: 'LA', name: 'Louisiana' },
  { abbreviation: 'ME', name: 'Maine' },
  { abbreviation: 'MD', name: 'Maryland' },
  { abbreviation: 'MA', name: 'Massachusetts' },
  { abbreviation: 'MI', name: 'Michigan' },
  { abbreviation: 'MN', name: 'Minnesota' },
  { abbreviation: 'MS', name: 'Mississippi' },
  { abbreviation: 'MO', name: 'Missouri' },
  { abbreviation: 'MT', name: 'Montana' },
  { abbreviation: 'NE', name: 'Nebraska' },
  { abbreviation: 'NV', name: 'Nevada' },
  { abbreviation: 'NH', name: 'New Hampshire' },
  { abbreviation: 'NJ', name: 'New Jersey' },
  { abbreviation: 'NM', name: 'New Mexico' },
  { abbreviation: 'NY', name: 'New York' },
  { abbreviation: 'NC', name: 'North Carolina' },
  { abbreviation: 'ND', name: 'North Dakota' },
  { abbreviation: 'OH', name: 'Ohio' },
  { abbreviation: 'OK', name: 'Oklahoma' },
  { abbreviation: 'OR', name: 'Oregon' },
  { abbreviation: 'PA', name: 'Pennsylvania' },
  { abbreviation: 'RI', name: 'Rhode Island' },
  { abbreviation: 'SC', name: 'South Carolina' },
  { abbreviation: 'SD', name: 'South Dakota' },
  { abbreviation: 'TN', name: 'Tennessee' },
  { abbreviation: 'TX', name: 'Texas' },
  { abbreviation: 'UT', name: 'Utah' },
  { abbreviation: 'VT', name: 'Vermont' },
  { abbreviation: 'VA', name: 'Virginia' },
  { abbreviation: 'WA', name: 'Washington' },
  { abbreviation: 'WV', name: 'West Virginia' },
  { abbreviation: 'WI', name: 'Wisconsin' },
  { abbreviation: 'WY', name: 'Wyoming' },
  { abbreviation: 'DC', name: 'District of Columbia' },
];

export function expandStateAbbreviation(abbreviation: string): string | null {
  const match = US_STATES.find((state) => state.abbreviation === abbreviation);
  return match ? match.name : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/us-states.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/fill-engine/us-states.ts tests/us-states.test.ts
git commit -m "feat: add US states abbreviation/name lookup table"
```

- [ ] **Step 6: Write the failing fill-engine tests**

Add to `tests/fill-engine.test.ts`, inside the existing `describe('fillFields', ...)` block (after the `'fills a phone type select field...'` test):

```ts
  it('fills a state select whose options are abbreviations', () => {
    document.body.innerHTML = `
      <select id="state">
        <option value="NC">NC</option>
        <option value="CA">CA</option>
      </select>
    `;
    const element = document.getElementById('state') as HTMLSelectElement;
    const stateProfile = { ...profile, personal: { ...profile.personal, state: 'NC' } };
    const summary = fillFields(
      [{ element, label: 'State', kind: 'select', profileKey: 'personal.state' }],
      stateProfile
    );
    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(element.value).toBe('NC');
  });

  it('fills a state select whose options are full names, from a stored abbreviation', () => {
    document.body.innerHTML = `
      <select id="state">
        <option value="1">North Carolina</option>
        <option value="2">California</option>
      </select>
    `;
    const element = document.getElementById('state') as HTMLSelectElement;
    const stateProfile = { ...profile, personal: { ...profile.personal, state: 'NC' } };
    const summary = fillFields(
      [{ element, label: 'State', kind: 'select', profileKey: 'personal.state' }],
      stateProfile
    );
    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(element.value).toBe('1');
  });
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `npx vitest run tests/fill-engine.test.ts`
Expected: FAIL — the second new test fails because `selectOptionByText` currently only matches `'NC'` literally against option text, and no option's text is `'NC'` in that fixture.

- [ ] **Step 8: Generalize `selectOptionByText` to accept multiple candidates**

In `src/fill-engine/fill-engine.ts`, replace the `selectOptionByText` function:

```ts
function selectOptionByText(select: HTMLSelectElement, candidates: string[]): boolean {
  const normalizedCandidates = candidates.map(normalize);
  const options = Array.from(select.options);

  for (const candidate of normalizedCandidates) {
    const match = options.find((opt) => normalize(opt.textContent ?? '') === candidate);
    if (match) {
      setNativeValue(select, match.value);
      return true;
    }
  }

  for (const candidate of normalizedCandidates) {
    const match = options.find((opt) => matchesWholeWord(normalize(opt.textContent ?? ''), candidate));
    if (match) {
      setNativeValue(select, match.value);
      return true;
    }
  }

  return false;
}
```

Add the import at the top of the file:

```ts
import { expandStateAbbreviation } from './us-states';
```

Update the `select` branch in `fillFields` to build a candidate list, expanding state abbreviations specifically:

```ts
    } else if (value && field.kind === 'select') {
      const select = field.element as HTMLSelectElement;
      const candidates =
        field.profileKey === 'personal.state'
          ? [value, expandStateAbbreviation(value)].filter((c): c is string => Boolean(c))
          : [value];
      if (selectOptionByText(select, candidates)) {
        filled++;
      } else {
        flagField(field.element);
        flagged++;
      }
    } else {
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run tests/fill-engine.test.ts`
Expected: PASS (all tests in the file, including the 2 new ones)

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: PASS (all tests, no regressions)

- [ ] **Step 11: Commit**

```bash
git add src/fill-engine/fill-engine.ts tests/fill-engine.test.ts
git commit -m "feat: match select options against multiple candidates, expanding state abbreviations"
```

---

### Task 2: Options page State dropdown

**Files:**
- Modify: `src/options/options.html`
- Test: `tests/profile-form.test.ts`

**Interfaces:**
- Consumes: nothing new — `serializeProfile`/`populateForm` in `profile-form.ts` already handle `<select>` elements the same as `<input>` elements, no code change needed there.
- Produces: nothing consumed by a later task — this is the last task in the plan.

- [ ] **Step 1: Write the failing test**

In `tests/profile-form.test.ts`, replace the `<input name="personal.state" />` line inside `FORM_HTML` with a `<select>`:

```ts
    <select name="personal.state">
      <option value="">--</option>
      <option value="NC">North Carolina</option>
      <option value="CA">California</option>
    </select>
```

Add a new test in the `describe('serializeProfile', ...)` block:

```ts
  it('reads state from the form into a Profile', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    (form.elements.namedItem('personal.state') as HTMLSelectElement).value = 'NC';

    const profile = serializeProfile(form, DEFAULT_PROFILE);

    expect(profile.personal.state).toBe('NC');
  });
```

Add a new test in the `describe('populateForm', ...)` block:

```ts
  it('writes state back into the form', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'CA' } };

    populateForm(form, profile);

    expect((form.elements.namedItem('personal.state') as HTMLSelectElement).value).toBe('CA');
  });
```

- [ ] **Step 2: Run the tests to confirm they pass against the updated fixture**

Run: `npx vitest run tests/profile-form.test.ts`
Expected: PASS (all tests, including the 2 new ones). This step has no genuine red/green cycle — `serializeProfile`/`populateForm` are already element-agnostic (per this task's Interfaces block), so the new tests pass as soon as the fixture itself has a `<select>` in it, with no production code change. What's still missing is the real `options.html` file, which Step 3 provides — these tests only prove the *pattern* works, not that the real page was updated.

- [ ] **Step 3: Replace the State input with a dropdown in the real options page**

In `src/options/options.html`, replace this line:

```html
        <label>State <input name="personal.state" /></label>
```

with a `<select>` listing every entry from `US_STATES` (Task 1), option `value` set to the abbreviation, visible text set to the full name, plus a `--` placeholder first. Generate the 51 `<option>` lines from the exact same data as `src/fill-engine/us-states.ts` so the two never drift apart — copy each `{ abbreviation, name }` pair from that file's `US_STATES` array into `<option value="{abbreviation}">{name}</option>` form, in the same order, wrapped like this:

```html
        <label>State
          <select name="personal.state">
            <option value="">--</option>
            <!-- one <option value="{abbreviation}">{name}</option> per US_STATES entry from src/fill-engine/us-states.ts, same order -->
          </select>
        </label>
```

- [ ] **Step 4: Run the full suite and build**

Run: `npm test`
Expected: PASS (all tests, no regressions)

Run: `npm run build`
Expected: succeeds, no errors

- [ ] **Step 5: Commit**

```bash
git add src/options/options.html tests/profile-form.test.ts
git commit -m "feat: change state field to a dropdown of US states"
```

---

## Self-Review Notes

- **Spec coverage:** The design's Components section (us-states.ts, fill-engine.ts's selectOptionByText, options.html, no profile-form.ts change) maps 1:1 to Task 1 (lookup table + matching) and Task 2 (dropdown markup). The spec's claim that `profile-form.ts` needs no changes is verified directly, not just asserted — Task 2 has no step touching that file.
- **Type consistency:** `US_STATES: { abbreviation: string; name: string }[]` and `expandStateAbbreviation` are defined once in Task 1 and used identically wherever referenced. `selectOptionByText`'s new `candidates: string[]` parameter is used consistently in its own implementation and in `fillFields`'s call site, both in Task 1.
- **Placeholder scan:** Task 2 Step 3's HTML uses a comment (`<!-- one <option>... -->`) instead of listing all 51 states inline a third time, since the exact same 51 entries are already fully spelled out in Task 1's `us-states.ts` (real, already-committed code by the time Task 2 runs) and the transform is a mechanical 1:1 copy with no ambiguity — this is a deliberate exception to fully spelling out every line, not a vague "figure it out" placeholder; an implementer has an exact, unambiguous source of truth to copy from.

