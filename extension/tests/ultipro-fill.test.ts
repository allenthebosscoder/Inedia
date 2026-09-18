import { beforeEach, describe, expect, it } from 'vitest';
import { extractFields } from '../src/fill-engine/generic-adapter';
import { fillUltiProForm, ULTIPRO_HOST_PATTERN } from '../src/fill-engine/ultipro-fill';
import { DEFAULT_PROFILE, Profile } from '../src/storage/profile-schema';

function profile(): Profile {
  return {
    ...DEFAULT_PROFILE,
    resume: { name: 'Allen Ryu CV.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,QQ==' },
    workAuthorization: { authorizedToWork: 'yes', requiresSponsorship: 'yes' },
    jobPreferences: {
      ...DEFAULT_PROFILE.jobPreferences,
      availableStartDate: '2027-05-03',
      atLeast18: 'yes',
    },
    professional: { ...DEFAULT_PROFILE.professional, hasNonCompeteAgreement: 'no' },
    disclosures: {
      ...DEFAULT_PROFILE.disclosures,
      gender: 'Male',
      hispanicOrLatino: 'Not Hispanic or Latino',
      raceEthnicity: 'Asian',
      veteranStatus: 'I am not a veteran',
    },
  };
}

function question(id: number, label: string, options: string[]): string {
  return `<div class="form-group" role="group">
    <label data-automation="question-title">${label}</label>
    ${options.map((option, index) => `<label><input type="radio" name="MultipleChoiceResponse${id}" value="${index}" data-automation="multiple-choice-response"><span>${option}</span></label>`).join('')}
  </div>`;
}

