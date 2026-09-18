# ADP Recruiting (`recruiting.adp.com`) Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extension autofill ADP's Dojo-based `recruiting.adp.com` career site — the repeatable Employment History section first, plus Personal Information and the cleanly-mappable General Information dropdowns.

**Architecture:** A new `adp-recruiting` adapter matches `recruiting.adp.com` and returns no extractable fields (so the generic engine never fights Dojo). All writing goes through a small MAIN-world Dojo bridge (`adp-recruiting-dojo.ts`) that loads `dijit/registry`, finds the widget behind a field `name`, and sets its value through the Dijit API. Two passes consume the bridge: a flat `name → ProfileFieldKey` pass and a `profile.workHistory` repeatable pass. `WorkHistoryEntry` gains four optional fields (supervisor name, supervisor/employer phone, may-contact, reason for leaving) and the options work-history editor captures them.

**Tech Stack:** TypeScript, esbuild (`build.mjs`, IIFE bundle from `src/fill-engine/index.ts`), vitest + jsdom. Chrome MV3 extension; `dist/fill-engine.js` is injected with `world: 'MAIN'`.

**Spec:** `docs/superpowers/specs/2026-08-31-adp-recruiting-adapter-design.md`

## Global Constraints

- No AI, no network calls, no remote code. Everything runs locally in the content/MAIN-world bundle.
- The fill bundle runs in the page MAIN world — `window.require` / `window.dijit` are reachable; do not add `chrome.*` calls to fill-engine modules.
- New `src/fill-engine/*.ts` modules are bundled automatically when imported from `index.ts`; do not edit `build.mjs` or `manifest.json`.
- Follow existing fill-module conventions: each site pass returns `FillSummary` (`{ filled: number; flagged: number }`); unmatched required fields are flagged via `flagField`, never guessed.
- `flagField(el)` sets `el.style.outline` and `el.dataset.autofillFlag = 'needs-input'` (from `src/fill-engine/fill-engine.ts`).
- Do not modify `adp-adapter.ts` / `adp-fill.ts` (the separate `workforcenow.adp.com` product).
- Run `npm test` and `npm run typecheck` before every commit; both must pass.
- Manual browser verification on a real `recruiting.adp.com` application is the acceptance test for the feature (see Task 7).

---

### Task 1: Adapter skeleton + registry + orchestrator wiring

**Files:**
- Create: `src/fill-engine/adp-recruiting-adapter.ts`
- Create: `src/fill-engine/adp-recruiting-fill.ts`
- Modify: `src/fill-engine/adapter-registry.ts`
- Modify: `src/fill-engine/index.ts:17` (imports), `:42-44` (branch), `:188-189` (totals)
- Test: `tests/adp-recruiting-adapter.test.ts`

**Interfaces:**
- Consumes: `Adapter`, `FillSummary` from `./types`; `Profile` from `../storage/profile-schema`.
- Produces:
  - `adpRecruitingAdapter: Adapter` with `id: 'adp-recruiting'`, `matchesHostname(h): boolean`, `extractFields(): FieldDescriptor[]` → always `[]`.
  - `fillAdpRecruitingForm(profile: Profile, root?: ParentNode): Promise<FillSummary>` — this task ships a stub returning `{ filled: 0, flagged: 0 }`; Tasks 3 and 5 fill it in.

- [ ] **Step 1: Write the failing test**

```ts
// tests/adp-recruiting-adapter.test.ts
import { describe, expect, it } from 'vitest';
import { adpRecruitingAdapter } from '../src/fill-engine/adp-recruiting-adapter';
import { ADAPTERS } from '../src/fill-engine/adapter-registry';
import { pickAdapter } from '../src/fill-engine/site-detector';

describe('adpRecruitingAdapter', () => {
  it('matches recruiting.adp.com and nothing else ADP', () => {
    expect(adpRecruitingAdapter.matchesHostname('recruiting.adp.com')).toBe(true);
    expect(adpRecruitingAdapter.matchesHostname('workforcenow.adp.com')).toBe(false);
    expect(adpRecruitingAdapter.matchesHostname('example.com')).toBe(false);
  });

  it('extracts no fields (Dojo is driven by the dedicated pass)', () => {
    document.body.innerHTML = '<input name="firstName_RTiCandidate" class="dijitInputInner">';
    expect(adpRecruitingAdapter.extractFields(document)).toEqual([]);
  });

  it('is registered and selected for recruiting.adp.com', () => {
    expect(pickAdapter('recruiting.adp.com', ADAPTERS).id).toBe('adp-recruiting');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adp-recruiting-adapter.test.ts`
Expected: FAIL — cannot resolve `../src/fill-engine/adp-recruiting-adapter`.

- [ ] **Step 3: Create the adapter**

```ts
// src/fill-engine/adp-recruiting-adapter.ts
import { Adapter } from './types';

// recruiting.adp.com ("Recruiting Management / SRCCAR") is a Dojo/Dijit app. Its widgets keep
// their state in the Dijit registry, so a plain input.value write is reverted. adp-recruiting-fill
// drives them through the Dijit API instead; returning no fields here keeps the generic engine out.
export const adpRecruitingAdapter: Adapter = {
  id: 'adp-recruiting',
  matchesHostname: (hostname) => /(^|\.)recruiting\.adp\.com$/i.test(hostname),
  extractFields: () => [],
};
```

- [ ] **Step 4: Create the fill stub**

```ts
// src/fill-engine/adp-recruiting-fill.ts
import { Profile } from '../storage/profile-schema';
import { FillSummary } from './types';

export async function fillAdpRecruitingForm(
  _profile: Profile,
  _root: ParentNode = document
): Promise<FillSummary> {
  return { filled: 0, flagged: 0 };
}
```

- [ ] **Step 5: Register the adapter**

In `src/fill-engine/adapter-registry.ts`, add the import next to the other adapter imports:

```ts
import { adpRecruitingAdapter } from './adp-recruiting-adapter';
```

and append it to the array (after `adpAdapter`):

