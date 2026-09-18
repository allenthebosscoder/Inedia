import { beforeEach, describe, expect, it } from 'vitest';
import { fillAppleForm } from '../src/fill-engine/apple-fill';
import { DEFAULT_PROFILE, Profile } from '../src/storage/profile-schema';

function typeahead(id: string, initial: string): string {
  return `
    <div id="${id.replace('-suggestion-textbox', '')}" class="typeahead-container">
      <input id="${id}" value="${initial}">
      <button type="button" class="form-icons-reset">Clear</button>
    </div>
  `;
}

function wireTypeaheads(): void {
  document.body.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button.form-icons-reset');
    if (!button) return;
    const input = button.parentElement!.querySelector<HTMLInputElement>('input')!;
    input.value = '';
  });
}

function option(value: string, text: string): string {
  return `<option value="${value}">${text}</option>`;
}

function mountEducation(): void {
  document.body.insertAdjacentHTML('beforeend', `
    <fieldset id="education-row">
      ${typeahead('parsedmodal-school-0-suggestion-textbox', 'Wrong School')}
      ${typeahead('parsedmodal-major-0-suggestion-textbox', 'Wrong Major')}
      <select id="parsedmodal-degree-0">
        ${option('', 'Degree')}${option('educationDegree-BA', "Bachelor's Degree")}
      </select>
      <input type="radio" id="parsedmodal-gradstatus-0-graduationStatus-YES" name="grad">
      <input type="radio" id="parsedmodal-gradstatus-0-graduationStatus-SA" name="grad">
      <button id="parsedmodal-remove-education-degree-0">Remove</button>
      <button id="parsedmodal-add-education-degree-0">Add education</button>
    </fieldset>
  `);
}

function mountEmployment(current = false): void {
  document.body.insertAdjacentHTML('beforeend', `
    <fieldset id="employment-row">
      ${typeahead('parsedmodal-employer-0-suggestion-textbox', 'Wrong Company')}
      <input id="parsedmodal-jobtitle-0" value="Wrong Title">
      <input type="radio" id="parsedmodal-currentemployer-yes-123" name="current" value="Yes" ${current ? 'checked' : ''}>
      <input type="radio" id="parsedmodal-currentemployer-no-123" name="current" value="No" ${current ? '' : 'checked'}>
      <select id="parsedmodal-startmonth-0">${option('', 'Month')}${option('08', 'August')}</select>
      <select id="parsedmodal-startyear-0">${option('', 'Year')}${option('2024', '2024')}</select>
      ${current ? '' : `
        <select id="parsedmodal-endmonth-0">${option('', 'Month')}${option('07', 'July')}</select>
        <select id="parsedmodal-endyear-0">${option('', 'Year')}${option('2026', '2026')}</select>
      `}
      <textarea id="parsedmodal-job-description-0">Wrong description</textarea>
      <button id="parsedmodal-remove-employment-0">Remove</button>
      <button id="parsedmodal-add-employment-0">Add employment</button>
    </fieldset>
  `);
}

function profile(current = false): Profile {
  return {
    ...DEFAULT_PROFILE,
    personal: { ...DEFAULT_PROFILE.personal, addressLine2: '' },
    education: [{
      school: 'Example University', degree: 'BS', fieldOfStudy: 'Electrical & Computer Engineering',
      graduationDate: '05/2027', startDate: '08/2024', endDate: '05/2027', gpa: '4.00',
    }],
    workHistory: [{
      company: 'Duke Electric Vehicles', title: 'Power Systems Lead', location: 'Durham, NC',
      startDate: '08/2024', endDate: current ? '' : '07/2026', currentlyWorksHere: current,
      description: '- Built hardware\n- Led testing',
    }],
  };
}

