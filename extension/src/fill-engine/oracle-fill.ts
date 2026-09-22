import { Profile, EducationEntry } from '../storage/profile-schema';
import { flagField, setNativeValue } from './fill-engine';
import { findMatchIndex } from './fill-engine';
import { normalize } from './synonym-dictionary';
import { FillSummary } from './types';
import { selectOracleGridValue } from './oracle-select';
import { COMPANY_WEBSITE_SOURCE, isSourceQuestion } from './source-answer';

function clearFlag(element: HTMLElement): void {
  delete element.dataset.autofillFlag;
  element.style.outline = '';
}

function parseMonthYear(value: string): { month: number; year: number } | null {
  const monthFirst = value.match(/^(\d{1,2})\/(\d{4})$/);
  if (monthFirst) return { month: Number(monthFirst[1]), year: Number(monthFirst[2]) };
  const iso = value.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (iso) return { month: Number(iso[2]), year: Number(iso[1]) };
  const yearOnly = value.match(/^(\d{4})$/);
  return yearOnly ? { month: 5, year: Number(yearOnly[1]) } : null;
}

function educationEnd(entry: EducationEntry): { month: number; year: number } | null {
  return parseMonthYear(entry.endDate || entry.graduationDate || entry.endYear || '');
}

function educationStart(entry: EducationEntry): { month: number; year: number } | null {
  return parseMonthYear(entry.startDate || entry.startYear || '');
}

function dateNumber(date: { month: number; year: number }): number {
  return date.year * 12 + date.month;
}

function currentEducation(profile: Profile, now: Date): EducationEntry | null {
  const currentMonth = now.getFullYear() * 12 + now.getMonth() + 1;
  return profile.education.find((entry) => {
    const start = educationStart(entry);
    const end = educationEnd(entry);
    return (!start || dateNumber(start) <= currentMonth) && (!end || dateNumber(end) >= currentMonth);
  }) ?? profile.education[0] ?? null;
}

function academicLevel(profile: Profile, now: Date): string | null {
  const education = currentEducation(profile, now);
  if (!education) return null;
  const degree = normalize(education.degree);
  if (/\b(?:phd|doctor|doctoral)\b/.test(degree)) return 'PhD';
  if (/\b(?:master|masters|ma|ms|mba)\b/.test(degree)) return "Master's";
  const start = educationStart(education);
  if (!start) return null;
  const elapsedMonths = now.getFullYear() * 12 + now.getMonth() + 1 - dateNumber(start);
  const year = Math.max(1, Math.floor(Math.max(0, elapsedMonths) / 12) + 1);
  return ['Freshman', 'Sophomore', 'Junior', 'Senior'][Math.min(year, 4) - 1];
}

function graduation(profile: Profile, now: Date): { month: number; year: number } | null {
  const active = currentEducation(profile, now);
  return active ? educationEnd(active) : null;
}

function normalizedYesNo(value: string | undefined): 'Yes' | 'No' | null {
  const normalized = normalize(value ?? '');
  if (normalized === 'yes') return 'Yes';
  if (normalized === 'no') return 'No';
  return null;
}

function gpaAnswer(profile: Profile, label: string): 'Yes' | 'No' | null {
  const threshold = Number(label.match(/(?:GPA[^\d]*|minimum[^\d]*)(\d+(?:\.\d+)?)/i)?.[1]);
  const gpas = profile.education
    .map((entry) => Number(entry.gpa))
    .filter((gpa) => Number.isFinite(gpa));
  if (!Number.isFinite(threshold) || gpas.length === 0) return null;
  return Math.max(...gpas) >= threshold ? 'Yes' : 'No';
}

function graduatedBeforeAvailableStart(profile: Profile, now: Date): 'Yes' | 'No' | null {
  const end = graduation(profile, now);
  const start = profile.jobPreferences.availableStartDate.match(/^(\d{4})-(\d{2})/);
  if (!end || !start) return null;
  return dateNumber(end) < Number(start[1]) * 12 + Number(start[2]) ? 'Yes' : 'No';
}

