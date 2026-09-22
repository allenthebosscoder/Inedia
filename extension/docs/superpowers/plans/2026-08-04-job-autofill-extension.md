# Job Application Autofill Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome extension that autofills known job-application form fields from a locally stored profile, with no AI/LLM calls and no background scanning.

**Architecture:** Manifest V3 extension with no persistent background service worker. The popup injects a bundled "fill script" on demand (via `chrome.scripting.executeScript`) only when the user clicks "Autofill." The fill script uses an adapter registry (per-ATS adapters + a generic DOM-based fallback matcher) to find fields, resolve them against the stored Profile via a synonym dictionary, fill what it can, and visually flag anything it can't (essays, unmatched fields, radio groups).

**Tech Stack:** TypeScript, esbuild (bundling), Vitest + jsdom (testing), `chrome.storage.local` (persistence), no frameworks, no runtime dependencies.

## Global Constraints

- Chrome only, Manifest V3 — no Firefox/Edge support in v1.
- No AI/LLM calls or network requests at runtime — all matching logic is local and deterministic.
- Profile data lives only in `chrome.storage.local` — no backend, no sync service.
- Autofill runs only when the user manually clicks the popup's "Autofill" button — no content script runs automatically on page load.
- v1 ships exactly 4 ATS adapters — Greenhouse, Lever, Workday, LinkedIn Easy Apply — plus a generic fallback for every other site.
- TypeScript throughout; bundled with esbuild; tested with Vitest in a jsdom environment.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `manifest.json`, `build.mjs`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a working `npm test` and `npm run build` toolchain that every later task builds on. Later tasks assume `src/` and `tests/` exist and `npx vitest run` works.

- [ ] **Step 1: Initialize the npm project and install dependencies**

Run:
```bash
npm init -y
npm install -D typescript vitest jsdom esbuild @types/chrome
```

- [ ] **Step 1b: Overwrite `package.json` with the project's scripts**

`npm init -y` writes defaults (no `build`/`test` scripts, `"main": "index.js"`, etc.) — replace its content entirely, keeping whatever dependency versions `npm install` resolved in `devDependencies`:

```json
{
  "name": "job-autofill-extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node build.mjs",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/chrome": "<version npm installed>",
    "esbuild": "<version npm installed>",
    "jsdom": "<version npm installed>",
    "typescript": "<version npm installed>",
    "vitest": "<version npm installed>"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "lib": ["ES2020", "DOM"],
    "types": ["chrome"],
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
  },
});
```

- [ ] **Step 4: Write `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Job Autofill",
  "version": "0.1.0",
  "description": "Fast, local autofill for job applications. No AI, no tracking.",
  "action": {
    "default_popup": "dist/popup.html"
  },
  "options_page": "dist/options.html",
  "permissions": ["storage", "activeTab", "scripting"],
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

Add placeholder icon files at `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` (any solid-color square PNG at those sizes — this is an asset creation step, not something to script).

- [ ] **Step 5: Write `build.mjs`**

```js
import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await esbuild.build({
  entryPoints: {
    popup: 'src/popup/popup.ts',
    options: 'src/options/options.ts',
    'fill-engine': 'src/fill-engine/index.ts',
  },
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  target: 'chrome110',
});

copyFileSync('src/popup/popup.html', 'dist/popup.html');
copyFileSync('src/options/options.html', 'dist/options.html');

console.log('Build complete.');
```

This references `src/` files that don't exist until later tasks — that's expected, `npm run build` isn't runnable until Task 14.

- [ ] **Step 6: Write a toolchain smoke test**

`tests/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 7: Run the test suite to verify the toolchain works**

Run: `npm test`
Expected: PASS (1 test) — this confirms the `package.json` `test` script from Step 1b works, not just `npx vitest` directly.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts manifest.json build.mjs icons tests/smoke.test.ts
git commit -m "chore: scaffold extension project"
```

---

### Task 2: Profile schema and storage layer

**Files:**
- Create: `src/storage/profile-schema.ts`
- Create: `src/storage/profile-store.ts`
- Create: `tests/chrome-mock.ts`
- Test: `tests/profile-store.test.ts`

**Interfaces:**
- Consumes: nothing beyond Task 1's toolchain.
- Produces: `Profile`, `ProfileFieldKey`, `DEFAULT_PROFILE` (from `profile-schema.ts`), `getProfile(): Promise<Profile>` and `saveProfile(profile: Profile): Promise<void>` (from `profile-store.ts`). Every later task that reads or writes profile data uses these exact exports. `tests/chrome-mock.ts` exports `installChromeStorageMock()`, reused by every later test that touches storage.

- [ ] **Step 1: Write the profile schema**

`src/storage/profile-schema.ts`:
```ts
export interface WorkHistoryEntry {
  company: string;
  title: string;
  startDate: string;
  endDate: string;
  description: string;
}

export interface EducationEntry {
  school: string;
  degree: string;
  fieldOfStudy: string;
  graduationDate: string;
}

export type ProfileFieldKey =
  | 'personal.firstName'
  | 'personal.lastName'
  | 'personal.email'
  | 'personal.phone'
  | 'personal.address'
  | 'personal.city'
  | 'personal.state'
  | 'personal.zip'
  | 'workAuthorization.authorizedToWork'
  | 'workAuthorization.requiresSponsorship'
  | 'links.linkedin'
  | 'links.portfolio'
  | 'links.github';

export interface Profile {
  version: 1;
  personal: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    address: string;
    city: string;
    state: string;
    zip: string;
  };
  workAuthorization: {
    authorizedToWork: 'yes' | 'no' | '';
    requiresSponsorship: 'yes' | 'no' | '';
  };
  links: {
    linkedin: string;
    portfolio: string;
    github: string;
  };
  workHistory: WorkHistoryEntry[];
  education: EducationEntry[];
  overrides: Record<string, ProfileFieldKey>;
}

export const DEFAULT_PROFILE: Profile = {
  version: 1,
  personal: { firstName: '', lastName: '', email: '', phone: '', address: '', city: '', state: '', zip: '' },
  workAuthorization: { authorizedToWork: '', requiresSponsorship: '' },
  links: { linkedin: '', portfolio: '', github: '' },
  workHistory: [],
  education: [],
  overrides: {},
};
```

- [ ] **Step 2: Write the chrome.storage mock helper**

`tests/chrome-mock.ts`:
```ts
export function installChromeStorageMock(): void {
  const store: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: (key: string) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
        set: (items: Record<string, unknown>) => {
          Object.assign(store, items);
          return Promise.resolve();
        },
      },
    },
  };
}
```

- [ ] **Step 3: Write the failing test for the storage layer**

`tests/profile-store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeStorageMock } from './chrome-mock';
import { getProfile, saveProfile } from '../src/storage/profile-store';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';

