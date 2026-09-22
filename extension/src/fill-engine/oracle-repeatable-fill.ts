import { EducationEntry, Profile, WorkHistoryEntry } from '../storage/profile-schema';
import { flagField, setNativeValue } from './fill-engine';
import { normalize } from './synonym-dictionary';
import { FillSummary } from './types';
import { selectOracleGridValue } from './oracle-select';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bring-up instrumentation for a newer Oracle Recruiting "Candidate Experience" React UI: a live
// diagnostic showed an Experience editor genuinely open with Employer Name/Job Title visible but
// blank, meaning this got far enough to open the row but not to write it — surfacing exactly where
// each step succeeds or fails beats guessing at another blind fix.
function trace(entry: Record<string, unknown>): void {
  (window as unknown as { __jobAutofillOracleTrace?: unknown[] }).__jobAutofillOracleTrace
    ??= [];
  (window as unknown as { __jobAutofillOracleTrace: unknown[] }).__jobAutofillOracleTrace.push(entry);
}

async function waitFor<T>(read: () => T | null, attempts = 30): Promise<T | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = read();
    if (value) return value;
    await wait(50);
  }
  return null;
}

function visible(element: HTMLElement): boolean {
  // jsdom has no layout; accept connected controls there while using actual layout in Chrome.
  if (/jsdom/i.test(navigator.userAgent)) {
    return element.isConnected && !element.hidden && element.style.display !== 'none';
  }
  return element.offsetParent !== null || element.getClientRects().length > 0;
}

function clearFlag(element: HTMLElement): void {
  delete element.dataset.autofillFlag;
  element.style.outline = '';
}

function parseMonthYear(value: string): { month: number; year: number } | null {
  const monthFirst = value.match(/^(\d{1,2})\/(\d{4})$/);
  if (monthFirst) return { month: Number(monthFirst[1]), year: Number(monthFirst[2]) };
  const iso = value.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (iso) return { month: Number(iso[2]), year: Number(iso[1]) };
  const year = value.match(/^(\d{4})$/);
  return year ? { month: 5, year: Number(year[1]) } : null;
}

function fieldByLabel<T extends HTMLInputElement | HTMLTextAreaElement>(
  form: HTMLElement,
  label: string
): T | null {
  return Array.from(form.querySelectorAll<T>('input, textarea')).find((element) =>
    normalize(element.labels?.[0]?.textContent ?? element.getAttribute('aria-label') ?? '') === normalize(label)
  ) ?? null;
}

function write(element: HTMLInputElement | HTMLTextAreaElement | null, value: string): boolean {
  if (!element || !value) return false;
  if (element.value !== value) setNativeValue(element, value);
  element.blur();
  clearFlag(element);
  return true;
}

async function fillMonthYear(
  block: HTMLElement,
  prefix: 'startDate' | 'endDate',
  value: string
): Promise<FillSummary> {
  const date = parseMonthYear(value);
  if (!date) return { filled: 0, flagged: 0 };
  const monthCandidates = [
    MONTHS[date.month - 1], MONTHS[date.month - 1].slice(0, 3),
    String(date.month), String(date.month).padStart(2, '0'),
  ];
  const month = await selectOracleGridValue(
    () => currentEditor(block),
    `input[id^="month-${prefix}-"][role="combobox"]`,
    monthCandidates
  );
  const year = await selectOracleGridValue(
    () => currentEditor(block),
    `input[id^="year-${prefix}-"][role="combobox"]`,
    [String(date.year)]
  );
  const summary = { filled: Number(month) + Number(year), flagged: Number(!month) + Number(!year) };
  return summary;
}

async function fillCountry(block: HTMLElement, country: string): Promise<FillSummary> {
  const input = Array.from(currentEditor(block)?.querySelectorAll<HTMLInputElement>('input[role="combobox"]') ?? []).find((element) =>
    /^(?:employer )?country$/i.test(element.labels?.[0]?.textContent?.trim() ?? '')
  );
  if (!input || !country) {
    return { filled: 0, flagged: 0 };
  }
  const candidates = normalize(country) === 'united states'
    ? ['United States of America', 'United States']
    : [country];
  // Oracle preselects the tenant's default country in many newly added records. Treat that as
  // committed instead of reopening the grid: some tenants leave the grid's internal promise
  // pending even though the visible input already contains the exact saved option.
  if (candidates.map(normalize).includes(normalize(input.value))) {
    clearFlag(input);
    return { filled: 1, flagged: 0 };
  }
  const selector = input.id.startsWith('countryCode-')
    ? 'input[id^="countryCode-"][role="combobox"]'
    : `#${CSS.escape(input.id)}`;
  const selected = await selectOracleGridValue(
    () => currentEditor(block),
    selector,
    candidates
  );
  const summary = { filled: Number(selected), flagged: Number(!selected) };
  return summary;
}

