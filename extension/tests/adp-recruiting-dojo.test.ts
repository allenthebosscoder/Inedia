import { afterEach, describe, expect, it } from 'vitest';
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

function fakeDateWidget(): DijitWidget {
  let value: unknown = undefined;
  return {
    get: () => value,
    set: (_p, v) => { value = v; },
    domNode: document.createElement('div'),
  };
}

function frozenDateWidget(prior: Date): DijitWidget {
  return {
    get: () => prior,
    set: () => { /* no-op: widget rejects the value */ },
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

  it('falls back to the .dojositeFld wrapper matched by decoded field name', () => {
    const meta = encodeURIComponent(JSON.stringify({ name: '$$employerStartDate_1' }));
    document.body.innerHTML =
      `<div class="dojositeFld" data-dojosite-fld="${meta}">` +
      `<div class="rw"><input class="dijitInputInner"></div></div>`;
    const node = document.querySelector('input.dijitInputInner')!;
    const widget = fakeTextWidget();
    const reg = {
      byId: () => undefined,
      getEnclosingWidget: (n: Node) => (n === node ? widget : undefined),
    } as DijitRegistry;
    expect(widgetForName('$$employerStartDate_1_RTiCandidate', reg)).toBe(widget);
  });
});

describe('setText / setSelect / setDate', () => {
  it('setText writes the value and fires change', () => {
    const w = fakeTextWidget();
    expect(setText(w, 'Allen')).toBe(true);
    expect(w.get('value')).toBe('Allen');
    expect(w.changed).toBe('Allen');
  });

  it('setText accepts a masked reformat of a digits-only value (phone widget)', () => {
    let stored = '';
    const w: DijitWidget = {
      get: () => stored,
      set: (_p, v) => {
        const d = String(v).replace(/\D/g, '');
        stored = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
      },
      domNode: document.createElement('div'),
    };
    expect(setText(w, '9195551234')).toBe(true);
    expect(w.get('value')).toBe('(919) 555-1234');
  });

  it('setText rejects a mismatch that is not just a mask reformat', () => {
    const w: DijitWidget = {
      get: () => 'Bob',
      set: () => { /* widget keeps its own value */ },
      domNode: document.createElement('div'),
    };
    expect(setText(w, 'Allen')).toBe(false);
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

  it('setSelect expands a "USA" country value and matches ADP HTML option labels', () => {
    const w = fakeSelectWidget([
      { value: '', label: '<span>— Please Specify —</span>' },
      { value: 'USA', label: '​<span class=label>United States&nbsp;</span>' },
      { value: 'AFG', label: '<b>Other Countries</b><br>&nbsp;&nbsp;​<span class=label>Afghanistan&nbsp;</span>' },
    ]);
    expect(setSelect(w, 'personal.country', 'USA')).toBe(true);
    expect(w.get('value')).toBe('USA');
  });

  it('setSelect matches a state through a group-header HTML option label', () => {
    const w = fakeSelectWidget([
      { value: '', label: '— Please Specify —' },
      { value: 'AL', label: '<b>United States</b><br>&nbsp;​<span class=label>Alabama&nbsp;</span>' },
      { value: 'NC', label: '&nbsp;​<span class=label>North Carolina&nbsp;</span>' },
    ]);
    expect(setSelect(w, 'personal.state', 'NC')).toBe(true);
    expect(w.get('value')).toBe('NC');
  });

  it('setDate parses MM/YYYY and confirms the widget stored that date', () => {
    const w = fakeDateWidget();
    expect(setDate(w, '06/2023')).toBe(true);
    const stored = w.get('value');
    expect(stored).toBeInstanceOf(Date);
    expect((stored as Date).getFullYear()).toBe(2023);
    expect((stored as Date).getMonth()).toBe(5);
  });

  it('setDate returns false when the widget did not accept the parsed date', () => {
    const w = frozenDateWidget(new Date(2000, 0, 1));
    expect(setDate(w, '06/2023')).toBe(false);
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
