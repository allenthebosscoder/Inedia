// src/fill-engine/adp-recruiting-fill.ts
import { EducationEntry, Profile, ProfileFieldKey, WorkHistoryEntry } from '../storage/profile-schema';
import { flagField, resolveProfileValue } from './fill-engine';
import { FillSummary } from './types';
import {
  DijitRegistry,
  DijitWidget,
  clickAndWait,
  describeWidget,
  getRegistryAsync,
  setDate,
  setSelect,
  setText,
  widgetForName,
} from './adp-recruiting-dojo';

interface AdpRecruitingOptions {
  addRowIntervalMs?: number;
  addRowMaxAttempts?: number;
}

// Temporary live-debugging instrumentation. One structured console line per autofill run on
// recruiting.adp.com so the exact widget shapes / match failures can be read from the page
// console without pasting probe scripts. Remove once the adapter is verified against real ADP.
const ADP_DEBUG = true;
let TRACE: unknown[] = [];

function trace(
  field: string,
  widget: DijitWidget | null,
  want: string,
  result: 'filled' | 'flagged' | 'skip-hidden' | 'skip-empty' | 'no-widget',
  extra?: Record<string, unknown>
): void {
  if (!ADP_DEBUG) return;
  TRACE.push({ field, want, result, widget: describeWidget(widget), ...extra });
}

// Date/select widgets on ADP are opaque templated composites; dump their DOM so the real editable
// control / hidden serialization node can be identified from a single live trace.
function widgetProbe(widget: DijitWidget | null): Record<string, unknown> {
  const dom = widget?.domNode;
  if (!dom) return {};
  try {
    return {
      domHTML: dom.outerHTML.replace(/\s+/g, ' ').slice(0, 1800),
      inputs: Array.from(dom.querySelectorAll('input, select')).map((i) => ({
        tag: i.tagName, name: (i as HTMLInputElement).name, type: (i as HTMLInputElement).type,
        value: (i as HTMLInputElement).value, widgetid: i.getAttribute('widgetid'),
      })),
      shownLabel: dom.querySelector('.dijitSelectLabel, .dijitButtonText')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 40),
    };
  } catch {
    return {};
  }
}

// The page console is easy to miss (wrong frame, filtered). Also drop the diagnostics into a
// fixed panel on the page so it can be copied with one selection.
function showDiagnosticsPanel(payload: unknown): void {
  if (!ADP_DEBUG || typeof document === 'undefined') return;
  try {
    const id = '__adp_autofill_diag';
    document.getElementById(id)?.remove();
    const box = document.createElement('textarea');
    box.id = id;
    box.readOnly = true;
    box.value = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1);
    box.setAttribute(
      'style',
      'position:fixed;bottom:8px;right:8px;width:420px;height:260px;z-index:2147483647;' +
      'font:11px/1.35 monospace;background:#111;color:#0f0;border:2px solid #0f0;padding:6px;' +
      'white-space:pre;overflow:auto;opacity:.95'
    );
    box.title = 'ADP autofill diagnostics — click, Cmd+A, Cmd+C, paste to support. Double-click to dismiss.';
    box.addEventListener('dblclick', () => box.remove());
    (document.body ?? document.documentElement).appendChild(box);
  } catch {
    // a CSP or detached document must not break the fill
  }
}

const EMPLOYER_MAX_ROWS = 6;
const EDUCATION_MAX_ROWS = 6;

type AdpFieldType = 'text' | 'select' | 'date';

interface AdpFlatField {
  name: string;
  profileKey: ProfileFieldKey;
  type: AdpFieldType;
  // Alternate control-name bases seen across ADP tenants; tried in order until a widget resolves.
  aliases?: string[];
}

