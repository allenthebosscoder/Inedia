import { Profile, ProfileFieldKey } from '../storage/profile-schema';
import {
  buildCandidates,
  findMatchIndex,
  flagField,
  resolveProfileValue,
  setNativeValue,
} from './fill-engine';
import { normalize } from './synonym-dictionary';
import { FillSummary } from './types';
import { findCompanyWebsiteSourceIndex } from './source-answer';

export const ULTIPRO_HOST_PATTERN = /(?:^|\.)ultipro\.com$/i;

function clearFlag(element: HTMLElement): void {
  delete element.dataset.autofillFlag;
  element.style.outline = '';
}

function markHandled(element: HTMLElement): void {
  element.dataset.jobAutofillHandled = 'true';
  clearFlag(element);
}

function optionLabel(input: HTMLInputElement): string {
  return input.closest('label')?.textContent?.replace(/\s+/g, ' ').trim() || input.value;
}

function chooseRadio(inputs: HTMLInputElement[], candidates: string[]): boolean {
  const match = findMatchIndex(inputs.map(optionLabel), candidates);
  if (match === null) return false;
  if (!inputs[match].checked) inputs[match].click();
  if (!inputs[match].checked) return false;
  inputs.forEach(markHandled);
  return true;
}

function chooseSelect(select: HTMLSelectElement, profileKey: ProfileFieldKey, value: string): boolean {
  const options = Array.from(select.options);
  const candidates = buildCandidates(profileKey, value);
  const match = findMatchIndex(
    options.map((option) => `${option.value} ${option.textContent ?? ''}`),
    candidates
  );
  if (match === null) return false;
  setNativeValue(select, options[match].value);
  if (select.value !== options[match].value) return false;
  markHandled(select);
  return true;
}

function markOptionalControls(root: ParentNode, profile: Profile): void {
  const selectors = [
    '#Prefix',
    '#Suffix',
    '#PreferredName',
    '#FormerName',
    '#SecondaryPhone',
    '[data-automation="existing-resume-selector"]',
    '[data-automation="file-description"]',
    '[data-automation$="-decline-checkbox"]',
  ];
  if (!profile.personal.middleName) selectors.push('#MiddleName');
  root.querySelectorAll<HTMLElement>(selectors.join(',')).forEach(markHandled);
}

function includeExistingResume(root: ParentNode, profile: Profile): 'included' | 'absent' | 'failed' {
  const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-automation="file-row"]'));
  const storedName = normalize(profile.resume?.name ?? '');
  const row = rows.find((candidate) => {
    const name = normalize(candidate.querySelector<HTMLElement>('[data-automation="file-name"]')?.textContent ?? '');
    const type = normalize(candidate.querySelector<HTMLElement>('[data-automation="file-type"]')?.textContent ?? '');
    return (storedName && name.includes(storedName)) || /(?:^|\s)(?:resume|cv)(?:\s|$)/.test(type);
  });
  if (!row) return 'absent';

  const checkbox = row.querySelector<HTMLInputElement>('[data-automation="select-document-checkbox"]');
  // A few tenant layouts show uploaded documents without offering per-application inclusion.
  // In that shape there is no actionable control to flag or safely infer.
  if (!checkbox) return 'absent';
  if (!checkbox.checked) checkbox.click();
  if (!checkbox.checked) {
    checkbox.dataset.jobAutofillHandled = 'true';
    flagField(checkbox);
    return 'failed';
  }
  markHandled(checkbox);

  // The document is already stored by UltiPro and selected for this application. Do not feed the
  // same profile file into either of its upload controls, which would create a duplicate.
  root.querySelectorAll<HTMLElement>('[data-automation="upload-file-input"]').forEach(markHandled);
  return 'included';
}

function chooseCompanyWebsiteApplicantSource(root: ParentNode): boolean {
  const select = root.querySelector<HTMLSelectElement>('#ApplicantSource, [data-automation="applicant-source-dropdown"]');
  if (!select) return false;
  if (select.value) {
    markHandled(select);
    return true;
  }
  const options = Array.from(select.options).filter((candidate) => candidate.value.trim());
  const match = findCompanyWebsiteSourceIndex(options.map((option) => option.textContent ?? ''));
  if (match === null) return false;
  setNativeValue(select, options[match].value);
  if (!select.value) return false;
  markHandled(select);
  return true;
}

function chooseNoEmployeeReferral(root: ParentNode): boolean {
  const radios = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="radio"][name="employeereferral"]'));
  if (radios.length === 0) return false;
  return chooseRadio(radios, ['No', 'False']);
}

interface QuestionRule {
  pattern: RegExp;
  profileKey?: ProfileFieldKey;
  candidates?: (profile: Profile) => string[] | null;
}