function isCurrentlyEnrolled(profile: Profile, now: Date): 'Yes' | 'No' | null {
  if (profile.education.length === 0) return null;
  const currentMonth = now.getFullYear() * 12 + now.getMonth() + 1;
  return profile.education.some((entry) => {
    const start = educationStart(entry);
    const end = educationEnd(entry);
    return (!start || dateNumber(start) <= currentMonth) && (!end || dateNumber(end) >= currentMonth);
  }) ? 'Yes' : 'No';
}

function hasGovernmentExperience(profile: Profile): 'Yes' | 'No' {
  return profile.workHistory.some((entry) => /\b(?:government|armed forces|military|army|navy|air force|civil service)\b/i.test(
    `${entry.company} ${entry.title}`
  )) ? 'Yes' : 'No';
}

function previousEmployerAnswer(profile: Profile, label: string): 'Yes' | 'No' | null {
  const employer = label.match(/employed directly by\s+(.+?)(?:,|\s+or\s+a\s+subsidiary)/i)?.[1]?.trim();
  if (!employer) return null;
  const employerName = normalize(employer);
  return profile.workHistory.some((entry) => normalize(entry.company).includes(employerName)) ? 'Yes' : 'No';
}

function answerForOracleQuestion(profile: Profile, label: string, now: Date): string | null {
  const question = normalize(label);
  if (isSourceQuestion(label)) return COMPANY_WEBSITE_SOURCE;
  if (question === 'title') {
    const gender = normalize(profile.disclosures.gender);
    if (gender === 'male' || gender === 'man') return 'Mr.';
    if (gender === 'female' || gender === 'woman') return 'Ms.';
    return gender ? 'Unknown' : null;
  }
  if (question.includes('accommodations or support during the recruitment process')) {
    return normalize(profile.disclosures.disabilityStatus).startsWith('no') ? 'No' : null;
  }
  if (question.includes('minimum gpa requirement')) return gpaAnswer(profile, label);
  if (question.includes('legally authorized to work')) return normalizedYesNo(profile.workAuthorization.authorizedToWork);
  if (question.includes('sponsor') || question.includes('sponsorship')) {
    return normalizedYesNo(profile.workAuthorization.requiresSponsorship);
  }
  if (question.includes('18 years of age') || question.includes('at least 18')) {
    return normalizedYesNo(profile.jobPreferences.atLeast18);
  }
  if (question.includes('willing to relocate') || question.includes('able to relocate')) {
    return normalizedYesNo(profile.jobPreferences.willingToRelocate);
  }
  if (question.includes('united states citizen') || question.includes('u s citizen') || question.includes('us citizen')) {
    return normalizedYesNo(profile.jobPreferences.usCitizen);
  }
  if (question.includes('security clearance')) {
    return normalizedYesNo(profile.jobPreferences.securityClearance);
  }
  if (question.includes('graduated prior to the start')) return graduatedBeforeAvailableStart(profile, now);
  if (question.includes('provide an official or unofficial educational transcript')) {
    return profile.education.length > 0 ? 'Yes' : null;
  }
  if (question.includes('currently enrolled in an accredited')) return isCurrentlyEnrolled(profile, now);
  if (question.includes('active non compete')) return normalizedYesNo(profile.professional?.hasNonCompeteAgreement);
  if (question.includes('previously employed directly by')) return previousEmployerAnswer(profile, label);
  if (question.includes('currently work for the government')) return hasGovernmentExperience(profile);
  return null;
}

