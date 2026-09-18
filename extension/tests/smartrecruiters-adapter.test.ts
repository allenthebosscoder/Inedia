import { beforeEach, describe, expect, it } from 'vitest';
import { extractSmartRecruitersFields, smartRecruitersAdapter } from '../src/fill-engine/smartrecruiters-adapter';
import { fillSmartRecruitersForm, parseSmartRecruitersMonthYear } from '../src/fill-engine/smartrecruiters-fill';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';

function shadow(host: HTMLElement, html: string): ShadowRoot {
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = html;
  return root;
}

describe('SmartRecruiters adapter', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches SmartRecruiters application hosts', () => {
    expect(smartRecruitersAdapter.matchesHostname('jobs.smartrecruiters.com')).toBe(true);
    expect(smartRecruitersAdapter.matchesHostname('example.com')).toBe(false);
  });

  it('normalizes SmartRecruiters month/year profile values', () => {
    expect(parseSmartRecruitersMonthYear('2024-08')).toEqual({ year: 2024, month: 8 });
    expect(parseSmartRecruitersMonthYear('05/2022')).toEqual({ year: 2022, month: 5 });
    expect(parseSmartRecruitersMonthYear('2020')).toEqual({ year: 2020, month: 1 });
    expect(parseSmartRecruitersMonthYear('not a date')).toBeNull();
  });

  it('extracts fields through nested SPL shadow roots', () => {
    const firstName = document.createElement('spl-input');
    firstName.id = 'first-name-input';
    firstName.setAttribute('required', '');
    shadow(firstName, '<label for="first-name-input">First name *</label><input id="first-name-input" aria-required="true">');

    const location = document.createElement('spl-autocomplete');
    location.setAttribute('data-test', 'location-autocomplete');
    const locationRoot = shadow(location, '<spl-input id="city-input"></spl-input>');
    const cityHost = locationRoot.querySelector<HTMLElement>('spl-input')!;
    shadow(cityHost, '<label for="city-input">City *</label><input id="city-input" aria-required="true">');

    document.body.append(firstName, location);
    const fields = extractSmartRecruitersFields();

    expect(fields.map((field) => [field.label.replace(/\s*\*$/, ''), field.profileKey])).toEqual([
      ['First name', 'personal.firstName'],
    ]);
  });

  it('extracts a slotted legal-name question through a non-SPL screening shadow host', () => {
    const screeningForm = document.createElement('sr-screening-questions-form');
    const formRoot = shadow(screeningForm, '<spl-input id="question_legal" required><span slot="label-content">Please confirm your Legal First and Last Name</span></spl-input>');
    const inputHost = formRoot.querySelector<HTMLElement>('spl-input')!;
    shadow(inputHost, '<label for="question_legal"><slot name="label-content"></slot>*</label><input id="question_legal" aria-required="true">');
    document.body.append(screeningForm);

    const fields = extractSmartRecruitersFields();

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      label: 'Please confirm your Legal First and Last Name',
      profileKey: 'personal.fullName',
      kind: 'text',
    });
  });

  it('maps confirm email and only the real resume attachment', () => {
    const confirmEmail = document.createElement('spl-input');
    confirmEmail.id = 'confirm-email-input';
    shadow(confirmEmail, '<label for="confirm-email-input">Confirm your email *</label><input id="confirm-email-input" type="email" aria-required="true">');

    const parseDropzone = document.createElement('spl-dropzone');
    parseDropzone.setAttribute('data-test', 'apply-with-resume-container');
    shadow(parseDropzone, '<input type="file" id="file-input">');
    const resumeDropzone = document.createElement('spl-dropzone');
    resumeDropzone.setAttribute('data-test', 'resume-upload');
    shadow(resumeDropzone, '<input type="file" id="file-input">');
    document.body.append(confirmEmail, parseDropzone, resumeDropzone);

    const fields = extractSmartRecruitersFields();

    expect(fields.filter((field) => field.kind === 'file')).toHaveLength(1);
    expect(fields.find((field) => field.kind === 'file')?.label).toBe('Resume *');
    expect(fields.find((field) => field.element.id === 'confirm-email-input')?.profileKey).toBe('personal.email');
  });

  it('ignores internal searches, calendar controls, and unsupported optional fields', () => {
    const countrySearch = document.createElement('spl-dropdown-search');
    shadow(countrySearch, '<input aria-label="Search by country/region or code">');
    const dateField = document.createElement('spl-date-field');
    dateField.setAttribute('required', '');
    shadow(dateField, '<label for="year">From *</label><input id="year" aria-required="true">');
    const facebook = document.createElement('spl-input');
    shadow(facebook, '<label for="facebook">Facebook</label><input id="facebook">');
    document.body.append(countrySearch, dateField, facebook);

    expect(extractSmartRecruitersFields()).toEqual([]);
  });

  it('exposes a required legal checkbox for manual review without mapping an answer', () => {
    const consent = document.createElement('spl-checkbox');
    consent.setAttribute('required', '');
    consent.textContent = 'I declare that I have read and understand the privacy notice.';
    shadow(consent, '<input type="checkbox" aria-required="true">');
    document.body.append(consent);

    const fields = extractSmartRecruitersFields();

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      kind: 'checkbox',
      label: 'I declare that I have read and understand the privacy notice.',
      profileKey: null,
    });
  });

  it('fills nested SmartRecruiters screening radios from work-authorization answers', async () => {
    const wrapper = document.createElement('spl-wrapper');
    const wrapperRoot = shadow(wrapper, '<spl-radio-group required></spl-radio-group>');
    const group = wrapperRoot.querySelector<HTMLElement>('spl-radio-group')!;
    group.textContent = 'Are you currently authorized to work lawfully in the US on a full time basis?';
    const yes = document.createElement('spl-radio');
    yes.setAttribute('label', 'Yes');
    yes.setAttribute('aria-checked', 'false');
    const no = document.createElement('spl-radio');
    no.setAttribute('label', 'No');
    no.setAttribute('aria-checked', 'false');
    yes.addEventListener('click', () => yes.setAttribute('aria-checked', 'true'));
    no.addEventListener('click', () => no.setAttribute('aria-checked', 'true'));
    group.append(yes, no);
    document.body.append(wrapper);

    const summary = await fillSmartRecruitersForm({
      ...DEFAULT_PROFILE,
      workAuthorization: { ...DEFAULT_PROFILE.workAuthorization, authorizedToWork: 'yes' },
    });

    expect(yes.getAttribute('aria-checked')).toBe('true');
    expect(summary).toEqual({ filled: 1, flagged: 0 });
  });

  it('fills nested SmartRecruiters screening dropdowns from voluntary disclosures', async () => {
    const wrapper = document.createElement('spl-wrapper');
    const wrapperRoot = shadow(wrapper, '<spl-autocomplete id="question_hispanic" required aria-label="Select Are You Hispanic or Latino?"></spl-autocomplete>');
    const autocomplete = wrapperRoot.querySelector<HTMLElement>('spl-autocomplete')!;
    const autocompleteRoot = shadow(autocomplete, '<spl-input></spl-input><spl-select-option>No</spl-select-option><spl-select-option>Yes</spl-select-option>');
    const inputHost = autocompleteRoot.querySelector<HTMLElement>('spl-input')!;
    const inputRoot = shadow(inputHost, '<input>');
    const input = inputRoot.querySelector('input')!;
    autocompleteRoot.querySelectorAll('spl-select-option').forEach((option) => {
      option.addEventListener('click', () => {
        input.value = option.textContent ?? '';
        autocomplete.setAttribute('value', option.textContent ?? '');
      });
    });
    document.body.append(wrapper);

    const summary = await fillSmartRecruitersForm({
      ...DEFAULT_PROFILE,
      disclosures: { ...DEFAULT_PROFILE.disclosures, hispanicOrLatino: 'No' },
    });

    expect(input.value).toBe('No');
    expect(summary).toEqual({ filled: 1, flagged: 0 });
  });
});
