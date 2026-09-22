import { EducationEntry, Profile, WorkHistoryEntry } from '../storage/profile-schema';
import { ComboboxFillOptions, fillComboboxFields } from './combobox-fill';
import { findMatchIndex, flagField, setNativeValue } from './fill-engine';
import { FillSummary } from './types';
import { isCancelled } from './cancellation';

const WAIT_MS = 50;
const MAX_ATTEMPTS = 20;
// Some Workday tenants take several seconds to mount a repeatable row after Add.
const ROW_ADD_MAX_ATTEMPTS = 8;
const MAX_YEAR_NAVIGATION = 150;

type RepeatableKind = 'workExperience' | 'education';
type ReactHandler = (event: Record<string, unknown>) => void;

export interface WorkdayRepeatableFillOptions {
  combobox?: ComboboxFillOptions;
  workStartIndex?: number;
  educationStartIndex?: number;
  skipEducation?: boolean;
  requireVisibleExperienceStep?: boolean;
}

function isElementVisible(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    if (current.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
    current = current.parentElement;
  }
  return true;
}

function isOnVisibleMyExperienceStep(): boolean {
  const headingMatch = Array.from(document.querySelectorAll<HTMLElement>('h1,h2,h3,[role="heading"]'))
    .some((heading) => /^(my experience|work experience|education|experience & education|experience and education)$/i
      .test((heading.textContent ?? '').replace(/\s+/g, ' ').trim()) && isElementVisible(heading));
  if (headingMatch) return true;
  // Cisco (and other tenants) drop the step from the URL and relabel the heading once inside the
  // SPA. A visible work-experience or education row editor is an unambiguous signal we are on the
  // right step.
  return Array.from(document.querySelectorAll<HTMLElement>(
    '[id^="workExperience-"][id*="--jobTitle"], [id^="workExperience-"][id*="--companyName"], [id^="education-"][id*="--school"]'
  )).some((input) => input instanceof HTMLInputElement && isElementVisible(input));
}