describe('fillUltiProForm', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('recognizes numbered UltiPro recruiting hosts', () => {
    expect(ULTIPRO_HOST_PATTERN.test('recruiting2.ultipro.com')).toBe(true);
    expect(ULTIPRO_HOST_PATTERN.test('example.com')).toBe(false);
  });

  it('commits source, referral, profile questions, disclosures, and an existing resume', async () => {
    document.body.innerHTML = `
      <select id="ApplicantSource" data-automation="applicant-source-dropdown"><option value="">Choose...</option><option value="ada">ADA</option><option value="careers">Starkey Careers</option><option value="linkedin">LinkedIn</option></select>
      <label><input type="radio" name="employeereferral" value="true">Yes</label>
      <label><input type="radio" name="employeereferral" value="false" data-automation="no-employee-referral-radio">No</label>
      ${question(0, 'Are you subject to a non-competition agreement?', ['Yes', 'No'])}
      ${question(2, 'Are you a current Starkey employee?', ['Yes - manager told', 'No - I am not currently a Starkey employee'])}
      ${question(3, 'Are you currently authorized to work for any US employer?', ['Yes', 'No'])}
      ${question(4, 'Will you now or in the future require sponsorship for an employment visa status?', ['Yes', 'No'])}
      <select id="Gender"><option value="">Choose...</option><option value="M">Male</option></select>
      <select id="HispanicOrigin"><option value="">Choose...</option><option value="No">Not Hispanic/Latino</option></select>
      <select id="EthnicOrigin" data-automation="country-questions-race"><option value="">Choose...</option><option value="Asian">Asian</option></select>
      <select id="VeteranStatus"><option value="">Choose...</option><option value="No">No</option></select>
      <label><input type="checkbox" data-automation="gender-decline-checkbox">I decline to say</label>
      <div data-automation="file-row"><span data-automation="file-name">Allen Ryu CV.pdf</span><span data-automation="file-type">Resume</span><input type="checkbox" data-automation="select-document-checkbox"></div>
      <input type="file" data-automation="upload-file-input">
      <select data-automation="existing-resume-selector"><option value="">Choose a resume</option></select>
      <input id="SecondaryPhone" aria-label="Secondary Phone">
    `;

    const summary = await fillUltiProForm(profile());

    expect((document.querySelector('#ApplicantSource') as HTMLSelectElement).value).toBe('careers');
    expect((document.querySelector('[data-automation="no-employee-referral-radio"]') as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector('input[name="MultipleChoiceResponse0"][value="1"]') as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector('input[name="MultipleChoiceResponse2"][value="1"]') as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector('input[name="MultipleChoiceResponse3"][value="0"]') as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector('input[name="MultipleChoiceResponse4"][value="0"]') as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector('#HispanicOrigin') as HTMLSelectElement).value).toBe('No');
    expect((document.querySelector('#EthnicOrigin') as HTMLSelectElement).value).toBe('Asian');
    expect((document.querySelector('[data-automation="select-document-checkbox"]') as HTMLInputElement).checked).toBe(true);
    expect(extractFields(document).some((field) => field.element.id === 'SecondaryPhone')).toBe(false);
    expect(extractFields(document).some((field) => field.element.getAttribute('data-automation') === 'existing-resume-selector')).toBe(false);
    expect(extractFields(document).some((field) => field.element.getAttribute('data-automation') === 'gender-decline-checkbox')).toBe(false);
    expect(summary.flagged).toBe(0);
  });

  it('edits the open UKG date shadow root and verifies the component commit', async () => {
    const wrapper = document.createElement('div');
    wrapper.dataset.automation = 'available-start-date-datepicker';
    const host = document.createElement('ukg-input');
    host.dataset.automation = 'ukg-datepicker-input';
    host.setAttribute('value', '2026-08-26');
    const text = document.createElement('ukg-date-input-text');
    text.setAttribute('value', '2026-08-26');
    const shadow = text.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input aria-label="Month"><input aria-label="Day"><input aria-label="Year">';
    text.addEventListener('input', () => {
      const inputs = Array.from(shadow.querySelectorAll<HTMLInputElement>('input'));
      if (inputs.every((input) => input.value)) host.setAttribute('value', `${inputs[2].value}-${inputs[0].value}-${inputs[1].value}`);
    });
    host.append(text);
    wrapper.append(host);
    document.body.append(wrapper);

    const summary = await fillUltiProForm(profile());

    expect(Array.from(shadow.querySelectorAll<HTMLInputElement>('input')).map((input) => input.value)).toEqual(['05', '03', '2027']);
    expect(host.getAttribute('value')).toBe('2027-05-03');
    expect(summary.flagged).toBe(0);
  });

  it('flags the live UKG date element when its component rejects the edit', async () => {
    const wrapper = document.createElement('div');
    wrapper.dataset.automation = 'available-start-date-datepicker';
    const host = document.createElement('ukg-input');
    host.dataset.automation = 'ukg-datepicker-input';
    host.setAttribute('value', '2026-08-26');
    const text = document.createElement('ukg-date-input-text');
    const shadow = text.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input><input><input>';
    host.append(text);
    wrapper.append(host);
    document.body.append(wrapper);

    const summary = await fillUltiProForm(profile());

    expect(text.dataset.autofillFlag).toBe('needs-input');
    expect(wrapper.dataset.autofillFlag).toBeUndefined();
    expect(summary.flagged).toBe(1);
  });

  it('flags a matching stored resume when UltiPro cannot include it', async () => {
    document.body.innerHTML = `
      <div data-automation="file-row">
        <span data-automation="file-name">Allen Ryu CV.pdf</span>
        <span data-automation="file-type">Resume</span>
        <input type="checkbox" data-automation="select-document-checkbox" disabled>
      </div>
    `;

    const summary = await fillUltiProForm(profile());
    const checkbox = document.querySelector<HTMLInputElement>('[data-automation="select-document-checkbox"]')!;

    expect(checkbox.checked).toBe(false);
    expect(checkbox.dataset.autofillFlag).toBe('needs-input');
    expect(extractFields(document)).toEqual([]);
    expect(summary.flagged).toBe(1);
  });
});
