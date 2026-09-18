// src/fill-engine/adp-recruiting-dojo.ts
import { buildCandidates, findMatchIndex } from './fill-engine';

export interface DijitWidget {
  get(prop: string): unknown;
  set(prop: string, value: unknown): void;
  getOptions?(): { value: string; label: string }[];
  _handleOnChange?(value: unknown, priorityChange?: boolean): void;
  onChange?(value: unknown): void;
  domNode?: HTMLElement;
  focusNode?: HTMLElement;
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

// On a `dojoConfig async:true` build the synchronous `require('dijit/registry')` throws until the
// module has been pulled in. Fall back to the AMD callback form, bounded so a page that never
// loads the registry doesn't hang the run.
export function getRegistryAsync(timeoutMs = 800): Promise<DijitRegistry | null> {
  const sync = getRegistry();
  if (sync) return Promise.resolve(sync);
  const w = window as unknown as DojoWindow;
  if (typeof w.require !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: DijitRegistry | null) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      (w.require as (deps: string[], cb: (...m: unknown[]) => void) => void)(['dijit/registry'], (reg) => {
        finish(reg && typeof (reg as DijitRegistry).getEnclosingWidget === 'function' ? (reg as DijitRegistry) : null);
      });
    } catch {
      finish(getRegistry());
      return;
    }
    setTimeout(() => finish(getRegistry()), timeoutMs);
  });
}

export function widgetForName(
  name: string,
  registry: DijitRegistry,
  root: ParentNode = document
): DijitWidget | null {
  // 1. The control that carries the field name -> its enclosing widget.
  for (const sel of [`[name="${CSS.escape(name)}"]`, `[name="${CSS.escape(name + 'Date')}"]`]) {
    const node = root.querySelector<HTMLElement>(sel);
    if (node) {
      const widget = registry.getEnclosingWidget(node);
      if (widget) return widget;
    }
  }
  // 2. Fallback: match the `.dojositeFld` wrapper by its url-encoded field name, then resolve the
  // real form widget inside it. The hidden `_RTiCandidateDate` serialization input and other
  // nameless inputs are NOT inside the widget's domNode, so try the registered widget id first
  // (the wrapper's `.rw` holds `<div|table class="dijit ..." widgetid="...">`), then each
  // plausible inner control, before giving up.
  const base = name.replace(/_RTiCandidate(Date)?$/, '');
  for (const wrapper of Array.from(root.querySelectorAll<HTMLElement>('.dojositeFld[data-dojosite-fld]'))) {
    let meta: { name?: string };
    try {
      meta = JSON.parse(decodeURIComponent(wrapper.getAttribute('data-dojosite-fld') ?? ''));
    } catch {
      continue;
    }
    if (meta.name !== base) continue;
    for (const withId of Array.from(wrapper.querySelectorAll<HTMLElement>('.rw [widgetid], [widgetid]'))) {
      const id = withId.getAttribute('widgetid');
      const widget = id ? registry.byId(id) : undefined;
      if (widget && (typeof widget.get === 'function' || typeof widget.set === 'function')) return widget;
    }
    for (const inner of Array.from(wrapper.querySelectorAll<HTMLElement>(
      'input.dijitInputInner, input[role="combobox"], input[role="textbox"], textarea, table[role="listbox"]'
    ))) {
      const widget = registry.getEnclosingWidget(inner);
      if (widget) return widget;
    }
  }
  return null;
}

// Compact one-line description of a widget for diagnostics.
export function describeWidget(widget: DijitWidget | null): unknown {
  if (!widget) return null;
  let options: unknown = 'n/a';
  try {
    if (typeof widget.getOptions === 'function') {
      options = widget.getOptions().map((o) => o && o.label).slice(0, 8);
    }
  } catch (e) {
    options = `getOptions() threw: ${String((e as Error)?.message ?? e).slice(0, 60)}`;
  }
  let value: unknown;
  try {
    value = typeof widget.get === 'function' ? widget.get('value') : '(no get)';
  } catch {
    value = '(get threw)';
  }
  return {
    declaredClass: widget.declaredClass ?? '(unknown)',
    hasGetOptions: typeof widget.getOptions === 'function',
    options,
    currentValue: value instanceof Date ? `Date(${value.toISOString()})` : value,
  };
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
    const stored = String(widget.get('value') ?? '');
    if (stored === value) return true;
    // Masked inputs (e.g. a phone widget) reformat on commit: `9195551234` is stored as
    // `(919) 555-1234`. Accept a digits-only match when the requested value is all digits.
    if (/^\d+$/.test(value) && stored.replace(/\D/g, '') === value) return true;
    return false;
  } catch {
    return false;
  }
}