// Workday defers a newly added repeatable row until the current injected script returns. The
// background runner calls this small Add-only step across separate executions, then performs one
// real fill pass after every required editor exists.
export function prepareNextWorkdayRepeatableRow(profile: Profile): boolean {
  if (!isOnVisibleMyExperienceStep()) return false;
  if (rowGroups('workExperience').size < profile.workHistory.length) {
    const addWork = findAddButton('workExperience');
    if (addWork) {
      addWork.click();
      return true;
    }
  }
  if (rowGroups('education').size < profile.education.length) {
    const addEducation = findAddButton('education');
    if (addEducation) {
      addEducation.click();
      return true;
    }
  }
  return false;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rowGroups(kind: RepeatableKind): Map<string, HTMLElement[]> {
  const groups = new Map<string, HTMLElement[]>();
  document.querySelectorAll<HTMLElement>(`[id^="${kind}-"][id*="--"]`).forEach((element) => {
    const match = element.id.match(new RegExp(`^${kind}-(.+?)--`));
    if (!match) return;
    const elements = groups.get(match[1]) ?? [];
    elements.push(element);
    groups.set(match[1], elements);
  });
  return groups;
}

function findAddButton(kind: RepeatableKind): HTMLElement | null {
  const kindWords = kind === 'workExperience' ? ['work experience', 'experience'] : ['education', 'school'];
  const buttons = Array.from(document.querySelectorAll<HTMLElement>('button'));

  return buttons.find((button) => {
    const automationId = (button.getAttribute('data-automation-id') ?? '').toLowerCase();
    return automationId.includes('add') && kindWords.some((word) => automationId.includes(word.replace(/\s/g, '')));
  }) ?? (() => {
    const headingPattern = kind === 'workExperience' ? /^(employment history|work experience)$/i : /^education$/i;
    const heading = Array.from(document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,legend,[role="heading"]'))
      .find((element) => headingPattern.test((element.textContent ?? '').replace(/\s+/g, ' ').trim()));
    if (!heading) return null;
    return buttons.find((button) => {
      const text = (button.textContent ?? '').replace(/\s+/g, ' ').trim();
      return /\badd\b/i.test(text) && Boolean(heading.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING);
    }) ?? null;
  })() ?? buttons.find((button) => {
    const text = (button.textContent ?? '').toLowerCase().trim();
    if (!text.includes('add')) return false;
    let ancestor: HTMLElement | null = button;
    for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
      const context = `${ancestor.getAttribute('data-automation-id') ?? ''} ${ancestor.getAttribute('aria-label') ?? ''} ${ancestor.textContent ?? ''}`.toLowerCase();
      if (kindWords.some((word) => context.includes(word))) return true;
    }
    return false;
  }) ?? null;
}

async function ensureRow(kind: RepeatableKind, index: number): Promise<HTMLElement[] | null> {
  let groups = rowGroups(kind);
  const primarySuffixes = kind === 'workExperience' ? ['jobTitle', 'title'] : ['school', 'schoolName'];
  const findBlankEditableRow = (): HTMLElement[] | undefined => Array.from(groups.values()).find((elements) => {
    const primary = bySuffix(elements, primarySuffixes);
    return primary !== null && 'value' in primary && !String(primary.value ?? '').trim();
  });
  const hasEditableControl = (els: HTMLElement[]): boolean =>
    els.some((el) =>
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement);
  const existing = Array.from(groups.values())[index];
  // Reuse an existing row rather than adding a duplicate: the primary editor, or failing that any
  // editable control in the group, means the row is already usable.
  if (existing && (bySuffix(existing, primarySuffixes) !== null || hasEditableControl(existing))) return existing;

  while (true) {
    const addButton = findAddButton(kind);
    if (!addButton) return null;
    const priorIds = new Set(groups.keys());
    addButton.click();
    for (let attempt = 0; attempt < ROW_ADD_MAX_ATTEMPTS; attempt++) {
      await wait(WAIT_MS);
      groups = rowGroups(kind);
      const blankEditableRow = findBlankEditableRow();
      if (blankEditableRow) return blankEditableRow;
      const newId = Array.from(groups.keys()).find((id) => !priorIds.has(id));
      if (newId) return groups.get(newId) ?? null;
      const indexed = Array.from(groups.values())[index];
      if (indexed) return indexed;
    }
    return null;
  }
}

function bySuffix(elements: HTMLElement[], suffixes: string[]): HTMLElement | null {
  const matches = elements.filter((element) => {
    const suffix = element.id.split('--').at(-1)?.toLowerCase() ?? '';
    return suffixes.some((candidate) => suffix === candidate.toLowerCase() || suffix.startsWith(`${candidate.toLowerCase()}-`));
  });
  const directControl = matches.find((element) =>
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
  );
  if (directControl) return directControl;
  for (const match of matches) {
    const nested = match.querySelector<HTMLElement>('input, textarea, select, [aria-haspopup="listbox"]');
    if (nested) return nested;
  }
  return matches[0] ?? null;
}

function isCombobox(element: HTMLElement): boolean {
  return element.getAttribute('aria-haspopup') === 'listbox' || element.matches('input[data-uxi-widget-type="selectinput"]');
}

function invokeReactHandler(element: HTMLElement, handlerName: 'onInput' | 'onChange' | 'onBlur'): void {
  const propsKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
  if (!propsKey) return;
  const props = (element as unknown as Record<string, unknown>)[propsKey] as Record<string, unknown> | undefined;
  const handler = props?.[handlerName] as ReactHandler | undefined;
  if (typeof handler !== 'function') return;

  const type = handlerName === 'onInput' ? 'input' : handlerName === 'onChange' ? 'change' : 'blur';
  const nativeEvent = new Event(type, { bubbles: true, cancelable: true });
  let defaultPrevented = false;
  let propagationStopped = false;
  handler({
    type,
    target: element,
    currentTarget: element,
    nativeEvent,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    eventPhase: Event.AT_TARGET,
    isTrusted: false,
    timeStamp: nativeEvent.timeStamp,
    preventDefault: () => { defaultPrevented = true; },
    isDefaultPrevented: () => defaultPrevented,
    stopPropagation: () => { propagationStopped = true; },
    isPropagationStopped: () => propagationStopped,
    persist: () => undefined,
    isPersistent: () => true,
  });
}

function invokeReactKeyDown(element: HTMLElement, key: string): void {
  const propsKey = Object.keys(element).find((candidate) => candidate.startsWith('__reactProps$'));
  if (!propsKey) return;
  const props = (element as unknown as Record<string, unknown>)[propsKey] as Record<string, unknown> | undefined;
  const handler = props?.onKeyDown as ReactHandler | undefined;
  if (typeof handler !== 'function') return;

  const nativeEvent = new KeyboardEvent('keydown', {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
  });
  let defaultPrevented = false;
  let propagationStopped = false;
  handler({
    type: 'keydown',
    key,
    target: element,
    currentTarget: element,
    nativeEvent,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    eventPhase: Event.AT_TARGET,
    isTrusted: false,
    timeStamp: nativeEvent.timeStamp,
    preventDefault: () => { defaultPrevented = true; },
    isDefaultPrevented: () => defaultPrevented,
    stopPropagation: () => { propagationStopped = true; },
    isPropagationStopped: () => propagationStopped,
    persist: () => undefined,
    isPersistent: () => true,
  });
}

async function leaveDateWidget(yearInput: HTMLElement): Promise<void> {
  const wrapper = yearInput.closest<HTMLElement>('[data-automation-id="dateInputWrapper"]');
  if (!wrapper) return;
  yearInput.focus();

  // A physical Tab first lands on Workday's calendar button, and the second leaves the widget.
  // Programmatic KeyboardEvents do not execute that native focus navigation, so reproduce the
  // actual focus path explicitly to trigger the wrapper's focus-out commit.
  // The calendar icon is a sibling of dateInputWrapper, not its descendant. Walk outward only
  // until both controls share a container; stopping at the wrapper reproduces just the first Tab.
  let widgetScope: HTMLElement = wrapper;
  let calendarControl: HTMLElement | null = null;
  for (let depth = 0; widgetScope && depth < 5; depth++) {
    calendarControl = widgetScope.querySelector<HTMLElement>('[data-automation-id="dateIcon"][tabindex="0"]');
    if (calendarControl) break;
    if (!widgetScope.parentElement) break;
    widgetScope = widgetScope.parentElement;
  }
  calendarControl?.focus();
  await wait(0);

  const focusables = Array.from(document.querySelectorAll<HTMLElement>(
    'input, button, select, textarea, [tabindex="0"]'
  )).filter((element) => !element.hasAttribute('disabled'));
  const lastWrapperIndex = focusables.reduce(
    (last, element, index) => widgetScope.contains(element) ? index : last,
    -1
  );
  const outsideControl = focusables.slice(lastWrapperIndex + 1).find((element) => !widgetScope.contains(element));
  if (outsideControl) {
    outsideControl.focus();
  } else {
    const priorTabIndex = document.body.getAttribute('tabindex');
    document.body.tabIndex = -1;
    document.body.focus();
    if (priorTabIndex === null) document.body.removeAttribute('tabindex');
    else document.body.setAttribute('tabindex', priorTabIndex);
  }
  await wait(0);
}

function calendarControlFor(input: HTMLElement): HTMLElement | null {
  const wrapper = input.closest<HTMLElement>('[data-automation-id="dateInputWrapper"]') ?? input.parentElement;
  if (!wrapper) return null;
  let scope: HTMLElement | null = wrapper;
  for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
    const controls = Array.from(scope.querySelectorAll<HTMLElement>('[data-automation-id="dateIcon"]'));
    if (controls.length === 1) return controls[0];
    if (controls.length > 1) {
      const inputRect = input.getBoundingClientRect();
      const inputCenterX = inputRect.left + inputRect.width / 2;
      const inputCenterY = inputRect.top + inputRect.height / 2;
      return controls.reduce((nearest, candidate) => {
        const distance = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          return Math.hypot(rect.left + rect.width / 2 - inputCenterX, rect.top + rect.height / 2 - inputCenterY);
        };
        return distance(candidate) < distance(nearest) ? candidate : nearest;
      });
    }
  }
  return null;
}