```ts
export const ADAPTERS: Adapter[] = [appleAdapter, greenhouseAdapter, leverAdapter, workdayAdapter, linkedinAdapter, smartRecruitersAdapter, oracleAdapter, adpAdapter, adpRecruitingAdapter];
```

- [ ] **Step 6: Wire the orchestrator**

In `src/fill-engine/index.ts`, add after the `import { fillAdpForm } from './adp-fill';` line (~line 17):

```ts
import { fillAdpRecruitingForm } from './adp-recruiting-fill';
```

Add after the `adpSummary` block (~line 44):

```ts
  const adpRecruitingSummary = adapter.id === 'adp-recruiting'
    ? await fillAdpRecruitingForm(profile)
    : { filled: 0, flagged: 0 };
```

In the `return { filled: …, flagged: … }` object (~lines 188-189), add `+ adpRecruitingSummary.filled` to the `filled` sum and `+ adpRecruitingSummary.flagged` to the `flagged` sum.

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run tests/adp-recruiting-adapter.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/fill-engine/adp-recruiting-adapter.ts src/fill-engine/adp-recruiting-fill.ts src/fill-engine/adapter-registry.ts src/fill-engine/index.ts tests/adp-recruiting-adapter.test.ts
git commit -m "feat: register recruiting.adp.com adapter skeleton

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Dojo bridge module

**Files:**
- Create: `src/fill-engine/adp-recruiting-dojo.ts`
- Test: `tests/adp-recruiting-dojo.test.ts`

**Interfaces:**
- Consumes: `buildCandidates`, `findMatchIndex` from `./fill-engine`.
- Produces:
  - `interface DijitWidget { get(p:'value'):unknown; set(p:'value',v:unknown):void; getOptions?():{value:string;label:string}[]; _handleOnChange?(v:unknown,priority?:boolean):void; onChange?(v:unknown):void; domNode?: HTMLElement; declaredClass?: string }`
  - `interface DijitRegistry { byId(id:string):DijitWidget|undefined; getEnclosingWidget(n:Node):DijitWidget|undefined }`
  - `getRegistry(): DijitRegistry | null`
  - `widgetForName(name: string, registry: DijitRegistry, root?: ParentNode): DijitWidget | null`
  - `fireChange(widget: DijitWidget): void`
  - `setText(widget: DijitWidget, value: string): boolean`
  - `setSelect(widget: DijitWidget, matchKey: string | null, value: string): boolean`
  - `setDate(widget: DijitWidget, raw: string): boolean`
  - `parseAdpDate(raw: string): Date | null`
  - `clickAndWait(button: HTMLElement, predicate: () => boolean, opts?: { intervalMs?: number; maxAttempts?: number }): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/adp-recruiting-dojo.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getRegistry, widgetForName, setText, setSelect, setDate, parseAdpDate, clickAndWait,
  DijitRegistry, DijitWidget,
} from '../src/fill-engine/adp-recruiting-dojo';

function fakeTextWidget(initial = ''): DijitWidget & { changed: unknown } {
  let value = initial;
  return {
    changed: undefined as unknown,
    get: () => value,
    set: (_p, v) => { value = String(v); },
    _handleOnChange(v) { (this as { changed: unknown }).changed = v; },
    domNode: document.createElement('div'),
  };
}

function fakeSelectWidget(options: { value: string; label: string }[]): DijitWidget {
  let value = '';
  return {
    get: () => value,
    set: (_p, v) => { value = String(v); },
    getOptions: () => options,
    domNode: document.createElement('div'),
  };
}

afterEach(() => {
  delete (window as unknown as { dijit?: unknown }).dijit;
  delete (window as unknown as { require?: unknown }).require;
  document.body.innerHTML = '';
});

describe('getRegistry', () => {
  it('returns null when neither require nor dijit is present', () => {
    expect(getRegistry()).toBeNull();
  });
  it('uses window.dijit.registry as a fallback', () => {
    const reg = { byId: () => undefined, getEnclosingWidget: () => undefined } as DijitRegistry;
    (window as unknown as { dijit: { registry: DijitRegistry } }).dijit = { registry: reg };
    expect(getRegistry()).toBe(reg);
  });
});

describe('widgetForName', () => {
  it('finds the widget enclosing the control with that name', () => {
    document.body.innerHTML = '<input name="firstName_RTiCandidate">';
    const node = document.querySelector('input')!;
    const widget = fakeTextWidget();
    const reg = {
      byId: () => undefined,
      getEnclosingWidget: (n: Node) => (n === node ? widget : undefined),
    } as DijitRegistry;
    expect(widgetForName('firstName_RTiCandidate', reg)).toBe(widget);
  });
});

describe('setText / setSelect / setDate', () => {
  it('setText writes the value and fires change', () => {
    const w = fakeTextWidget();
    expect(setText(w, 'Allen')).toBe(true);
    expect(w.get('value')).toBe('Allen');
    expect(w.changed).toBe('Allen');
  });

  it('setSelect matches a coded option by label, incl. state abbreviation', () => {
    const w = fakeSelectWidget([
      { value: 'CA', label: 'California' },
      { value: 'NC', label: 'North Carolina' },
    ]);
    expect(setSelect(w, 'personal.state', 'NC')).toBe(true);
    expect(w.get('value')).toBe('NC');
  });

  it('setSelect returns false when nothing matches', () => {
    const w = fakeSelectWidget([{ value: 'X', label: 'Xland' }]);
    expect(setSelect(w, null, 'Yes')).toBe(false);
  });

  it('setDate parses MM/YYYY', () => {
    const w = fakeTextWidget();
    (w as unknown as { get: () => unknown }).get = () => new Date(2023, 5, 1);
    expect(setDate(w, '06/2023')).toBe(true);
  });
});

describe('parseAdpDate', () => {
  it('handles MM/YYYY, MM/DD/YYYY and ISO', () => {
    expect(parseAdpDate('06/2023')).toEqual(new Date(2023, 5, 1));
    expect(parseAdpDate('06/15/2023')).toEqual(new Date(2023, 5, 15));
    expect(parseAdpDate('2023-06')).toEqual(new Date(2023, 5, 1));
    expect(parseAdpDate('nonsense')).toBeNull();
  });
});

describe('clickAndWait', () => {
  it('clicks and resolves true once the predicate passes', async () => {
    const button = document.createElement('button');
    let ready = false;
    button.addEventListener('click', () => { setTimeout(() => { ready = true; }, 5); });
    const ok = await clickAndWait(button, () => ready, { intervalMs: 2, maxAttempts: 20 });
    expect(ok).toBe(true);
  });

  it('resolves false if the predicate never passes', async () => {
    const button = document.createElement('button');
    const ok = await clickAndWait(button, () => false, { intervalMs: 1, maxAttempts: 3 });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adp-recruiting-dojo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the bridge**

```ts
// src/fill-engine/adp-recruiting-dojo.ts
import { buildCandidates, findMatchIndex } from './fill-engine';

