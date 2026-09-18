import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeStorageMock } from './chrome-mock';
import { saveProfile } from '../src/storage/profile-store';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';
import { run, runWithProfile, uploadResumeWithProfile } from '../src/fill-engine/index';

describe('run', () => {
  beforeEach(() => {
    installChromeStorageMock();
    document.body.innerHTML = '';
    vi.stubGlobal('location', { hostname: 'boards.greenhouse.io' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fills recognized fields and flags the rest', async () => {
    await saveProfile({ ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Jorge' } });
    document.body.innerHTML = `
      <label for="fname">First Name</label>
      <input id="fname" type="text" />
      <label for="essay">Why do you want to work here?</label>
      <textarea id="essay"></textarea>
    `;

    const summary = await run();

    expect(summary).toEqual({ filled: 1, flagged: 1 });
    expect((document.getElementById('fname') as HTMLInputElement).value).toBe('Jorge');
  });

  it('fills iCIMS available-start-date components and age from the profile', async () => {
    vi.stubGlobal('location', { hostname: 'tenant.icims.com' });
    document.body.innerHTML = `
      <input id="icims_f_Over_18_Yes" name="icims_f_Over_18" type="radio" value="Yes" />
      <label for="icims_f_Over_18_Yes">Yes</label>
      <input id="icims_f_Over_18_No" name="icims_f_Over_18" type="radio" value="No" />
      <label for="icims_f_Over_18_No">No</label>
      <select id="icims_f_DateAvailableToStart_Month" name="icims_f_DateAvailableToStart_Month">
        <option value="0"></option><option value="09">Sep</option>
      </select><label for="icims_f_DateAvailableToStart_Month">Month</label>
      <select id="icims_f_DateAvailableToStart_Date" name="icims_f_DateAvailableToStart_Date">
        <option value="0"></option><option value="15">15</option>
      </select><label for="icims_f_DateAvailableToStart_Date">Day</label>
      <input id="icims_f_DateAvailableToStart_Year" name="icims_f_DateAvailableToStart_Year" />
      <label for="icims_f_DateAvailableToStart_Year">Year</label>
    `;
    const profile = {
      ...DEFAULT_PROFILE,
      jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, availableStartDate: '2026-09-15', atLeast18: 'yes' as const },
    };

    expect(await runWithProfile(profile, { skipResume: true })).toEqual({ filled: 4, flagged: 0 });
    expect((document.getElementById('icims_f_Over_18_Yes') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('icims_f_DateAvailableToStart_Month') as HTMLSelectElement).value).toBe('09');
    expect((document.getElementById('icims_f_DateAvailableToStart_Date') as HTMLSelectElement).value).toBe('15');
    expect((document.getElementById('icims_f_DateAvailableToStart_Year') as HTMLInputElement).value).toBe('2026');
  });

  it('can upload only the resume before an ATS replaces its form document', () => {
    document.body.innerHTML = `
      <label for="resume">Resume/CV</label><input id="resume" type="file" />
      <label for="fname">First Name</label><input id="fname" type="text" />
    `;
    const profile = {
      ...DEFAULT_PROFILE,
      resume: {
        name: 'Jorge Resume.pdf',
        type: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,SGVsbG8=',
      },
      personal: { ...DEFAULT_PROFILE.personal, firstName: 'Jorge' },
    };

    expect(uploadResumeWithProfile(profile)).toEqual({ filled: 1, flagged: 0 });
    expect((document.getElementById('resume') as HTMLInputElement).files?.[0]?.name)
      .toBe('Jorge Resume.pdf');
    expect((document.getElementById('fname') as HTMLInputElement).value).toBe('');
  });

  it('applies a custom override before the synonym dictionary', async () => {
    await saveProfile({
      ...DEFAULT_PROFILE,
      links: { ...DEFAULT_PROFILE.links, github: 'https://github.com/jorge' },
      overrides: { 'do you have a code sample link': 'links.github' },
    });
    document.body.innerHTML = `<input type="text" aria-label="Do you have a code sample link?" />`;

    const summary = await run();

    expect(summary.filled).toBe(1);
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('https://github.com/jorge');
  });

  it('does not crash on a label that normalizes to a prototype-chain property name like "constructor"', async () => {
    await saveProfile({ ...DEFAULT_PROFILE, overrides: {} });
    document.body.innerHTML = `<input type="text" aria-label="Constructor" />`;

    const summary = await run();

    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('');
  });

  it('fills an ARIA combobox field alongside ordinary fields', async () => {
    await saveProfile({
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, firstName: 'Jorge', state: 'NC' },
    });
    document.body.innerHTML = `
      <label for="fname">First Name</label>
      <input id="fname" type="text" />
      <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox" aria-label="State">--</button>
      <div id="state-listbox"></div>
    `;
    const trigger = document.getElementById('state-trigger')!;
    const listbox = document.getElementById('state-listbox')!;
    trigger.addEventListener('click', () => {
      listbox.innerHTML = '<li role="option" data-value="NC">North Carolina</li>';
    });

    const summary = await run();

    expect(summary).toEqual({ filled: 2, flagged: 0 });
    expect((document.getElementById('fname') as HTMLInputElement).value).toBe('Jorge');
  });

  it('rescans dependent fields after Country replaces the State control', async () => {
    await saveProfile({
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, country: 'United States', state: 'NC' },
    });
    document.body.innerHTML = `
      <button id="country-trigger" aria-haspopup="listbox" aria-controls="country-listbox" aria-label="Country">--</button>
      <div id="country-listbox"></div>
      <div id="state-slot">
        <button id="old-state" aria-haspopup="listbox" aria-controls="state-listbox" aria-label="State">--</button>
      </div>
      <div id="state-listbox"></div>
    `;
    const countryTrigger = document.getElementById('country-trigger')!;
    const countryListbox = document.getElementById('country-listbox')!;
    const stateSlot = document.getElementById('state-slot')!;
    const stateListbox = document.getElementById('state-listbox')!;

    countryTrigger.addEventListener('click', () => {
      countryListbox.innerHTML = '<div role="option">United States of America</div>';
      countryListbox.querySelector('[role="option"]')!.addEventListener('mousedown', () => {
        stateSlot.innerHTML = '<button id="new-state" aria-haspopup="listbox" aria-controls="state-listbox" aria-label="State">--</button>';
        document.getElementById('new-state')!.addEventListener('click', () => {
          stateListbox.innerHTML = '<div role="option">North Carolina</div>';
        });
      });
    });

    const summary = await run();

    expect(summary).toEqual({ filled: 2, flagged: 0 });
    expect(document.getElementById('old-state')).toBeNull();
    expect(document.getElementById('new-state')).not.toBeNull();
  });

  it('retries a mapped Workday checkbox after the first click is rolled back', async () => {
    vi.stubGlobal('location', { hostname: 'tenant.myworkdayjobs.com' });
    document.body.innerHTML = `
      <fieldset id="selfIdentifiedDisabilityData--disabilityStatus">
        <input id="disability-yes" type="checkbox" />
        <label for="disability-yes">Yes, I have a disability, or have had one in the past</label>
        <input id="disability-no" type="checkbox" />
        <label for="disability-no">No, I do not have a disability and have not had one in the past</label>
      </fieldset>
    `;
    const no = document.getElementById('disability-no') as HTMLInputElement;
    let clicks = 0;
    no.addEventListener('click', () => {
      clicks++;
      if (clicks === 1) setTimeout(() => { no.checked = false; }, 0);
    });
    const profile = {
      ...DEFAULT_PROFILE,
      disclosures: {
        ...DEFAULT_PROFILE.disclosures,
        disabilityStatus: 'No, I do not have a disability and have not had one in the past',
      },
    };

    const summary = await runWithProfile(profile, { skipResume: true, workdayCheckboxSettleMs: 5 });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(clicks).toBe(2);
    expect(no.checked).toBe(true);
  });

  it('rescans a Workday question revealed by an earlier questionnaire answer', async () => {
    vi.stubGlobal('location', { hostname: 'tenant.myworkdayjobs.com' });
    document.body.innerHTML = `
      <fieldset><legend>Are you a U.S. person?</legend>
        <button id="primaryQuestionnaire--us-person" aria-haspopup="listbox">Select One</button>
      </fieldset>
      <div id="us-person-options"></div>
      <div id="dependent-slot"></div>
    `;
    const usPerson = document.getElementById('primaryQuestionnaire--us-person')!;
    const usPersonOptions = document.getElementById('us-person-options')!;
    usPerson.addEventListener('click', () => {
      usPerson.setAttribute('aria-controls', 'us-person-options');
      usPerson.setAttribute('aria-expanded', 'true');
      usPersonOptions.innerHTML = '<li role="option">Yes</li><li role="option">No</li>';
    });
    usPersonOptions.addEventListener('click', (event) => {
      const selected = (event.target as Element).closest('[role="option"]');
      if (!selected) return;
      usPerson.textContent = selected.textContent;
      usPerson.removeAttribute('aria-expanded');
      usPersonOptions.replaceChildren();
      document.getElementById('dependent-slot')!.innerHTML = `
        <fieldset><legend>Are you a citizen of any one of these countries: Cuba, Iran, North Korea, or Syria?</legend>
          <button id="primaryQuestionnaire--restricted-subset" aria-haspopup="listbox">Select One</button>
        </fieldset>
        <div id="restricted-options"></div>
      `;
      const dependent = document.getElementById('primaryQuestionnaire--restricted-subset')!;
      const options = document.getElementById('restricted-options')!;
      dependent.addEventListener('click', () => {
        dependent.setAttribute('aria-controls', 'restricted-options');
        dependent.setAttribute('aria-expanded', 'true');
        options.innerHTML = '<li role="option">Yes</li><li role="option">No</li>';
      });
      options.addEventListener('click', (dependentEvent) => {
        const dependentSelection = (dependentEvent.target as Element).closest('[role="option"]');
        if (!dependentSelection) return;
        dependent.textContent = dependentSelection.textContent;
        dependent.removeAttribute('aria-expanded');
        options.replaceChildren();
      });
    });
    const profile = {
      ...DEFAULT_PROFILE,
      workAuthorization: {
        ...DEFAULT_PROFILE.workAuthorization,
        usPerson: 'no' as const,
        restrictedCountryStatus: 'no' as const,
      },
    };

    const summary = await runWithProfile(profile, { skipResume: true });

    expect(summary).toEqual({ filled: 2, flagged: 0 });
    expect(usPerson.textContent).toBe('No');
    expect(document.getElementById('primaryQuestionnaire--restricted-subset')!.textContent).toBe('No');
  });
});
