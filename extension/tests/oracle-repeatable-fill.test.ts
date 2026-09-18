import { beforeEach, describe, expect, it } from 'vitest';
import { fillOracleRepeatableSections } from '../src/fill-engine/oracle-repeatable-fill';
import { DEFAULT_PROFILE, Profile } from '../src/storage/profile-schema';

let nextId = 1;

function installCombo(input: HTMLInputElement, values: string[]): void {
  const listbox = document.createElement('div');
  listbox.id = `${input.id}-listbox`;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', listbox.id);
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
  input.after(listbox);
}

function makeCard(primary: string, secondary: string, dates: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'apply-flow-profile-item-tile';
  card.textContent = `${secondary}\n${primary}\n${dates}`;
  const edit = document.createElement('button');
  edit.setAttribute('aria-label', 'Edit');
  card.append(edit);
  return card;
}

function mountEditor(block: HTMLElement, kind: 'education' | 'experience', card?: HTMLElement): void {
  const id = nextId++;
  const wrapper = document.createElement('div');
  wrapper.className = 'profile-item-content--form';
  if (kind === 'experience') {
    wrapper.innerHTML = `
      <label for="employer-${id}">Employer Name</label><input id="employer-${id}">
      <label for="title-${id}">Job Title</label><input id="title-${id}">
      <input id="month-startDate-${id}"><input id="year-startDate-${id}">
      <input id="month-endDate-${id}"><input id="year-endDate-${id}">
      <label for="af-checkbox-currentJobFlag-${id}">Current Job</label><input id="af-checkbox-currentJobFlag-${id}" type="checkbox">
      <label for="city-${id}">Employer City</label><input id="city-${id}">
      <button>Cancel</button><button>${card ? 'Save' : 'Add experience'}</button>`;
  } else {
    wrapper.innerHTML = `
      <label for="degree-${id}">Degree</label><input id="degree-${id}">
      <label for="major-${id}">Major</label><input id="major-${id}">
      <label for="school-${id}">School Name</label><textarea id="school-${id}"></textarea>
      <input id="month-startDate-${id}"><input id="year-startDate-${id}">
      <input id="month-endDate-${id}"><input id="year-endDate-${id}">
      <button>Cancel</button><button>${card ? 'Save' : 'Add education'}</button>`;
  }
  block.append(wrapper);
  for (const input of Array.from(wrapper.querySelectorAll<HTMLInputElement>('input[id^="month-"]'))) {
    installCombo(input, ['January', 'May', 'July', 'August', 'September', 'December']);
  }
  for (const input of Array.from(wrapper.querySelectorAll<HTMLInputElement>('input[id^="year-"]'))) {
    installCombo(input, ['2022', '2024', '2026', '2027']);
  }
  const cancel = Array.from(wrapper.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Cancel')!;
  cancel.addEventListener('click', () => wrapper.remove());
  const save = Array.from(wrapper.querySelectorAll<HTMLButtonElement>('button')).find((button) => button !== cancel)!;
  save.addEventListener('click', () => {
    const target = card ?? makeCard('', '', '');
    if (!card) {
      block.querySelector('button[id^="profileItemsAddButton"]')!.before(target);
      target.querySelector('button')!.addEventListener('click', () => mountEditor(block, kind, target));
    }
    if (kind === 'experience') {
      const employer = (wrapper.querySelector('input[id^="employer-"]') as HTMLInputElement).value;
      const title = (wrapper.querySelector('input[id^="title-"]') as HTMLInputElement).value;
      const month = (wrapper.querySelector('input[id^="month-startDate-"]') as HTMLInputElement).value;
      const year = (wrapper.querySelector('input[id^="year-startDate-"]') as HTMLInputElement).value;
      target.firstChild!.textContent = `${title}\n${employer}\n${month} ${year}`;
    } else {
      const school = (wrapper.querySelector('textarea') as HTMLTextAreaElement).value;
      const major = (wrapper.querySelector('input[id^="major-"]') as HTMLInputElement).value;
      const endMonth = (wrapper.querySelector('input[id^="month-endDate-"]') as HTMLInputElement).value;
      const endYear = (wrapper.querySelector('input[id^="year-endDate-"]') as HTMLInputElement).value;
      target.firstChild!.textContent = `${major}\n${school}\n${endMonth} ${endYear}`;
    }
    wrapper.remove();
  });
}

describe('fillOracleRepeatableSections', () => {
  beforeEach(() => {
    nextId = 1;
    document.body.innerHTML = `
      <apply-flow-block id="education-block">
        <div class="apply-flow-profile-item-tile">Old Major\nDuke University 08/2024 - 12/2027<button aria-label="Edit"></button></div>
        <button id="profileItemsAddButton-education" type="button">Add Education</button>
      </apply-flow-block>
      <apply-flow-block id="experience-block">
        <div class="apply-flow-profile-item-tile">Old Title\nDuke Electric Vehicles 08/2024 - Present<button aria-label="Edit"></button></div>
        <button id="profileItemsAddButton-experience" type="button">Add Experience</button>
      </apply-flow-block>`;
    for (const block of Array.from(document.querySelectorAll<HTMLElement>('apply-flow-block'))) {
      const kind = block.id.startsWith('education') ? 'education' : 'experience';
      block.querySelector<HTMLButtonElement>('.apply-flow-profile-item-tile button')!
        .addEventListener('click', () => mountEditor(block, kind, block.querySelector('.apply-flow-profile-item-tile') as HTMLElement));
      block.querySelector<HTMLButtonElement>('button[id^="profileItemsAddButton"]')!
        .addEventListener('click', () => mountEditor(block, kind));
    }
  });

  it('updates matched Oracle cards and adds missing profile entries once', async () => {
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, city: 'Durham', country: 'United States' },
      education: [{
        school: 'Duke University', degree: 'BS', fieldOfStudy: 'Electrical and Computer Engineering',
        graduationDate: '05/2027', startDate: '08/2024', endDate: '05/2027',
      }],
      workHistory: [
        {
          company: 'Duke Electric Vehicles', title: 'Power Systems Lead', location: 'Durham, North Carolina',
          startDate: '08/2024', endDate: '', currentlyWorksHere: true, description: '',
        },
        {
          company: 'Singapore Armed Forces', title: 'Platoon Commander', location: 'Singapore',
          startDate: '09/2022', endDate: '07/2024', currentlyWorksHere: false, description: '',
        },
      ],
    };

    const first = await fillOracleRepeatableSections(profile);
    const educationText = document.querySelector('#education-block .apply-flow-profile-item-tile')!.textContent!;
    const workCards = Array.from(document.querySelectorAll('#experience-block .apply-flow-profile-item-tile'));

    expect(educationText).toContain('Electrical and Computer Engineering\nDuke University\nMay 2027');
    expect(workCards).toHaveLength(2);
    expect(workCards[0].textContent).toContain('Power Systems Lead\nDuke Electric Vehicles\nAugust 2024');
    expect(workCards[1].textContent).toContain('Platoon Commander\nSingapore Armed Forces\nSeptember 2022');
    expect(first.flagged).toBe(0);

    await fillOracleRepeatableSections(profile);
    expect(document.querySelectorAll('#experience-block .apply-flow-profile-item-tile')).toHaveLength(2);
  });

  it('ignores repeatable controls mounted in a hidden future Oracle step', async () => {
    // Hide the section's own container, not just the button: addButton() now checks the
    // container's visibility rather than the button's, precisely so a button legitimately hidden
    // by its own open editor (a real Oracle behavior, see the recovery test below) is not mistaken
    // for this "entirely different, off-screen application step" case.
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('apply-flow-block'));
    blocks.forEach((block) => { block.hidden = true; });
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[id^="profileItemsAddButton"]'));
    let clicks = 0;
    buttons.forEach((button) => button.addEventListener('click', () => { clicks++; }));
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      education: [{ school: 'Duke University', degree: 'BS', fieldOfStudy: 'ECE', graduationDate: '05/2027' }],
      workHistory: [{
        company: 'Duke University', title: 'Teaching Assistant', startDate: '01/2026',
        endDate: '', currentlyWorksHere: true, description: '',
      }],
    };

    const summary = await fillOracleRepeatableSections(profile);

    expect(clicks).toBe(0);
    expect(summary).toEqual({ filled: 0, flagged: 0 });
  });

  it('recovers from an empty Experience editor stuck open from an earlier run', async () => {
    // Reproduces a live bug: an earlier run left an "Add Experience" editor open and empty (its
    // fill/save never completed), and Oracle hides the Add button itself while its own editor is
    // open — so a fresh run could never even locate the button, let alone add the real entry.
    const experienceBlock = document.getElementById('experience-block')!;
    const addExperienceButton = experienceBlock.querySelector<HTMLButtonElement>('button[id^="profileItemsAddButton"]')!;
    mountEditor(experienceBlock, 'experience');
    addExperienceButton.hidden = true;
    // Real Oracle couples "Add" button visibility to editor open/closed state; the test's own
    // Cancel handler only removes the editor markup, so restore it the same way here.
    experienceBlock.querySelector<HTMLButtonElement>('.profile-item-content--form button')!
      .addEventListener('click', () => { addExperienceButton.hidden = false; });

    const profile: Profile = {
      ...DEFAULT_PROFILE,
      workHistory: [{
        company: 'Duke Electric Vehicles', title: 'Power Systems Lead', location: 'Durham, North Carolina',
        startDate: '08/2024', endDate: '', currentlyWorksHere: true, description: '',
      }],
    };

    const summary = await fillOracleRepeatableSections(profile);

    expect(experienceBlock.querySelectorAll('.profile-item-content--form')).toHaveLength(0);
    const cards = Array.from(experienceBlock.querySelectorAll('.apply-flow-profile-item-tile'));
    expect(cards.some((card) => card.textContent?.includes('Power Systems Lead\nDuke Electric Vehicles'))).toBe(true);
    expect(summary.filled).toBeGreaterThan(0);
  });

  it('leaves a stuck editor with real typed content alone rather than discarding it', async () => {
    const experienceBlock = document.getElementById('experience-block')!;
    const addExperienceButton = experienceBlock.querySelector<HTMLButtonElement>('button[id^="profileItemsAddButton"]')!;
    mountEditor(experienceBlock, 'experience');
    (experienceBlock.querySelector('input[id^="employer-"]') as HTMLInputElement).value = 'Something the applicant typed';
    addExperienceButton.hidden = true;

    const summary = await fillOracleRepeatableSections({
      ...DEFAULT_PROFILE,
      workHistory: [{
        company: 'Duke Electric Vehicles', title: 'Power Systems Lead', location: '',
        startDate: '08/2024', endDate: '', currentlyWorksHere: true, description: '',
      }],
    });

    expect(experienceBlock.querySelectorAll('.profile-item-content--form')).toHaveLength(1);
    expect(summary).toEqual({ filled: 0, flagged: 0 });
  });
});
