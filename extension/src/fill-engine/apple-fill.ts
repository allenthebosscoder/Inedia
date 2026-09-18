import { EducationEntry, Profile, WorkHistoryEntry } from '../storage/profile-schema';
import { flagField, setNativeValue } from './fill-engine';
import { normalize } from './synonym-dictionary';
import { FillSummary } from './types';

interface AppleFillOptions {
  settleMs?: number;
  now?: Date;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function byId<T extends HTMLElement>(root: ParentNode, id: string): T | null {
  return root.querySelector<T>(`#${CSS.escape(id)}`);
}

function markHandled(element: HTMLElement): void {
  element.dataset.jobAutofillHandled = 'true';
  delete element.dataset.autofillFlag;
  element.style.outline = '';
}

async function commitText(
  root: ParentNode,
  id: string,
  value: string,
  settleMs: number
): Promise<boolean> {
  let input = byId<HTMLInputElement | HTMLTextAreaElement>(root, id);
  if (!input) return false;
  input.focus();
  setNativeValue(input, value);
  await wait(settleMs);
  // Apple uses controlled React inputs and may replace the DOM node after onChange. Always blur
  // the live node so its typeahead onBlur handler commits custom school/major/employer text.
  input = byId<HTMLInputElement | HTMLTextAreaElement>(root, id);
  input?.blur();
  await wait(settleMs);
  input = byId<HTMLInputElement | HTMLTextAreaElement>(root, id);
  if (input && input.value === value) {
    markHandled(input);
    return true;
  }
  if (input) flagField(input);
  return false;
}

async function commitTypeahead(
  root: ParentNode,
  id: string,
  value: string,
  settleMs: number
): Promise<boolean> {
  let input = byId<HTMLInputElement>(root, id);
  if (!input) return false;
  if (normalize(input.value) !== normalize(value)) {
    const reset = input.closest<HTMLElement>('.typeahead-container')
      ?.querySelector<HTMLButtonElement>('button.form-icons-reset');
    if (reset && input.value) {
      reset.click();
      await wait(settleMs);
    }
  }
  return commitText(root, id, value, settleMs);
}

async function commitSelect(
  root: ParentNode,
  id: string,
  candidates: string[],
  settleMs: number
): Promise<boolean> {
  let select = byId<HTMLSelectElement>(root, id);
  if (!select) return false;
  const wanted = candidates.map(normalize);
  const option = Array.from(select.options).find((entry) =>
    wanted.includes(normalize(entry.textContent ?? '')) || wanted.includes(normalize(entry.value))
  );
  if (!option) {
    flagField(select);
    return false;
  }
  setNativeValue(select, option.value);
  await wait(settleMs);
  select = byId<HTMLSelectElement>(root, id);
  if (select?.value === option.value) {
    markHandled(select);
    return true;
  }
  if (select) flagField(select);
  return false;
}

function parseMonthYear(value: string): { month: number; year: number } | null {
  const monthFirst = value.match(/^(\d{1,2})\/(\d{4})$/);
  if (monthFirst) return { month: Number(monthFirst[1]), year: Number(monthFirst[2]) };
  const iso = value.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (iso) return { month: Number(iso[2]), year: Number(iso[1]) };
  const year = value.match(/^(\d{4})$/);
  return year ? { month: 5, year: Number(year[1]) } : null;
}

function workDate(entry: WorkHistoryEntry, side: 'start' | 'end') {
  return parseMonthYear(side === 'start' ? entry.startDate : entry.endDate);
}

function educationEnd(entry: EducationEntry) {
  return parseMonthYear(entry.endDate || entry.graduationDate || entry.endYear || '');
}

function degreeCandidates(degree: string): string[] {
  const value = normalize(degree);
  if (/\b(?:phd|doctor|doctoral)\b/.test(value)) return ['PhD', 'Doctorate'];
  if (/\b(?:master|masters|ma|ms|mba|msc)\b/.test(value)) return ["Master's Degree"];
  if (/\b(?:bachelor|bachelors|ba|bs|bsc)\b/.test(value)) return ["Bachelor's Degree"];
  if (/\b(?:associate|associates|aa|as)\b/.test(value)) return ["Associate's Degree"];
  if (/\b(?:high school|secondary)\b/.test(value)) return ['High School or equivalent'];
  return degree ? [degree] : [];
}

async function reconcileCount(
  root: ParentNode,
  rowSelector: string,
  addSelector: string,
  target: number,
  settleMs: number
): Promise<void> {
  let count = root.querySelectorAll(rowSelector).length;
  while (count < target) {
    const add = root.querySelector<HTMLButtonElement>(addSelector);
    if (!add) break;
    add.click();
    await wait(settleMs);
    const next = root.querySelectorAll(rowSelector).length;
    if (next <= count) break;
    count = next;
  }
}

async function fillEducation(
  profile: Profile,
  root: ParentNode,
  settleMs: number,
  now: Date
): Promise<FillSummary> {
  if (!root.querySelector('[id^="parsedmodal-school-"][id$="-suggestion-textbox"]')) {
    return { filled: 0, flagged: 0 };
  }
  await reconcileCount(
    root,
    '[id^="parsedmodal-school-"][id$="-suggestion-textbox"]',
    '[id^="parsedmodal-add-education-degree-"]',
    profile.education.length,
    settleMs
  );

  let filled = 0;
  let flagged = 0;
  for (let index = 0; index < profile.education.length; index++) {
    const entry = profile.education[index];
    await commitTypeahead(root, `parsedmodal-school-${index}-suggestion-textbox`, entry.school, settleMs) ? filled++ : flagged++;
    await commitTypeahead(root, `parsedmodal-major-${index}-suggestion-textbox`, entry.fieldOfStudy, settleMs) ? filled++ : flagged++;

    const degree = degreeCandidates(entry.degree);
    if (degree.length > 0) {
      await commitSelect(root, `parsedmodal-degree-${index}`, degree, settleMs) ? filled++ : flagged++;
    }

    const end = educationEnd(entry);
    const stillAttending = Boolean(end) && (
      end!.year > now.getFullYear() ||
      (end!.year === now.getFullYear() && end!.month >= now.getMonth() + 1)
    );
    const status = byId<HTMLInputElement>(
      root,
      `parsedmodal-gradstatus-${index}-graduationStatus-${stillAttending ? 'SA' : 'YES'}`
    );
    if (status) {
      if (!status.checked) status.click();
      await wait(settleMs);
      const live = byId<HTMLInputElement>(root, status.id);
      if (live?.checked) {
        markHandled(live);
        filled++;
      } else {
        if (live) flagField(live);
        flagged++;
      }
    }
  }
  return { filled, flagged };
}

async function fillEmployment(profile: Profile, root: ParentNode, settleMs: number): Promise<FillSummary> {
  if (!root.querySelector('[id^="parsedmodal-employer-"][id$="-suggestion-textbox"]')) {
    return { filled: 0, flagged: 0 };
  }
  await reconcileCount(
    root,
    '[id^="parsedmodal-employer-"][id$="-suggestion-textbox"]',
    '[id^="parsedmodal-add-employment-"]',
    profile.workHistory.length,
    settleMs
  );

  let filled = 0;
  let flagged = 0;
  for (let index = 0; index < profile.workHistory.length; index++) {
    const entry = profile.workHistory[index];
    for (const result of [
      await commitTypeahead(root, `parsedmodal-employer-${index}-suggestion-textbox`, entry.company, settleMs),
      await commitText(root, `parsedmodal-jobtitle-${index}`, entry.title, settleMs),
      await commitText(root, `parsedmodal-job-description-${index}`, entry.description, settleMs),
    ]) result ? filled++ : flagged++;

    const currentSelector = `input[id^="parsedmodal-currentemployer-${entry.currentlyWorksHere ? 'yes' : 'no'}-"]`;
    let current = root.querySelector<HTMLInputElement>(
      `#${CSS.escape(`parsedmodal-currentemployer-${entry.currentlyWorksHere ? 'yes' : 'no'}`)}-${index}`
    );
    // Apple's random suffix is the row's entity key rather than its visible index.
    current = byId<HTMLElement>(root, `parsedmodal-employer-${index}`)
      ?.closest('fieldset')?.querySelector<HTMLInputElement>(currentSelector) ?? current;
    if (current) {
      if (!current.checked) current.click();
      await wait(settleMs);
      const fieldset = byId<HTMLElement>(root, `parsedmodal-employer-${index}`)?.closest('fieldset');
      const live = fieldset?.querySelector<HTMLInputElement>(currentSelector);
      if (live?.checked) {
        markHandled(live);
        filled++;
      } else {
        if (live) flagField(live);
        flagged++;
      }
    } else {
      flagged++;
    }

    const start = workDate(entry, 'start');
    if (start) {
      await commitSelect(root, `parsedmodal-startmonth-${index}`, [MONTHS[start.month - 1], String(start.month).padStart(2, '0')], settleMs) ? filled++ : flagged++;
      await commitSelect(root, `parsedmodal-startyear-${index}`, [String(start.year)], settleMs) ? filled++ : flagged++;
    }
    if (!entry.currentlyWorksHere) {
      const end = workDate(entry, 'end');
      if (end) {
        await commitSelect(root, `parsedmodal-endmonth-${index}`, [MONTHS[end.month - 1], String(end.month).padStart(2, '0')], settleMs) ? filled++ : flagged++;
        await commitSelect(root, `parsedmodal-endyear-${index}`, [String(end.year)], settleMs) ? filled++ : flagged++;
      }
    }
  }
  return { filled, flagged };
}

function savedSkills(profile: Profile): string[] {
  return profile.professional.skills
    .split(/[,;\n]+/)
    .map((skill) => skill.trim())
    .filter(Boolean);
}

function renderedSkills(root: ParentNode): Set<string> {
  const values = new Set<string>();
  root.querySelectorAll<HTMLElement>(
    '[id^="apply-main-skill-delete-button-"], [id^="apply-manual-skills-"]'
  ).forEach((element) => {
    const label = element.getAttribute('aria-label') || element.textContent || '';
    const skill = label.replace(/^Remove(?: Skill)?\s+/i, '').trim();
    if (skill) values.add(normalize(skill));
  });
  return values;
}

async function fillSkills(profile: Profile, root: ParentNode, settleMs: number): Promise<FillSummary> {
  const id = 'apply-skills-typeahead-suggestion-textbox';
  let input = byId<HTMLInputElement>(root, id);
  const desired = savedSkills(profile);
  if (!input || desired.length === 0) return { filled: 0, flagged: 0 };

  const existing = renderedSkills(root);
  const missing = desired.filter((skill) => !existing.has(normalize(skill)));
  let added = 0;
  for (const skill of missing) {
    input = byId<HTMLInputElement>(root, id);
    if (!input || input.disabled) break;
    input.focus();
    setNativeValue(input, skill);
    await wait(settleMs);
    input = byId<HTMLInputElement>(root, id);
    if (!input || normalize(input.value) !== normalize(skill)) break;
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true,
    }));
    await wait(settleMs);
    if (renderedSkills(root).has(normalize(skill))) {
      added++;
      existing.add(normalize(skill));
    } else {
      break;
    }
  }

  if (root.querySelector('[id^="apply-manual-skills-"]')) {
    const confirm = byId<HTMLButtonElement>(root, 'rate-skills-button');
    if (confirm && !confirm.disabled) {
      confirm.click();
      await wait(settleMs);
    }
  }
  input = byId<HTMLInputElement>(root, id);
  const committed = renderedSkills(root);
  const unresolved = desired.filter((skill) => !committed.has(normalize(skill)));
  if (input) {
    markHandled(input);
    if (unresolved.length > 0) flagField(input);
  }
  return { filled: added, flagged: unresolved.length > 0 ? 1 : 0 };
}