async function visibleMonthPicker(): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const picker = Array.from(document.querySelectorAll<HTMLElement>('[data-automation-id="monthPicker"]'))
      .find((element) => element.getClientRects().length > 0 || element.offsetParent !== null);
    if (picker) return picker;
    await wait(WAIT_MS);
  }
  return null;
}

async function selectDateFromPicker(input: HTMLElement, month: string, year: string): Promise<boolean> {
  if (!month || !year) return false;
  const calendarControl = calendarControlFor(input);
  if (!calendarControl) return false;
  calendarControl.click();
  const picker = await visibleMonthPicker();
  if (!picker) return false;

  const targetYear = Number(year);
  const yearLabel = picker.querySelector<HTMLElement>('[data-automation-id="monthPickerSpinnerLabel"]');
  let currentYear = Number(yearLabel?.textContent?.trim());
  if (!Number.isInteger(targetYear) || !Number.isInteger(currentYear)) return false;

  for (let step = 0; currentYear !== targetYear && step < MAX_YEAR_NAVIGATION; step++) {
    const buttons = Array.from(picker.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    if (buttons.length < 2) return false;
    const direction = targetYear < currentYear ? -1 : 1;
    const button = direction < 0 ? buttons[0] : buttons[buttons.length - 1];
    const previousYear = currentYear;
    button.click();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await wait(WAIT_MS);
      currentYear = Number(yearLabel?.textContent?.trim());
      if (currentYear !== previousYear) break;
    }
    if (currentYear === previousYear || !Number.isInteger(currentYear)) return false;
  }
  if (currentYear !== targetYear) return false;

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const targetMonth = monthNames[Number(month) - 1];
  if (!targetMonth) return false;
  const tile = Array.from(picker.querySelectorAll<HTMLElement>('[data-automation-id="monthPickerTile"]'))
    .find((element) => {
      const label = element.querySelector<HTMLElement>('[data-automation-id="monthPickerTileLabel"]');
      return (label?.getAttribute('title') || label?.textContent || '').trim().slice(0, 3) === targetMonth;
    });
  if (!tile) return false;
  // The outer <li> carries Workday's month/year metadata, but its inner role=button owns the
  // selection action. Clicking the <li> can update the visible MM/YYYY sections without updating
  // the parent form value, which then disappears during Save and Continue validation.
  const tileControl = tile.querySelector<HTMLElement>('[role="button"], button, [tabindex="0"]') ?? tile;
  tileControl.click();
  // Workday tenants vary in how quickly a picker selection remounts its repeatable row. Moving
  // straight to the adjacent To field can target the old, about-to-be-detached row: it looks like
  // the click succeeded, but the new row renders with an empty year. Wait for either that remount
  // or a short stable period before the caller re-queries the row.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await wait(WAIT_MS);
    const currentInput = document.getElementById(input.id);
    if (!input.isConnected || currentInput !== input) break;
    if (attempt >= 4) break;
  }
  return true;
}