// Field names captured from real recruiting.adp.com applications. The control name is
// `<name>_RTiCandidate`; `$$` marks ADP "custom-ish" standard fields.
export const ADP_RECRUITING_FLAT_FIELDS: AdpFlatField[] = [
  { name: 'firstName', profileKey: 'personal.firstName', type: 'text' },
  { name: 'middleName', profileKey: 'personal.middleName', type: 'text' },
  { name: 'lastName', profileKey: 'personal.lastName', type: 'text' },
  { name: 'email', profileKey: 'personal.email', type: 'text', aliases: ['email1', 'emailAddress', 'primaryEmail', 'emailId'] },
  { name: 'address1', profileKey: 'personal.address', type: 'text', aliases: ['addressLine1', 'address'] },
  { name: 'address2', profileKey: 'personal.addressLine2', type: 'text', aliases: ['addressLine2'] },
  { name: 'city', profileKey: 'personal.city', type: 'text' },
  { name: 'state', profileKey: 'personal.state', type: 'select', aliases: ['stateProvince', 'province'] },
  { name: 'country', profileKey: 'personal.country', type: 'select' },
  { name: 'zip', profileKey: 'personal.zip', type: 'text', aliases: ['zipCode', 'zipPostalCode', 'postalCode'] },
  { name: 'phone', profileKey: 'personal.phone', type: 'text', aliases: ['phoneNumber', 'primaryPhone', 'homePhone', 'mobilePhone'] },
  { name: '$$willingToRelocate', profileKey: 'jobPreferences.willingToRelocate', type: 'select' },
  { name: '$$authorizedToWork', profileKey: 'workAuthorization.authorizedToWork', type: 'select' },
  { name: '$$18yearsOfAge', profileKey: 'jobPreferences.atLeast18', type: 'select', aliases: ['$$atLeast18', '$$18YearsOrOlder', '$$ageEligible'] },
];

function writeByType(
  widget: NonNullable<ReturnType<typeof widgetForName>>,
  type: AdpFieldType,
  matchKey: ProfileFieldKey | null,
  value: string,
  registry?: DijitRegistry
): boolean {
  if (type === 'select') return setSelect(widget, matchKey, value, registry);
  if (type === 'date') return setDate(widget, value, registry);
  return setText(widget, value);
}

// The inner node `sweepRequired` inspects (input.dijitInputInner / textarea /
// table[role="listbox"]) — the same node `flagWidget` targets. In real Dojo the widget's
// `domNode` is an outer wrapper, not that inner control. We stamp `dataset.autofillFilled` /
// `dataset.autofillFlag` on it so the sweep can dedupe against both.
function controlNode(widget: DijitWidget): HTMLElement | null {
  return (
    widget.domNode?.querySelector<HTMLElement>(
      'input.dijitInputInner, textarea, table[role="listbox"]'
    ) ??
    widget.domNode ??
    null
  );
}

function flagWidget(widget: DijitWidget): void {
  const control = controlNode(widget);
  if (control) flagField(control);
}

// jsdom has no layout, so `offsetParent`/`getClientRects()` are always dead here. Walk ancestors
// for an explicit hidden signal instead: absence of layout info = treat as visible (works in
// jsdom); still catches the real case where ADP sets `display:none` on a conditional field's row.
function isHidden(el: HTMLElement): boolean {
  const canCompute = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function';
  // `visibility` is inherited, so the element's OWN computed value already reflects any
  // ancestor that set `visibility: hidden` — read it once instead of per ancestor.
  if (canCompute && window.getComputedStyle(el).visibility === 'hidden') return true;
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.hasAttribute('hidden')) return true;
    const inline = node.style;
    if (inline && (inline.display === 'none' || inline.visibility === 'hidden')) return true;
    if (canCompute && window.getComputedStyle(node).display === 'none') return true;
  }
  return false;
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
// accurate. Conditional (hidden) fields are skipped via the hidden check.
function sweepRequired(root: ParentNode): number {
  let flagged = 0;
  for (const wrapper of Array.from(root.querySelectorAll<HTMLElement>('.dojositeFld[data-dojosite-fld]'))) {
    const control = wrapper.querySelector<HTMLElement>(
      'input.dijitInputInner, textarea, table[role="listbox"]'
    );
    if (!control || isHidden(control) || control.dataset.autofillFlag || control.dataset.autofillFilled)
      continue;
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
    let widget: DijitWidget | null = null;
    for (const nm of [field.name, ...(field.aliases ?? [])]) {
      widget = widgetForName(`${nm}_RTiCandidate`, registry, root);
      if (widget) break;
    }
    const value = resolveProfileValue(profile, field.profileKey) ?? '';
    if (!widget) { trace(field.name, null, value, 'no-widget'); continue; }
    const control = controlNode(widget);
    // Skip ADP's conditional hidden fields — don't write, don't count.
    if (control && isHidden(control)) { trace(field.name, widget, value, 'skip-hidden'); continue; }
    if (!value) { trace(field.name, widget, value, 'skip-empty'); continue; } // sweepRequired handles flagging
    if (writeByType(widget, field.type, field.profileKey, value, registry)) {
      filled++;
      if (control) control.dataset.autofillFilled = '1';
      trace(field.name, widget, value, 'filled');
    } else {
      flagWidget(widget);
      flagged++;
      trace(field.name, widget, value, 'flagged');
    }
  }
  return { filled, flagged };
}

