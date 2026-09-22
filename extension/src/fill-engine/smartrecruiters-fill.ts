import type { EducationEntry, Profile, WorkHistoryEntry } from '../storage/profile-schema';
import {
  buildCandidates,
  findMatchIndex,
  flagField,
  resolveProfileValue,
} from './fill-engine';
import { lookupFieldKey } from './synonym-dictionary';
import type { FillSummary } from './types';
import { normalizeStateValue } from './us-states';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | null | undefined, attempts = 30): Promise<T | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = read();
    if (value) return value;
    await wait(50);
  }
  return null;
}

function nativeInput(host: HTMLElement): HTMLInputElement | HTMLTextAreaElement | null {
  const direct = host.shadowRoot?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input.c-spl-input, textarea.c-spl-textarea, input, textarea');
  if (direct) return direct;
  const nestedInput = host.shadowRoot?.querySelector<HTMLElement>('spl-input, spl-textarea');
  return nestedInput ? nativeInput(nestedInput) : null;
}

function setEditedValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    composed: true,
    inputType: 'insertText',
    data: value,
  }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function clickSplButton(label: string): boolean {
  const host = Array.from(document.querySelectorAll<HTMLElement>('spl-button'))
    .find((button) => button.getAttribute('aria-label') === label);
  const button = host?.shadowRoot?.querySelector<HTMLButtonElement>('button');
  if (!button) return false;
  button.click();
  return true;
}

function deepQuery(root: ParentNode, selector: string): HTMLElement | null {
  const direct = root.querySelector<HTMLElement>(selector);
  if (direct) return direct;
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (!element.shadowRoot) continue;
    const nested = deepQuery(element.shadowRoot, selector);
    if (nested) return nested;
  }
  return null;
}

function deepQueryAll<T extends HTMLElement>(root: ParentNode, selector: string): T[] {
  const matches = Array.from(root.querySelectorAll<T>(selector));
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (element.shadowRoot) matches.push(...deepQueryAll<T>(element.shadowRoot, selector));
  }
  return matches;
}

function clickOption(option: HTMLElement): void {
  const target = option.shadowRoot ? deepQuery(option.shadowRoot, '[role="option"]') : null;
  const clickable = target ?? option;
  clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
  clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
  clickable.click();
}

function selectedAutocompleteValue(host: HTMLElement): boolean {
  const value = host.getAttribute('value');
  return Boolean(value && value !== '' && value !== '[object Object]') || value === '[object Object]';
}