async function fillValue(
  element: HTMLElement | null,
  value: string,
  comboboxOptions: ComboboxFillOptions,
  candidates?: string[]
): Promise<FillSummary> {
  if (!value) return { filled: 0, flagged: 0 };
  if (!element) return { filled: 0, flagged: 0 };
  element.dataset.jobAutofillRepeatable = 'true';

  if (isCombobox(element)) {
    const profile = {
      personal: { city: value },
    } as Profile;
    return fillComboboxFields(
      [{ element, label: '', kind: 'combobox', profileKey: 'personal.city', candidates }],
      profile,
      comboboxOptions
    );
  }

  if (element instanceof HTMLSelectElement && candidates) {
    const options = Array.from(element.options);
    const matchIndex = findMatchIndex(options.map((option) => option.textContent ?? ''), candidates);
    if (matchIndex === null) {
      flagField(element);
      return { filled: 0, flagged: 1 };
    }
    setNativeValue(element, options[matchIndex].value);
    return { filled: 1, flagged: 0 };
  }

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    delete element.dataset.autofillFlag;
    element.style.outline = '';
    element.focus();
    // This runs in the page's MAIN world. The prototype setter deliberately bypasses React's
    // instance-level value tracker, leaving its previous value intact; the following input event
    // therefore reaches Workday's onInput as a real old-to-new change. execCommand must not be
    // used here because it advances _valueTracker before the event and React ignores the change.
    setNativeValue(element, value);
    // Workday's repeatable form keeps its own state in the element's onInput callback. Its React
    // delegation layer can still discard programmatic events even in MAIN world, so invoke the
    // exact handler exposed on this element as the authoritative state update.
    invokeReactHandler(element, 'onInput');
    invokeReactHandler(element, 'onChange');
    // React 18 batches state updates made outside its delegated event transaction. Yield before
    // blur so Workday does not validate the previous empty state in its onBlur callback.
    await wait(0);
    element.blur();
    invokeReactHandler(element, 'onBlur');
    return { filled: 1, flagged: 0 };
  }

  flagField(element);
  return { filled: 0, flagged: 1 };
}