interface RepeatColumn<E> {
  base: string;
  type: AdpFieldType;
  matchKey?: ProfileFieldKey;
  // Alternate `base` names for the same column across ADP tenants; `_<row>` is appended to each.
  aliases?: string[];
  value(entry: E, profile: Profile): string;
}

// Returns the i-th comma-separated segment of a "City, State, Country" location string.
const locationPart = (loc: string, i: number) => (loc.split(',')[i] ?? '').trim();

// Column names captured from a real recruiting.adp.com Employment History section.
// `employerReference` is the "May We Contact?" Yes/No select (assumed — verify live).
const EMPLOYER_COLUMNS: RepeatColumn<WorkHistoryEntry>[] = [
  { base: 'employerType', type: 'select', value: (e) => (e.currentlyWorksHere ? 'Current' : 'Previous') },
  { base: 'employerName', type: 'text', value: (e) => e.company },
  { base: 'employerSupvPhone', type: 'text', aliases: ['employerPhone', 'supervisorPhone', 'employerContactPhone'], value: (e) => e.supervisorPhone ?? '' },
  { base: 'employerCity', type: 'text', value: (e) => locationPart(e.location ?? '', 0) },
  { base: 'employerCountry', type: 'select', matchKey: 'personal.country', value: (e, p) => locationPart(e.location ?? '', 2) || p.personal.country },
  { base: 'employerState', type: 'select', matchKey: 'personal.state', value: (e) => locationPart(e.location ?? '', 1) },
  { base: 'employerStartDate', type: 'date', value: (e) => e.startDate },
  { base: 'employerStartTitle', type: 'text', value: (e) => e.title },
  // End DATE is left blank for a current role (ADP's own hint: "If Current, please leave blank").
  { base: 'employerEndDate', type: 'date', value: (e) => (e.currentlyWorksHere ? '' : e.endDate) },
  // End Position/Title stays required on some tenants even for a current role — fill it with the
  // role title regardless.
  { base: 'employerEndTitle', type: 'text', value: (e) => e.title },
  { base: 'employerSupvName', type: 'text', aliases: ['supervisorName', 'employerSupervisor', 'employerContactName'], value: (e) => e.supervisorName ?? '' },
  { base: 'employerReference', type: 'select', value: (e) => e.mayContact ?? '' },
  { base: 'employerJobDuties', type: 'text', value: (e) => e.description },
  { base: 'employerReasonForLeaving', type: 'text', value: (e) => e.reasonForLeaving ?? '' },
];

// ADP's "Education Level" options -> our short `degree` codes / free text.
function adpDegreeLevel(degree: string): string {
  const d = degree.toLowerCase().trim();
  if (!d) return '';
  if (d === 'ged' || d.includes('high school') || d.includes('diploma') || d.startsWith('hs')) return 'GED High School Diploma';
  if (d.includes('doctor') || d.includes('phd') || d.startsWith('dr') || /\bd\.?(phil|sc|ed)\b/.test(d)) return 'Doctorate or Post Doctorate';
  if (d.includes('master') || /^(m\.?s|m\.?a|m\.?b\.?a|m\.?eng|meng|mfa|llm)\b/.test(d) || d.startsWith('m ')) return "Master's Level Degree";
  if (d.includes('bachelor') || /^(b\.?s|b\.?a|b\.?s\.?e|b\.?b\.?a|b\.?eng|beng|b\.?tech)\b/.test(d) || d.startsWith('b ')) return "Bachelor's Level Degree";
  if (d.includes('associate') || /^(a\.?a|a\.?s|a\.?a\.?s)\b/.test(d)) return 'Associate Degree';
  if (d.includes('cert')) return 'Certification';
  return degree;
}

function educationYear(e: EducationEntry): number {
  const s = e.endDate || e.graduationDate || e.endYear || e.startDate || '';
  const m = s.match(/\d{4}/);
  return m ? Number(m[0]) : 0;
}