describe('profile-store', () => {
  beforeEach(() => {
    installChromeStorageMock();
  });

  it('returns the default profile when nothing is stored', async () => {
    const profile = await getProfile();
    expect(profile).toEqual(DEFAULT_PROFILE);
  });

  it('round-trips a saved profile', async () => {
    const custom = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Jorge' } };
    await saveProfile(custom);
    const profile = await getProfile();
    expect(profile.personal.firstName).toBe('Jorge');
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/profile-store.test.ts`
Expected: FAIL (`profile-store` module not found)

- [ ] **Step 5: Implement the storage layer**

`src/storage/profile-store.ts`:
```ts
import { DEFAULT_PROFILE, Profile } from './profile-schema';

const STORAGE_KEY = 'profile';

export async function getProfile(): Promise<Profile> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as Profile) ?? DEFAULT_PROFILE;
}

export async function saveProfile(profile: Profile): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: profile });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/profile-store.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add src/storage tests/chrome-mock.ts tests/profile-store.test.ts
git commit -m "feat: add profile schema and chrome.storage-backed storage layer"
```

---

### Task 3: Synonym dictionary and label normalizer

**Files:**
- Create: `src/fill-engine/synonym-dictionary.ts`
- Test: `tests/synonym-dictionary.test.ts`

**Interfaces:**
- Consumes: `ProfileFieldKey` (from Task 2's `profile-schema.ts`).
- Produces: `normalize(text: string): string` and `lookupFieldKey(labelText: string): ProfileFieldKey | null`. Used by the generic adapter (Task 5), the fill orchestrator (Task 11), and the options page overrides table (Task 14).

- [ ] **Step 1: Write the failing tests**

`tests/synonym-dictionary.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { lookupFieldKey, normalize } from '../src/fill-engine/synonym-dictionary';

describe('normalize', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalize('Are you legally authorized to work in the US?')).toBe(
      'are you legally authorized to work in the us'
    );
  });
});

