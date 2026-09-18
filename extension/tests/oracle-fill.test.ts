import { beforeEach, describe, expect, it } from 'vitest';
import { fillOracleForm } from '../src/fill-engine/oracle-fill';
import { DEFAULT_PROFILE, Profile } from '../src/storage/profile-schema';

function pillQuestion(label: string): string {
  return `<ul class="cx-select-pills-container" aria-label="${label}">
    <li><button type="button" aria-pressed="false">Yes</button></li>
    <li><button type="button" aria-pressed="false">No</button></li>
  </ul>`;
}

function radioQuestion(id: string, label: string): string {
  return `<div id="${id}-label">${label}</div>
    <div role="radiogroup" aria-labelledby="${id}-label">
      <input id="${id}-yes" type="radio" name="${id}" /><label for="${id}-yes">Yes</label>
      <input id="${id}-no" type="radio" name="${id}" /><label for="${id}-no">No</label>
    </div>`;
}

function installPillBehavior(): void {
  document.querySelectorAll<HTMLElement>('ul.cx-select-pills-container').forEach((group) => {
    group.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.addEventListener('click', () => {
        group.querySelectorAll('button').forEach((candidate) => candidate.setAttribute('aria-pressed', 'false'));
        button.setAttribute('aria-pressed', 'true');
      });
    });
  });
}

function selectedPill(label: string): string | undefined {
  const group = Array.from(document.querySelectorAll<HTMLElement>('ul.cx-select-pills-container'))
    .find((candidate) => candidate.getAttribute('aria-label') === label);
  return group?.querySelector('[aria-pressed="true"]')?.textContent?.trim();
}