async function fillAutocomplete(
  host: HTMLElement,
  value: string,
  state = ''
): Promise<boolean> {
  if (!value) return false;
  if (selectedAutocompleteValue(host)) return true;
  const input = nativeInput(host);
  if (!input) return false;
  input.focus();
  setEditedValue(input, value);
  const options = await waitFor(() => {
    const found = host.shadowRoot
      ? deepQueryAll<HTMLElement>(host.shadowRoot, 'spl-select-option')
      : [];
    return found.length ? found : null;
  });
  if (!options) return false;

  const wantedCity = value.split(',')[0].trim().toLocaleLowerCase();
  const wantedState = normalizeStateValue(state || value.split(',').slice(1).join(',').trim()).toLocaleLowerCase();
  const option = options.find((candidate) => {
    const text = (candidate.innerText || candidate.textContent || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    if (candidate.getAttribute('value') === '#spl-custom-option') return !state;
    return text.startsWith(wantedCity) && (!wantedState || text.includes(`, ${wantedState.toLocaleLowerCase()},`));
  }) ?? options.find((candidate) => {
    const text = (candidate.innerText || candidate.textContent || '').trim().toLocaleLowerCase();
    return text === value.toLocaleLowerCase() || text.startsWith(`${wantedCity},`);
  });
  if (!option) return false;
  clickOption(option);
  await wait(30);
  return Boolean(nativeInput(host)?.value.trim());
}

function screeningLabel(host: HTMLElement): string {
  const visibleLabel = (host.innerText || host.textContent || '').replace(/\s+/g, ' ').trim();
  if (visibleLabel) return visibleLabel;
  return (host.getAttribute('aria-label') ?? '')
    .replace(/^Select\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fillScreeningRadio(host: HTMLElement, value: string, profileKey: string): Promise<boolean> {
  const options = Array.from(host.querySelectorAll<HTMLElement>('spl-radio'));
  const labels = options.map((option) => option.getAttribute('label') || option.textContent || '');
  const matchIndex = findMatchIndex(labels, buildCandidates(profileKey, value));
  if (matchIndex === null) return false;
  const option = options[matchIndex];
  if (option.getAttribute('aria-checked') === 'true') return true;
  option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
  option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
  option.click();
  await wait(20);
  return option.getAttribute('aria-checked') === 'true';
}

async function fillScreeningAutocomplete(host: HTMLElement, value: string, profileKey: string): Promise<boolean> {
  if (selectedAutocompleteValue(host)) return true;
  const input = nativeInput(host);
  if (!input) return false;
  input.focus();
  input.click();
  let options = await waitFor(() => {
    const found = host.shadowRoot
      ? deepQueryAll<HTMLElement>(host.shadowRoot, 'spl-select-option')
      : [];
    return found.length ? found : null;
  });
  if (!options) {
    // Most screening dropdowns have minQueryLength=0. This fallback supports tenants that defer
    // loading until the user types without filtering on a profile phrase that may differ from the
    // site's concise option (for example, saved "I am not a veteran" versus option "No").
    setEditedValue(input, value.slice(0, 1));
    options = await waitFor(() => {
      const found = host.shadowRoot
        ? deepQueryAll<HTMLElement>(host.shadowRoot, 'spl-select-option')
        : [];
      return found.length ? found : null;
    });
  }
  if (!options) return false;
  const labels = options.map((option) => (option.innerText || option.textContent || '').replace(/\s+/g, ' ').trim());
  const matchIndex = findMatchIndex(labels, buildCandidates(profileKey, value));
  if (matchIndex === null) return false;
  clickOption(options[matchIndex]);
  await wait(30);
  return selectedAutocompleteValue(host) || Boolean(input.value.trim());
}

async function fillScreeningQuestions(profile: Profile, summary: FillSummary): Promise<void> {
  const radioGroups = deepQueryAll<HTMLElement>(document, 'spl-radio-group');
  for (const host of radioGroups) {
    const label = screeningLabel(host);
    const profileKey = lookupFieldKey(label);
    if (!profileKey) {
      if (host.hasAttribute('required')) markFailure(host, summary);
      continue;
    }
    const value = resolveProfileValue(profile, profileKey);
    if (value && await fillScreeningRadio(host, value, profileKey)) summary.filled++;
    else markFailure(host, summary);
  }

  const dropdowns = deepQueryAll<HTMLElement>(document, 'spl-autocomplete')
    .filter((host) => host.id.startsWith('question_') || (host.getAttribute('data-test') ?? '').startsWith('question-eeo-'));
  for (const host of dropdowns) {
    const label = screeningLabel(host);
    const profileKey = lookupFieldKey(label);
    if (!profileKey) {
      if (host.hasAttribute('required')) markFailure(host, summary);
      continue;
    }
    const value = resolveProfileValue(profile, profileKey);
    if (value && await fillScreeningAutocomplete(host, value, profileKey)) summary.filled++;
    else markFailure(host, summary);
  }
}

export function parseSmartRecruitersMonthYear(value: string): { month: number; year: number } | null {
  const iso = value.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]) };
  const us = value.match(/^(\d{1,2})\/(\d{4})$/);
  if (us) return { year: Number(us[2]), month: Number(us[1]) };
  const year = value.match(/^(\d{4})$/);
  if (year) return { year: Number(year[1]), month: 1 };
  return null;
}