export async function fillAppleForm(
  profile: Profile,
  root: ParentNode = document,
  options: AppleFillOptions = {}
): Promise<FillSummary> {
  const settleMs = options.settleMs ?? 50;
  let filled = 0;
  let flagged = 0;

  const line2 = byId<HTMLInputElement>(root, 'profile-field-line2');
  if (line2) {
    if (line2.value !== profile.personal.addressLine2) {
      await commitText(root, line2.id, profile.personal.addressLine2, settleMs) ? filled++ : flagged++;
    } else {
      markHandled(line2);
    }
  }
  const preferred = byId<HTMLInputElement>(root, 'profile-preferredname');
  if (preferred && preferred.getAttribute('aria-required') !== 'true') markHandled(preferred);

  const education = await fillEducation(profile, root, settleMs, options.now ?? new Date());
  const employment = await fillEmployment(profile, root, settleMs);
  const skills = await fillSkills(profile, root, settleMs);
  filled += education.filled + employment.filled + skills.filled;
  flagged += education.flagged + employment.flagged + skills.flagged;

  // Apple labels this as an optional supporting-file attachment on Profile Information. It is
  // not the Add Resume control from step 1, so never attach the stored resume here.
  const supportingFile = byId<HTMLInputElement>(root, 'attachfile-resume-supportfile');
  if (supportingFile) markHandled(supportingFile);

  // Skill rows are handled above one item at a time. The Apple adapter keeps this typeahead out of
  // generic filling so the comma-separated profile string can never become one invalid skill.
  return { filled, flagged };
}