function normalizeMonthYear(value: string): string {
  const isoMatch = value.match(/^(\d{4})-(\d{1,2})$/);
  if (isoMatch) return `${isoMatch[2].padStart(2, '0')}/${isoMatch[1]}`;
  return value;
}

function monthYearParts(value: string): { month: string; year: string } {
  const normalized = normalizeMonthYear(value);
  const match = normalized.match(/^(\d{1,2})\/(\d{4})$/);
  if (match) return { month: match[1].padStart(2, '0'), year: match[2] };
  return { month: '', year: normalized.match(/^\d{4}$/)?.[0] ?? '' };
}

async function fillDate(
  elements: HTMLElement[],
  fieldNames: string[],
  value: string,
  includeMonth: boolean,
  comboboxOptions: ComboboxFillOptions
): Promise<FillSummary> {
  if (!value) return { filled: 0, flagged: 0 };
  const { month, year } = monthYearParts(value);
  const matchesField = (element: HTMLElement) => fieldNames.some((name) =>
    element.id.toLowerCase().includes(`--${name.toLowerCase()}-`)
  );
  const monthInput = elements.find((element) =>
    matchesField(element) && element.id.endsWith('dateSectionMonth-input')
  ) ?? null;
  const yearInput = elements.find((element) =>
    matchesField(element) && element.id.endsWith('dateSectionYear-input')
  ) ?? null;

  // Workday owns the composite value on dateInputWrapper. Updating the two visible spinbuttons
  // can make MM/YYYY appear correct without updating that parent value, so submit still reports
  // the date as empty. Selecting a real month tile runs Workday's own picker callback and commits
  // the composite date atomically. Keep the spinbutton path only as a compatibility fallback for
  // Workday variants that do not render a month picker (including year-only education controls).
  if (includeMonth && yearInput && await selectDateFromPicker(yearInput, month, year)) {
    return { filled: 1, flagged: 0 };
  }

  let success = true;
  if (includeMonth) {
    // Workday's date spinbutton calls validateAndUpdate with an unpadded numeric month. Passing
    // the profile's canonical "05" can display as May while the component rejects its internal
    // value, leaving the composite date missing at submit time.
    const workdayMonth = month ? String(Number(month)) : '';
    const monthSummary = await fillValue(monthInput, workdayMonth, comboboxOptions);
    success = success && monthSummary.filled === 1;
  }
  const yearSummary = await fillValue(yearInput, year, comboboxOptions);
  success = success && yearSummary.filled === 1;
  if (success && yearInput) {
    // Workday's composite date has no onBlur handler on its section inputs. Its onKeyDown path
    // explicitly handles Tab and commits the accepted month/year sections to the parent date.
    invokeReactKeyDown(yearInput, 'Tab');
    await leaveDateWidget(yearInput);
  }
  return success ? { filled: 1, flagged: 0 } : { filled: 0, flagged: 1 };
}

function dateMatches(
  elements: HTMLElement[],
  fieldNames: string[],
  value: string,
  includeMonth: boolean
): boolean {
  const { month, year } = monthYearParts(value);
  const matchesField = (element: HTMLElement) => fieldNames.some((name) =>
    element.id.toLowerCase().includes(`--${name.toLowerCase()}-`)
  );
  const yearInput = elements.find((element) =>
    matchesField(element) && element.id.endsWith('dateSectionYear-input')
  );
  if (!(yearInput instanceof HTMLInputElement) || yearInput.value !== year) return false;
  if (!includeMonth) return true;
  const monthInput = elements.find((element) =>
    matchesField(element) && element.id.endsWith('dateSectionMonth-input')
  );
  return monthInput instanceof HTMLInputElement && Number(monthInput.value) === Number(month);
}

async function fillWorkDateWithVerification(
  rowId: string | undefined,
  fallbackElements: HTMLElement[],
  fieldNames: string[],
  value: string,
  comboboxOptions: ComboboxFillOptions
): Promise<FillSummary> {
  if (!value) return { filled: 0, flagged: 0 };
  for (let attempt = 0; attempt < 3; attempt++) {
    const currentElements = rowId ? rowGroups('workExperience').get(rowId) ?? fallbackElements : fallbackElements;
    await fillDate(currentElements, fieldNames, value, true, comboboxOptions);
    await wait(WAIT_MS);
    const renderedElements = rowId ? rowGroups('workExperience').get(rowId) ?? currentElements : currentElements;
    if (dateMatches(renderedElements, fieldNames, value, true)) return { filled: 1, flagged: 0 };
  }
  const finalElements = rowId ? rowGroups('workExperience').get(rowId) ?? fallbackElements : fallbackElements;
  const target = finalElements.find((element) => fieldNames.some((name) =>
    element.id.toLowerCase().includes(`--${name.toLowerCase()}-`)
  ));
  if (target) flagField(target);
  return { filled: 0, flagged: 1 };
}