async function fillDate(host: HTMLElement | null, value: string): Promise<boolean> {
  const parsed = parseSmartRecruitersMonthYear(value);
  if (!host || !parsed) return false;
  if (host.getAttribute('value')) return true;
  const picker = host.shadowRoot?.querySelector<HTMLElement>('spl-date-picker');
  const pickerRoot = picker?.shadowRoot;
  const input = pickerRoot?.querySelector<HTMLInputElement>('input[data-input]');
  const yearInput = pickerRoot?.querySelector<HTMLInputElement>('input.cur-year');
  if (!input || !yearInput || !pickerRoot) return false;
  input.click();
  let displayedYear = Number(yearInput.value);
  const direction = parsed.year < displayedYear ? '.flatpickr-prev-month' : '.flatpickr-next-month';
  for (let attempts = 0; displayedYear !== parsed.year && attempts < 100; attempts++) {
    pickerRoot.querySelector<HTMLElement>(direction)?.click();
    await wait(5);
    displayedYear = Number(yearInput.value);
  }
  if (displayedYear !== parsed.year) return false;
  const months = Array.from(pickerRoot.querySelectorAll<HTMLElement>('.flatpickr-monthSelect-month'));
  months[parsed.month - 1]?.click();
  await wait(20);
  return Boolean(host.getAttribute('value') || input.value);
}

function setSplText(selector: string, value: string): boolean {
  if (!value) return false;
  const host = document.querySelector<HTMLElement>(selector);
  const input = host ? nativeInput(host) : null;
  if (!input) return false;
  setEditedValue(input, value);
  input.blur();
  return input.value === value;
}

function setCurrentEmployment(current: boolean): boolean {
  const host = Array.from(document.querySelectorAll<HTMLElement>('spl-checkbox'))
    .find((checkbox) => /currently work here/i.test(checkbox.textContent ?? ''));
  const input = host?.shadowRoot?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!host || !input) return false;
  if (input.checked !== current) input.click();
  return input.checked === current;
}

function markFailure(element: HTMLElement | null, summary: FillSummary): void {
  if (!element) return;
  flagField(element);
  summary.flagged++;
}

async function fillExperience(entry: WorkHistoryEntry, summary: FillSummary): Promise<boolean> {
  const title = document.querySelector<HTMLElement>('spl-autocomplete[data-test="job-title-autocomplete"]');
  const company = document.querySelector<HTMLElement>('spl-autocomplete[data-test="company-autocomplete"]');
  const location = Array.from(document.querySelectorAll<HTMLElement>('spl-autocomplete[data-test="location-autocomplete"]'))
    .find((field) => field.getAttribute('label') === 'Office location') ?? null;
  if (!title || !company) return false;

  if (await fillAutocomplete(title, entry.title)) summary.filled++; else markFailure(title, summary);
  if (await fillAutocomplete(company, entry.company)) summary.filled++; else markFailure(company, summary);
  if (entry.location && location) {
    const [city, ...rest] = entry.location.split(',');
    if (await fillAutocomplete(location, city.trim(), rest.join(',').trim())) summary.filled++;
    else markFailure(location, summary);
  }
  if (entry.description && setSplText('spl-textarea[id^="exp-desc-"]', entry.description)) summary.filled++;

  const from = document.querySelector<HTMLElement>('spl-date-field[id^="exp-from-"]');
  if (await fillDate(from, entry.startDate)) summary.filled++; else markFailure(from, summary);
  if (entry.currentlyWorksHere) {
    if (setCurrentEmployment(true)) summary.filled++;
  } else {
    const to = document.querySelector<HTMLElement>('spl-date-field[id^="exp-to-"]');
    if (await fillDate(to, entry.endDate)) summary.filled++; else markFailure(to, summary);
  }
  return true;
}