export interface DijitWidget {
  get(prop: 'value'): unknown;
  set(prop: 'value', value: unknown): void;
  getOptions?(): { value: string; label: string }[];
  _handleOnChange?(value: unknown, priorityChange?: boolean): void;
  onChange?(value: unknown): void;
  domNode?: HTMLElement;
  declaredClass?: string;
}

export interface DijitRegistry {
  byId(id: string): DijitWidget | undefined;
  getEnclosingWidget(node: Node): DijitWidget | undefined;
}

interface DojoWindow {
  require?: ((mod: string) => unknown) & ((deps: string[], cb: (...mods: unknown[]) => void) => void);
  dijit?: { registry?: DijitRegistry };
}

export function getRegistry(): DijitRegistry | null {
  const w = window as unknown as DojoWindow;
  try {
    if (typeof w.require === 'function') {
      const reg = (w.require as (mod: string) => unknown)('dijit/registry') as DijitRegistry | undefined;
      if (reg && typeof reg.getEnclosingWidget === 'function') return reg;
    }
  } catch {
    // require() throws for a module that is registered but not yet loaded; fall through.
  }
  if (w.dijit?.registry && typeof w.dijit.registry.getEnclosingWidget === 'function') {
    return w.dijit.registry;
  }
  return null;
}

export function widgetForName(
  name: string,
  registry: DijitRegistry,
  root: ParentNode = document
): DijitWidget | null {
  const escaped = CSS.escape(name);
  const node =
    root.querySelector<HTMLElement>(`[name="${escaped}"]`) ??
    root.querySelector<HTMLElement>(`[name="${CSS.escape(name + 'Date')}"]`);
  if (node) {
    const widget = registry.getEnclosingWidget(node);
    if (widget) return widget;
  }
  // Fallback: match the .dojositeFld wrapper by its url-encoded field name.
  const base = name.replace(/_RTiCandidate(Date)?$/, '');
  for (const wrapper of Array.from(root.querySelectorAll<HTMLElement>('.dojositeFld[data-dojosite-fld]'))) {
    let meta: { name?: string };
    try {
      meta = JSON.parse(decodeURIComponent(wrapper.getAttribute('data-dojosite-fld') ?? ''));
    } catch {
      continue;
    }
    if (meta.name !== base) continue;
    const inner = wrapper.querySelector<HTMLElement>('input, textarea, table[role="listbox"]');
    const widget = inner ? registry.getEnclosingWidget(inner) : undefined;
    if (widget) return widget;
  }
  return null;
}

export function fireChange(widget: DijitWidget): void {
  try {
    const value = widget.get('value');
    if (typeof widget._handleOnChange === 'function') widget._handleOnChange(value, true);
    else if (typeof widget.onChange === 'function') widget.onChange(value);
  } catch {
    // A tenant handler that throws must not abort the fill run.
  }
}

export function setText(widget: DijitWidget, value: string): boolean {
  try {
    widget.set('value', value);
    fireChange(widget);
    return String(widget.get('value') ?? '') === value;
  } catch {
    return false;
  }
}

export function setSelect(widget: DijitWidget, matchKey: string | null, value: string): boolean {
  try {
    const options = typeof widget.getOptions === 'function' ? widget.getOptions() : [];
    if (!options.length) return false;
    const index = findMatchIndex(options.map((o) => o.label), buildCandidates(matchKey, value));
    if (index === null) return false;
    widget.set('value', options[index].value);
    fireChange(widget);
    return String(widget.get('value') ?? '') === String(options[index].value);
  } catch {
    return false;
  }
}

export function parseAdpDate(raw: string): Date | null {
  const s = raw.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2})\/(\d{4})$/.exec(s))) return new Date(Number(m[2]), Number(m[1]) - 1, 1);
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  if ((m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(s))) return new Date(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1);
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function setDate(widget: DijitWidget, raw: string): boolean {
  const date = parseAdpDate(raw);
  if (!date) return false;
  try {
    widget.set('value', date);
    fireChange(widget);
    const v = widget.get('value');
    return v instanceof Date && !Number.isNaN(v.getTime());
  } catch {
    return false;
  }
}

export async function clickAndWait(
  button: HTMLElement,
  predicate: () => boolean,
  opts: { intervalMs?: number; maxAttempts?: number } = {}
): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? 50;
  const maxAttempts = opts.maxAttempts ?? 20;
  button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  button.click();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/adp-recruiting-dojo.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fill-engine/adp-recruiting-dojo.ts tests/adp-recruiting-dojo.test.ts
git commit -m "feat: Dojo/Dijit bridge for recruiting.adp.com

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Flat field pass (Personal + General Information) + required sweep

**Files:**
- Modify: `src/fill-engine/adp-recruiting-fill.ts`
- Test: `tests/adp-recruiting-fill.test.ts`

**Interfaces:**
- Consumes: `getRegistry`, `widgetForName`, `setText`, `setSelect`, `setDate` from `./adp-recruiting-dojo`; `resolveProfileValue`, `flagField` from `./fill-engine`; `Profile`, `ProfileFieldKey` from `../storage/profile-schema`.
- Produces: `fillAdpRecruitingForm` now runs the flat pass + a leftover-required sweep. Exports `ADP_RECRUITING_FLAT_FIELDS` for the test. Task 5 adds the employment pass to the same file.