function questionLabel(group: HTMLElement): string {
  const ariaLabel = group.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();
  const labelledBy = group.getAttribute('aria-labelledby');
  if (labelledBy) {
    return labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

function selectButtonAnswer(group: HTMLElement, answer: string): boolean {
  const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('button'));
  const match = findMatchIndex(buttons.map((button) => button.textContent ?? ''), [answer]);
  if (match === null) return false;
  const selected = buttons[match].getAttribute('aria-pressed') === 'true' ||
    buttons[match].getAttribute('aria-checked') === 'true';
  if (!selected) buttons[match].click();
  clearFlag(group);
  buttons.forEach(clearFlag);
  return true;
}

function selectRadioAnswer(group: HTMLElement, answer: string): boolean {
  const radios = Array.from(group.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  const labels = radios.map((radio) =>
    document.querySelector(`label[for="${CSS.escape(radio.id)}"]`)?.textContent || radio.value
  );
  const match = findMatchIndex(labels, [answer]);
  if (match === null) return false;
  if (!radios[match].checked) radios[match].click();
  clearFlag(group);
  radios.forEach(clearFlag);
  return true;
}

function fillOracleQuestions(profile: Profile, root: ParentNode, now: Date): FillSummary {
  let filled = 0;
  let flagged = 0;
  const buttonGroups = Array.from(root.querySelectorAll<HTMLElement>('ul.cx-select-pills-container'));
  for (const group of buttonGroups) {
    const label = questionLabel(group);
    const answer = answerForOracleQuestion(profile, label, now);
    if (answer && selectButtonAnswer(group, answer)) {
      filled++;
    } else if (!group.querySelector('[aria-pressed="true"], [aria-checked="true"]') && /\?$/.test(label)) {
      flagField(group);
      flagged++;
    }
  }

  const radioGroups = Array.from(root.querySelectorAll<HTMLElement>('[role="radiogroup"]'));
  for (const group of radioGroups) {
    const label = questionLabel(group);
    const answer = answerForOracleQuestion(profile, label, now);
    if (!answer) continue;
    if (selectRadioAnswer(group, answer)) filled++;
    else {
      flagField(group);
      flagged++;
    }
  }
  return { filled, flagged };
}

function fillAcademicLevel(profile: Profile, root: ParentNode, now: Date): FillSummary {
  const textarea = Array.from(root.querySelectorAll<HTMLTextAreaElement>('textarea')).find((element) =>
    /academic level/i.test(element.labels?.[0]?.textContent ?? element.getAttribute('aria-label') ?? '')
  );
  if (!textarea) return { filled: 0, flagged: 0 };
  const level = academicLevel(profile, now);
  if (!level) {
    flagField(textarea);
    return { filled: 0, flagged: 1 };
  }
  if (textarea.value !== level) setNativeValue(textarea, level);
  textarea.blur();
  clearFlag(textarea);
  return { filled: 1, flagged: 0 };
}

async function fillGraduationDate(profile: Profile, root: ParentNode, now: Date): Promise<FillSummary> {
  const end = graduation(profile, now);
  if (!end) return { filled: 0, flagged: 0 };
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[role="combobox"]')).filter((input) => {
    if (!/^(?:day|month|year)-/.test(input.id)) return false;
    const labelledBy = input.getAttribute('aria-labelledby') ?? '';
    return labelledBy.split(/\s+/).some((id) => /expected year of graduation/i.test(
      document.getElementById(id)?.textContent ?? ''
    ));
  });
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  let filled = 0;
  let flagged = 0;
  for (const element of inputs) {
    const component = element.id.split('-', 1)[0];
    const candidates = component === 'day'
      ? ['1', '01']
      : component === 'month'
        ? [monthNames[end.month - 1], monthNames[end.month - 1].slice(0, 3), String(end.month), String(end.month).padStart(2, '0')]
        : [String(end.year)];
    const selected = await selectOracleGridValue(root, `#${CSS.escape(element.id)}`, candidates);
    if (selected) filled++;
    else flagged++;
  }
  return { filled, flagged };
}

export async function fillOracleForm(
  profile: Profile,
  root: ParentNode = document,
  now: Date = new Date()
): Promise<FillSummary> {
  const questions = fillOracleQuestions(profile, root, now);
  const level = fillAcademicLevel(profile, root, now);
  const date = await fillGraduationDate(profile, root, now);
  return {
    filled: questions.filled + level.filled + date.filled,
    flagged: questions.flagged + level.flagged + date.flagged,
  };
}
