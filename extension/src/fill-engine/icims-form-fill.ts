import { Profile } from '../storage/profile-schema';
import { setNativeValue } from './fill-engine';
import { normalize } from './synonym-dictionary';
import { FillSummary } from './types';

interface DateParts {
  month: string;
  day: string;
  year: string;
}

function parseProfileDate(value: string): DateParts | null {
  let match = value.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (match) {
    return { month: match[2].padStart(2, '0'), day: String(Number(match[3] ?? '1')), year: match[1] };
  }
  match = value.match(/^(\d{1,2})\/(\d{4})$/);
  if (match) {
    return { month: match[1].padStart(2, '0'), day: '1', year: match[2] };
  }
  match = value.match(/^(\d{4})$/);
  return match ? { month: '', day: '', year: match[1] } : null;
}

function setMissingValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null, value: string): number {
  if (!element || !value || (element.value && element.value !== '0' && element.value !== '-999')) return 0;
  const desired = element instanceof HTMLSelectElement
    ? Array.from(element.options).find((option) => option.value === value)?.value ?? ''
    : value;
  if (!desired) return 0;
  setNativeValue(element, desired);
  return 1;
}

function restoreDescriptionFormatting(element: HTMLTextAreaElement | null, value: string): number {
  if (!element || !value) return 0;
  if (!element.value) {
    setNativeValue(element, value);
    return 1;
  }
  // iCIMS resume parsing commonly turns "- first\n- second" into
  // "first - second". Restore exact profile formatting only when punctuation-insensitive text
  // comparison proves the content itself is unchanged, preserving any real manual edit.
  if (element.value !== value && normalize(element.value) === normalize(value)) {
    setNativeValue(element, value);
    return 1;
  }
  return 0;
}

function fillDate(prefix: string, value: string): number {
  const parts = parseProfileDate(value);
  if (!parts) return 0;
  return (
    setMissingValue(document.getElementById(`${prefix}_Month`) as HTMLSelectElement | null, parts.month) +
    setMissingValue(document.getElementById(`${prefix}_Date`) as HTMLSelectElement | null, parts.day) +
    setMissingValue(document.getElementById(`${prefix}_Year`) as HTMLInputElement | null, parts.year)
  );
}

function normalizedPhone(value: string): string {
  return value.replace(/\D/g, '');
}

function clearIfEqual(element: HTMLInputElement | null, expected: string): number {
  if (!element || !expected || element.value.trim().toLowerCase() !== expected.trim().toLowerCase()) return 0;
  setNativeValue(element, '');
  return 1;
}

function removeApplicantFromReferences(profile: Profile): number {
  let cleared = 0;
  const referencePrefixes = new Set<string>();
  document.querySelectorAll<HTMLInputElement>('input[id^="icims_"][id*="_Ref"][id$="Email"]')
    .forEach((email) => {
      const match = email.id.match(/^(icims_\d+_Ref\d+)Email$/i);
      if (match && profile.personal.email && email.value.trim().toLowerCase() === profile.personal.email.trim().toLowerCase()) {
        referencePrefixes.add(match[1]);
      }
    });
  document.querySelectorAll<HTMLInputElement>('input[id^="icims_"][id*="_Ref"][id$="Phone"]')
    .forEach((phone) => {
      const match = phone.id.match(/^(icims_\d+_Ref\d+)Phone$/i);
      if (match && normalizedPhone(profile.personal.phone) && normalizedPhone(phone.value) === normalizedPhone(profile.personal.phone)) {
        referencePrefixes.add(match[1]);
      }
    });

  for (const prefix of referencePrefixes) {
    cleared += clearIfEqual(document.getElementById(`${prefix}FirstName`) as HTMLInputElement | null, profile.personal.firstName);
    cleared += clearIfEqual(document.getElementById(`${prefix}LastName`) as HTMLInputElement | null, profile.personal.lastName);
    cleared += clearIfEqual(document.getElementById(`${prefix}Email`) as HTMLInputElement | null, profile.personal.email);
    const phone = document.getElementById(`${prefix}Phone`) as HTMLInputElement | null;
    if (phone && normalizedPhone(phone.value) === normalizedPhone(profile.personal.phone)) {
      setNativeValue(phone, '');
      cleared++;
    }
  }
  return cleared;
}

