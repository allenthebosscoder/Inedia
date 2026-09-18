import { beforeEach, describe, expect, it } from 'vitest';
import { fillGreenhouseForm } from '../src/fill-engine/greenhouse-fill';
import { DEFAULT_PROFILE, Profile } from '../src/storage/profile-schema';

function mountSelect(id: string, label: string, options: string[], required = true, selectedDisplay?: string): void {
  const field = document.createElement('div');
  field.innerHTML = `
    <label id="${id}-label" for="${id}">${label}</label>
    <div class="select-wrapper">
      <div class="select__control">
        <div class="select__value-container">
          <input id="${id}" class="select__input" role="combobox" aria-haspopup="true"
            aria-expanded="false" aria-labelledby="${id}-label" ${required ? 'aria-required="true"' : ''}>
        </div>
      </div>
    </div>
    <div id="${id}-listbox" role="listbox"></div>
  `;
  document.body.append(field);

  const input = document.getElementById(id) as HTMLInputElement;
  const control = input.closest<HTMLElement>('.select__control')!;
  const wrapper = control.parentElement!;
  const listbox = document.getElementById(`${id}-listbox`)!;

  const render = (): void => {
    const query = input.value.trim().toLowerCase();
    const visible = options.filter((option) => option.toLowerCase().includes(query));
    listbox.innerHTML = visible.map((option) => `<div role="option">${option}</div>`).join('');
    listbox.querySelectorAll<HTMLElement>('[role="option"]').forEach((option) => {
      option.addEventListener('click', () => {
        control.querySelector('.select__single-value')?.remove();
        const selected = document.createElement('div');
        selected.className = 'select__single-value';
        selected.textContent = selectedDisplay ?? option.textContent;
        control.prepend(selected);
        input.value = '';
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-controls');
        listbox.innerHTML = '';
      });
    });
  };

  wrapper.addEventListener('mouseup', () => {
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', `${id}-listbox`);
    render();
  });
  wrapper.addEventListener('keyup', (event) => {
    if (event.key !== 'Escape') return;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-controls');
    listbox.innerHTML = '';
  });
  input.addEventListener('input', render);
}

function selected(id: string): string | undefined {
  return document.getElementById(id)?.closest('.select__control')
    ?.querySelector<HTMLElement>('.select__single-value')?.textContent?.trim();
}

