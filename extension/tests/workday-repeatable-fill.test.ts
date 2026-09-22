import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';
import { fillWorkdayRepeatableSections, prepareNextWorkdayRepeatableRow } from '../src/fill-engine/workday-repeatable-fill';

describe('fillWorkdayRepeatableSections', () => {
  it('prepares one missing repeatable row without filling existing fields', () => {
    document.body.innerHTML = `
      <h1>My Experience</h1>
      <h2>Employment History</h2>
      <input id="workExperience-1--jobTitle" />
      <button id="add-work">Add Another</button>
      <h2>Education</h2><button id="add-education">Add</button>
    `;
    let workAdds = 0;
    let educationAdds = 0;
    document.getElementById('add-work')!.addEventListener('click', () => workAdds++);
    document.getElementById('add-education')!.addEventListener('click', () => educationAdds++);

    const added = prepareNextWorkdayRepeatableRow({
      ...DEFAULT_PROFILE,
      workHistory: [
        { company: 'A', title: 'One', startDate: '', endDate: '', description: '' },
        { company: 'B', title: 'Two', startDate: '', endDate: '', description: '' },
      ],
      education: [{ school: 'School', degree: 'BS', fieldOfStudy: 'EE', graduationDate: '' }],
    });

    expect(added).toBe(true);
    expect(workAdds).toBe(1);
    expect(educationAdds).toBe(0);
    expect((document.getElementById('workExperience-1--jobTitle') as HTMLInputElement).value).toBe('');
  });

  it('starts at the requested repeatable index without rewriting completed rows', async () => {
    document.body.innerHTML = `
      <input id="workExperience-1--companyName" value="Acme" />
      <input id="workExperience-1--jobTitle" value="Engineer" />
      <input id="workExperience-2--companyName" />
      <input id="workExperience-2--jobTitle" />
    `;
    let firstRowInputs = 0;
    document.getElementById('workExperience-1--jobTitle')!.addEventListener('input', () => firstRowInputs++);

    await fillWorkdayRepeatableSections({
      ...DEFAULT_PROFILE,
      workHistory: [
        { company: 'Acme', title: 'Engineer', startDate: '', endDate: '', description: '' },
        { company: 'Beta', title: 'Lead', startDate: '', endDate: '', description: '' },
      ],
    }, { workStartIndex: 1, skipEducation: true });

    expect(firstRowInputs).toBe(0);
    expect((document.getElementById('workExperience-2--jobTitle') as HTMLInputElement).value).toBe('Lead');
  });

  it('retries a Workday end date when the first write disappears during a row rerender', async () => {
    document.body.innerHTML = `
      <input id="workExperience-1--companyName" />
      <input id="workExperience-1--jobTitle" />
      <input id="workExperience-1--startDate-dateSectionMonth-input" />
      <input id="workExperience-1--startDate-dateSectionYear-input" />
      <input id="workExperience-1--endDate-dateSectionMonth-input" />
      <input id="workExperience-1--endDate-dateSectionYear-input" />
      <input id="workExperience-1--currentlyWorkHere" type="checkbox" />
    `;
    const endMonth = document.getElementById('workExperience-1--endDate-dateSectionMonth-input') as HTMLInputElement;
    const endYear = document.getElementById('workExperience-1--endDate-dateSectionYear-input') as HTMLInputElement;
    let endYearWrites = 0;
    Object.defineProperty(endYear, '__reactProps$fixture', {
      configurable: true,
      enumerable: true,
      value: {
        onInput: () => {
          endYearWrites++;
          if (endYearWrites === 1) setTimeout(() => {
            endMonth.value = '';
            endYear.value = '';
          }, 0);
        },
        onBlur: () => undefined,
      },
    });

    await fillWorkdayRepeatableSections({
      ...DEFAULT_PROFILE,
      workHistory: [{
        company: 'Lab', title: 'Researcher', startDate: '05/2026', endDate: '07/2026',
        currentlyWorksHere: false, description: '',
      }],
    }, { skipEducation: true });

    expect(endYearWrites).toBe(2);
    expect(endMonth.value).toBe('7');
    expect(endYear.value).toBe('2026');
  });

  it('selects Workday dates through the interactive month control instead of its outer tile', async () => {
    document.body.innerHTML = `
      <input id="workExperience-1--companyName" />
      <input id="workExperience-1--jobTitle" />
      <section>
        <div id="workExperience-1--startDate" data-automation-id="dateInputWrapper">
          <input id="workExperience-1--startDate-dateSectionMonth-input" />
          <input id="workExperience-1--startDate-dateSectionYear-input" />
        </div>
        <div id="start-calendar" data-automation-id="dateIcon"></div>
      </section>
      <section>
        <div id="workExperience-1--endDate" data-automation-id="dateInputWrapper">
          <input id="workExperience-1--endDate-dateSectionMonth-input" />
          <input id="workExperience-1--endDate-dateSectionYear-input" />
        </div>
        <div id="end-calendar" data-automation-id="dateIcon"></div>
      </section>
      <input id="workExperience-1--currentlyWorkHere" type="checkbox" />
    `;
    let interactiveClicks = 0;
    const openPicker = (prefix: 'startDate' | 'endDate', monthName: string, month: string) => {
      document.getElementById('picker')?.remove();
      const picker = document.createElement('div');
      picker.id = 'picker';
      picker.setAttribute('data-automation-id', 'monthPicker');
      picker.innerHTML = `
        <span data-automation-id="monthPickerSpinnerLabel">2026</span>
        <li data-automation-id="monthPickerTile">
          <div data-automation-id="monthPickerTileLabel" title="${monthName}" role="button">${monthName}</div>
        </li>`;
      Object.defineProperty(picker, 'offsetParent', { configurable: true, get: () => document.body });
      picker.querySelector('[role="button"]')!.addEventListener('click', () => {
        interactiveClicks++;
        (document.getElementById(`workExperience-1--${prefix}-dateSectionMonth-input`) as HTMLInputElement).value = month;
        (document.getElementById(`workExperience-1--${prefix}-dateSectionYear-input`) as HTMLInputElement).value = '2026';
        picker.remove();
      });
      document.body.appendChild(picker);
    };
    document.getElementById('start-calendar')!.addEventListener('click', () => openPicker('startDate', 'May', '5'));
    document.getElementById('end-calendar')!.addEventListener('click', () => openPicker('endDate', 'July', '7'));

    await fillWorkdayRepeatableSections({
      ...DEFAULT_PROFILE,
      workHistory: [{
        company: 'Lab', title: 'Researcher', startDate: '05/2026', endDate: '07/2026',
        currentlyWorksHere: false, description: '',
      }],
    }, { skipEducation: true });

    expect(interactiveClicks).toBe(2);
    expect((document.getElementById('workExperience-1--endDate-dateSectionYear-input') as HTMLInputElement).value).toBe('2026');
  });

  it('uses the Add button inside the matching Workday section', async () => {
    document.body.innerHTML = `
      <main>
        <h2>Employment History</h2>
        <button id="add-work">Add Another</button>
        <h2>Education</h2>
        <button id="add-education">Add</button>
        <div id="rows"></div>
      </main>`;
    let workClicks = 0;
    document.getElementById('add-work')!.addEventListener('click', () => workClicks++);
    document.getElementById('add-education')!.addEventListener('click', () => {
      document.getElementById('rows')!.innerHTML = `
        <input id="education-1--school" />
        <input id="education-1--degree" />
        <input id="education-1--fieldOfStudy" />
      `;
    });

    await fillWorkdayRepeatableSections({
      ...DEFAULT_PROFILE,
      education: [{ school: 'Example University', degree: 'BS', fieldOfStudy: 'Engineering', graduationDate: '' }],
    });

    expect(workClicks).toBe(0);
    expect((document.getElementById('education-1--school') as HTMLInputElement).value).toBe('Example University');
  });

  it('clicks Add for every saved experience and fills each new row', async () => {
    document.body.innerHTML = `<button data-automation-id="addWorkExperience">Add</button><div id="rows"></div>`;
    const rows = document.getElementById('rows')!;
    let additions = 0;
    let currentRoleClicks = 0;
    const registeredTitles: string[] = [];
    const directReactTitles: string[] = [];
    const directReactDates: string[] = [];
    const committedDates: string[] = [];
    document.querySelector('button')!.addEventListener('click', () => {
      additions++;
      rows.insertAdjacentHTML('beforeend', `
        <input id="workExperience-${additions}--company" />
        <input id="workExperience-${additions}--jobTitle" />
        <input id="workExperience-${additions}--location" />
        <section class="date-widget">
          <div id="workExperience-${additions}--startDate">
            <input id="workExperience-${additions}--startDate-dateSectionMonth-input" />
            <input id="workExperience-${additions}--startDate-dateSectionYear-input" />
          </div>
          <div data-automation-id="dateIcon" role="button" tabindex="0">Calendar</div>
        </section>
        <section class="date-widget">
          <div id="workExperience-${additions}--endDate">
            <input id="workExperience-${additions}--endDate-dateSectionMonth-input" />
            <input id="workExperience-${additions}--endDate-dateSectionYear-input" />
          </div>
          <div data-automation-id="dateIcon" role="button" tabindex="0">Calendar</div>
        </section>
        <input id="workExperience-${additions}--currentlyWorkHere" type="checkbox" />
        <textarea id="workExperience-${additions}--description"></textarea>
      `);
      rows.querySelectorAll<HTMLElement>(`#workExperience-${additions}--startDate, #workExperience-${additions}--endDate`)
        .forEach((wrapper) => wrapper.setAttribute('data-automation-id', 'dateInputWrapper'));
      document.getElementById(`workExperience-${additions}--currentlyWorkHere`)!
        .addEventListener('click', () => currentRoleClicks++);
      const titleInput = document.getElementById(`workExperience-${additions}--jobTitle`) as HTMLInputElement;
      const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
      let trackedValue = titleInput.value;
      Object.defineProperty(titleInput, 'value', {
        configurable: true,
        get: () => nativeValue.get!.call(titleInput),
        set: (value: string) => {
          trackedValue = value;
          nativeValue.set!.call(titleInput, value);
        },
      });
      titleInput.addEventListener('input', () => {
        if (trackedValue !== titleInput.value) {
          registeredTitles.push(titleInput.value);
          trackedValue = titleInput.value;
        }
      });
      Object.defineProperty(titleInput, '__reactProps$fixture', {
        configurable: true,
        enumerable: true,
        value: {
          onInput: (event: { currentTarget: HTMLInputElement }) => {
            directReactTitles.push(event.currentTarget.value);
          },
          onBlur: () => undefined,
        },
      });
      rows.querySelectorAll<HTMLInputElement>(`[id^="workExperience-${additions}--"][id*="dateSection"]`)
        .forEach((dateInput) => {
          Object.defineProperty(dateInput, '__reactProps$fixture', {
            configurable: true,
            enumerable: true,
            value: {
              onChange: (event: { currentTarget: HTMLInputElement }) => {
                directReactDates.push(`${event.currentTarget.id}:${event.currentTarget.value}`);
              },
              onKeyDown: (event: { nativeEvent: KeyboardEvent; currentTarget: HTMLInputElement }) => {
                if (event.nativeEvent.key === 'Tab') committedDates.push(event.currentTarget.id);
              },
              onBlur: () => undefined,
            },
          });
        });
    });
    const profile = {
      ...DEFAULT_PROFILE,
      workHistory: [
        { company: 'Acme', title: 'Engineer', location: 'Raleigh, NC', startDate: '2020-01', endDate: '', currentlyWorksHere: true, description: 'Built things' },
        { company: 'Beta', title: 'Lead', location: 'Boston, MA', startDate: '2022-02', endDate: '2025-01', currentlyWorksHere: false, description: 'Led things' },
      ],
    };

    const summary = await fillWorkdayRepeatableSections(profile);

    expect(additions).toBe(2);
    expect(summary).toEqual({ filled: 13, flagged: 0 });
    expect((document.getElementById('workExperience-1--company') as HTMLInputElement).value).toBe('Acme');
    expect((document.getElementById('workExperience-2--jobTitle') as HTMLInputElement).value).toBe('Lead');
    expect((document.getElementById('workExperience-1--startDate-dateSectionMonth-input') as HTMLInputElement).value).toBe('1');
    expect((document.getElementById('workExperience-1--startDate-dateSectionYear-input') as HTMLInputElement).value).toBe('2020');
    expect((document.getElementById('workExperience-2--endDate-dateSectionYear-input') as HTMLInputElement).value).toBe('2025');
    expect((document.getElementById('workExperience-1--currentlyWorkHere') as HTMLInputElement).checked).toBe(true);
    expect(currentRoleClicks).toBe(1);
    expect(registeredTitles).toEqual(['Engineer', 'Lead']);
    expect(directReactTitles).toEqual(['Engineer', 'Lead']);
    expect(directReactDates).toEqual([
      'workExperience-1--startDate-dateSectionMonth-input:1',
      'workExperience-1--startDate-dateSectionYear-input:2020',
      'workExperience-2--startDate-dateSectionMonth-input:2',
      'workExperience-2--startDate-dateSectionYear-input:2022',
      'workExperience-2--endDate-dateSectionMonth-input:1',
      'workExperience-2--endDate-dateSectionYear-input:2025',
    ]);
    expect(committedDates).toEqual([
      'workExperience-1--startDate-dateSectionYear-input',
      'workExperience-2--startDate-dateSectionYear-input',
      'workExperience-2--endDate-dateSectionYear-input',
    ]);
    expect(document.activeElement).not.toBe(
      document.getElementById('workExperience-2--endDate-dateSectionYear-input')
    );
  });

  it('adds education and matches ampersand field-of-study wording to Workday and wording', async () => {
    document.body.innerHTML = `
      <button data-automation-id="addEducation">Add</button>
      <div id="rows"></div><div id="school-list"></div><div id="degree-list"></div><div id="field-list"></div>
    `;
    let selectedDegree = '';
    document.querySelector('button')!.addEventListener('click', () => {
      document.getElementById('rows')!.innerHTML = `
        <input id="education-1--school" aria-haspopup="listbox" aria-controls="school-list" />
        <input id="education-1--degree" aria-haspopup="listbox" aria-controls="degree-list" />
        <input id="education-1--fieldOfStudy" aria-haspopup="listbox" aria-controls="field-list" />
        <input id="education-1--firstYearAttended-dateSectionYear-input" />
        <input id="education-1--lastYearAttended-dateSectionYear-input" />
        <input id="education-1--gradeAverage" />
      `;
      const school = document.getElementById('education-1--school')!;
      const field = document.getElementById('education-1--fieldOfStudy')!;
      const degree = document.getElementById('education-1--degree')!;
      school.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter') {
          document.getElementById('school-list')!.innerHTML = '<div role="option">State University</div>';
        }
      });
      field.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter') {
          document.getElementById('field-list')!.innerHTML = '<div role="option">Electrical and Computer Engineering</div>';
        }
      });
      degree.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter') {
          document.getElementById('degree-list')!.innerHTML = '<div role="option">Bachelors</div>';
        }
      });
      document.getElementById('degree-list')!.addEventListener('click', (event) => {
        selectedDegree = (event.target as HTMLElement).textContent ?? '';
      });
    });
    const profile = {
      ...DEFAULT_PROFILE,
      education: [{ school: 'State University', degree: 'Bachelor of Science', fieldOfStudy: 'Electrical & Computer Engineering', graduationDate: '2020', startYear: '2016', endYear: '2020', gpa: '3.8' }],
    };

    const summary = await fillWorkdayRepeatableSections(profile, {
      combobox: { pollIntervalMs: 1, maxAttempts: 2 },
    });

    expect(summary).toEqual({ filled: 6, flagged: 0 });
    expect((document.getElementById('education-1--firstYearAttended-dateSectionYear-input') as HTMLInputElement).value).toBe('2016');
    expect((document.getElementById('education-1--lastYearAttended-dateSectionYear-input') as HTMLInputElement).value).toBe('2020');
    expect((document.getElementById('education-1--gradeAverage') as HTMLInputElement).value).toBe('3.8');
    expect(selectedDegree).toBe('Bachelors');
  });

  it('ignores hidden My Experience controls after Workday advances to another step', async () => {
    document.body.innerHTML = `
      <h1>Application Questions 2 of 2</h1>
      <section style="display: none">
        <h2>My Experience</h2>
        <input id="education-1--fieldOfStudy" aria-haspopup="listbox" />
      </section>
    `;
    const hiddenField = document.getElementById('education-1--fieldOfStudy') as HTMLInputElement;
    const profile = {
      ...DEFAULT_PROFILE,
      education: [{
        school: 'State University',
        degree: 'Bachelor of Science',
        fieldOfStudy: 'Computer Science',
        graduationDate: '2020',
        startYear: '2016',
        endYear: '2020',
        gpa: '3.8',
      }],
    };

    const summary = await fillWorkdayRepeatableSections(profile, {
      requireVisibleExperienceStep: true,
    });

    expect(summary).toEqual({ filled: 0, flagged: 0 });
    expect(hiddenField.value).toBe('');
    expect(hiddenField.dataset.autofillFlag).toBeUndefined();
  });
});
