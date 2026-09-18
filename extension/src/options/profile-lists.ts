import { WorkHistoryEntry, EducationEntry, ProfileFieldKey } from '../storage/profile-schema';
import { normalize } from '../fill-engine/synonym-dictionary';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const MONTHS = [
  ['01', 'January'], ['02', 'February'], ['03', 'March'], ['04', 'April'],
  ['05', 'May'], ['06', 'June'], ['07', 'July'], ['08', 'August'],
  ['09', 'September'], ['10', 'October'], ['11', 'November'], ['12', 'December'],
] as const;

function dateParts(value = ''): { month: string; year: string } {
  const monthFirst = value.match(/^(\d{1,2})\/(\d{4})$/);
  if (monthFirst) return { month: monthFirst[1].padStart(2, '0'), year: monthFirst[2] };
  const yearFirst = value.match(/^(\d{4})-(\d{1,2})$/);
  if (yearFirst) return { month: yearFirst[2].padStart(2, '0'), year: yearFirst[1] };
  return { month: '', year: value.match(/^\d{4}$/)?.[0] ?? '' };
}

function monthOptions(selected: string): string {
  return `<option value="">Month</option>${MONTHS.map(([value, label]) =>
    `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`
  ).join('')}`;
}

function yearOptions(selected: string): string {
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 81 }, (_, index) => String(currentYear + 10 - index));
  if (selected && !years.includes(selected)) years.push(selected);
  return `<option value="">Year</option>${years.map((year) =>
    `<option value="${year}"${year === selected ? ' selected' : ''}>${year}</option>`
  ).join('')}`;
}

function dateSelects(prefix: 'start' | 'end', value: string): string {
  const { month, year } = dateParts(value);
  return `
    <select name="${prefix}Month">${monthOptions(month)}</select>
    <select name="${prefix}Year">${yearOptions(year)}</select>
  `;
}

function readDate(entry: HTMLElement, prefix: 'start' | 'end'): string {
  const month = (entry.querySelector(`[name="${prefix}Month"]`) as HTMLSelectElement).value;
  const year = (entry.querySelector(`[name="${prefix}Year"]`) as HTMLSelectElement).value;
  return month && year ? `${month}/${year}` : '';
}

const DEGREES = [
  ['', '-- Degree --'], ['High School Diploma', 'High School Diploma'], ['GED', 'GED'],
  ['AA', 'AA — Associate of Arts'], ['AS', 'AS — Associate of Science'],
  ['BA', 'BA — Bachelor of Arts'], ['BS', 'BS — Bachelor of Science'],
  ['BBA', 'BBA — Bachelor of Business Administration'], ['MA', 'MA — Master of Arts'],
  ['MS', 'MS — Master of Science'], ['MBA', 'MBA — Master of Business Administration'],
  ['JD', 'JD — Juris Doctor'], ['MD', 'MD — Doctor of Medicine'],
  ['PhD', 'PhD — Doctor of Philosophy'], ['Other', 'Other'],
] as const;

function canonicalDegree(value: string): string {
  const normalized = normalize(value);
  const compact = normalized.replace(/\s/g, '').toLowerCase();
  const acronym = DEGREES.find(([degree]) => degree && degree.toLowerCase() === compact)?.[0];
  if (acronym) return acronym;
  const aliases: Record<string, string> = {
    'associate of arts': 'AA', 'associate of science': 'AS',
    'bachelor of arts': 'BA', 'bachelor of science': 'BS',
    'bachelor of business administration': 'BBA', 'master of arts': 'MA',
    'master of science': 'MS', 'master of business administration': 'MBA',
    'juris doctor': 'JD', 'doctor of medicine': 'MD', 'doctor of philosophy': 'PhD',
  };
  return aliases[normalized] ?? value;
}

function degreeOptions(value: string): string {
  const selected = canonicalDegree(value);
  return DEGREES.map(([degree, label]) =>
    `<option value="${degree}"${degree === selected ? ' selected' : ''}>${label}</option>`
  ).join('');
}