function removePhoneFromExtension(profile: Profile): number {
  const profilePhone = normalizedPhone(profile.personal.phone);
  if (!profilePhone) return 0;
  let cleared = 0;
  document.querySelectorAll<HTMLInputElement>('input[id$="_PhoneExtension"]')
    .forEach((extension) => {
      if (normalizedPhone(extension.value) === profilePhone) {
        setNativeValue(extension, '');
        cleared++;
      }
    });
  return cleared;
}

function removeApplicantPhoneFromEmploymentContacts(profile: Profile): number {
  const profilePhone = normalizedPhone(profile.personal.phone);
  if (!profilePhone) return 0;
  let cleared = 0;
  document.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
    const metadata = `${input.id} ${input.name} ${input.getAttribute('aria-label') ?? ''}`
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[-_]+/g, ' ');
    if (
      /\bicims\b/i.test(metadata) &&
      /(?:employer|company|supervisor|reference|\bemp\b|\bsup\b|\bref\b).*phone|phone.*(?:employer|company|supervisor|reference|\bemp\b|\bsup\b|\bref\b)/i.test(metadata) &&
      normalizedPhone(input.value) === profilePhone
    ) {
      setNativeValue(input, '');
      cleared++;
    }
  });
  return cleared;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function questionLabel(el: HTMLElement): string {
  const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
  return (byFor?.textContent || el.closest('label')?.textContent || el.getAttribute('aria-label') || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function findQuestionField(pattern: RegExp, tag: 'input' | 'select' | 'textarea'):
  HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(tag))) {
    if (pattern.test(questionLabel(el))) {
      return el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    }
  }
  return null;
}

// The user's most advanced / most recent degree entry.
function primaryEducation(profile: Profile) {
  return profile.education[0] ?? null;
}

function expectedGraduation(profile: Profile): string {
  const entry = primaryEducation(profile);
  if (!entry) return '';
  const raw = entry.graduationDate || entry.endDate || (entry.endYear ? `01/${entry.endYear}` : '');
  const m = raw.match(/^(\d{1,2})\/(\d{4})$/) || raw.match(/^(\d{4})-(\d{1,2})$/);
  if (!m) return '';
  const [monthNum, year] = raw.includes('-') ? [Number(m[2]), m[1]] : [Number(m[1]), m[2]];
  const graduated = new Date(Number(year), monthNum - 1, 28).getTime() < Date.now();
  return graduated ? 'NA' : `${MONTH_NAMES[monthNum - 1]} ${year}`;
}

function highestGpa(profile: Profile): number {
  let best = 0;
  for (const entry of profile.education) {
    const value = Number((entry.gpa ?? '').match(/[\d.]+/)?.[0] ?? 0);
    if (value > best && value <= 4.5) best = value;
  }
  return best;
}

// Match a GPA number against an iCIMS range option ("2.99 or lower", "3.25 - 3.49", "4.0 or above").
function matchGpaOption(options: HTMLOptionsCollection, gpa: number): string | null {
  for (const option of Array.from(options)) {
    const text = option.textContent ?? '';
    const range = text.match(/(\d(?:\.\d+)?)\s*-\s*(\d(?:\.\d+)?)/);
    if (range && gpa >= Number(range[1]) && gpa <= Number(range[2])) return option.value;
    const lower = text.match(/(\d(?:\.\d+)?)\s*or\s*lower/i);
    if (lower && gpa <= Number(lower[1])) return option.value;
    const above = text.match(/(\d(?:\.\d+)?)\s*or\s*(?:above|higher)/i);
    if (above && gpa >= Number(above[1])) return option.value;
  }
  return null;
}

// Convert the saved minimum salary to an hourly rate and pick the iCIMS wage-range option it
// falls in ("$12.00 - $14.00 per hour", "More than $36.00 per hour").
function matchHourlyWageOption(options: HTMLOptionsCollection, hourly: number): string | null {
  for (const option of Array.from(options)) {
    const text = (option.textContent ?? '').replace(/,/g, '');
    const range = text.match(/\$?(\d+(?:\.\d+)?)\s*(?:-|to)\s*\$?(\d+(?:\.\d+)?)/);
    if (range && hourly >= Number(range[1]) - 0.01 && hourly <= Number(range[2]) + 0.99) return option.value;
    const more = text.match(/(?:more than|over|above|greater than)\s*\$?(\d+(?:\.\d+)?)/i);
    if (more && hourly > Number(more[1])) return option.value;
    const less = text.match(/(?:less than|under|below)\s*\$?(\d+(?:\.\d+)?)/i);
    if (less && hourly < Number(less[1])) return option.value;
  }
  return null;
}