function degreeCandidates(value: string): string[] {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  const groups: string[][] = [
    ['AA', 'Associate of Arts', 'Associates'], ['AS', 'Associate of Science', 'Associates'],
    ['BA', 'Bachelor of Arts', 'Bachelors'], ['BS', 'Bachelor of Science', 'Bachelors'],
    ['BBA', 'Bachelor of Business Administration', 'Bachelors'], ['MA', 'Master of Arts', 'Masters'],
    ['MS', 'Master of Science', 'Masters'], ['MBA', 'Master of Business Administration'],
    ['PhD', 'Doctor of Philosophy', 'Doctorate'], ['JD', 'Juris Doctor'], ['MD', 'Doctor of Medicine'],
  ];
  return groups.find((group) => group.some((candidate) =>
    candidate.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim() === normalized
  )) ?? [value];
}

function fieldOfStudyCandidates(value: string): string[] {
  // A related discipline is not necessarily an acceptable substitute for the saved major.
  // Require Workday's controlled list to contain the exact profile value; otherwise leave the
  // field flagged for the applicant instead of guessing (for example, EE vs. CompE).
  // Treat an ampersand and the word "and" as the same exact conjunction. Ambarella exposes
  // "Electrical and Computer Engineering" while the saved profile uses
  // "Electrical & Computer Engineering"; these names identify the same major.
  const withAnd = value.replace(/\s*&\s*/g, ' and ').replace(/\s+/g, ' ').trim();
  return withAnd === value ? [value] : [value, withAnd];
}

function setChecked(element: HTMLElement | null, checked: boolean): FillSummary {
  if (!(element instanceof HTMLInputElement) || element.type !== 'checkbox') return { filled: 0, flagged: 0 };
  element.dataset.jobAutofillRepeatable = 'true';
  // React tracks checkbox state from its click transition. Directly assigning .checked can look
  // correct until the next render, when Workday restores the still-false model value.
  if (element.checked !== checked) element.click();
  return { filled: 1, flagged: 0 };
}

function addSummary(total: FillSummary, next: FillSummary): void {
  total.filled += next.filled;
  total.flagged += next.flagged;
}

async function fillWorkRow(
  elements: HTMLElement[],
  entry: WorkHistoryEntry,
  summary: FillSummary,
  comboboxOptions: ComboboxFillOptions
): Promise<void> {
  const rowId = elements.map((element) => element.id.match(/^workExperience-(.+?)--/)?.[1]).find(Boolean);
  const values: Array<[string[], string]> = [
    [['company', 'companyName'], entry.company],
    [['jobTitle', 'title'], entry.title],
    [['location'], entry.location ?? ''],
    [['description', 'roleDescription'], entry.description],
  ];
  for (const [suffixes, value] of values) {
    const entryLog: Record<string, unknown> = { row: rowId, field: suffixes[0], want: value.slice(0, 30) };
    try {
      const live = rowId ? rowGroups('workExperience').get(rowId) ?? elements : elements;
      const target = bySuffix(live, suffixes);
      entryLog.targetId = target?.id;
      entryLog.targetTag = target?.tagName;
      entryLog.before = target && 'value' in target ? (target as HTMLInputElement).value.slice(0, 30) : '(n/a)';
      addSummary(summary, await fillValue(target, value, comboboxOptions));
      const check = rowId ? rowGroups('workExperience').get(rowId) ?? live : live;
      const after = bySuffix(check, suffixes);
      entryLog.after = after && 'value' in after ? (after as HTMLInputElement).value.slice(0, 30) : '(gone)';
      entryLog.sameNode = target === after;
    } catch (error) {
      entryLog.error = String((error as Error)?.message ?? error).slice(0, 120);
    }
    // eslint-disable-next-line no-console
    console.log('[autofill:wd-exp]', JSON.stringify(entryLog));
    const w = window as unknown as { __jobAutofillWdTrace?: unknown[] };
    (w.__jobAutofillWdTrace ??= []).push(entryLog);
  }
  addSummary(summary, await fillWorkDateWithVerification(
    rowId, elements, ['startDate', 'from'], entry.startDate, comboboxOptions
  ));
  // Selecting From through Workday's calendar can remount the entire repeatable row. Re-query by
  // its generated row ID before touching To/current-role so we do not write to detached controls.
  const currentElements = rowId ? rowGroups('workExperience').get(rowId) ?? elements : elements;
  if (!entry.currentlyWorksHere) {
    addSummary(summary, await fillWorkDateWithVerification(
      rowId, currentElements, ['endDate', 'to'], entry.endDate, comboboxOptions
    ));
  }
  addSummary(
    summary,
    setChecked(bySuffix(currentElements, ['currentlyWorkHere', 'currentlyWorksHere', 'currentJob']), Boolean(entry.currentlyWorksHere))
  );
}