export function renderWorkHistoryEntry(entry: WorkHistoryEntry): HTMLElement {
  const startDate = entry.startDate;
  const endDate = entry.endDate;
  const div = document.createElement('div');
  div.setAttribute('data-work-entry', '');
  div.innerHTML = `
    <input name="company" placeholder="Company" value="${escapeHtml(entry.company)}" />
    <input name="title" placeholder="Title" value="${escapeHtml(entry.title)}" />
    <input name="location" placeholder="Location" value="${escapeHtml(entry.location ?? '')}" />
    <span>From</span>${dateSelects('start', startDate)}
    <span>To</span>${dateSelects('end', endDate)}
    <label><input type="checkbox" name="currentlyWorksHere"${entry.currentlyWorksHere ? ' checked' : ''} /> I currently work here</label>
    <textarea name="description">${escapeHtml(entry.description)}</textarea>
    <input name="supervisorName" placeholder="Supervisor name" value="${escapeHtml(entry.supervisorName ?? '')}" />
    <input name="supervisorPhone" placeholder="Supervisor / employer phone" value="${escapeHtml(entry.supervisorPhone ?? '')}" />
    <label>May we contact this employer?
      <select name="mayContact">
        <option value=""${!entry.mayContact ? ' selected' : ''}></option>
        <option value="yes"${entry.mayContact === 'yes' ? ' selected' : ''}>Yes</option>
        <option value="no"${entry.mayContact === 'no' ? ' selected' : ''}>No</option>
      </select>
    </label>
    <textarea name="reasonForLeaving" placeholder="Reason for leaving">${escapeHtml(entry.reasonForLeaving ?? '')}</textarea>
    <button type="button" data-remove>Remove</button>
  `;
  return div;
}

export function parseWorkHistory(container: HTMLElement): WorkHistoryEntry[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-work-entry]')).map((entry) => ({
    company: (entry.querySelector('[name="company"]') as HTMLInputElement).value,
    title: (entry.querySelector('[name="title"]') as HTMLInputElement).value,
    location: (entry.querySelector('[name="location"]') as HTMLInputElement).value,
    startDate: readDate(entry, 'start'),
    endDate: readDate(entry, 'end'),
    currentlyWorksHere: (entry.querySelector('[name="currentlyWorksHere"]') as HTMLInputElement).checked,
    description: (entry.querySelector('[name="description"]') as HTMLTextAreaElement).value,
    supervisorName: (entry.querySelector('[name="supervisorName"]') as HTMLInputElement).value,
    supervisorPhone: (entry.querySelector('[name="supervisorPhone"]') as HTMLInputElement).value,
    mayContact: (entry.querySelector('[name="mayContact"]') as HTMLSelectElement).value as '' | 'yes' | 'no',
    reasonForLeaving: (entry.querySelector('[name="reasonForLeaving"]') as HTMLTextAreaElement).value,
  }));
}

export function renderEducationEntry(entry: EducationEntry): HTMLElement {
  const startDate = entry.startDate ?? (entry.startYear ? `01/${entry.startYear}` : '');
  const endDate = entry.endDate ?? (entry.endYear ? `01/${entry.endYear}` : entry.graduationDate);
  const div = document.createElement('div');
  div.setAttribute('data-education-entry', '');
  div.innerHTML = `
    <input name="school" placeholder="School" value="${escapeHtml(entry.school)}" />
    <select name="degree">${degreeOptions(entry.degree)}</select>
    <input name="fieldOfStudy" placeholder="Field of Study" value="${escapeHtml(entry.fieldOfStudy)}" />
    <input name="location" placeholder="Location (City, State, Country)" value="${escapeHtml(entry.location ?? '')}" />
    <span>From</span>${dateSelects('start', startDate)}
    <span>To</span>${dateSelects('end', endDate)}
    <input name="gpa" placeholder="GPA" value="${escapeHtml(entry.gpa ?? '')}" />
    <button type="button" data-remove>Remove</button>
  `;
  return div;
}

export function parseEducation(container: HTMLElement): EducationEntry[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-education-entry]')).map((entry) => {
    const startDate = readDate(entry, 'start');
    const endDate = readDate(entry, 'end');
    return {
      school: (entry.querySelector('[name="school"]') as HTMLInputElement).value,
      degree: (entry.querySelector('[name="degree"]') as HTMLSelectElement).value,
      fieldOfStudy: (entry.querySelector('[name="fieldOfStudy"]') as HTMLInputElement).value,
      location: (entry.querySelector('[name="location"]') as HTMLInputElement).value,
      startDate,
      endDate,
      startYear: dateParts(startDate).year,
      endYear: dateParts(endDate).year,
      gpa: (entry.querySelector('[name="gpa"]') as HTMLInputElement).value,
      graduationDate: endDate,
    };
  });
}