const QUESTION_RULES: QuestionRule[] = [
  {
    pattern: /non[- ]?(?:competition|compete)|non[- ]?solicitation|restrict your ability to work/i,
    profileKey: 'professional.hasNonCompeteAgreement',
  },
  {
    pattern: /(?:currently )?authorized to work|legally authorized to work/i,
    profileKey: 'workAuthorization.authorizedToWork',
  },
  {
    pattern: /require (?:employment )?(?:visa )?sponsorship|sponsorship for an employment visa|now or in the future.*sponsor/i,
    profileKey: 'workAuthorization.requiresSponsorship',
  },
  {
    pattern: /(?:at least|over) 18|18 years of age|legal working age/i,
    profileKey: 'jobPreferences.atLeast18',
  },
  {
    pattern: /willing|able to relocate/i,
    profileKey: 'jobPreferences.willingToRelocate',
  },
  {
    pattern: /(?:united states|u\.?s\.?) citizen/i,
    profileKey: 'jobPreferences.usCitizen',
  },
  {
    pattern: /security clearance/i,
    profileKey: 'jobPreferences.securityClearance',
  },
  {
    pattern: /current .+ employee|currently employed (?:by|with)/i,
    candidates: () => ['No - I am not currently an employee', 'No - I am not currently', 'No'],
  },
];

function fillApplicationQuestions(root: ParentNode, profile: Profile): number {
  let filled = 0;
  const questionLabels = Array.from(root.querySelectorAll<HTMLElement>('[data-automation="question-title"]'));
  for (const label of questionLabels) {
    const question = label.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const rule = QUESTION_RULES.find((candidate) => candidate.pattern.test(question));
    if (!rule) continue;
    const group = label.closest<HTMLElement>('[role="group"], [role="radiogroup"], .form-group');
    const radios = group
      ? Array.from(group.querySelectorAll<HTMLInputElement>('input[type="radio"][data-automation="multiple-choice-response"]'))
      : [];
    if (radios.length === 0) continue;

    let candidates = rule.candidates?.(profile) ?? null;
    if (rule.profileKey) {
      const value = resolveProfileValue(profile, rule.profileKey);
      if (!value) continue;
      candidates = buildCandidates(rule.profileKey, value);
    }
    if (candidates && chooseRadio(radios, candidates)) filled++;
  }
  return filled;
}

function fillVoluntarySelects(root: ParentNode, profile: Profile): number {
  const mappings: Array<{ selector: string; key: ProfileFieldKey }> = [
    { selector: '#Gender, select[data-automation="gender-dropdown"]', key: 'disclosures.gender' },
    { selector: '#HispanicOrigin, select[data-automation="ethnic-origin-dropdown"]', key: 'disclosures.hispanicOrLatino' },
    { selector: '#EthnicOrigin, select[data-automation="country-questions-race"]', key: 'disclosures.raceEthnicity' },
    { selector: '#VeteranStatus, select[data-automation="veteran-status-dropdown"]', key: 'disclosures.veteranStatus' },
  ];
  let filled = 0;
  for (const { selector, key } of mappings) {
    const select = root.querySelector<HTMLSelectElement>(selector);
    const value = resolveProfileValue(profile, key);
    if (select && value && chooseSelect(select, key, value)) filled++;
  }
  return filled;
}

async function fillAvailableStartDate(root: ParentNode, date: string): Promise<boolean> {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const wrapper = root.querySelector<HTMLElement>('[data-automation="available-start-date-datepicker"]');
  const dateText = wrapper?.querySelector<HTMLElement>('ukg-date-input-text');
  const shadow = dateText?.shadowRoot;
  const parts = shadow ? Array.from(shadow.querySelectorAll<HTMLInputElement>('input')) : [];
  if (!wrapper || !dateText || parts.length !== 3) return false;

  const values = [match[2], match[3], match[1]];
  for (let index = 0; index < parts.length; index++) {
    const input = parts[index];
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, values[index]);
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      data: values[index],
      inputType: 'insertText',
    }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    input.blur();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));

  const host = wrapper.querySelector<HTMLElement>('ukg-input[data-automation="ukg-datepicker-input"]');
  const committed = parts.every((input, index) => input.value === values[index]) &&
    (host?.getAttribute('value') === date || dateText.getAttribute('value') === date);
  if (committed) {
    markHandled(wrapper);
    markHandled(dateText);
    return true;
  }
  // Flag the empty light-DOM date element, not its wrapper whose question-label text could make
  // the generic satisfied-field cleanup mistake a failed custom date for a completed field.
  flagField(dateText);
  return false;
}

export async function fillUltiProForm(
  profile: Profile,
  root: ParentNode = document
): Promise<FillSummary> {
  markOptionalControls(root, profile);
  let filled = 0;
  let flagged = 0;

  const resumeResult = includeExistingResume(root, profile);
  if (resumeResult === 'included') filled++;
  else if (resumeResult === 'failed') flagged++;
  if (chooseCompanyWebsiteApplicantSource(root)) filled++;
  if (chooseNoEmployeeReferral(root)) filled++;
  filled += fillApplicationQuestions(root, profile);
  filled += fillVoluntarySelects(root, profile);
  if (profile.jobPreferences.availableStartDate &&
      root.querySelector('[data-automation="available-start-date-datepicker"]')) {
    if (await fillAvailableStartDate(root, profile.jobPreferences.availableStartDate)) filled++;
    else flagged++;
  }

  return {
    filled,
    flagged,
  };
}
