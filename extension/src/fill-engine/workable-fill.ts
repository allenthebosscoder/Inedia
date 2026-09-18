import type { EducationEntry, Profile } from '../storage/profile-schema';
import { setNativeValue } from './fill-engine';
import type { FillSummary } from './types';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | null | undefined, attempts = 25): Promise<T | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = read();
    if (value) return value;
    await wait(20);
  }
  return null;
}

export function workableMonthYear(value: string): string {
  const iso = value.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (iso) return `${String(Number(iso[2])).padStart(2, '0')}/${iso[1]}`;
  const us = value.match(/^(\d{1,2})\/(\d{4})$/);
  if (us) return `${String(Number(us[1])).padStart(2, '0')}/${us[2]}`;
  const year = value.match(/^(\d{4})$/);
  return year ? `01/${year[1]}` : '';
}

export function workableEducationEndDate(value: string, now = new Date()): string {
  const normalized = workableMonthYear(value);
  if (!normalized) return '';
  const [month, year] = normalized.split('/').map(Number);
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  // Workable rejects future education dates in both the text mask and month picker. For an
  // education that is still in progress, the latest valid "attended through" value is the
  // current month; otherwise the controlled input immediately restores an empty value.
  if (year > currentYear || (year === currentYear && month > currentMonth)) {
    return `${String(currentMonth).padStart(2, '0')}/${currentYear}`;
  }
  return normalized;
}

function setInput(group: HTMLElement, name: string, value: string): boolean {
  if (!value) return false;
  const input = group.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!input) return false;
  setNativeValue(input, value);
  input.blur();
  return input.value === value;
}

async function setDateInput(group: HTMLElement, name: string, value: string): Promise<boolean> {
  if (!value) return false;
  const input = group.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!input) return false;
  if (input.value === value) return true;

  const [month, year] = value.split('/').map(Number);
  if (month >= 1 && month <= 12 && Number.isInteger(year)) {
    // Use Workable's React month picker so its reducer receives a real Date. Setting the masked
    // input's DOM value can look filled while Workable still saves null (or it can be restored
    // immediately by the controlled component).
    input.click();
    let header = await waitFor(() => document.querySelector<HTMLElement>('.react-datepicker-year-header'));
    for (let attempt = 0; header && attempt < 120; attempt++) {
      const displayedYear = Number(header.textContent?.trim());
      if (displayedYear === year) break;
      const direction = displayedYear > year ? 'Previous Year' : 'Next Year';
      const navigation = document.querySelector<HTMLButtonElement>(
        `.react-datepicker__navigation[aria-label="${direction}"]`
      );
      if (!navigation) break;
      navigation.click();
      header = await waitFor(() => {
        const next = document.querySelector<HTMLElement>('.react-datepicker-year-header');
        return next && Number(next.textContent?.trim()) !== displayedYear ? next : null;
      });
    }
    const monthName = new Date(2000, month - 1, 1).toLocaleString('en-US', { month: 'long' });
    const tile = document.querySelector<HTMLElement>(
      `[role="option"][aria-label="Choose ${monthName} ${year}"]`
    );
    if (tile && !tile.classList.contains('react-datepicker__month-text--disabled')) {
      tile.click();
      if (await waitFor(() => input.value === value || null)) return true;
    }
  }

  input.focus();
  input.select();
  let browserEdited = typeof document.execCommand === 'function';
  if (browserEdited) {
    // Workable's masked MM/YYYY component rejects a full prototype-set value and immediately
    // restores an empty React state. Character-by-character insertText follows the same path as
    // typing and lets the mask add its slash after the second digit.
    for (const character of value.replace('/', '')) {
      if (!document.execCommand('insertText', false, character)) {
        browserEdited = false;
        break;
      }
    }
  }
  if (!browserEdited || input.value !== value) setNativeValue(input, value);
  input.blur();
  return input.value === value;
}

function savedEducationCount(group: HTMLElement): number {
  return group.querySelectorAll('li [data-ui="school"]').length;
}

async function fillEducationEditor(
  group: HTMLElement,
  education: EducationEntry,
  summary: FillSummary
): Promise<boolean> {
  if (setInput(group, 'school', education.school)) summary.filled++;
  else return false;
  if (setInput(group, 'field_of_study', education.fieldOfStudy)) summary.filled++;
  if (setInput(group, 'degree', education.degree)) summary.filled++;
  const start = workableMonthYear(education.startDate || education.startYear || '');
  const end = workableEducationEndDate(
    education.endDate || education.graduationDate || education.endYear || ''
  );
  if (await setDateInput(group, 'start_date', start)) summary.filled++;
  if (await setDateInput(group, 'end_date', end)) summary.filled++;

  const before = savedEducationCount(group);
  group.querySelector<HTMLButtonElement>('button[data-ui="save-section"]')?.click();
  return Boolean(await waitFor(() => savedEducationCount(group) > before || null));
}

export async function fillWorkableForm(profile: Profile): Promise<FillSummary> {
  const summary: FillSummary = { filled: 0, flagged: 0 };
  const group = document.querySelector<HTMLElement>('[data-ui="education"]');
  if (!group || profile.education.length === 0) return summary;

  let index = savedEducationCount(group);
  while (index < profile.education.length) {
    let editor = group.querySelector<HTMLInputElement>('input[name="school"]');
    if (!editor) {
      const add = group.querySelector<HTMLButtonElement>('button[data-ui="add-section"]');
      if (!add || add.disabled) break;
      add.click();
      editor = await waitFor(() => group.querySelector<HTMLInputElement>('input[name="school"]'));
    }
    if (!editor || !await fillEducationEditor(group, profile.education[index], summary)) break;
    index++;
  }
  return summary;
}