describe('fillGreenhouseForm', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('commits official Greenhouse React Select choices and maps combined ECE to its canonical discipline', async () => {
    mountSelect('country', 'Country', ['Canada +1', 'United States +1'], true, '+1');
    mountSelect('candidate-location', 'Location', ['Durham, North Carolina, United States']);
    mountSelect('school--0', 'School', ['Example University', 'Duke Kunshan University']);
    mountSelect('degree--0', 'Degree', ["Bachelor's Degree", "Master's Degree"]);
    mountSelect('discipline--0', 'Discipline', ['Computer Science', 'Electrical Engineering', 'Engineering']);
    mountSelect('end-month--0', 'End month', ['April', 'May', 'June']);
    document.body.insertAdjacentHTML('beforeend', '<label for="end-year--0">End year</label><input id="end-year--0" type="number" aria-required="true">');
    mountSelect('question-grad', 'When do you graduate?', ['Sept - Dec 2027', 'Other']);
    mountSelect('question-gpa', 'What is your GPA?', ['3.7 - 4.0', '3.1 - 3.6', '3.0 or under']);
    mountSelect('question-season', 'Do you prefer a winter or summer internship?', ['Winter 2027', 'Summer 2027']);
    mountSelect('gender', 'Gender', ['Male', 'Female', 'Decline To Self Identify']);
    mountSelect('hispanic_ethnicity', 'Are you Hispanic/Latino?', ['Yes', 'No', 'Decline To Self Identify']);
    mountSelect('veteran_status', 'Veteran Status', [
      'I am not a protected veteran',
      'I identify as one or more of the classifications of a protected veteran',
      "I don't wish to answer",
    ]);
    mountSelect('disability_status', 'Disability Status', [
      'Yes, I have a disability, or have had one in the past',
      'No, I do not have a disability and have not had one in the past',
      'I do not wish to answer',
    ]);

    const profile: Profile = {
      ...DEFAULT_PROFILE,
      personal: {
        ...DEFAULT_PROFILE.personal,
        city: 'Durham', state: 'NC', country: 'United States', phoneCountryCode: 'United States',
      },
      jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, availableStartDate: '2027-05-03' },
      disclosures: {
        ...DEFAULT_PROFILE.disclosures,
        gender: 'Male',
        hispanicOrLatino: 'No',
        veteranStatus: 'I am not a veteran',
        disabilityStatus: 'No, I do not have a disability and have not had one in the past',
      },
      education: [{
        school: 'Example University', degree: 'BS', fieldOfStudy: 'Electrical and Computer Engineering',
        graduationDate: '05/2027', startDate: '08/2024', endDate: '05/2027', gpa: '4',
      }],
    };

    const summary = await fillGreenhouseForm(profile, document, { pollIntervalMs: 1, maxAttempts: 10 });

    expect(selected('country')).toBe('+1');
    expect(selected('candidate-location')).toBe('Durham, North Carolina, United States');
    expect(selected('school--0')).toBe('Example University');
    expect(selected('degree--0')).toBe("Bachelor's Degree");
    expect(selected('end-month--0')).toBe('May');
    expect((document.getElementById('end-year--0') as HTMLInputElement).value).toBe('2027');
    expect(selected('question-grad')).toBe('Other');
    expect(selected('question-gpa')).toBe('3.7 - 4.0');
    expect(selected('question-season')).toBe('Summer 2027');
    expect(selected('gender')).toBe('Male');
    expect(selected('hispanic_ethnicity')).toBe('No');
    expect(selected('veteran_status')).toBe('I am not a protected veteran');
    expect(selected('disability_status')).toBe('No, I do not have a disability and have not had one in the past');
    expect(selected('discipline--0')).toBe('Electrical Engineering');
    expect(summary).toEqual({ filled: 14, flagged: 0 });
  });

  it('fills Relay-style onsite, authorization, sponsorship, OPT, and free-text source questions', async () => {
    mountSelect('question-onsite', 'Are you able to work on-site at our Raleigh HQ consistently?', ['Yes', 'No']);
    mountSelect('question-authorized', 'Are you authorized to work lawfully in the United States?', ['Yes', 'No']);
    mountSelect('question-sponsorship', 'Will you require us to commence (sponsor) an immigration case?', ['Yes', 'No']);
    mountSelect('question-opt', 'Do you plan to work under Optional Practical Training (OPT)?', ['Yes', 'No']);
    document.body.insertAdjacentHTML('beforeend', '<input type="text" aria-label="How did you hear about this job?" aria-required="true">');
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      workAuthorization: {
        ...DEFAULT_PROFILE.workAuthorization,
        authorizedToWork: 'yes', requiresSponsorship: 'yes', plansToUseOPT: 'yes',
      },
      jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, willingToWorkOnsite: 'yes' },
    };

    const summary = await fillGreenhouseForm(profile, document, { pollIntervalMs: 1, maxAttempts: 10 });

    expect(selected('question-onsite')).toBe('Yes');
    expect(selected('question-authorized')).toBe('Yes');
    expect(selected('question-sponsorship')).toBe('Yes');
    expect(selected('question-opt')).toBe('Yes');
    expect((document.querySelector('[aria-label="How did you hear about this job?"]') as HTMLInputElement).value).toBe('Company Website');
    expect(summary).toEqual({ filled: 5, flagged: 0 });
  });

  it('fills Axon-style age, graduation, city, onsite, verification, export, conflict, employer, and race questions', async () => {
    mountSelect('question-age', 'Are you at least 18 years of age?', ['Yes', 'No']);
    mountSelect('question-graduation', 'What year do you graduate?', ['2027', '2028', '2029']);
    mountSelect('question-onsite', 'Are you able to work full-time on-site Scottsdale, AZ?', [
      'I am located near an office hub',
      'I am open to relocation with assistance',
      'I am looking for remote only',
    ]);
    mountSelect(
      'question-verification',
      'Can you provide verification of both your identity and authorization to work in the United States, to the extent required by law?',
      ['Yes', 'No']
    );
    mountSelect(
      'question-export',
      'If your scope of work requires exposure to U.S. Export Administration Controlled Technology and you are a Non-US Person, will you be able to coordinate with Axon Trade Compliance on obtaining U.S. Department of Commerce licensing as needed?',
      ['Yes', 'No']
    );
    mountSelect(
      'question-conflict',
      'Do you have any contractual obligations, agreements, relationships, or commitments to another person or entity that would impact, impede or interfere with your ability to join Axon?',
      ['Yes', 'No']
    );
    mountSelect('question-employer', 'Have you ever been employed by Axon?', ['Yes', 'No']);
    mountSelect('race', 'Please identify your race', ['Asian', 'White'], false);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<input id="current-city" type="text" aria-label="What city do you currently reside in?" aria-required="true">'
    );
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, city: 'Durham' },
      workAuthorization: {
        ...DEFAULT_PROFILE.workAuthorization,
        authorizedToWork: 'yes', requiresSponsorship: 'yes', usPerson: 'no',
      },
      jobPreferences: {
        ...DEFAULT_PROFILE.jobPreferences,
        atLeast18: 'yes', willingToWorkOnsite: 'yes', willingToRelocate: 'yes',
      },
      professional: { ...DEFAULT_PROFILE.professional, hasNonCompeteAgreement: 'no' },
      disclosures: { ...DEFAULT_PROFILE.disclosures, raceEthnicity: 'Asian' },
      education: [{
        school: 'Example University', degree: 'BS', fieldOfStudy: 'Electrical & Computer Engineering',
        graduationDate: '05/2027', startDate: '08/2024', endDate: '05/2027', gpa: '4',
      }],
    };

    const summary = await fillGreenhouseForm(profile, document, { pollIntervalMs: 1, maxAttempts: 10 });

    expect(selected('question-age')).toBe('Yes');
    expect(selected('question-graduation')).toBe('2027');
    expect(selected('question-onsite')).toBe('I am open to relocation with assistance');
    expect(selected('question-verification')).toBe('Yes');
    expect(selected('question-export')).toBe('Yes');
    expect(selected('question-conflict')).toBe('No');
    expect(selected('question-employer')).toBe('No');
    expect(selected('race')).toBe('Asian');
    expect((document.getElementById('current-city') as HTMLInputElement).value).toBe('Durham');
    expect(summary).toEqual({ filled: 9, flagged: 0 });
  });

  it('fills optional Greenhouse links with portfolio/GitHub fallback and ignores absent optional links', async () => {
    document.body.innerHTML = `
      <input id="linkedin" type="text" aria-label="LinkedIn Profile" aria-required="false" data-autofill-flag="needs-input">
      <input id="website" type="text" aria-label="Website" aria-required="false" data-autofill-flag="needs-input">
    `;
    const withGithub: Profile = {
      ...DEFAULT_PROFILE,
      links: { ...DEFAULT_PROFILE.links, github: 'https://github.com/example' },
    };

    expect(await fillGreenhouseForm(withGithub)).toEqual({ filled: 1, flagged: 0 });
    expect((document.getElementById('website') as HTMLInputElement).value).toBe('https://github.com/example');
    expect(document.getElementById('linkedin')?.dataset.autofillFlag).toBeUndefined();
    expect(document.getElementById('linkedin')?.dataset.jobAutofillHandled).toBe('true');
  });
});