describe('fillOracleForm', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <ul class="cx-select-pills-container" aria-label="Title">
        <li><button type="button" aria-pressed="false">Mr.</button></li>
        <li><button type="button" aria-pressed="false">Ms.</button></li>
        <li><button type="button" aria-pressed="false">Unknown</button></li>
      </ul>
      ${pillQuestion('Do you require any accommodations or support during the recruitment process?')}
      ${pillQuestion('Do you meet the minimum GPA requirement of 3.0?')}
      ${pillQuestion('Are you legally authorized to work in the United States?')}
      ${pillQuestion('Will you have graduated prior to the start of the co-op/internship?')}
      <ul class="cx-select-pills-container" aria-label="Where did you first hear about this position?">
        <li><button type="button" aria-pressed="false">Newsletter</button></li>
      </ul>
      ${radioQuestion('transcript', 'Can you provide an official or unofficial educational transcript for your college or university?')}
      ${radioQuestion('enrolled', 'Are you currently enrolled in an accredited US college, or university?')}
      ${radioQuestion('noncompete', 'Do you have any active non-compete, non-solicit, confidentiality agreements?')}
      ${radioQuestion('previous', 'I was previously employed directly by Nokia or a subsidiary of Nokia, not as a subcontractor.')}
      ${radioQuestion('government', 'Do you currently work for the government?')}
      <label for="academic">If currently enrolled, what is your academic level (e.g. sophomore, junior)?</label>
      <textarea id="academic"></textarea>
      <div id="graduation-label">What is your expected year of graduation?</div>
      <span id="day-label">Day</span><input id="day-grad" role="combobox" aria-controls="day-grad-listbox" aria-labelledby="graduation-label day-label" />
      <div id="day-grad-listbox"></div>
      <span id="month-label">Month</span><input id="month-grad" role="combobox" aria-controls="month-grad-listbox" aria-labelledby="graduation-label month-label" />
      <div id="month-grad-listbox"></div>
      <span id="year-label">Year</span><input id="year-grad" role="combobox" aria-controls="year-grad-listbox" aria-labelledby="graduation-label year-label" />
      <div id="year-grad-listbox"></div>
    `;
    installPillBehavior();
    const options: Record<string, string[]> = {
      'day-grad': ['1', '2'],
      'month-grad': ['May', 'December'],
      'year-grad': ['2026', '2027'],
    };
    Object.entries(options).forEach(([id, values]) => {
      const input = document.getElementById(id) as HTMLInputElement;
      const listbox = document.getElementById(`${id}-listbox`)!;
      input.addEventListener('click', () => {
        input.setAttribute('aria-expanded', 'true');
        listbox.innerHTML = values.map((value) => `<div role="gridcell">${value}</div>`).join('');
        listbox.querySelectorAll<HTMLElement>('[role="gridcell"]').forEach((option) => {
          option.addEventListener('click', () => {
            input.value = option.textContent ?? '';
            input.setAttribute('aria-expanded', 'false');
          });
        });
      });
    });
  });

  it('fills Oracle pill questions, derived education answers, radios, and graduation date', async () => {
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      workAuthorization: { ...DEFAULT_PROFILE.workAuthorization, authorizedToWork: 'yes' },
      jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, availableStartDate: '2027-05-03' },
      professional: { ...DEFAULT_PROFILE.professional, hasNonCompeteAgreement: 'no' },
      disclosures: {
        ...DEFAULT_PROFILE.disclosures,
        gender: 'Male',
        disabilityStatus: 'No, I do not have a disability and have not had one in the past',
      },
      education: [{
        school: 'Duke University', degree: 'BS', fieldOfStudy: 'ECE', graduationDate: '12/2027',
        startDate: '08/2024', endDate: '12/2027', gpa: '4',
      }],
      workHistory: [{
        company: 'Singapore Armed Forces', title: 'Platoon Commander', startDate: '09/2022',
        endDate: '07/2024', description: '',
      }],
    };

    const summary = await fillOracleForm(profile, document, new Date(2026, 7, 25));

    expect(selectedPill('Title')).toBe('Mr.');
    expect(selectedPill('Do you require any accommodations or support during the recruitment process?')).toBe('No');
    expect(selectedPill('Do you meet the minimum GPA requirement of 3.0?')).toBe('Yes');
    expect(selectedPill('Are you legally authorized to work in the United States?')).toBe('Yes');
    expect(selectedPill('Will you have graduated prior to the start of the co-op/internship?')).toBe('No');
    expect((document.getElementById('transcript-yes') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('enrolled-yes') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('noncompete-no') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('previous-no') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('government-yes') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('academic') as HTMLTextAreaElement).value).toBe('Junior');
    expect((document.getElementById('day-grad') as HTMLInputElement).value).toBe('1');
    expect((document.getElementById('month-grad') as HTMLInputElement).value).toBe('December');
    expect((document.getElementById('year-grad') as HTMLInputElement).value).toBe('2027');
    expect(document.querySelector<HTMLElement>('ul[aria-label^="Where did"]')?.dataset.autofillFlag).toBe('needs-input');
    expect(summary).toEqual({ filled: 14, flagged: 1 });
  });

  it('recognizes an already-selected Oracle pill that uses radio aria-checked state', async () => {
    document.body.innerHTML = `
      <ul class="cx-select-pills-container" aria-label="Title">
        <li><button type="button" role="radio" aria-checked="false">Miss</button></li>
        <li><button type="button" role="radio" aria-checked="true">Mr.</button></li>
      </ul>
    `;
    const selected = document.querySelector<HTMLButtonElement>('[aria-checked="true"]')!;
    let clicks = 0;
    selected.addEventListener('click', () => { clicks++; });
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      disclosures: { ...DEFAULT_PROFILE.disclosures, gender: 'Male' },
    };

    const summary = await fillOracleForm(profile, document);

    expect(clicks).toBe(0);
    expect(document.querySelector('ul')?.dataset.autofillFlag).toBeUndefined();
    expect(summary).toEqual({ filled: 1, flagged: 0 });
  });

  it('does not flag an unsupported Oracle pill question that already has an aria-checked answer', async () => {
    document.body.innerHTML = `
      <ul class="cx-select-pills-container" aria-label="Do you accept this tenant-specific policy?">
        <li><button type="button" role="radio" aria-checked="true">Yes</button></li>
        <li><button type="button" role="radio" aria-checked="false">No</button></li>
      </ul>
    `;

    const summary = await fillOracleForm(DEFAULT_PROFILE, document);

    expect(document.querySelector('ul')?.dataset.autofillFlag).toBeUndefined();
    expect(summary).toEqual({ filled: 0, flagged: 0 });
  });
});