// ADP's country dropdown labels the option "United States" but the saved profile value is often
// the abbreviation. Expand it so the label matcher has something to hit.
function adpSelectCandidates(matchKey: string | null, value: string): string[] {
  const base = buildCandidates(matchKey, value);
  if (matchKey === 'personal.country' && /^(usa|us|u\.?\s?s\.?\s?a?\.?)$/i.test(value.trim())) {
    return ['United States', 'United States of America', ...base];
  }
  return base;
}

// dijit/form/Select option labels can be raw HTML (`<span class=label>Alabama&nbsp;</span>`,
// group headers in `<b>…</b>`). Strip markup and entities before matching.
function plainLabel(label: string): string {
  return label
    .replace(/<b\b[^>]*>.*?<\/b>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#?[a-z0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The visible selection label of a dijit/form/Select, or '' while it shows "— Please Specify —".
function selectShownLabel(widget: DijitWidget): string {
  const dom = widget.domNode;
  const node = dom?.querySelector<HTMLElement>('.dijitSelectLabel, .dijitButtonText');
  const text = plainLabel(node?.textContent ?? '');
  return /please specify|^select( one)?$/i.test(text) ? '' : text;
}

function selectCommitted(widget: DijitWidget, optionValue: string, candidates: string[]): boolean {
  try {
    if (String(widget.get('value') ?? '') === String(optionValue) && optionValue !== '') return true;
  } catch { /* fall through */ }
  const shown = selectShownLabel(widget);
  return Boolean(shown) && findMatchIndex([shown], candidates) !== null;
}

export function setSelect(
  widget: DijitWidget,
  matchKey: string | null,
  value: string,
  registry?: DijitRegistry
): boolean {
  const candidates = adpSelectCandidates(matchKey, value);
  const target = innerWidget(widget, registry, INNER_SELECT_SELECTOR);
  let options: { value: string; label: string }[] = [];
  try {
    if (typeof target.getOptions === 'function') options = target.getOptions() || [];
  } catch {
    options = [];
  }

  // Path A — dijit/form/Select: it exposes its full static <option> list. If the list is
  // non-empty it is authoritative: match against it, or fail (no guessing past a real list).
  if (options.length) {
    const index = findMatchIndex(options.map((o) => plainLabel(o.label)), candidates);
    if (index === null) return false;
    try {
      target.set('value', options[index].value);
      fireChange(target);
      if (target !== widget) { fireChange(widget); }
      return selectCommitted(target, options[index].value, candidates) || selectCommitted(widget, options[index].value, candidates);
    } catch {
      return false;
    }
  }

  // Path B — dijit/form/FilteringSelect / ComboBox: store-backed, getOptions() is absent or
  // empty. Setting `displayedValue` makes the widget resolve the label to its value via the
  // store; a resolved non-empty `value` whose displayed text matches a candidate is a hit.
  for (const candidate of candidates) {
    try {
      target.set('displayedValue', candidate);
      fireChange(target);
      const v = String(target.get('value') ?? '').trim();
      const shown = String(target.get('displayedValue') ?? '').trim();
      if (v && findMatchIndex([shown], candidates) !== null) return true;
    } catch {
      // try next candidate
    }
  }
  return false;
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

function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function dateCommitted(widget: DijitWidget, date: Date): boolean {
  const yyyy = String(date.getFullYear());
  try {
    const v = widget.get('value');
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
      // Day is not verified — ADP's control defaults it for MM/YYYY inputs.
      return v.getFullYear() === date.getFullYear() && v.getMonth() === date.getMonth();
    }
    if (typeof v === 'string' && v.includes(yyyy)) return true;
  } catch {
    // fall through to the DOM check
  }
  const dom = widget.domNode;
  if (dom) {
    // The placeholder is only shown while the DateTextBox has no value; if it is hidden and an
    // input shows the year, the widget has genuinely taken the date.
    const placeholder = dom.querySelector<HTMLElement>('.dijitPlaceHolder');
    const placeholderHidden = !placeholder || placeholder.style.display === 'none' || placeholder.offsetParent === null;
    for (const input of Array.from(dom.querySelectorAll('input'))) {
      if (input.type !== 'hidden' && input.value.includes(yyyy) && placeholderHidden) return true;
    }
    const hidden = dom.querySelector<HTMLInputElement>('input[type="hidden"][name$="_RTiCandidateDate"]');
    if (hidden && hidden.value.includes(yyyy)) return true;
  }
  return false;
}

// ADP's Fld-* controls render an outer `_WidgetsInTemplateMixin` wrapper around the real dijit
// form widget (DateTextBox, Select, …). Setting the wrapper's value does not reach the child, the
// visible box, or the eForm serialization, so resolve the inner widget and drive that.
function innerWidget(widget: DijitWidget, registry: DijitRegistry | undefined, selector: string): DijitWidget {
  if (!registry || !widget.domNode) return widget;
  for (const el of Array.from(widget.domNode.querySelectorAll<HTMLElement>(selector))) {
    const id = el.getAttribute('widgetid');
    const child = id ? registry.byId(id) : undefined;
    if (child && child !== widget && typeof child.set === 'function') return child;
  }
  return widget;
}

const INNER_DATE_SELECTOR = '.dijitDateTextBox[widgetid], [widgetid].dijitDateTextBox';
const INNER_SELECT_SELECTOR =
  '.dijitSelect[widgetid], .dijitComboBox[widgetid], .dijitFilteringSelect[widgetid], [widgetid][role="listbox"], [widgetid][role="combobox"]';

export function setDate(widget: DijitWidget, raw: string, registry?: DijitRegistry): boolean {
  const date = parseAdpDate(raw);
  if (!date) return false;
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  const slash = `${mm}/${dd}/${yyyy}`;
  const iso = `${yyyy}-${mm}-${dd}`;

  const target = innerWidget(widget, registry, INNER_DATE_SELECTOR);

  // 1. Canonical dijit/form/DateTextBox path: repaints, hides the placeholder, fires onChange, and
  // lets the eForm write its serialization node — so it passes validation. `displayedValue` first
  // for the string parse, then `set('value', Date)` last so the widget ends on the Date.
  try { target.set('displayedValue', slash); } catch { /* not all widgets expose it */ }
  try { target.set('value', date); } catch { /* try the strings / DOM below */ }
  fireChange(target);
  if (target !== widget) fireChange(widget);
  if (dateCommitted(target, date) || dateCommitted(widget, date)) return true;

  // 2. Templated ADP date widgets keep their visible box in a child node the parent's `set` does
  // not repaint. Type the date into every editable input the widget owns, and stamp the hidden
  // `_RTiCandidateDate` serialization input so the form submits the value regardless of display.
  const dom = widget.domNode;
  if (dom) {
    for (const input of Array.from(dom.querySelectorAll('input'))) {
      try {
        if (input.type === 'hidden') {
          if (/_RTiCandidate(Date)?$/.test(input.name)) setNativeValue(input, slash);
          continue;
        }
        if (input.readOnly || input.disabled || input.getAttribute('role') === 'presentation') continue;
        setNativeValue(input, input.type === 'date' ? iso : slash);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      } catch {
        // keep going with the other inputs
      }
    }
  }
  const focus = widget.focusNode;
  if (focus instanceof HTMLInputElement && !focus.value.includes(yyyy)) {
    try {
      setNativeValue(focus, slash);
      focus.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    } catch { /* ignore */ }
  }
  fireChange(widget);

  return dateCommitted(widget, date);
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