- [ ] **Step 1: Write the failing test**

```ts
// tests/adp-recruiting-fill.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fillAdpRecruitingForm } from '../src/fill-engine/adp-recruiting-fill';
import { DijitRegistry, DijitWidget } from '../src/fill-engine/adp-recruiting-dojo';
import { DEFAULT_PROFILE, Profile } from '../src/storage/profile-schema';

// A jsdom stand-in for the Dijit registry: widgets are registered against their control node.
const widgets = new Map<Node, DijitWidget>();

function registry(): DijitRegistry {
  return {
    byId: () => undefined,
    getEnclosingWidget: (node: Node) => {
      let el: Node | null = node;
      while (el) {
        const w = widgets.get(el);
        if (w) return w;
        el = (el as HTMLElement).parentElement;
      }
      return undefined;
    },
  };
}

function mountText(name: string, label: string, required = true): DijitWidget {
  const wrapper = document.createElement('div');
  wrapper.className = 'dojositeFld';
  wrapper.setAttribute('data-dojosite-fld', encodeURIComponent(JSON.stringify({ name: name })));
  wrapper.innerHTML = `<div class="element"><label>${label}${required ? '**' : ''}</label>
    <input class="dijitInputInner" name="${name}_RTiCandidate" aria-required="${required}"></div>`;
  document.body.append(wrapper);
  const node = wrapper.querySelector('input')!;
  let value = '';
  const widget: DijitWidget = {
    get: () => value,
    set: (_p, v) => { value = String(v); (node as HTMLInputElement).value = value; },
    domNode: node,
  };
  widgets.set(node, widget);
  return widget;
}

function mountSelect(name: string, label: string, options: { value: string; label: string }[]): DijitWidget {
  const wrapper = document.createElement('div');
  wrapper.className = 'dojositeFld';
  wrapper.setAttribute('data-dojosite-fld', encodeURIComponent(JSON.stringify({ name: name })));
  wrapper.innerHTML = `<div class="element"><label>${label}**</label>
    <table role="listbox"><input type="hidden" name="${name}_RTiCandidate" aria-hidden="true">
    <span class="dijitSelectLabel"><span class="label"></span></span></table></div>`;
  document.body.append(wrapper);
  const node = wrapper.querySelector('table')!;
  let value = '';
  const widget: DijitWidget = {
    get: () => value,
    set: (_p, v) => {
      value = String(v);
      const hidden = wrapper.querySelector<HTMLInputElement>('input[type="hidden"]')!;
      hidden.value = value;
      const shown = options.find((o) => o.value === value)?.label ?? '';
      wrapper.querySelector('.label')!.textContent = shown;
    },
    getOptions: () => options,
    domNode: node,
  };
  widgets.set(node, widget);
  return widget;
}

beforeEach(() => { widgets.clear(); document.body.innerHTML = ''; });
afterEach(() => { widgets.clear(); document.body.innerHTML = ''; });

describe('fillAdpRecruitingForm — flat pass', () => {
  it('no-ops without a Dojo registry', async () => {
    mountText('firstName', 'Legal First Name');
    const summary = await fillAdpRecruitingForm({ ...DEFAULT_PROFILE }, document);
    expect(summary).toEqual({ filled: 0, flagged: 0 });
  });

  it('fills text and coded-select fields through the widgets', async () => {
    (window as unknown as { dijit: { registry: DijitRegistry } }).dijit = { registry: registry() };
    const first = mountText('firstName', 'Legal First Name');
    const state = mountSelect('state', 'State/Province', [
      { value: 'NC', label: 'North Carolina' },
      { value: 'CA', label: 'California' },
    ]);
    const relocate = mountSelect('$$willingToRelocate', 'Willing to Relocate', [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' },
    ]);
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, firstName: 'Allen', state: 'NC' },
      jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, willingToRelocate: 'yes' },
    };

    const summary = await fillAdpRecruitingForm(profile, document);

    expect(first.get('value')).toBe('Allen');
    expect(state.get('value')).toBe('NC');
    expect(relocate.get('value')).toBe('true');
    expect(summary.filled).toBe(3);
    delete (window as unknown as { dijit?: unknown }).dijit;
  });

  it('flags a visible required field with no profile value', async () => {
    (window as unknown as { dijit: { registry: DijitRegistry } }).dijit = { registry: registry() };
    const city = mountText('city', 'City');
    const summary = await fillAdpRecruitingForm({ ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, city: '' } }, document);
    expect((city.domNode as HTMLElement).dataset.autofillFlag).toBe('needs-input');
    expect(summary.flagged).toBeGreaterThanOrEqual(1);
    delete (window as unknown as { dijit?: unknown }).dijit;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adp-recruiting-fill.test.ts`
Expected: FAIL — `fillAdpRecruitingForm` returns `{filled:0,flagged:0}` even with a registry / no flagging.

- [ ] **Step 3: Implement the flat pass**

Replace the contents of `src/fill-engine/adp-recruiting-fill.ts`:

```ts
// src/fill-engine/adp-recruiting-fill.ts
import { Profile, ProfileFieldKey } from '../storage/profile-schema';
import { flagField, resolveProfileValue } from './fill-engine';
import { FillSummary } from './types';
import {
  DijitRegistry,
  getRegistry,
  setDate,
  setSelect,
  setText,
  widgetForName,
} from './adp-recruiting-dojo';

type AdpFieldType = 'text' | 'select' | 'date';

interface AdpFlatField {
  name: string;
  profileKey: ProfileFieldKey;
  type: AdpFieldType;
}

// Field names captured from a real recruiting.adp.com application (Holden Industries). The control
// name is `<name>_RTiCandidate`; `$$` marks ADP "custom-ish" standard fields.
export const ADP_RECRUITING_FLAT_FIELDS: AdpFlatField[] = [
  { name: 'firstName', profileKey: 'personal.firstName', type: 'text' },
  { name: 'middleName', profileKey: 'personal.middleName', type: 'text' },
  { name: 'lastName', profileKey: 'personal.lastName', type: 'text' },
  { name: 'email', profileKey: 'personal.email', type: 'text' },
  { name: 'address1', profileKey: 'personal.address', type: 'text' },
  { name: 'address2', profileKey: 'personal.addressLine2', type: 'text' },
  { name: 'city', profileKey: 'personal.city', type: 'text' },
  { name: 'state', profileKey: 'personal.state', type: 'select' },
  { name: 'country', profileKey: 'personal.country', type: 'select' },
  { name: 'zip', profileKey: 'personal.zip', type: 'text' },
  { name: 'phone', profileKey: 'personal.phone', type: 'text' },
  { name: '$$willingToRelocate', profileKey: 'jobPreferences.willingToRelocate', type: 'select' },
  { name: '$$authorizedToWork', profileKey: 'workAuthorization.authorizedToWork', type: 'select' },
  { name: '$$18yearsOfAge', profileKey: 'jobPreferences.atLeast18', type: 'select' },
];

function writeByType(
  widget: NonNullable<ReturnType<typeof widgetForName>>,
  type: AdpFieldType,
  matchKey: ProfileFieldKey | null,
  value: string
): boolean {
  if (type === 'select') return setSelect(widget, matchKey, value);
  if (type === 'date') return setDate(widget, value);
  return setText(widget, value);
}

function isVisible(el: HTMLElement): boolean {
  return el.offsetParent !== null || el.getClientRects().length > 0;
}

function wrapperHasValue(wrapper: HTMLElement): boolean {
  const hidden = wrapper.querySelector<HTMLInputElement>(
    'input[type="hidden"][name$="_RTiCandidate"], input[type="hidden"][name$="_RTiCandidateDate"]'
  );
  if (hidden?.value.trim()) return true;
  const text = wrapper.querySelector<HTMLInputElement | HTMLTextAreaElement>('input.dijitInputInner, textarea');
  if (text?.value.trim()) return true;
  const selected = wrapper.querySelector('.dijitSelectLabel .label, .dijitButtonText .label');
  return Boolean(selected?.textContent && selected.textContent.trim());
}

// Best-effort: after the mapped passes, flag any still-empty visible field ADP marks required
// (label contains `**`, or the control is aria-required) so the popup's "N need your input" is
// accurate. Conditional (hidden) fields are skipped via the visibility check.
function sweepRequired(root: ParentNode): number {
  let flagged = 0;
  for (const wrapper of Array.from(root.querySelectorAll<HTMLElement>('.dojositeFld[data-dojosite-fld]'))) {
    const control = wrapper.querySelector<HTMLElement>(
      'input.dijitInputInner, textarea, table[role="listbox"]'
    );
    if (!control || !isVisible(control) || control.dataset.autofillFlag) continue;
    const label = wrapper.querySelector('label')?.textContent ?? '';
    const ariaReq = control.getAttribute('aria-required');
    const required = /\*\*/.test(label) || ariaReq === 'true' || ariaReq === 'required';
    if (!required || wrapperHasValue(wrapper)) continue;
    flagField(control);
    flagged++;
  }
  return flagged;
}

async function fillFlatFields(
  profile: Profile,
  registry: DijitRegistry,
  root: ParentNode
): Promise<FillSummary> {
  let filled = 0;
  let flagged = 0;
  for (const field of ADP_RECRUITING_FLAT_FIELDS) {
    const widget = widgetForName(`${field.name}_RTiCandidate`, registry, root);
    if (!widget) continue;
    const value = resolveProfileValue(profile, field.profileKey);
    if (!value) continue; // sweepRequired handles flagging
    if (writeByType(widget, field.type, field.profileKey, value)) {
      filled++;
    } else {
      if (widget.domNode) flagField(widget.domNode);
      flagged++;
    }
  }
  return { filled, flagged };
}

export async function fillAdpRecruitingForm(
  profile: Profile,
  root: ParentNode = document
): Promise<FillSummary> {
  const registry = getRegistry();
  if (!registry) return { filled: 0, flagged: 0 };
  const flat = await fillFlatFields(profile, registry, root);
  const sweptFlags = sweepRequired(root);
  return { filled: flat.filled, flagged: flat.flagged + sweptFlags };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/adp-recruiting-fill.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fill-engine/adp-recruiting-fill.ts tests/adp-recruiting-fill.test.ts
git commit -m "feat: fill Personal + General Info on recruiting.adp.com

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `WorkHistoryEntry` fields + options work-history editor

**Files:**
- Modify: `src/storage/profile-schema.ts:1-9`
- Modify: `src/options/profile-lists.ts` (`renderWorkHistoryEntry` ~87-103, `parseWorkHistory` ~105-115)
- Test: `tests/profile-lists.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `WorkHistoryEntry` gains `supervisorName?: string`, `supervisorPhone?: string`, `mayContact?: 'yes' | 'no' | ''`, `reasonForLeaving?: string`. `renderWorkHistoryEntry` / `parseWorkHistory` round-trip them. Task 5 reads these keys.

- [ ] **Step 1: Write the failing test**

Add to `tests/profile-lists.test.ts` inside the `renderWorkHistoryEntry / parseWorkHistory` describe block:

```ts
  it('round-trips supervisor, phone, may-contact and reason-for-leaving', () => {
    const entry = {
      company: 'Acme', title: 'Engineer', location: 'Durham, NC',
      startDate: '06/2021', endDate: '08/2023', currentlyWorksHere: false,
      description: 'Built things',
      supervisorName: 'Dana Lee', supervisorPhone: '9195551234',
      mayContact: 'yes' as const, reasonForLeaving: 'Career growth',
    };
    const container = document.createElement('div');
    container.appendChild(renderWorkHistoryEntry(entry));
    expect(parseWorkHistory(container)).toEqual([entry]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/profile-lists.test.ts`
Expected: FAIL — parsed entry lacks the four new keys.

- [ ] **Step 3: Extend the schema**

In `src/storage/profile-schema.ts`, replace the `WorkHistoryEntry` interface:

```ts
export interface WorkHistoryEntry {
  company: string;
  title: string;
  location?: string;
  startDate: string;
  endDate: string;
  currentlyWorksHere?: boolean;
  description: string;
  supervisorName?: string;
  supervisorPhone?: string;
  mayContact?: 'yes' | 'no' | '';
  reasonForLeaving?: string;
}
```

(`DEFAULT_PROFILE.workHistory` stays `[]`; `mergeProfile` in `profile-store.ts` copies `workHistory` wholesale and the new keys are optional, so no store change is needed.)

- [ ] **Step 4: Extend the editor**

In `src/options/profile-lists.ts`, in `renderWorkHistoryEntry`, add before the `<button type="button" data-remove>` line:

```ts
    <input name="supervisorName" placeholder="Supervisor name" value="${escapeHtml(entry.supervisorName ?? '')}" />
    <input name="supervisorPhone" placeholder="Supervisor / employer phone" value="${escapeHtml(entry.supervisorPhone ?? '')}" />
    <label>May we contact this employer?
      <select name="mayContact">
        <option value=""${!entry.mayContact ? ' selected' : ''}></option>
        <option value="yes"${entry.mayContact === 'yes' ? ' selected' : ''}>Yes</option>
        <option value="no"${entry.mayContact === 'no' ? ' selected' : ''}>No</option>
      </select>
    </label>
    <textarea name="reasonForLeaving" placeholder="Reason for leaving">${escapeHtml(entry.reasonForLeaving ?? '')}</textarea>
```

In `parseWorkHistory`, add to the returned object literal:

```ts
    supervisorName: (entry.querySelector('[name="supervisorName"]') as HTMLInputElement).value,
    supervisorPhone: (entry.querySelector('[name="supervisorPhone"]') as HTMLInputElement).value,
    mayContact: (entry.querySelector('[name="mayContact"]') as HTMLSelectElement).value as '' | 'yes' | 'no',
    reasonForLeaving: (entry.querySelector('[name="reasonForLeaving"]') as HTMLTextAreaElement).value,
```

- [ ] **Step 5: Reconcile the existing round-trip test**

The existing `renderWorkHistoryEntry / parseWorkHistory` tests build an `entry` without the new keys and assert `toEqual`. `parseWorkHistory` now always returns the four keys (as `''`), so update those existing test fixtures to include `supervisorName: '', supervisorPhone: '', mayContact: '', reasonForLeaving: ''` (matching how the existing test already handles `location`/`currentlyWorksHere`). Run the file and fix each failing `toEqual` the same way.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run tests/profile-lists.test.ts tests/profile-store.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage/profile-schema.ts src/options/profile-lists.ts tests/profile-lists.test.ts
git commit -m "feat: capture supervisor / may-contact / reason-for-leaving in work history

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Employment History repeatable pass

**Files:**
- Modify: `src/fill-engine/adp-recruiting-fill.ts`
- Test: `tests/adp-recruiting-fill.test.ts`

**Interfaces:**
- Consumes: `clickAndWait` from `./adp-recruiting-dojo` (plus the Task 2/3 imports already in the file); `WorkHistoryEntry` from `../storage/profile-schema`.
- Produces: `fillAdpRecruitingForm` also fills the Employment History rows from `profile.workHistory` (cap 6), clicking "Add Employer" for rows that aren't rendered yet.

- [ ] **Step 1: Write the failing test**

Add to `tests/adp-recruiting-fill.test.ts`. Reuse the `widgets` map / `registry()` / `mountText` / `mountSelect` helpers from Task 3; add a date mount and an "Add Employer" button helper:

```ts
function mountDate(name: string): DijitWidget {
  const wrapper = document.createElement('div');
  wrapper.className = 'dojositeFld';
  wrapper.setAttribute('data-dojosite-fld', encodeURIComponent(JSON.stringify({ name })));
  wrapper.innerHTML = `<div class="element"><label>Start Date**</label>
    <input class="dijitInputInner" role="textbox" name="${name}_RTiCandidate">
    <input type="hidden" name="${name}_RTiCandidateDate"></div>`;
  document.body.append(wrapper);
  const node = wrapper.querySelector('input.dijitInputInner')!;
  let value: unknown = '';
  const widget: DijitWidget = {
    get: () => value,
    set: (_p, v) => { value = v; },
    domNode: node,
  };
  widgets.set(node, widget);
  return widget;
}

function mountEmployerRow(row: number): Record<string, DijitWidget> {
  return {
    type: mountSelect(`$$employerType_${row}`, 'Type', [
      { value: '00001000', label: 'Current' }, { value: '00002000', label: 'Previous' },
    ]),
    name: mountText(`$$employerName_${row}`, 'Employer'),
    city: mountText(`$$employerCity_${row}`, 'City'),
    startTitle: mountText(`$$employerStartTitle_${row}`, 'Start Position/Title'),
    startDate: mountDate(`$$employerStartDate_${row}`),
    duties: mountText(`$$employerJobDuties_${row}`, 'Job Duties'),
    supvName: mountText(`$$employerSupvName_${row}`, "Supervisor's Name"),
  };
}

describe('fillAdpRecruitingForm — Employment History', () => {
  it('fills rendered rows and clicks "Add Employer" for missing ones', async () => {
    (window as unknown as { dijit: { registry: DijitRegistry } }).dijit = { registry: registry() };
    const row1 = mountEmployerRow(1);

    const addButton = document.createElement('span');
    addButton.className = 'dijitButtonText';
    addButton.textContent = 'Add Employer';
    addButton.addEventListener('click', () => { mountEmployerRow(2); });
    document.body.append(addButton);

    const profile: Profile = {
      ...DEFAULT_PROFILE,
      workHistory: [
        { company: 'Acme', title: 'Engineer', location: 'Durham', startDate: '06/2021', endDate: '08/2023', currentlyWorksHere: false, description: 'Built things', supervisorName: 'Dana Lee' },
        { company: 'Globex', title: 'Intern', location: 'Raleigh', startDate: '05/2020', endDate: '08/2020', currentlyWorksHere: false, description: 'Learned things', supervisorName: 'Sam Roe' },
      ],
    };

    const summary = await fillAdpRecruitingForm(profile, document, { addRowIntervalMs: 1, addRowMaxAttempts: 5 });

    expect(row1.name.get('value')).toBe('Acme');
    expect(row1.type.get('value')).toBe('00002000'); // not current -> Previous
    expect(row1.startDate.get('value')).toBeInstanceOf(Date);
    expect(document.querySelector('[name="$$employerName_2_RTiCandidate"]')).not.toBeNull();
    expect(summary.filled).toBeGreaterThanOrEqual(10);
    delete (window as unknown as { dijit?: unknown }).dijit;
  });

  it('leaves End Date / End Title blank for a current job', async () => {
    (window as unknown as { dijit: { registry: DijitRegistry } }).dijit = { registry: registry() };
    const row1 = mountEmployerRow(1);
    const endTitle = mountText('$$employerEndTitle_1', 'End Position/Title');
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      workHistory: [
        { company: 'Acme', title: 'Engineer', location: 'Durham', startDate: '06/2021', endDate: '', currentlyWorksHere: true, description: 'x' },
      ],
    };
    await fillAdpRecruitingForm(profile, document, { addRowIntervalMs: 1, addRowMaxAttempts: 2 });
    expect(row1.type.get('value')).toBe('00001000'); // Current
    expect(endTitle.get('value')).toBe('');
    delete (window as unknown as { dijit?: unknown }).dijit;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adp-recruiting-fill.test.ts`