describe('fillAppleForm', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="profile-field-line1" value="123 Example Street">
      <input id="profile-field-line2" value="123 Example Street">
      <input id="profile-preferredname" aria-required="false" data-autofill-flag="needs-input">
      <input id="apply-skills-typeahead-suggestion-textbox">
      <input id="attachfile-resume-supportfile" type="file">
    `;
    wireTypeaheads();
  });

  it('reconciles Apple education/employment, preserves multiline descriptions, and clears duplicate line 2', async () => {
    mountEducation();
    mountEmployment(false);

    const summary = await fillAppleForm(profile(false), document, {
      settleMs: 0,
      now: new Date(2026, 7, 29),
    });

    expect((document.getElementById('profile-field-line2') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('parsedmodal-school-0-suggestion-textbox') as HTMLInputElement).value).toBe('Example University');
    expect((document.getElementById('parsedmodal-major-0-suggestion-textbox') as HTMLInputElement).value).toBe('Electrical & Computer Engineering');
    expect((document.getElementById('parsedmodal-degree-0') as HTMLSelectElement).value).toBe('educationDegree-BA');
    expect((document.getElementById('parsedmodal-gradstatus-0-graduationStatus-SA') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('parsedmodal-employer-0-suggestion-textbox') as HTMLInputElement).value).toBe('Duke Electric Vehicles');
    expect((document.getElementById('parsedmodal-jobtitle-0') as HTMLInputElement).value).toBe('Power Systems Lead');
    expect((document.getElementById('parsedmodal-currentemployer-no-123') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('parsedmodal-startmonth-0') as HTMLSelectElement).value).toBe('08');
    expect((document.getElementById('parsedmodal-startyear-0') as HTMLSelectElement).value).toBe('2024');
    expect((document.getElementById('parsedmodal-endmonth-0') as HTMLSelectElement).value).toBe('07');
    expect((document.getElementById('parsedmodal-endyear-0') as HTMLSelectElement).value).toBe('2026');
    expect((document.getElementById('parsedmodal-job-description-0') as HTMLTextAreaElement).value).toBe('- Built hardware\n- Led testing');
    expect(document.getElementById('profile-preferredname')?.dataset.autofillFlag).toBeUndefined();
    expect(document.getElementById('attachfile-resume-supportfile')?.dataset.jobAutofillHandled).toBe('true');
    expect(summary).toEqual({ filled: 13, flagged: 0 });
  });

  it('selects current employer and does not require nonexistent end-date controls', async () => {
    mountEducation();
    mountEmployment(true);

    const summary = await fillAppleForm(profile(true), document, {
      settleMs: 0,
      now: new Date(2026, 7, 29),
    });

    expect((document.getElementById('parsedmodal-currentemployer-yes-123') as HTMLInputElement).checked).toBe(true);
    expect(summary).toEqual({ filled: 11, flagged: 0 });
  });

  it('adds each missing saved skill separately and confirms the pending Apple skill list once', async () => {
    (document.getElementById('profile-field-line2') as HTMLInputElement).value = '';
    const skillInput = document.getElementById('apply-skills-typeahead-suggestion-textbox') as HTMLInputElement;
    const confirm = document.createElement('button');
    confirm.id = 'rate-skills-button';
    confirm.textContent = 'Add Skills';
    document.body.append(confirm);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<button id="apply-main-skill-delete-button-0" aria-label="Remove Skill C++"></button>'
    );
    skillInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !skillInput.value) return;
      const pending = document.createElement('button');
      pending.id = `apply-manual-skills-${document.querySelectorAll('[id^="apply-manual-skills-"]').length}`;
      pending.textContent = skillInput.value;
      pending.setAttribute('aria-label', `Remove ${skillInput.value}`);
      document.body.append(pending);
      skillInput.value = '';
    });
    confirm.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('[id^="apply-manual-skills-"]').forEach((pending) => {
        const committed = document.createElement('button');
        committed.id = `apply-main-skill-delete-button-${document.querySelectorAll('[id^="apply-main-skill-delete-button-"]').length}`;
        committed.setAttribute('aria-label', `Remove Skill ${pending.textContent}`);
        pending.replaceWith(committed);
      });
    });
    const skillsProfile = {
      ...DEFAULT_PROFILE,
      professional: { ...DEFAULT_PROFILE.professional, skills: 'C++, Verilog; MATLAB\nGit' },
    };

    const summary = await fillAppleForm(skillsProfile, document, { settleMs: 0 });

    expect(Array.from(document.querySelectorAll<HTMLElement>('[id^="apply-main-skill-delete-button-"]'))
      .map((button) => button.getAttribute('aria-label'))).toEqual([
        'Remove Skill C++', 'Remove Skill Verilog', 'Remove Skill MATLAB', 'Remove Skill Git',
      ]);
    expect(summary).toEqual({ filled: 3, flagged: 0 });
  });
});