export const PROFILE_FIELD_KEYS: { key: ProfileFieldKey; label: string }[] = [
  { key: 'personal.firstName', label: 'First Name' },
  { key: 'personal.middleName', label: 'Middle Name' },
  { key: 'personal.lastName', label: 'Last Name' },
  { key: 'personal.fullName', label: 'Full Name' },
  { key: 'personal.email', label: 'Email' },
  { key: 'personal.phone', label: 'Phone' },
  { key: 'personal.phoneType', label: 'Phone Type' },
  { key: 'personal.phoneCountryCode', label: 'Phone Country Code' },
  { key: 'personal.address', label: 'Address Line 1' },
  { key: 'personal.addressLine2', label: 'Address Line 2' },
  { key: 'personal.city', label: 'City' },
  { key: 'personal.county', label: 'County' },
  { key: 'personal.country', label: 'Country' },
  { key: 'personal.state', label: 'State' },
  { key: 'personal.zip', label: 'Zip' },
  { key: 'workAuthorization.authorizedToWork', label: 'Authorized to Work' },
  { key: 'workAuthorization.requiresSponsorship', label: 'Requires Sponsorship' },
  { key: 'workAuthorization.usPerson', label: 'U.S. Person' },
  { key: 'workAuthorization.restrictedCountryStatus', label: 'Restricted-country Citizenship/Residency' },
  { key: 'jobPreferences.availableStartDate', label: 'Available Start Date' },
  { key: 'jobPreferences.atLeast18', label: 'At Least 18' },
  { key: 'jobPreferences.minimumSalary', label: 'Minimum Salary' },
  { key: 'jobPreferences.usCitizen', label: 'U.S. Citizen' },
  { key: 'jobPreferences.securityClearance', label: 'Security Clearance' },
  { key: 'jobPreferences.willingToRelocate', label: 'Willing to Relocate' },
  { key: 'professional.hasNonCompeteAgreement', label: 'Active Non-Compete Agreement' },
  { key: 'professional.highestEducation', label: 'Highest Completed Education' },
  { key: 'disclosures.hispanicOrLatino', label: 'Hispanic/Latino Status' },
  { key: 'disclosures.gender', label: 'Gender' },
  { key: 'disclosures.raceEthnicity', label: 'Race/Ethnicity' },
  { key: 'disclosures.veteranStatus', label: 'Veteran Status' },
  { key: 'disclosures.disabilityStatus', label: 'Disability Status' },
  { key: 'links.linkedin', label: 'LinkedIn' },
  { key: 'links.portfolio', label: 'Portfolio' },
  { key: 'links.github', label: 'GitHub' },
];

export function renderOverrideRow(label = '', fieldKey: ProfileFieldKey | '' = ''): HTMLElement {
  const div = document.createElement('div');
  div.setAttribute('data-override-row', '');
  const options = PROFILE_FIELD_KEYS.map(
    (f) => `<option value="${f.key}"${f.key === fieldKey ? ' selected' : ''}>${f.label}</option>`
  ).join('');
  div.innerHTML = `
    <input name="label" placeholder="Question phrasing" value="${escapeHtml(label)}" />
    <select name="fieldKey"><option value="">--</option>${options}</select>
    <button type="button" data-remove>Remove</button>
  `;
  return div;
}

export function parseOverrides(container: HTMLElement): Record<string, ProfileFieldKey> {
  const overrides: Record<string, ProfileFieldKey> = {};

  container.querySelectorAll<HTMLElement>('[data-override-row]').forEach((row) => {
    const labelInput = row.querySelector('[name="label"]') as HTMLInputElement;
    const keySelect = row.querySelector('[name="fieldKey"]') as HTMLSelectElement;
    const label = normalize(labelInput.value);
    const key = keySelect.value as ProfileFieldKey;
    if (label && key) overrides[label] = key;
  });

  return overrides;
}