// Column names captured from a real recruiting.adp.com Education section (Stellantis tenant).
const EDUCATION_COLUMNS: RepeatColumn<EducationEntry>[] = [
  { base: 'educationDegreeLevel', type: 'select', value: (e) => adpDegreeLevel(e.degree) },
  { base: 'educationSchoolName', type: 'text', aliases: ['educationSchool', 'schoolName'], value: (e) => e.school },
  { base: 'educationCity', type: 'text', value: (e, p) => locationPart(e.location ?? '', 0) || p.personal.city },
  { base: 'educationCountry', type: 'select', matchKey: 'personal.country', value: (e, p) => locationPart(e.location ?? '', 2) || p.personal.country },
  { base: 'educationState', type: 'select', matchKey: 'personal.state', value: (e, p) => locationPart(e.location ?? '', 1) || p.personal.state },
  { base: 'educationMajor', type: 'text', aliases: ['educationFieldOfStudy'], value: (e) => e.fieldOfStudy },
  {
    base: 'educationGraduated', type: 'select',
    value: (e) => {
      const yr = educationYear(e);
      return yr === 0 ? '' : (yr <= new Date().getFullYear() ? 'yes' : 'no');
    },
  },
];

function findAddButton(root: ParentNode, re: RegExp): HTMLElement | null {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('span.dijitButtonText, button, a'))) {
    if (re.test(el.textContent ?? '')) {
      // A `dijit/form/Button` puts `widgetid` on the OUTER domNode but binds its click handler to
      // the INNER `.dijitButtonNode` — clicking an ancestor never fires it. Target the inner node
      // (a click on any of its descendants bubbles up to the handler).
      return el.closest<HTMLElement>('.dijitButtonNode, button, a') ?? el;
    }
  }
  return null;
}