function mappedDegree(degree: string): string {
  const value = normalize(degree);
  if (/\b(?:phd|doctor|doctoral)\b/.test(value)) return 'Doctorate degree';
  if (/\b(?:master|masters|ma|ms|mba)\b/.test(value)) return 'Master’s degree';
  if (/\b(?:associate|associates|aa|as)\b/.test(value)) return 'Associate degree';
  if (/\b(?:bachelor|bachelors|ba|bs|bsc)\b/.test(value)) return 'Bachelor’s degree';
  return degree;
}

function cardLines(card: HTMLElement): string[] {
  return (card.innerText || card.textContent || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
}

function cardIdentity(card: HTMLElement): { primary: string; secondary: string } {
  const lines = cardLines(card);
  const primaryWithDates = lines[1] ?? '';
  const primary = primaryWithDates
    .replace(/\s+\d{1,2}\/\d{4}\s*-\s*(?:\d{1,2}\/\d{4}|present)(?:\s+fields to fix:.*)?$/i, '')
    .trim();
  return { primary: normalize(primary), secondary: normalize(lines[0] ?? '') };
}

function findMatchingCard(
  cards: HTMLElement[],
  primary: string,
  secondary: string,
  used: Set<HTMLElement>
): HTMLElement | null {
  const normalizedPrimary = normalize(primary);
  const normalizedSecondary = normalize(secondary);
  let fallback: HTMLElement | null = null;
  for (const card of cards) {
    if (used.has(card)) continue;
    const identity = cardIdentity(card);
    if (identity.primary !== normalizedPrimary) continue;
    if (identity.secondary === normalizedSecondary) return card;
    fallback ??= card;
  }
  return fallback;
}

function blockForButton(button: HTMLElement): HTMLElement | null {
  return button.closest<HTMLElement>('apply-flow-block, .apply-flow-block');
}

function addButton(root: ParentNode, label: RegExp): HTMLButtonElement | null {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button[id^="profileItemsAddButton"]'))
    .find((button) => {
      if (!label.test(button.textContent ?? '')) return false;
      // Oracle keeps later application steps mounted in the DOM with their controls hidden. Only
      // reconcile the repeatable section the applicant can currently see; otherwise Contact Info
      // autofill can silently open an off-screen Experience editor and appear to hang. Checking
      // the section's own container rather than the button itself matters: confirmed live, Oracle
      // also hides this exact button whenever its own inline editor is already open in the
      // currently-visible section — that must not be mistaken for "this is an off-screen step".
      const block = blockForButton(button);
      return block !== null && visible(block);
    }) ?? null;
}

function editorIsEmpty(form: HTMLElement): boolean {
  // A checkbox/radio's .value attribute defaults to "on" regardless of whether it is actually
  // checked — this editor's own "Current Job" checkbox would otherwise always read as non-empty
  // and this check would never pass on the real page. Checked state, not the static value, is
  // what "empty" means for these.
  return Array.from(form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'))
    .every((element) =>
      element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)
        ? !element.checked
        : !element.value.trim()
    );
}

// Confirmed live: an Experience editor was stuck open (visible, every field blank) with the "Add
// Experience" button correctly hidden by Oracle's own UI while it's open, so a normal run could
// never even locate the button. Recover only when the stuck editor is entirely empty — a
// genuinely-in-progress manual edit the applicant is mid-typing must never be discarded.
async function recoverStuckEditor(block: HTMLElement, step: string): Promise<void> {
  const stuckForm = currentEditor(block);
  const empty = stuckForm ? editorIsEmpty(stuckForm) : false;
  const cancelled = stuckForm && empty ? await cancelEditor(block) : false;
  trace({ step, stuckFormFound: Boolean(stuckForm), empty, cancelled });
}

function cardsIn(block: HTMLElement): HTMLElement[] {
  return Array.from(block.querySelectorAll<HTMLElement>('.apply-flow-profile-item-tile'));
}

function currentEditor(block: HTMLElement): HTMLElement | null {
  return Array.from(block.querySelectorAll<HTMLElement>('.profile-item-content--form')).find(visible) ?? null;
}

async function openEditor(block: HTMLElement, trigger: HTMLElement): Promise<HTMLElement | null> {
  trigger.click();
  return waitFor(() => currentEditor(block));
}

function actionButton(block: HTMLElement, text: RegExp): HTMLButtonElement | null {
  return Array.from(block.querySelectorAll<HTMLButtonElement>('button'))
    // Oracle omits the type attribute on inline Save/Cancel. The DOM property still defaults to
    // "submit", while button[type=submit] misses both controls.
    .find((button) => button.type === 'submit' && visible(button) && text.test(button.textContent?.trim() ?? '')) ?? null;
}

async function saveEditor(block: HTMLElement, text: RegExp): Promise<boolean> {
  const button = actionButton(block, text);
  if (!button) return false;
  button.click();
  const closed = await waitFor(() =>
    !Array.from(block.querySelectorAll<HTMLElement>('.profile-item-content--form')).some(visible) ? true : null
  , 80);
  return Boolean(closed);
}

async function cancelEditor(block: HTMLElement): Promise<boolean> {
  actionButton(block, /^cancel$/i)?.click();
  const closed = await waitFor(() =>
    !Array.from(block.querySelectorAll<HTMLElement>('.profile-item-content--form')).some(visible) ? true : null
  , 40);
  return Boolean(closed);
}

function writeLiveField(
  block: HTMLElement,
  label: string,
  value: string
): boolean {
  const form = currentEditor(block);
  const field = form ? fieldByLabel(form, label) : null;
  const written = form ? write(field, value) : false;
  trace({
    step: 'writeLiveField', label, wanted: value,
    formFound: Boolean(form), fieldFound: Boolean(field),
    fieldId: field?.id || undefined,
    valueAfter: field?.value || undefined,
    written,
  });
  return written;
}

function workLocation(entry: WorkHistoryEntry, profile: Profile): { city: string; country: string } {
  const parts = (entry.location ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  const city = parts[0] ?? '';
  const normalizedLocation = normalize(entry.location ?? '');
  const country = normalizedLocation.includes('singapore') ? 'Singapore' : profile.personal.country;
  return { city, country };
}

async function fillWorkEditor(block: HTMLElement, entry: WorkHistoryEntry, profile: Profile): Promise<FillSummary> {
  let filled = 0;
  let flagged = 0;
  filled += Number(writeLiveField(block, 'Employer Name', entry.company));
  filled += Number(writeLiveField(block, 'Job Title', entry.title));
  const current = currentEditor(block)?.querySelector<HTMLInputElement>('input[id^="af-checkbox-currentJobFlag-"]');
  if (current && current.checked !== Boolean(entry.currentlyWorksHere)) current.click();
  if (current) filled++;
  const start = await fillMonthYear(block, 'startDate', entry.startDate);
  filled += start.filled;
  flagged += start.flagged;
  if (!entry.currentlyWorksHere && entry.endDate) {
    const end = await fillMonthYear(block, 'endDate', entry.endDate);
    filled += end.filled;
    flagged += end.flagged;
  }
  const location = workLocation(entry, profile);
  filled += Number(writeLiveField(block, 'Employer City', location.city));
  const country = await fillCountry(block, location.country);
  filled += country.filled;
  flagged += country.flagged;
  return { filled, flagged };
}

async function fillEducationEditor(block: HTMLElement, entry: EducationEntry, profile: Profile): Promise<FillSummary> {
  let filled = 0;
  let flagged = 0;
  filled += Number(writeLiveField(block, 'Degree', mappedDegree(entry.degree)));
  filled += Number(writeLiveField(block, 'Major', entry.fieldOfStudy));
  filled += Number(writeLiveField(block, 'School Name', entry.school));
  const start = await fillMonthYear(block, 'startDate', entry.startDate || (entry.startYear ? `05/${entry.startYear}` : ''));
  const end = await fillMonthYear(block, 'endDate', entry.endDate || entry.graduationDate || (entry.endYear ? `05/${entry.endYear}` : ''));
  filled += start.filled + end.filled;
  flagged += start.flagged + end.flagged;
  const country = await fillCountry(block, profile.personal.country);
  filled += country.filled;
  flagged += country.flagged;
  return { filled, flagged };
}

async function reconcileWork(profile: Profile, root: ParentNode): Promise<FillSummary> {
  let add = addButton(root, /add\s+experience/i);
  const block = add ? blockForButton(add) : null;
  trace({ step: 'reconcileWork:setup', addFound: Boolean(add), blockFound: Boolean(block), addVisible: add ? visible(add) : undefined });
  if (!add || !block) return { filled: 0, flagged: 0 };
  if (!visible(add)) {
    await recoverStuckEditor(block, 'reconcileWork:recoverStuckEditor');
    add = addButton(root, /add\s+experience/i);
    if (!add || !visible(add)) return { filled: 0, flagged: 0 };
  }
  let filled = 0;
  let flagged = 0;
  const used = new Set<HTMLElement>();
  const initiallyMatchedCompanies = new Set(cardsIn(block).map((card) => cardIdentity(card).primary));
  const entries = [...profile.workHistory].sort((left, right) =>
    Number(initiallyMatchedCompanies.has(normalize(right.company))) -
    Number(initiallyMatchedCompanies.has(normalize(left.company)))
  );

  for (const entry of entries) {
    const cards = cardsIn(block);
    const card = findMatchingCard(cards, entry.company, entry.title, used);
    trace({
      step: 'reconcileWork:entry', company: entry.company, title: entry.title,
      cardsInBlock: cards.length, cardFound: Boolean(card), alreadyDone: card?.dataset.jobAutofillOracleEntry === 'true',
    });
    if (card?.dataset.jobAutofillOracleEntry === 'true') {
      used.add(card);
      continue;
    }
    const trigger = card?.querySelector<HTMLElement>('button[aria-label="Edit"]') ?? add;
    const form = await openEditor(block, trigger);
    trace({ step: 'reconcileWork:openEditor', company: entry.company, editorOpened: Boolean(form) });
    if (!form) {
      if (card) flagField(card);
      flagged++;
      continue;
    }
    const entrySummary = await fillWorkEditor(block, entry, profile);
    const saved = await saveEditor(block, card ? /^save$/i : /^add\s+experience$/i);
    trace({ step: 'reconcileWork:save', company: entry.company, saved, entrySummary });
    if (!saved) {
      const cancelled = await cancelEditor(block);
      if (card) flagField(card);
      flagged++;
      // Oracle creates a draft tile as soon as Add is clicked. If validation keeps that editor
      // open, never proceed to the next profile entry: doing so reuses the same draft and mixes
      // the next role's text with the previous role's dates.
      if (!cancelled || !card) break;
      continue;
    }
    const refreshed = findMatchingCard(cardsIn(block), entry.company, entry.title, new Set());
    if (refreshed) {
      refreshed.dataset.jobAutofillOracleEntry = 'true';
      clearFlag(refreshed);
      used.add(refreshed);
    }
    filled += entrySummary.filled;
    flagged += entrySummary.flagged;
  }

  for (const card of cardsIn(block)) {
    if (used.has(card) || card.dataset.jobAutofillOracleEntry === 'true') continue;
    flagField(card);
    flagged++;
  }
  return { filled, flagged };
}

async function reconcileEducation(profile: Profile, root: ParentNode): Promise<FillSummary> {
  let add = addButton(root, /add\s+education/i);
  const block = add ? blockForButton(add) : null;
  trace({ step: 'reconcileEducation:setup', addFound: Boolean(add), blockFound: Boolean(block), addVisible: add ? visible(add) : undefined });
  if (!add || !block) return { filled: 0, flagged: 0 };
  if (!visible(add)) {
    await recoverStuckEditor(block, 'reconcileEducation:recoverStuckEditor');
    add = addButton(root, /add\s+education/i);
    if (!add || !visible(add)) return { filled: 0, flagged: 0 };
  }
  let filled = 0;
  let flagged = 0;
  const used = new Set<HTMLElement>();

  for (const entry of profile.education) {
    const cards = cardsIn(block);
    const card = findMatchingCard(cards, entry.school, entry.fieldOfStudy, used);
    trace({
      step: 'reconcileEducation:entry', school: entry.school, cardsInBlock: cards.length,
      cardFound: Boolean(card), alreadyDone: card?.dataset.jobAutofillOracleEntry === 'true',
    });
    if (card?.dataset.jobAutofillOracleEntry === 'true') {
      used.add(card);
      continue;
    }
    const trigger = card?.querySelector<HTMLElement>('button[aria-label="Edit"]') ?? add;
    const form = await openEditor(block, trigger);
    trace({ step: 'reconcileEducation:openEditor', school: entry.school, editorOpened: Boolean(form) });
    if (!form) {
      if (card) flagField(card);
      flagged++;
      continue;
    }
    const entrySummary = await fillEducationEditor(block, entry, profile);
    const saved = await saveEditor(block, card ? /^save$/i : /^add\s+education$/i);
    trace({ step: 'reconcileEducation:save', school: entry.school, saved, entrySummary });
    if (!saved) {
      const cancelled = await cancelEditor(block);
      if (card) flagField(card);
      flagged++;
      if (!cancelled || !card) break;
      continue;
    }
    const refreshed = findMatchingCard(cardsIn(block), entry.school, entry.fieldOfStudy, new Set());
    if (refreshed) {
      refreshed.dataset.jobAutofillOracleEntry = 'true';
      clearFlag(refreshed);
      used.add(refreshed);
    }
    filled += entrySummary.filled;
    flagged += entrySummary.flagged;
  }
  return { filled, flagged };
}

export async function fillOracleRepeatableSections(
  profile: Profile,
  root: ParentNode = document
): Promise<FillSummary> {
  (window as unknown as { __jobAutofillOracleTrace?: unknown[] }).__jobAutofillOracleTrace = [];
  const education = await reconcileEducation(profile, root);
  const work = await reconcileWork(profile, root);
  return {
    filled: education.filled + work.filled,
    flagged: education.flagged + work.flagged,
  };
}