describe('lookupFieldKey', () => {
  it('matches visa sponsorship phrasing variants', () => {
    expect(lookupFieldKey('Will you now or in the future require visa sponsorship?')).toBe(
      'workAuthorization.requiresSponsorship'
    );
    expect(lookupFieldKey('Do you require sponsorship to work in this country?')).toBe(
      'workAuthorization.requiresSponsorship'
    );
  });

  it('matches first name variants', () => {
    expect(lookupFieldKey('Legal First Name')).toBe('personal.firstName');
  });

  it('returns null for unrecognized text', () => {
    expect(lookupFieldKey('Why do you want to work here?')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/synonym-dictionary.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the dictionary**

`src/fill-engine/synonym-dictionary.ts`:
```ts
import { ProfileFieldKey } from '../storage/profile-schema';

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SYNONYMS: Record<ProfileFieldKey, string[]> = {
  'personal.firstName': ['first name', 'given name', 'legal first name'],
  'personal.lastName': ['last name', 'family name', 'surname', 'legal last name'],
  'personal.email': ['email', 'email address'],
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

export function lookupFieldKey(labelText: string): ProfileFieldKey | null {
  const normalized = normalize(labelText);
  for (const [key, phrases] of Object.entries(SYNONYMS) as [ProfileFieldKey, string[]][]) {
    if (phrases.some((phrase) => normalized.includes(phrase))) {
      return key;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/synonym-dictionary.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/fill-engine/synonym-dictionary.ts tests/synonym-dictionary.test.ts
git commit -m "feat: add label normalizer and synonym dictionary"
```

---

### Task 4: Fill engine core

**Files:**
- Create: `src/fill-engine/types.ts`
- Create: `src/fill-engine/fill-engine.ts`
- Test: `tests/fill-engine.test.ts`

**Interfaces:**
- Consumes: `Profile` (Task 2), `normalize` (Task 3).
- Produces: `FieldKind`, `FieldDescriptor`, `Adapter`, `FillSummary` (types, from `types.ts`); `setNativeValue(element: HTMLElement, value: string): void`, `flagField(element: HTMLElement): void`, `fillFields(fields: FieldDescriptor[], profile: Profile): FillSummary` (from `fill-engine.ts`). Every adapter (Tasks 5, 7–10) implements the `Adapter` interface and produces `FieldDescriptor[]`; the orchestrator (Task 11) calls `fillFields`.

- [ ] **Step 1: Write the shared types**

`src/fill-engine/types.ts`:
```ts
import { ProfileFieldKey } from '../storage/profile-schema';

export type FieldKind = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox';

export interface FieldDescriptor {
  element: HTMLElement;
  label: string;
  kind: FieldKind;
  profileKey: ProfileFieldKey | null;
}

export interface Adapter {
  id: string;
  matchesHostname(hostname: string): boolean;
  extractFields(root: ParentNode): FieldDescriptor[];
}

export interface FillSummary {
  filled: number;
  flagged: number;
}
```

- [ ] **Step 2: Write the failing tests**

`tests/fill-engine.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { fillFields, setNativeValue, flagField } from '../src/fill-engine/fill-engine';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';

describe('setNativeValue', () => {
  it('sets the value and dispatches an input event', () => {
    document.body.innerHTML = '<input type="text" />';
    const input = document.querySelector('input')!;
    const inputHandler = vi.fn();
    input.addEventListener('input', inputHandler);

    setNativeValue(input, 'hello');

    expect(input.value).toBe('hello');
    expect(inputHandler).toHaveBeenCalledOnce();
  });
});

describe('flagField', () => {
  it('outlines the element and marks it as needing input', () => {
    document.body.innerHTML = '<input type="text" />';
    const input = document.querySelector('input')!;
    flagField(input);
    expect(input.style.outline).toBe('2px solid #f5a623');
    expect(input.dataset.autofillFlag).toBe('needs-input');
  });
});

describe('fillFields', () => {
  const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Jorge' } };

  it('fills a matched text field', () => {
    document.body.innerHTML = '<input type="text" id="fname" />';
    const element = document.getElementById('fname')!;
    const summary = fillFields(
      [{ element, label: 'First Name', kind: 'text', profileKey: 'personal.firstName' }],
      profile
    );
    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect((element as HTMLInputElement).value).toBe('Jorge');
  });

  it('flags a field with no profile match', () => {
    document.body.innerHTML = '<textarea id="essay"></textarea>';
    const element = document.getElementById('essay')!;
    const summary = fillFields([{ element, label: 'Why us?', kind: 'textarea', profileKey: null }], profile);
    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect(element.dataset.autofillFlag).toBe('needs-input');
  });

  it('selects a matching option by visible text', () => {
    document.body.innerHTML = `
      <select id="auth">
        <option value="1">Yes</option>
        <option value="2">No</option>
      </select>
    `;
    const element = document.getElementById('auth') as HTMLSelectElement;
    const authProfile = {
      ...profile,
      workAuthorization: { authorizedToWork: 'yes' as const, requiresSponsorship: '' as const },
    };
    const summary = fillFields(
      [{ element, label: 'Authorized to work?', kind: 'select', profileKey: 'workAuthorization.authorizedToWork' }],
      authProfile
    );
    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(element.value).toBe('1');
  });

  it('flags radio and checkbox fields rather than guessing which input to click', () => {
    document.body.innerHTML = '<input type="radio" id="yes" name="auth" />';
    const element = document.getElementById('yes')!;
    const authProfile = {
      ...profile,
      workAuthorization: { authorizedToWork: 'yes' as const, requiresSponsorship: '' as const },
    };
    const summary = fillFields(
      [{ element, label: 'Authorized to work?', kind: 'radio', profileKey: 'workAuthorization.authorizedToWork' }],
      authProfile
    );
    expect(summary).toEqual({ filled: 0, flagged: 1 });
  });
});
```

Radio-group filling is intentionally out of scope for v1 — matching the right input within a same-`name` group by its associated label text is a separate, more involved problem. Radio fields are always flagged for manual review, same as essays.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/fill-engine.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 4: Implement the fill engine**

`src/fill-engine/fill-engine.ts`:
```ts
import { Profile } from '../storage/profile-schema';
import { normalize } from './synonym-dictionary';
import { FieldDescriptor, FillSummary } from './types';

export function setNativeValue(element: HTMLElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

export function flagField(element: HTMLElement): void {
  element.style.outline = '2px solid #f5a623';
  element.dataset.autofillFlag = 'needs-input';
}

function resolveProfileValue(profile: Profile, key: string): string | null {
  const [section, field] = key.split('.') as [keyof Profile, string];
  const sectionValue = profile[section] as Record<string, unknown>;
  const value = sectionValue?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function selectOptionByText(select: HTMLSelectElement, targetText: string): boolean {
  const target = normalize(targetText);
  const option = Array.from(select.options).find((opt) => normalize(opt.textContent ?? '').includes(target));
  if (!option) return false;
  select.value = option.value;
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
      if (selectOptionByText(select, value)) {
        select.dispatchEvent(new Event('change', { bubbles: true }));
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

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/fill-engine.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/fill-engine/types.ts src/fill-engine/fill-engine.ts tests/fill-engine.test.ts
git commit -m "feat: add fill engine core (value setting, option matching, flagging)"
```

---

### Task 5: Generic adapter

**Files:**
- Create: `src/fill-engine/generic-adapter.ts`
- Test: `tests/generic-adapter.test.ts`

**Interfaces:**
- Consumes: `lookupFieldKey` (Task 3), `FieldDescriptor`, `FieldKind` (Task 4).
- Produces: `extractFields(root?: ParentNode): FieldDescriptor[]` and `genericAdapter: Adapter`. Reused directly by the Greenhouse, Lever, and Workday adapters (Tasks 7–9) and used as the fallback in the site detector (Task 6).

- [ ] **Step 1: Write the failing tests**

`tests/generic-adapter.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { extractFields } from '../src/fill-engine/generic-adapter';

describe('extractFields', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves label via label[for]', () => {
    document.body.innerHTML = `
      <label for="fname">First Name</label>
      <input id="fname" type="text" />
    `;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].label).toBe('First Name');
    expect(fields[0].profileKey).toBe('personal.firstName');
  });

  it('resolves label via aria-label when no label element exists', () => {
    document.body.innerHTML = `<input type="text" aria-label="Email Address" />`;
    const fields = extractFields(document);
    expect(fields[0].profileKey).toBe('personal.email');
  });

  it('falls back to placeholder text', () => {
    document.body.innerHTML = `<input type="text" placeholder="Phone Number" />`;
    const fields = extractFields(document);
    expect(fields[0].profileKey).toBe('personal.phone');
  });

  it('leaves profileKey null for unrecognized fields, e.g. essay questions', () => {
    document.body.innerHTML = `
      <label for="essay">Why do you want to work here?</label>
      <textarea id="essay"></textarea>
    `;
    const fields = extractFields(document);
    expect(fields[0].kind).toBe('textarea');
    expect(fields[0].profileKey).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/generic-adapter.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the generic adapter**

`src/fill-engine/generic-adapter.ts`:
```ts
import { lookupFieldKey } from './synonym-dictionary';
import { Adapter, FieldDescriptor, FieldKind } from './types';

function resolveLabel(element: HTMLElement): string {
  const id = element.getAttribute('id');
  if (id) {
    const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (labelEl?.textContent) return labelEl.textContent.trim();
  }
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();
  const closestLabel = element.closest('label');
  if (closestLabel?.textContent) return closestLabel.textContent.trim();
  const placeholder = element.getAttribute('placeholder');
  if (placeholder) return placeholder.trim();
  return '';
}

function classifyKind(element: HTMLElement): FieldKind | null {
  if (element instanceof HTMLTextAreaElement) return 'textarea';
  if (element instanceof HTMLSelectElement) return 'select';
  if (element instanceof HTMLInputElement) {
    if (element.type === 'radio') return 'radio';
    if (element.type === 'checkbox') return 'checkbox';
    if (['text', 'email', 'tel', 'url', ''].includes(element.type)) return 'text';
  }
  return null;
}

export function extractFields(root: ParentNode = document): FieldDescriptor[] {
  const elements = root.querySelectorAll('input, select, textarea');
  const fields: FieldDescriptor[] = [];

  elements.forEach((el) => {
    const element = el as HTMLElement;
    const kind = classifyKind(element);
    if (!kind) return;

    const label = resolveLabel(element);
    const profileKey = label ? lookupFieldKey(label) : null;
    fields.push({ element, label, kind, profileKey });
  });

  return fields;
}

export const genericAdapter: Adapter = {
  id: 'generic',
  matchesHostname: () => true,
  extractFields,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/generic-adapter.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/fill-engine/generic-adapter.ts tests/generic-adapter.test.ts
git commit -m "feat: add generic DOM-based field extraction adapter"
```

---

### Task 6: Site detector

**Files:**
- Create: `src/fill-engine/site-detector.ts`
- Test: `tests/site-detector.test.ts`

**Interfaces:**
- Consumes: `Adapter` (Task 4), `genericAdapter` (Task 5).
- Produces: `pickAdapter(hostname: string, adapters: Adapter[]): Adapter`. Used by the fill orchestrator (Task 11) and the popup (Task 12) to decide which adapter applies to the current page.

- [ ] **Step 1: Write the failing tests**

`tests/site-detector.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { pickAdapter } from '../src/fill-engine/site-detector';
import { Adapter } from '../src/fill-engine/types';

const fakeAdapter: Adapter = {
  id: 'fake',
  matchesHostname: (hostname) => hostname === 'example.com',
  extractFields: () => [],
};

describe('pickAdapter', () => {
  it('returns the matching adapter', () => {
    expect(pickAdapter('example.com', [fakeAdapter]).id).toBe('fake');
  });

  it('falls back to genericAdapter when nothing matches', () => {
    expect(pickAdapter('unknown.com', [fakeAdapter]).id).toBe('generic');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/site-detector.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the site detector**

`src/fill-engine/site-detector.ts`:
```ts
import { genericAdapter } from './generic-adapter';
import { Adapter } from './types';

export function pickAdapter(hostname: string, adapters: Adapter[]): Adapter {
  const match = adapters.find((adapter) => adapter.matchesHostname(hostname));
  return match ?? genericAdapter;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/site-detector.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/fill-engine/site-detector.ts tests/site-detector.test.ts
git commit -m "feat: add adapter registry lookup by hostname"
```

---

### Task 7: Greenhouse adapter

**Files:**
- Create: `src/fill-engine/greenhouse-adapter.ts`
- Test: `tests/greenhouse-adapter.test.ts`

**Interfaces:**
- Consumes: `extractFields` (Task 5), `Adapter` (Task 4).
- Produces: `greenhouseAdapter: Adapter` with `id: 'greenhouse'`. Registered in the adapter list built in Task 11.

Greenhouse-hosted applications live on `*.greenhouse.io` (e.g. `boards.greenhouse.io`, `job-boards.greenhouse.io`). v1 detects the site by hostname and reuses the generic DOM extractor — Greenhouse forms are standard labeled HTML inputs, so no site-specific selectors are needed yet. If real-world testing (Task 15) turns up fields the generic extractor misses, that's a follow-up adapter refinement, not a blocker for v1.

- [ ] **Step 1: Write the failing test**

`tests/greenhouse-adapter.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { greenhouseAdapter } from '../src/fill-engine/greenhouse-adapter';

describe('greenhouseAdapter.matchesHostname', () => {
  it('matches greenhouse.io subdomains', () => {
    expect(greenhouseAdapter.matchesHostname('boards.greenhouse.io')).toBe(true);
    expect(greenhouseAdapter.matchesHostname('job-boards.greenhouse.io')).toBe(true);
  });

  it('does not match unrelated hosts', () => {
    expect(greenhouseAdapter.matchesHostname('example.com')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/greenhouse-adapter.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter**

`src/fill-engine/greenhouse-adapter.ts`:
```ts
import { extractFields } from './generic-adapter';
import { Adapter } from './types';

export const greenhouseAdapter: Adapter = {
  id: 'greenhouse',
  matchesHostname: (hostname) => /(^|\.)greenhouse\.io$/.test(hostname),
  extractFields,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/greenhouse-adapter.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/fill-engine/greenhouse-adapter.ts tests/greenhouse-adapter.test.ts
git commit -m "feat: add Greenhouse adapter"
```

---

### Task 8: Lever adapter

**Files:**
- Create: `src/fill-engine/lever-adapter.ts`
- Test: `tests/lever-adapter.test.ts`

**Interfaces:**
- Consumes: `extractFields` (Task 5), `Adapter` (Task 4).
- Produces: `leverAdapter: Adapter` with `id: 'lever'`. Registered in Task 11.

Same reasoning as Task 7: Lever-hosted applications live on `*.lever.co` (e.g. `jobs.lever.co`); v1 detects by hostname and delegates extraction to the generic adapter.

- [ ] **Step 1: Write the failing test**

`tests/lever-adapter.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { leverAdapter } from '../src/fill-engine/lever-adapter';

describe('leverAdapter.matchesHostname', () => {
  it('matches lever.co subdomains', () => {
    expect(leverAdapter.matchesHostname('jobs.lever.co')).toBe(true);
  });

  it('does not match unrelated hosts', () => {
    expect(leverAdapter.matchesHostname('example.com')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lever-adapter.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter**

`src/fill-engine/lever-adapter.ts`:
```ts
import { extractFields } from './generic-adapter';
import { Adapter } from './types';

export const leverAdapter: Adapter = {
  id: 'lever',
  matchesHostname: (hostname) => /(^|\.)lever\.co$/.test(hostname),
  extractFields,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lever-adapter.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/fill-engine/lever-adapter.ts tests/lever-adapter.test.ts
git commit -m "feat: add Lever adapter"
```

---

### Task 9: Workday adapter

**Files:**
- Create: `src/fill-engine/workday-adapter.ts`
- Test: `tests/workday-adapter.test.ts`

**Interfaces:**
- Consumes: `extractFields` (Task 5), `Adapter` (Task 4).
- Produces: `workdayAdapter: Adapter` with `id: 'workday'`. Registered in Task 11.

Workday tenants are hosted at `<company>.wd<n>.myworkdayjobs.com`. v1 detects by hostname and delegates to the generic adapter; per the spec's Error Handling section, Workday's multi-step wizard means the user re-clicks "Autofill" on each step rather than the extension chaining across pages automatically.

- [ ] **Step 1: Write the failing test**

`tests/workday-adapter.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { workdayAdapter } from '../src/fill-engine/workday-adapter';

describe('workdayAdapter.matchesHostname', () => {
  it('matches myworkdayjobs.com tenant subdomains', () => {
    expect(workdayAdapter.matchesHostname('acme.wd1.myworkdayjobs.com')).toBe(true);
  });

  it('does not match unrelated hosts', () => {
    expect(workdayAdapter.matchesHostname('example.com')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/workday-adapter.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter**

`src/fill-engine/workday-adapter.ts`:
```ts
import { extractFields } from './generic-adapter';
import { Adapter } from './types';

export const workdayAdapter: Adapter = {
  id: 'workday',
  matchesHostname: (hostname) => /\.myworkdayjobs\.com$/.test(hostname),
  extractFields,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/workday-adapter.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/fill-engine/workday-adapter.ts tests/workday-adapter.test.ts
git commit -m "feat: add Workday adapter"
```

---

### Task 10: LinkedIn adapter

**Files:**
- Create: `src/fill-engine/linkedin-adapter.ts`
- Test: `tests/linkedin-adapter.test.ts`

**Interfaces:**
- Consumes: `extractFields` (Task 5), `Adapter` (Task 4).
- Produces: `linkedinAdapter: Adapter` with `id: 'linkedin'`. Registered in Task 11.

LinkedIn Easy Apply renders its form inside a modal dialog (`.jobs-easy-apply-modal`) layered over the job posting page, which also contains unrelated inputs (search bars, etc.). This adapter scopes extraction to the modal when present, falling back to the whole document otherwise.

- [ ] **Step 1: Write the failing tests**

`tests/linkedin-adapter.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { linkedinAdapter } from '../src/fill-engine/linkedin-adapter';

describe('linkedinAdapter', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches linkedin.com', () => {
    expect(linkedinAdapter.matchesHostname('www.linkedin.com')).toBe(true);
    expect(linkedinAdapter.matchesHostname('example.com')).toBe(false);
  });

  it('scopes extraction to the Easy Apply modal when present', () => {
    document.body.innerHTML = `
      <input type="text" placeholder="Search" />
      <div class="jobs-easy-apply-modal">
        <input type="text" aria-label="First Name" />
      </div>
    `;
    const fields = linkedinAdapter.extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].profileKey).toBe('personal.firstName');
  });

  it('falls back to the whole document when no modal is present', () => {
    document.body.innerHTML = `<input type="text" aria-label="Email Address" />`;
    const fields = linkedinAdapter.extractFields(document);
    expect(fields).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/linkedin-adapter.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the adapter**

`src/fill-engine/linkedin-adapter.ts`:
```ts
import { extractFields } from './generic-adapter';
import { Adapter } from './types';

const EASY_APPLY_MODAL_SELECTOR = '.jobs-easy-apply-modal';

export const linkedinAdapter: Adapter = {
  id: 'linkedin',
  matchesHostname: (hostname) => /(^|\.)linkedin\.com$/.test(hostname),
  extractFields: (root) => {
    const modal = root.querySelector(EASY_APPLY_MODAL_SELECTOR);
    return extractFields(modal ?? root);
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/linkedin-adapter.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/fill-engine/linkedin-adapter.ts tests/linkedin-adapter.test.ts
git commit -m "feat: add LinkedIn Easy Apply adapter scoped to the modal"
```

---

### Task 11: Adapter registry and fill orchestrator

**Files:**
- Create: `src/fill-engine/adapter-registry.ts`
- Create: `src/fill-engine/index.ts`
- Test: `tests/fill-orchestrator.test.ts`

**Interfaces:**
- Consumes: `pickAdapter` (Task 6), all four site adapters (Tasks 7–10), `fillFields` (Task 4), `getProfile` (Task 2), `normalize` (Task 3).
- Produces: `ADAPTERS: Adapter[]` (from `adapter-registry.ts`, reused by the popup in Task 12); `run(): Promise<FillSummary>` (from `index.ts`), attached to `window.__jobAutofillRun` — this is the function the popup invokes via `chrome.scripting.executeScript` after injecting the bundled `fill-engine.js`.

- [ ] **Step 1: Write the adapter registry**

`src/fill-engine/adapter-registry.ts`:
```ts
import { Adapter } from './types';
import { greenhouseAdapter } from './greenhouse-adapter';
import { leverAdapter } from './lever-adapter';
import { workdayAdapter } from './workday-adapter';
import { linkedinAdapter } from './linkedin-adapter';

export const ADAPTERS: Adapter[] = [greenhouseAdapter, leverAdapter, workdayAdapter, linkedinAdapter];
```

- [ ] **Step 2: Write the failing tests for the orchestrator**

`tests/fill-orchestrator.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeStorageMock } from './chrome-mock';
import { saveProfile } from '../src/storage/profile-store';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';
import { run } from '../src/fill-engine/index';

describe('run', () => {
  beforeEach(() => {
    installChromeStorageMock();
    document.body.innerHTML = '';
    vi.stubGlobal('location', { hostname: 'boards.greenhouse.io' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fills recognized fields and flags the rest', async () => {
    await saveProfile({ ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Jorge' } });
    document.body.innerHTML = `
      <label for="fname">First Name</label>
      <input id="fname" type="text" />
      <label for="essay">Why do you want to work here?</label>
      <textarea id="essay"></textarea>
    `;

    const summary = await run();

    expect(summary).toEqual({ filled: 1, flagged: 1 });
    expect((document.getElementById('fname') as HTMLInputElement).value).toBe('Jorge');
  });

  it('applies a custom override before the synonym dictionary', async () => {
    await saveProfile({
      ...DEFAULT_PROFILE,
      links: { ...DEFAULT_PROFILE.links, github: 'https://github.com/jorge' },
      overrides: { 'do you have a code sample link': 'links.github' },
    });
    document.body.innerHTML = `<input type="text" aria-label="Do you have a code sample link?" />`;

    const summary = await run();

    expect(summary.filled).toBe(1);
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('https://github.com/jorge');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/fill-orchestrator.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 4: Implement the orchestrator**

`src/fill-engine/index.ts`:
```ts
import { getProfile } from '../storage/profile-store';
import { pickAdapter } from './site-detector';
import { ADAPTERS } from './adapter-registry';
import { fillFields } from './fill-engine';
import { normalize } from './synonym-dictionary';
import { FillSummary } from './types';

export async function run(): Promise<FillSummary> {
  const profile = await getProfile();
  const adapter = pickAdapter(location.hostname, ADAPTERS);
  const fields = adapter.extractFields(document);

  for (const field of fields) {
    const overrideKey = profile.overrides[normalize(field.label)];
    if (overrideKey) field.profileKey = overrideKey;
  }

  return fillFields(fields, profile);
}

(window as unknown as Record<string, unknown>).__jobAutofillRun = run;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/fill-orchestrator.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/fill-engine/adapter-registry.ts src/fill-engine/index.ts tests/fill-orchestrator.test.ts
git commit -m "feat: wire adapter registry into the fill orchestrator entry point"
```

---

### Task 12: Popup UI

**Files:**
- Create: `src/popup/popup-logic.ts`
- Create: `src/popup/popup.ts`
- Create: `src/popup/popup.html`
- Test: `tests/popup-logic.test.ts`

**Interfaces:**
- Consumes: `pickAdapter` (Task 6), `ADAPTERS` (Task 11), `FillSummary` (Task 4).
- Produces: `formatSummary(summary: FillSummary): string` and `detectAdapterId(hostname: string): string` (from `popup-logic.ts`, unit tested). `popup.ts` is browser glue (DOM wiring + `chrome.tabs`/`chrome.scripting` calls) verified manually in Task 15, not unit tested — this split keeps testable logic separate from untestable browser APIs.

- [ ] **Step 1: Write the failing tests for the pure popup logic**

`tests/popup-logic.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { formatSummary, detectAdapterId } from '../src/popup/popup-logic';

describe('formatSummary', () => {
  it('pluralizes filled/flagged counts correctly', () => {
    expect(formatSummary({ filled: 1, flagged: 0 })).toBe('Filled 1 field, 0 need your input.');
    expect(formatSummary({ filled: 14, flagged: 3 })).toBe('Filled 14 fields, 3 need your input.');
    expect(formatSummary({ filled: 5, flagged: 1 })).toBe('Filled 5 fields, 1 needs your input.');
  });
});

describe('detectAdapterId', () => {
  it('identifies Greenhouse by hostname', () => {
    expect(detectAdapterId('boards.greenhouse.io')).toBe('greenhouse');
  });

  it('falls back to generic for unknown hosts', () => {
    expect(detectAdapterId('example.com')).toBe('generic');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/popup-logic.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the pure popup logic**

`src/popup/popup-logic.ts`:
```ts
import { pickAdapter } from '../fill-engine/site-detector';
import { ADAPTERS } from '../fill-engine/adapter-registry';
import { FillSummary } from '../fill-engine/types';

export function formatSummary(summary: FillSummary): string {
  const fieldWord = summary.filled === 1 ? 'field' : 'fields';
  const needWord = summary.flagged === 1 ? 'needs' : 'need';
  return `Filled ${summary.filled} ${fieldWord}, ${summary.flagged} ${needWord} your input.`;
}

export function detectAdapterId(hostname: string): string {
  return pickAdapter(hostname, ADAPTERS).id;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/popup-logic.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the popup markup**

`src/popup/popup.html`:
```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: system-ui, sans-serif; width: 260px; padding: 12px; }
      button { width: 100%; padding: 8px; margin-top: 8px; }
      #status { margin-top: 8px; font-size: 13px; color: #444; }
    </style>
  </head>
  <body>
    <div id="site-label">Detecting site…</div>
    <button id="fill-button">Autofill this page</button>
    <div id="status"></div>
    <a href="options.html" target="_blank">Edit profile</a>
    <script src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 6: Write the popup glue script**

`src/popup/popup.ts`:
```ts
import { formatSummary, detectAdapterId } from './popup-logic';
import { FillSummary } from '../fill-engine/types';

async function main(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const hostname = tab.url ? new URL(tab.url).hostname : '';

  const siteLabel = document.getElementById('site-label')!;
  siteLabel.textContent = `Detected: ${detectAdapterId(hostname)}`;

  document.getElementById('fill-button')!.addEventListener('click', async () => {
    const statusEl = document.getElementById('status')!;
    statusEl.textContent = 'Filling…';

    await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['fill-engine.js'] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: () => (window as unknown as { __jobAutofillRun: () => Promise<FillSummary> }).__jobAutofillRun(),
    });

    statusEl.textContent = formatSummary(result as FillSummary);
  });
}

main();
```

- [ ] **Step 7: Commit**

```bash
git add src/popup tests/popup-logic.test.ts
git commit -m "feat: add popup UI with site detection and autofill trigger"
```

---

### Task 13: Options page — profile fields

**Files:**
- Create: `src/options/profile-form.ts`
- Test: `tests/profile-form.test.ts`

**Interfaces:**
- Consumes: `Profile`, `DEFAULT_PROFILE` (Task 2).
- Produces: `serializeProfile(form: HTMLFormElement, base: Profile): Profile` and `populateForm(form: HTMLFormElement, profile: Profile): void`, covering the single-instance fields (personal info, work authorization, links). Task 14 extends the same form with repeatable lists and reuses `base` from this task's `serializeProfile` to merge in `workHistory`/`education`/`overrides`.

- [ ] **Step 1: Write the failing tests**

`tests/profile-form.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { serializeProfile, populateForm } from '../src/options/profile-form';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';

const FORM_HTML = `
  <form id="profile-form">
    <input name="personal.firstName" />
    <input name="personal.lastName" />
    <input name="personal.email" />
    <input name="personal.phone" />
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

describe('serializeProfile', () => {
  it('reads form values into a Profile', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    (form.elements.namedItem('personal.firstName') as HTMLInputElement).value = 'Jorge';
    (form.elements.namedItem('workAuthorization.authorizedToWork') as HTMLSelectElement).value = 'yes';

    const profile = serializeProfile(form, DEFAULT_PROFILE);

    expect(profile.personal.firstName).toBe('Jorge');
    expect(profile.workAuthorization.authorizedToWork).toBe('yes');
  });
});

describe('populateForm', () => {
  it('writes a Profile back into the form fields', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, email: 'jorge@example.com' } };

    populateForm(form, profile);

    expect((form.elements.namedItem('personal.email') as HTMLInputElement).value).toBe('jorge@example.com');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/profile-form.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the form serialization**

`src/options/profile-form.ts`:
```ts
import { Profile } from '../storage/profile-schema';

export function serializeProfile(form: HTMLFormElement, base: Profile): Profile {
  const data = new FormData(form);
  const get = (name: string) => (data.get(name) as string) ?? '';

  return {
    ...base,
    personal: {
      firstName: get('personal.firstName'),
      lastName: get('personal.lastName'),
      email: get('personal.email'),
      phone: get('personal.phone'),
      address: get('personal.address'),
      city: get('personal.city'),
      state: get('personal.state'),
      zip: get('personal.zip'),
    },
    workAuthorization: {
      authorizedToWork: get('workAuthorization.authorizedToWork') as 'yes' | 'no' | '',
      requiresSponsorship: get('workAuthorization.requiresSponsorship') as 'yes' | 'no' | '',
    },
    links: {
      linkedin: get('links.linkedin'),
      portfolio: get('links.portfolio'),
      github: get('links.github'),
    },
  };
}

export function populateForm(form: HTMLFormElement, profile: Profile): void {
  const setValue = (name: string, value: string) => {
    const field = form.elements.namedItem(name);
    if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) field.value = value;
  };

  setValue('personal.firstName', profile.personal.firstName);
  setValue('personal.lastName', profile.personal.lastName);
  setValue('personal.email', profile.personal.email);
  setValue('personal.phone', profile.personal.phone);
  setValue('personal.address', profile.personal.address);
  setValue('personal.city', profile.personal.city);
  setValue('personal.state', profile.personal.state);
  setValue('personal.zip', profile.personal.zip);
  setValue('workAuthorization.authorizedToWork', profile.workAuthorization.authorizedToWork);
  setValue('workAuthorization.requiresSponsorship', profile.workAuthorization.requiresSponsorship);
  setValue('links.linkedin', profile.links.linkedin);
  setValue('links.portfolio', profile.links.portfolio);
  setValue('links.github', profile.links.github);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/profile-form.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/options/profile-form.ts tests/profile-form.test.ts
git commit -m "feat: add profile form serialization for personal/work-auth/links fields"
```

---

### Task 14: Options page — work history, education, and overrides

**Files:**
- Create: `src/options/profile-lists.ts`
- Create: `src/options/options.ts`
- Create: `src/options/options.html`
- Test: `tests/profile-lists.test.ts`

**Interfaces:**
- Consumes: `WorkHistoryEntry`, `EducationEntry`, `ProfileFieldKey` (Task 2), `normalize` (Task 3), `serializeProfile`/`populateForm` (Task 13).
- Produces: `parseWorkHistory(container: HTMLElement): WorkHistoryEntry[]`, `renderWorkHistoryEntry(entry: WorkHistoryEntry): HTMLElement`, `parseEducation(container: HTMLElement): EducationEntry[]`, `renderEducationEntry(entry: EducationEntry): HTMLElement`, `parseOverrides(container: HTMLElement): Record<string, ProfileFieldKey>`, `renderOverrideRow(label?: string, fieldKey?: ProfileFieldKey | ''): HTMLElement`, `PROFILE_FIELD_KEYS: { key: ProfileFieldKey; label: string }[]`. `options.ts` wires all of this plus `getProfile`/`saveProfile` (Task 2) into the full options page — browser glue, verified manually in Task 15.

- [ ] **Step 1: Write the failing tests**

`tests/profile-lists.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  parseWorkHistory,
  renderWorkHistoryEntry,
  parseEducation,
  renderEducationEntry,
  parseOverrides,
  renderOverrideRow,
} from '../src/options/profile-lists';
import { WorkHistoryEntry, EducationEntry } from '../src/storage/profile-schema';

describe('renderWorkHistoryEntry / parseWorkHistory', () => {
  it('round-trips a work history entry through the DOM', () => {
    const entry: WorkHistoryEntry = {
      company: 'Acme',
      title: 'Engineer',
      startDate: '2020-01',
      endDate: '2022-01',
      description: 'Built things.',
    };

    const container = document.createElement('div');
    container.appendChild(renderWorkHistoryEntry(entry));

    expect(parseWorkHistory(container)).toEqual([entry]);
  });

  it('round-trips values containing quotes and angle brackets without corrupting the markup', () => {
    const entry: WorkHistoryEntry = {
      company: 'Widgets "R" Us',
      title: 'Lead, <Special> Projects',
      startDate: '2020-01',
      endDate: '2022-01',
      description: 'Shipped a "great" feature & handled </textarea> edge cases.',
    };

    const container = document.createElement('div');
    container.appendChild(renderWorkHistoryEntry(entry));

    expect(parseWorkHistory(container)).toEqual([entry]);
  });
});

describe('renderEducationEntry / parseEducation', () => {
  it('round-trips an education entry through the DOM', () => {
    const entry: EducationEntry = {
      school: 'State University',
      degree: 'B.S.',
      fieldOfStudy: 'Computer Science',
      graduationDate: '2019-05',
    };

    const container = document.createElement('div');
    container.appendChild(renderEducationEntry(entry));

    expect(parseEducation(container)).toEqual([entry]);
  });
});

describe('renderOverrideRow / parseOverrides', () => {
  it('round-trips an override row through the DOM', () => {
    const container = document.createElement('div');
    container.appendChild(renderOverrideRow('Do you have a code sample link?', 'links.github'));

    expect(parseOverrides(container)).toEqual({
      'do you have a code sample link': 'links.github',
    });
  });

  it('normalizes labels and pairs them with the chosen profile field key', () => {
    document.body.innerHTML = `
      <div id="overrides">
        <div data-override-row>
          <input name="label" value="Do You Have A Code Sample Link?" />
          <select name="fieldKey"><option value="links.github" selected>GitHub</option></select>
        </div>
      </div>
    `;
    const container = document.getElementById('overrides')!;

    expect(parseOverrides(container)).toEqual({
      'do you have a code sample link': 'links.github',
    });
  });

  it('skips rows with no label or no selected key', () => {
    document.body.innerHTML = `
      <div id="overrides">
        <div data-override-row>
          <input name="label" value="" />
          <select name="fieldKey"><option value="links.github" selected>GitHub</option></select>
        </div>
      </div>
    `;
    const container = document.getElementById('overrides')!;

    expect(parseOverrides(container)).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/profile-lists.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement work history, education, and overrides list handling**

`src/options/profile-lists.ts`:
```ts
import { WorkHistoryEntry, EducationEntry, ProfileFieldKey } from '../storage/profile-schema';
import { normalize } from '../fill-engine/synonym-dictionary';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function renderWorkHistoryEntry(entry: WorkHistoryEntry): HTMLElement {
  const div = document.createElement('div');
  div.setAttribute('data-work-entry', '');
  div.innerHTML = `
    <input name="company" placeholder="Company" value="${escapeHtml(entry.company)}" />
    <input name="title" placeholder="Title" value="${escapeHtml(entry.title)}" />
    <input name="startDate" placeholder="Start Date" value="${escapeHtml(entry.startDate)}" />
    <input name="endDate" placeholder="End Date" value="${escapeHtml(entry.endDate)}" />
    <textarea name="description">${escapeHtml(entry.description)}</textarea>
  `;
  return div;
}

export function parseWorkHistory(container: HTMLElement): WorkHistoryEntry[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-work-entry]')).map((entry) => ({
    company: (entry.querySelector('[name="company"]') as HTMLInputElement).value,
    title: (entry.querySelector('[name="title"]') as HTMLInputElement).value,
    startDate: (entry.querySelector('[name="startDate"]') as HTMLInputElement).value,
    endDate: (entry.querySelector('[name="endDate"]') as HTMLInputElement).value,
    description: (entry.querySelector('[name="description"]') as HTMLTextAreaElement).value,
  }));
}

export function renderEducationEntry(entry: EducationEntry): HTMLElement {
  const div = document.createElement('div');
  div.setAttribute('data-education-entry', '');
  div.innerHTML = `
    <input name="school" placeholder="School" value="${escapeHtml(entry.school)}" />
    <input name="degree" placeholder="Degree" value="${escapeHtml(entry.degree)}" />
    <input name="fieldOfStudy" placeholder="Field of Study" value="${escapeHtml(entry.fieldOfStudy)}" />
    <input name="graduationDate" placeholder="Graduation Date" value="${escapeHtml(entry.graduationDate)}" />
  `;
  return div;
}

export function parseEducation(container: HTMLElement): EducationEntry[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-education-entry]')).map((entry) => ({
    school: (entry.querySelector('[name="school"]') as HTMLInputElement).value,
    degree: (entry.querySelector('[name="degree"]') as HTMLInputElement).value,
    fieldOfStudy: (entry.querySelector('[name="fieldOfStudy"]') as HTMLInputElement).value,
    graduationDate: (entry.querySelector('[name="graduationDate"]') as HTMLInputElement).value,
  }));
}

export const PROFILE_FIELD_KEYS: { key: ProfileFieldKey; label: string }[] = [
  { key: 'personal.firstName', label: 'First Name' },
  { key: 'personal.lastName', label: 'Last Name' },
  { key: 'personal.email', label: 'Email' },
  { key: 'personal.phone', label: 'Phone' },
  { key: 'personal.address', label: 'Address' },
  { key: 'personal.city', label: 'City' },
  { key: 'personal.state', label: 'State' },
  { key: 'personal.zip', label: 'Zip' },
  { key: 'workAuthorization.authorizedToWork', label: 'Authorized to Work' },
  { key: 'workAuthorization.requiresSponsorship', label: 'Requires Sponsorship' },
  { key: 'links.linkedin', label: 'LinkedIn' },
  { key: 'links.portfolio', label: 'Portfolio' },
  { key: 'links.github', label: 'GitHub' },
];

export function renderOverrideRow(label = '', fieldKey: ProfileFieldKey | '' = ''): HTMLElement {
  const div = document.createElement('div');
  div.setAttribute('data-override-row', '');
  const options = PROFILE_FIELD_KEYS.map(
    (f) => `<option value="${f.key}"${f.key === fieldKey ? ' selected' : ''}>${f.label}</option>`
  ).join('');
  div.innerHTML = `
    <input name="label" placeholder="Question phrasing" value="${escapeHtml(label)}" />
    <select name="fieldKey"><option value="">--</option>${options}</select>
  `;
  return div;
}

export function parseOverrides(container: HTMLElement): Record<string, ProfileFieldKey> {
  const overrides: Record<string, ProfileFieldKey> = {};

  container.querySelectorAll<HTMLElement>('[data-override-row]').forEach((row) => {
    const labelInput = row.querySelector('[name="label"]') as HTMLInputElement;
    const keySelect = row.querySelector('[name="fieldKey"]') as HTMLSelectElement;
    const label = normalize(labelInput.value);
    const key = keySelect.value as ProfileFieldKey;
    if (label && key) overrides[label] = key;
  });

  return overrides;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/profile-lists.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the options page markup**

`src/options/options.html`:
```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: system-ui, sans-serif; max-width: 640px; margin: 24px auto; }
      fieldset { margin-bottom: 16px; }
      label { display: block; margin-top: 8px; font-size: 13px; }
      input, select, textarea { width: 100%; padding: 4px; }
      [data-work-entry], [data-education-entry], [data-override-row] {
        border: 1px solid #ddd; padding: 8px; margin-top: 8px;
      }
    </style>
  </head>
  <body>
    <form id="profile-form">
      <fieldset>
        <legend>Personal</legend>
        <label>First name <input name="personal.firstName" /></label>
        <label>Last name <input name="personal.lastName" /></label>
        <label>Email <input name="personal.email" /></label>
        <label>Phone <input name="personal.phone" /></label>
        <label>Address <input name="personal.address" /></label>
        <label>City <input name="personal.city" /></label>
        <label>State <input name="personal.state" /></label>
        <label>Zip <input name="personal.zip" /></label>
      </fieldset>

      <fieldset>
        <legend>Work Authorization</legend>
        <label>Authorized to work?
          <select name="workAuthorization.authorizedToWork">
            <option value="">--</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label>Requires sponsorship?
          <select name="workAuthorization.requiresSponsorship">
            <option value="">--</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>Links</legend>
        <label>LinkedIn <input name="links.linkedin" /></label>
        <label>Portfolio <input name="links.portfolio" /></label>
        <label>GitHub <input name="links.github" /></label>
      </fieldset>

      <fieldset>
        <legend>Work History</legend>
        <div id="work-history-list"></div>
        <button type="button" id="add-work-entry">+ Add job</button>
      </fieldset>

      <fieldset>
        <legend>Education</legend>
        <div id="education-list"></div>
        <button type="button" id="add-education-entry">+ Add school</button>
      </fieldset>

      <fieldset>
        <legend>Custom Q&amp;A Overrides</legend>
        <div id="overrides-list"></div>
        <button type="button" id="add-override">+ Add override</button>
      </fieldset>

      <button type="submit">Save</button>
      <span id="save-status"></span>
    </form>
    <script src="options.js"></script>
  </body>
</html>
```

- [ ] **Step 6: Write the options page glue script**

`src/options/options.ts`:
```ts
import { getProfile, saveProfile } from '../storage/profile-store';
import { serializeProfile, populateForm } from './profile-form';
import {
  parseWorkHistory,
  renderWorkHistoryEntry,
  parseEducation,
  renderEducationEntry,
  parseOverrides,
  renderOverrideRow,
} from './profile-lists';
import { Profile } from '../storage/profile-schema';

async function main(): Promise<void> {
  const form = document.getElementById('profile-form') as HTMLFormElement;
  const workHistoryList = document.getElementById('work-history-list')!;
  const educationList = document.getElementById('education-list')!;
  const overridesList = document.getElementById('overrides-list')!;
  const profile = await getProfile();

  populateForm(form, profile);
  profile.workHistory.forEach((entry) => workHistoryList.appendChild(renderWorkHistoryEntry(entry)));
  profile.education.forEach((entry) => educationList.appendChild(renderEducationEntry(entry)));
  Object.entries(profile.overrides).forEach(([label, fieldKey]) =>
    overridesList.appendChild(renderOverrideRow(label, fieldKey))
  );

  document.getElementById('add-work-entry')!.addEventListener('click', () => {
    workHistoryList.appendChild(
      renderWorkHistoryEntry({ company: '', title: '', startDate: '', endDate: '', description: '' })
    );
  });

  document.getElementById('add-education-entry')!.addEventListener('click', () => {
    educationList.appendChild(
      renderEducationEntry({ school: '', degree: '', fieldOfStudy: '', graduationDate: '' })
    );
  });

  document.getElementById('add-override')!.addEventListener('click', () => {
    overridesList.appendChild(renderOverrideRow());
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const base: Profile = {
      ...profile,
      workHistory: parseWorkHistory(workHistoryList),
      education: parseEducation(educationList),
      overrides: parseOverrides(overridesList),
    };
    const updated = serializeProfile(form, base);
    await saveProfile(updated);
    document.getElementById('save-status')!.textContent = 'Saved.';
  });
}

main();
```

- [ ] **Step 7: Commit**

```bash
git add src/options tests/profile-lists.test.ts
git commit -m "feat: add work history, education, and custom overrides to options page"
```

---

### Task 15: Build and manual QA pass

**Files:**
- No new source files — this task builds and exercises everything from Tasks 1–14.

**Interfaces:**
- Consumes: the full `dist/` build output.
- Produces: a working unpacked Chrome extension, confirmed against real applications on all 4 target ATS platforms.

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (all tests from Tasks 1–14)

- [ ] **Step 2: Build the extension**

Run: `npm run build`
Expected: `dist/popup.js`, `dist/popup.html`, `dist/options.js`, `dist/options.html`, `dist/fill-engine.js` all created without errors.

- [ ] **Step 3: Load the unpacked extension in Chrome**

Open `chrome://extensions`, enable Developer Mode, click "Load unpacked," select the project root (containing `manifest.json`). Confirm the extension loads with no errors on the extensions page.

- [ ] **Step 4: Fill out your profile**

Click the extension icon → "Edit profile," fill in personal info, work authorization, links, and at least one work history entry. Save.

- [ ] **Step 5: Manually verify autofill on each target site**

For each of Greenhouse, Lever, Workday, and LinkedIn Easy Apply: open a real job application, click the extension icon, click "Autofill," and confirm:
- Recognized fields (name, email, phone, links, work authorization) are filled correctly.
- Essay/free-text fields are visually flagged (yellow outline), not filled.
- The popup summary count matches what's visibly filled/flagged on the page.
- No errors appear in the page's DevTools console.

If a site's fields aren't being recognized well by the generic extractor, note the specific field/label text — that's the input needed to write a more targeted adapter later, outside this v1 scope.

- [ ] **Step 6: Commit any fixes found during manual QA**

If manual QA turns up bugs, fix them with the normal TDD cycle (failing test → fix → passing test) and commit each fix separately rather than batching them.

---

## Self-Review Notes

- **Spec coverage:** Architecture (adapter pattern + on-demand injection) → Tasks 6, 11. Components (popup, options, fill script, synonym dictionary, storage) → Tasks 2, 3, 12, 13, 14. Data flow (hostname detection → injection → extraction → fill → flag → summary) → Task 11. Error handling (no-match summary, missing profile data, React-controlled inputs, multi-step forms, iframes) → Tasks 4, 9, 15. Testing (unit tests + fixture-based adapter tests + manual QA) → Tasks 2–14 (unit) and Task 15 (manual). Out-of-scope items (tracker, more adapters, Firefox/Edge, AI) are not built anywhere in this plan, matching the spec.
- **Radio-group filling** is a deliberate v1 scope cut (flagged, not filled) — called out explicitly in Task 4 rather than silently glossed over, since real visa/work-authorization questions are often radio buttons and this is a genuine limitation worth the user's awareness.
- **Type consistency checked:** `FieldDescriptor`, `Adapter`, `FillSummary` (Task 4) are used with identical shapes in Tasks 5–14. `ProfileFieldKey` (Task 2) is the type used consistently for both the synonym dictionary (Task 3) and the overrides map (Tasks 11, 14). `normalize()` (Task 3) is the single normalization function reused in Task 11's override lookup and Task 14's override parsing, so both sides of that lookup agree.