async function fillRepeatable<E>(
  profile: Profile,
  registry: DijitRegistry,
  root: ParentNode,
  options: Required<AdpRecruitingOptions>,
  cfg: { entries: E[]; anchorBase: string; maxRows: number; addButton: RegExp; columns: RepeatColumn<E>[] }
): Promise<FillSummary> {
  let filled = 0;
  let flagged = 0;
  const rowNameEl = (row: number): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[name="$$${cfg.anchorBase}_${row}_RTiCandidate"]`);
  if (!rowNameEl(1)) return { filled, flagged };
  const entries = cfg.entries.slice(0, cfg.maxRows);

  for (let i = 0; i < entries.length; i++) {
    const row = i + 1;
    // ADP pre-renders rows 2..N hidden; the "Add …" button reveals the next one. Click it whenever
    // this row's anchor control is missing OR still hidden, and wait for it to become visible.
    let nameEl = rowNameEl(row);
    if (row > 1 && (!nameEl || isHidden(nameEl))) {
      const button = findAddButton(root, cfg.addButton);
      if (button) {
        await clickAndWait(
          button,
          () => { const el = rowNameEl(row); return Boolean(el) && !isHidden(el as HTMLElement); },
          { intervalMs: options.addRowIntervalMs, maxAttempts: options.addRowMaxAttempts }
        );
      }
      nameEl = rowNameEl(row);
      if (!nameEl) break; // this row genuinely cannot be created
    }
    for (const col of cfg.columns) {
      let widget: DijitWidget | null = null;
      for (const b of [col.base, ...(col.aliases ?? [])]) {
        widget = widgetForName(`$$${b}_${row}_RTiCandidate`, registry, root);
        if (widget) break;
      }
      const value = col.value(entries[i], profile).trim();
      if (!widget) { trace(`${col.base}_${row}`, null, value, 'no-widget'); continue; }
      const control = controlNode(widget);
      // We have an entry for this row, so fill it even if `isHidden` is unsure — the reveal above
      // already gave it a chance to paint.
      if (!value) { trace(`${col.base}_${row}`, widget, value, 'skip-empty'); continue; }
      const probe = (col.type === 'date' || col.type === 'select') ? widgetProbe(widget) : undefined;
      if (writeByType(widget, col.type, col.matchKey ?? null, value, registry)) {
        filled++;
        if (control) control.dataset.autofillFilled = '1';
        trace(`${col.base}_${row}`, widget, value, 'filled', probe && { probe, probeAfter: widgetProbe(widget) });
      } else {
        flagWidget(widget);
        flagged++;
        trace(`${col.base}_${row}`, widget, value, 'flagged', probe && { probe, probeAfter: widgetProbe(widget) });
      }
    }
  }
  return { filled, flagged };
}

export async function fillAdpRecruitingForm(
  profile: Profile,
  root: ParentNode = document,
  options: AdpRecruitingOptions = {}
): Promise<FillSummary> {
  const timing: Required<AdpRecruitingOptions> = {
    addRowIntervalMs: options.addRowIntervalMs ?? 50,
    addRowMaxAttempts: options.addRowMaxAttempts ?? 20,
  };
  TRACE = [];
  const registry = await getRegistryAsync();
  const w = window as unknown as { require?: unknown; dijit?: { registry?: unknown }; dojo?: unknown };
  let widgetCount: unknown = 'n/a';
  try {
    const reg = registry as unknown as { toArray?: () => unknown[] };
    if (reg && typeof reg.toArray === 'function') widgetCount = reg.toArray().length;
  } catch { /* ignore */ }
  const env = {
    href: location.href,
    inIframe: window.top !== window.self,
    typeofRequire: typeof w.require,
    typeofDijit: typeof w.dijit,
    typeofDojo: typeof w.dojo,
    registryReachable: Boolean(registry),
    widgetCount,
    rtiFields: root.querySelectorAll('[name$="_RTiCandidate"],[name$="_RTiCandidateDate"]').length,
    dojositeFld: root.querySelectorAll('.dojositeFld[data-dojosite-fld]').length,
    employerName1: Boolean(root.querySelector('[name="$$employerName_1_RTiCandidate"]')),
    firstName: Boolean(root.querySelector('[name="firstName_RTiCandidate"]')),
  };
  // Full inventory of every ADP field on whatever page this is, so sections that aren't mapped
  // yet (Education, EEO, …) can be built from one live trace instead of guessing names.
  let pageFields: unknown[] = [];
  if (ADP_DEBUG && registry) {
    try {
      pageFields = Array.from(root.querySelectorAll<HTMLElement>('.dojositeFld[data-dojosite-fld]')).map((wrap) => {
        let meta: { name?: string; teName?: string } = {};
        try { meta = JSON.parse(decodeURIComponent(wrap.getAttribute('data-dojosite-fld') ?? '')); } catch { /* ignore */ }
        const control = wrap.querySelector<HTMLElement>('input, textarea, table[role="listbox"], select');
        const w = control ? registry.getEnclosingWidget(control) : undefined;
        const label = (wrap.closest('.element, .appPanel') ?? wrap).querySelector('label')?.textContent?.trim().slice(0, 40);
        return { name: meta.name, teName: meta.teName, label, widget: w ? describeWidget(w) : null };
      });
    } catch { /* ignore */ }
  }
  if (ADP_DEBUG) console.log('[autofill:adp-recruiting] env', JSON.stringify({ ...env, pageFields })); // eslint-disable-line no-console

  // No Dijit registry (script ran too early / not an ADP Dojo page): we can't drive widgets,
  // but still sweep so required blanks surface in the popup's "N need your input".
  if (!registry) {
    if (ADP_DEBUG) {
      console.log('[autofill:adp-recruiting] no registry — aborting fill'); // eslint-disable-line no-console
      showDiagnosticsPanel({ env, note: 'NO DIJIT REGISTRY — the fill could not run in this frame', trace: [] });
    }
    return { filled: 0, flagged: sweepRequired(root) };
  }
  const flat = await fillFlatFields(profile, registry, root);
  const employment = await fillRepeatable(profile, registry, root, timing, {
    entries: profile.workHistory,
    anchorBase: 'employerName',
    maxRows: EMPLOYER_MAX_ROWS,
    addButton: /add employer/i,
    columns: EMPLOYER_COLUMNS,
  });
  const education = await fillRepeatable(profile, registry, root, timing, {
    entries: profile.education,
    anchorBase: 'educationSchoolName',
    maxRows: EDUCATION_MAX_ROWS,
    addButton: /add (education|school|degree)/i,
    columns: EDUCATION_COLUMNS,
  });
  const sweptFlags = sweepRequired(root);
  const summary = {
    filled: flat.filled + employment.filled + education.filled,
    flagged: flat.flagged + employment.flagged + education.flagged + sweptFlags,
  };
  if (ADP_DEBUG) {
    console.log('[autofill:adp-recruiting] trace', JSON.stringify(TRACE, null, 1)); // eslint-disable-line no-console
    showDiagnosticsPanel({ env, summary, pageFields, trace: TRACE });
  }
  return summary;
}