async function fillEducationRow(
  elements: HTMLElement[],
  entry: EducationEntry,
  summary: FillSummary,
  comboboxOptions: ComboboxFillOptions
): Promise<void> {
  const values: Array<[string[], string, string[]?]> = [
    [['school', 'schoolName'], entry.school],
    [['degree'], entry.degree, degreeCandidates(entry.degree)],
    [['fieldOfStudy'], entry.fieldOfStudy, fieldOfStudyCandidates(entry.fieldOfStudy)],
    [['gpa', 'gradeAverage'], entry.gpa ?? ''],
  ];
  for (const [suffixes, value, candidates] of values) {
    addSummary(summary, await fillValue(bySuffix(elements, suffixes), value, comboboxOptions, candidates));
  }
  const startDate = entry.startDate ?? (entry.startYear ? `01/${entry.startYear}` : '');
  const endDate = entry.endDate ?? (entry.endYear ? `01/${entry.endYear}` : entry.graduationDate);
  addSummary(
    summary,
    await fillDate(elements, ['firstYearAttended', 'startDate', 'startYear', 'from'], startDate, false, comboboxOptions)
  );
  addSummary(
    summary,
    await fillDate(elements, ['lastYearAttended', 'endDate', 'endYear', 'to', 'graduationDate'], endDate, false, comboboxOptions)
  );
}

export async function fillWorkdayRepeatableSections(
  profile: Profile,
  options: WorkdayRepeatableFillOptions = {}
): Promise<FillSummary> {
  const summary: FillSummary = { filled: 0, flagged: 0 };
  if (options.requireVisibleExperienceStep && !isOnVisibleMyExperienceStep()) return summary;

  for (let index = options.workStartIndex ?? 0; index < profile.workHistory.length; index++) {
    if (isCancelled()) return summary;
    try {
      const row = await ensureRow('workExperience', index);
      if (!row) break;
      await wait(100);
      await fillWorkRow(row, profile.workHistory[index], summary, options.combobox ?? {});
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[autofill] workExperience row ${index} threw:`, error);
    }
  }

  if (options.skipEducation) return summary;
  for (let index = options.educationStartIndex ?? 0; index < profile.education.length; index++) {
    if (isCancelled()) return summary;
    try {
      const row = await ensureRow('education', index);
      if (!row) break;
      await wait(100);
      await fillEducationRow(row, profile.education[index], summary, options.combobox ?? {});
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[autofill] education row ${index} threw:`, error);
    }
  }

  return summary;
}

export async function fillWorkdayCompositeProfileDate(
  elements: HTMLElement[],
  value: string,
  comboboxOptions: ComboboxFillOptions = {}
): Promise<FillSummary> {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || elements.length === 0) return { filled: 0, flagged: 0 };
  const section = (name: string) => elements.find((element) =>
    element.id.endsWith(`dateSection${name}-input`)
  ) ?? null;
  const monthInput = section('Month');
  const dayInput = section('Day');
  const yearInput = section('Year');
  let success = true;
  for (const [element, part] of [
    [monthInput, String(Number(match[2]))],
    [dayInput, String(Number(match[3]))],
    [yearInput, match[1]],
  ] as Array<[HTMLElement | null, string]>) {
    const result = await fillValue(element, part, comboboxOptions);
    success = success && result.filled === 1;
  }
  if (success && yearInput) {
    invokeReactKeyDown(yearInput, 'Tab');
    await leaveDateWidget(yearInput);
  }
  return success ? { filled: 1, flagged: 0 } : { filled: 0, flagged: 1 };
}