async function fillEducation(entry: EducationEntry, summary: FillSummary): Promise<boolean> {
  const institution = document.querySelector<HTMLElement>('spl-autocomplete[data-test="institution-autocomplete"]');
  if (!institution) return false;
  if (await fillAutocomplete(institution, entry.school)) summary.filled++; else markFailure(institution, summary);
  if (entry.fieldOfStudy && setSplText('spl-input[id^="edu-major-"]', entry.fieldOfStudy)) summary.filled++;
  if (entry.degree && setSplText('spl-input[id^="edu-degree-"]', entry.degree)) summary.filled++;
  const start = entry.startDate || entry.startYear || '';
  const end = entry.endDate || entry.graduationDate || entry.endYear || '';
  if (start) {
    const from = document.querySelector<HTMLElement>('spl-date-field[id^="edu-from-"]');
    if (await fillDate(from, start)) summary.filled++; else markFailure(from, summary);
  }
  if (end) {
    const to = document.querySelector<HTMLElement>('spl-date-field[id^="edu-to-"]');
    if (await fillDate(to, end)) summary.filled++; else markFailure(to, summary);
  }
  return true;
}

function countSaved(kind: 'experience' | 'education'): number {
  const labels = Array.from(document.querySelectorAll<HTMLElement>('spl-button'))
    .map((button) => button.getAttribute('aria-label') ?? '');
  const editCount = labels.filter((label) => new RegExp(`^Edit ${kind} entry`, 'i').test(label)).length;
  const deleteCount = labels.filter((label) => new RegExp(`^Delete ${kind} entry`, 'i').test(label)).length;
  return editCount || deleteCount;
}

async function saveOpenEntry(kind: 'experience' | 'education'): Promise<boolean> {
  const label = `Save ${kind} entry`;
  if (!clickSplButton(label)) return false;
  return Boolean(await waitFor(() =>
    Array.from(document.querySelectorAll<HTMLElement>('spl-button'))
      .every((button) => button.getAttribute('aria-label') !== label) || null
  ));
}

async function fillEducationRows(profile: Profile, summary: FillSummary): Promise<void> {
  let index = countSaved('education');
  while (index < profile.education.length) {
    let editor = document.querySelector<HTMLElement>('spl-autocomplete[data-test="institution-autocomplete"]');
    if (!editor) {
      if (!clickSplButton('Add education entry')) return;
      editor = await waitFor(() => document.querySelector<HTMLElement>('spl-autocomplete[data-test="institution-autocomplete"]'));
    }
    if (!editor || !await fillEducation(profile.education[index], summary)) return;
    if (!await saveOpenEntry('education')) return;
    index++;
  }
}

async function fillExperienceRows(profile: Profile, summary: FillSummary): Promise<void> {
  let index = countSaved('experience');
  while (index < profile.workHistory.length) {
    let editor = document.querySelector<HTMLElement>('spl-autocomplete[data-test="job-title-autocomplete"]');
    if (!editor) {
      if (!clickSplButton('Add experience entry')) return;
      editor = await waitFor(() => document.querySelector<HTMLElement>('spl-autocomplete[data-test="job-title-autocomplete"]'));
    }
    if (!editor || !await fillExperience(profile.workHistory[index], summary)) return;
    if (!await saveOpenEntry('experience')) return;
    index++;
  }
}

export async function fillSmartRecruitersForm(profile: Profile): Promise<FillSummary> {
  const summary: FillSummary = { filled: 0, flagged: 0 };

  // If the user already opened an education editor, finish it before trying to open experience.
  if (document.querySelector('spl-autocomplete[data-test="institution-autocomplete"]')) {
    await fillEducationRows(profile, summary);
  }
  await fillExperienceRows(profile, summary);
  await fillEducationRows(profile, summary);
  await fillScreeningQuestions(profile, summary);

  const city = document.querySelector<HTMLElement>('spl-autocomplete[data-test="location-autocomplete"][label="City"]');
  if (city && profile.personal.city) {
    if (await fillAutocomplete(city, profile.personal.city, profile.personal.state)) summary.filled++;
    else markFailure(city, summary);
  }
  return summary;
}