Expected: FAIL — `fillAdpRecruitingForm` takes 2 args / ignores `workHistory`.

- [ ] **Step 3: Implement the employment pass**

In `src/fill-engine/adp-recruiting-fill.ts`, add the `WorkHistoryEntry` import, the `clickAndWait` import, an options object, the column table, and the pass. Add near the top:

```ts
import { Profile, ProfileFieldKey, WorkHistoryEntry } from '../storage/profile-schema';
// ...extend the existing dojo import with clickAndWait...
import {
  DijitRegistry, clickAndWait, getRegistry, setDate, setSelect, setText, widgetForName,
} from './adp-recruiting-dojo';

interface AdpRecruitingOptions {
  addRowIntervalMs?: number;
  addRowMaxAttempts?: number;
}

const EMPLOYER_MAX_ROWS = 6;

interface EmployerColumn {
  base: string;
  type: AdpFieldType;
  matchKey?: ProfileFieldKey;
  value(entry: WorkHistoryEntry, profile: Profile): string;
}

const before = (loc: string, i: number) => (loc.split(',')[i] ?? '').trim();

// Column order and names captured from a real recruiting.adp.com Employment History section.
// `employerReference` is the "May We Contact?" Yes/No select (assumed — verify live).
const EMPLOYER_COLUMNS: EmployerColumn[] = [
  { base: 'employerType', type: 'select', value: (e) => (e.currentlyWorksHere ? 'Current' : 'Previous') },
  { base: 'employerName', type: 'text', value: (e) => e.company },
  { base: 'employerSupvPhone', type: 'text', value: (e) => e.supervisorPhone ?? '' },
  { base: 'employerCity', type: 'text', value: (e) => before(e.location ?? '', 0) },
  { base: 'employerCountry', type: 'select', matchKey: 'personal.country', value: (e, p) => before(e.location ?? '', 2) || p.personal.country },
  { base: 'employerState', type: 'select', matchKey: 'personal.state', value: (e) => before(e.location ?? '', 1) },
  { base: 'employerStartDate', type: 'date', value: (e) => e.startDate },
  { base: 'employerStartTitle', type: 'text', value: (e) => e.title },
  { base: 'employerEndDate', type: 'date', value: (e) => (e.currentlyWorksHere ? '' : e.endDate) },
  { base: 'employerEndTitle', type: 'text', value: (e) => (e.currentlyWorksHere ? '' : e.title) },
  { base: 'employerSupvName', type: 'text', value: (e) => e.supervisorName ?? '' },
  { base: 'employerReference', type: 'select', value: (e) => e.mayContact ?? '' },
  { base: 'employerJobDuties', type: 'text', value: (e) => e.description },
  { base: 'employerReasonForLeaving', type: 'text', value: (e) => e.reasonForLeaving ?? '' },
];

function findAddEmployerButton(root: ParentNode): HTMLElement | null {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('span.dijitButtonText, button, a'))) {
    if (/add employer/i.test(el.textContent ?? '')) {
      return el.closest<HTMLElement>('[widgetid], button, a') ?? el;
    }
  }
  return null;
}

async function fillEmployment(
  profile: Profile,
  registry: DijitRegistry,
  root: ParentNode,
  options: Required<AdpRecruitingOptions>
): Promise<FillSummary> {
  let filled = 0;
  let flagged = 0;
  if (!root.querySelector('[name="$$employerName_1_RTiCandidate"]')) return { filled, flagged };
  const entries = profile.workHistory.slice(0, EMPLOYER_MAX_ROWS);

  for (let i = 0; i < entries.length; i++) {
    const row = i + 1;
    if (!root.querySelector(`[name="$$employerName_${row}_RTiCandidate"]`)) {
      const button = findAddEmployerButton(root);
      if (!button) break;
      const appeared = await clickAndWait(
        button,
        () => Boolean(root.querySelector(`[name="$$employerName_${row}_RTiCandidate"]`)),
        { intervalMs: options.addRowIntervalMs, maxAttempts: options.addRowMaxAttempts }
      );
      if (!appeared) break;
    }
    for (const col of EMPLOYER_COLUMNS) {
      const widget = widgetForName(`$$${col.base}_${row}_RTiCandidate`, registry, root);
      if (!widget) continue;
      const value = col.value(entries[i], profile).trim();
      if (!value) continue;
      if (writeByType(widget, col.type, col.matchKey ?? null, value)) {
        filled++;
      } else {
        if (widget.domNode) flagField(widget.domNode);
        flagged++;
      }
    }
  }
  return { filled, flagged };
}
```

Update `fillAdpRecruitingForm` to accept options and run both passes:

```ts
export async function fillAdpRecruitingForm(
  profile: Profile,
  root: ParentNode = document,
  options: AdpRecruitingOptions = {}
): Promise<FillSummary> {
  const timing: Required<AdpRecruitingOptions> = {
    addRowIntervalMs: options.addRowIntervalMs ?? 50,
    addRowMaxAttempts: options.addRowMaxAttempts ?? 20,
  };
  const registry = getRegistry();
  if (!registry) return { filled: 0, flagged: 0 };
  const flat = await fillFlatFields(profile, registry, root);
  const employment = await fillEmployment(profile, registry, root, timing);
  const sweptFlags = sweepRequired(root);
  return {
    filled: flat.filled + employment.filled,
    flagged: flat.flagged + employment.flagged + sweptFlags,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/adp-recruiting-fill.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS (watch for the Task 4 round-trip fixtures).

- [ ] **Step 6: Commit**

```bash
git add src/fill-engine/adp-recruiting-fill.ts tests/adp-recruiting-fill.test.ts
git commit -m "feat: fill Employment History rows on recruiting.adp.com

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/USAGE.md`
- Modify: `docs/QA-FINDINGS.md`

**Interfaces:** none.

- [ ] **Step 1: Update USAGE.md**

Find where supported ATS hosts are listed (search for `workforcenow` or `greenhouse`). Add a `recruiting.adp.com` entry noting it as a distinct ADP product (Dojo-based "Recruiting Management / SRCCAR"), with support for Personal Information, the mappable General Information dropdowns, and the repeatable Employment History section; Education / EEO / eSignature not yet covered.

- [ ] **Step 2: Update QA-FINDINGS.md**

Add a dated entry: `recruiting.adp.com` previously did nothing (only `workforcenow.adp.com` was handled); new `adp-recruiting` adapter + Dojo bridge added; **still needs manual verification against a live application** — widget API assumptions (`getOptions`, `_handleOnChange`), "Add Employer" timing, coded select values, and whether `employerReference` is the "May We Contact?" select.

- [ ] **Step 3: Commit**

```bash
git add docs/USAGE.md docs/QA-FINDINGS.md
git commit -m "docs: record recruiting.adp.com adapter + open QA

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Manual browser verification (acceptance test)

**Files:** none (may produce follow-up bug entries in `docs/QA-FINDINGS.md`).

This is the real acceptance test — the unit tests only prove our logic is internally consistent, not that it drives real ADP.

- [ ] **Step 1: Merge to `main` and build**

Per `docs/` workflow notes, the unpacked extension loads from `main`. Merge the branch, then `npm run build`.

- [ ] **Step 2: Load and run**

Load `dist/` as an unpacked extension. Open a real `recruiting.adp.com` job application with an active profile that has ≥2 work-history entries (including supervisor name/phone, may-contact, reason-for-leaving).

- [ ] **Step 3: Verify each section**

- Personal Information: first/middle/last name, address, city, State (dropdown), Country (dropdown), zip, phone all populate and **survive a section change / blur** (Dojo doesn't revert them).
- General Information: Willing to Relocate, work-authorization, and 18-years-of-age dropdowns select the right option.
- Employment History: row 1 fills from work-history entry 0; "Add Employer" is clicked and row 2 fills from entry 1; Type = Current/Previous matches `currentlyWorksHere`; dates land in the date pickers; a current job leaves End Date / End Title blank.
- The popup count ("N filled, M need your input") is plausible, and flagged fields are the ones with genuinely no profile data.

- [ ] **Step 4: Record results**

Note what worked and what didn't in `docs/QA-FINDINGS.md`. File any breakage (wrong widget API, timing, `employerReference` type, coded values) as a specific finding for a follow-up cycle.

---

## Self-Review

**Spec coverage:**
- New `adp-recruiting` adapter matching `recruiting.adp.com`, `extractFields → []` → Task 1. ✓
- Not touching `workforcenow` adapter → Global Constraints + Task 1 only adds. ✓
- Orchestrator branch + totals → Task 1 Step 6. ✓
- Dojo bridge (`getRegistry`/`widgetForName`/`setText`/`setSelect`/`setDate`/`clickAndWait`), MAIN-world, no-op without registry → Task 2. ✓
- Flat pass with `name → ProfileFieldKey` map (Personal + mappable General Info) → Task 3. ✓
- Required-but-empty flagging (visible only) → Task 3 `sweepRequired`. ✓
- `WorkHistoryEntry` gains supervisorName / supervisorPhone / mayContact / reasonForLeaving; options editor captures them → Task 4. ✓
- Employment History repeatable pass, cap 6, "Add Employer" with bounded poll, column mapping incl. current-job blank end fields → Task 5. ✓
- Docs (USAGE, QA-FINDINGS) → Task 6. ✓
- Manual verification as acceptance test → Task 7. ✓
- Out of scope (Education/EEO/eSignature, company-specific yes/nos, Willingness to Travel, keystroke fallback) → not implemented, consistent with spec. ✓

**Deviation from spec:** the spec's "flag company-specific required General Information questions" is implemented generically by `sweepRequired` (flag any visible required empty `.dojositeFld`), not by an explicit per-question list — simpler and also covers Employment History. `profile-store.ts` normalization is *not* changed (spec suggested it): `mergeProfile` copies `workHistory` wholesale and the four new keys are optional, so consumers use `?? ''`. Both noted in Task 3/4.

**Placeholder scan:** no TBD/TODO; every code step has real code; tests have real assertions. ✓

**Type consistency:** `DijitWidget` / `DijitRegistry` defined in Task 2, imported in Tasks 3 & 5. `AdpFieldType` defined in Task 3, used in Task 5. `writeByType` defined in Task 3, used in Task 5. `fillAdpRecruitingForm` signature grows from `(profile, root?)` (Task 1/3) to `(profile, root?, options?)` (Task 5) — Task 5 Step 3 shows the full replacement and Task 5 tests pass the 3rd arg. `ADP_RECRUITING_FLAT_FIELDS` exported in Task 3, referenced by name only in tests. ✓