function hourlyFromSalary(minimumSalary: string): number {
  const amount = Number((minimumSalary.match(/[\d.,]+/)?.[0] ?? '').replace(/,/g, ''));
  if (!amount || Number.isNaN(amount)) return 0;
  if (/hour|hr|per h/i.test(minimumSalary)) return amount;
  // A bare number: treat anything that reads like an annual figure as annual (2080 work hours/yr).
  return amount >= 2000 ? amount / 2080 : amount;
}

function fillIcimsQuestions(profile: Profile): number {
  let filled = 0;

  const wageField = findQuestionField(/hourly (wage|pay|rate|compensation)|wage range|expected hourly/i, 'select');
  if (wageField instanceof HTMLSelectElement && (!wageField.value || wageField.value === '-999')) {
    const hourly = hourlyFromSalary(profile.jobPreferences.minimumSalary);
    const optionValue = hourly > 0 ? matchHourlyWageOption(wageField.options, hourly) : null;
    if (optionValue) { setNativeValue(wageField, optionValue); filled++; }
  }

  const gradField = findQuestionField(/anticipated graduation date|expected graduation date/i, 'input');
  if (gradField instanceof HTMLInputElement && !gradField.value.trim()) {
    const text = expectedGraduation(profile);
    if (text) { setNativeValue(gradField, text); filled++; }
  }

  const gpaField = findQuestionField(/grade point average|cumulative gpa/i, 'select');
  if (gpaField instanceof HTMLSelectElement && (!gpaField.value || gpaField.value === '-999')) {
    const gpa = highestGpa(profile);
    const optionValue = gpa > 0 ? matchGpaOption(gpaField.options, gpa) : null;
    if (optionValue) { setNativeValue(gpaField, optionValue); filled++; }
  }

  return filled;
}

export function fillIcimsForm(profile: Profile): FillSummary {
  let filled = 0;

  filled += fillIcimsQuestions(profile);

  // Federal veteran/disability self-identification forms render their signature date as three
  // unlabeled iCIMS controls. Filling today's date does not check the separate legal signature
  // attestation; that checkbox intentionally remains for explicit user review.
  if (document.querySelector('input[name="icims_f_Veteran"], input[name="icims_f_Disability"]')) {
    const today = new Date();
    filled += fillDate(
      'icims_f_Date',
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    );
  }

  profile.education.forEach((entry, index) => {
    const prefix = `icims_${index}_`;
    filled += setMissingValue(document.getElementById(`${prefix}School`) as HTMLInputElement | null, entry.school);
    filled += setMissingValue(document.getElementById(`${prefix}Degree`) as HTMLInputElement | null, entry.degree);
    filled += setMissingValue(document.getElementById(`${prefix}Major`) as HTMLInputElement | null, entry.fieldOfStudy);
    filled += setMissingValue(document.getElementById(`${prefix}GPA`) as HTMLInputElement | null, entry.gpa ?? '');
    filled += fillDate(`${prefix}EducationStartDate`, entry.startDate || (entry.startYear ? `01/${entry.startYear}` : ''));
    filled += fillDate(`${prefix}GraduationDate`, entry.endDate || entry.graduationDate || (entry.endYear ? `01/${entry.endYear}` : ''));
  });

  profile.workHistory.forEach((entry, index) => {
    const prefix = `icims_${index}_`;
    filled += setMissingValue(document.getElementById(`${prefix}EmpName`) as HTMLInputElement | null, entry.company);
    filled += setMissingValue(document.getElementById(`${prefix}EmpTitle`) as HTMLInputElement | null, entry.title);
    filled += restoreDescriptionFormatting(
      document.getElementById(`${prefix}EmpDescription`) as HTMLTextAreaElement | null,
      entry.description
    );
    filled += fillDate(`${prefix}EmpStart`, entry.startDate);
    if (!entry.currentlyWorksHere) filled += fillDate(`${prefix}EmpEnd`, entry.endDate);
  });

  // These are corrections, not newly filled answers, so they intentionally do not increase the
  // "filled" summary. Only clear values that exactly duplicate the saved applicant identity.
  removeApplicantFromReferences(profile);
  removePhoneFromExtension(profile);
  removeApplicantPhoneFromEmploymentContacts(profile);
  return { filled, flagged: 0 };
}
