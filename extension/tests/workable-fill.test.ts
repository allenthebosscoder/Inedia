import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';
import {
  fillWorkableForm,
  workableEducationEndDate,
  workableMonthYear,
} from '../src/fill-engine/workable-fill';

function installEducationGroup(): HTMLElement {
  document.body.innerHTML = `
    <div data-ui="education">
      <button data-ui="add-section" type="button">Add</button>
    </div>`;
  const group = document.querySelector<HTMLElement>('[data-ui="education"]')!;
  group.querySelector('button')!.addEventListener('click', () => {
    group.insertAdjacentHTML('beforeend', `
      <div data-editor>
        <input name="school"><input name="field_of_study"><input name="degree">
        <input name="start_date"><input name="end_date">
        <button data-ui="save-section" type="button">Update</button>
      </div>`);
    group.querySelector<HTMLButtonElement>('button[data-ui="add-section"]')!.disabled = true;
    group.querySelector<HTMLButtonElement>('button[data-ui="save-section"]')!.addEventListener('click', () => {
      const school = group.querySelector<HTMLInputElement>('input[name="school"]')!.value;
      group.querySelector('[data-editor]')!.remove();
      group.insertAdjacentHTML('beforeend', `<li><span data-ui="school">${school}</span></li>`);
      group.querySelector<HTMLButtonElement>('button[data-ui="add-section"]')!.disabled = false;
    });
  });
  return group;
}

describe('Workable fill', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('normalizes profile dates to Workable MM/YYYY fields', () => {
    expect(workableMonthYear('2024-8')).toBe('08/2024');
    expect(workableMonthYear('12/2027')).toBe('12/2027');
    expect(workableMonthYear('2027')).toBe('01/2027');
  });

  it('uses the current month when Workable cannot accept a future education end date', () => {
    expect(workableEducationEndDate('2027-12', new Date(2026, 7, 5))).toBe('08/2026');
    expect(workableEducationEndDate('2025-05', new Date(2026, 7, 5))).toBe('05/2025');
  });

  it('adds, fills, and saves every missing education entry once', async () => {
    const group = installEducationGroup();
    const profile = {
      ...DEFAULT_PROFILE,
      education: [{
        school: 'Example University', degree: 'BS', fieldOfStudy: 'Electrical Engineering',
        startDate: '2024-08', endDate: '2025-12', graduationDate: '', gpa: '4',
      }],
    };

    const summary = await fillWorkableForm(profile);
    expect(group.querySelector('[data-ui="school"]')?.textContent).toBe('Example University');
    expect(summary).toEqual({ filled: 5, flagged: 0 });

    expect(await fillWorkableForm(profile)).toEqual({ filled: 0, flagged: 0 });
    expect(group.querySelectorAll('[data-ui="school"]')).toHaveLength(1);
  });

  it('types Workable masked dates one character at a time', async () => {
    installEducationGroup();
    const inserted: string[] = [];
    document.execCommand = vi.fn((_command, _showUi, value) => {
      const input = document.activeElement as HTMLInputElement;
      inserted.push(String(value));
      input.value += String(value);
      if (input.value.length === 2) input.value += '/';
      return true;
    });
    const profile = {
      ...DEFAULT_PROFILE,
      education: [{
        school: 'Example University', degree: 'BS', fieldOfStudy: 'Electrical Engineering',
        startDate: '2024-08', endDate: '2025-12', graduationDate: '', gpa: '4',
      }],
    };

    await fillWorkableForm(profile);

    expect(inserted.join('')).toBe('082024122025');
  });

  it('selects dates through Workable month-picker tiles when they are available', async () => {
    const group = installEducationGroup();
    document.execCommand = vi.fn(() => false);
    const add = group.querySelector<HTMLButtonElement>('button[data-ui="add-section"]')!;
    add.click();
    const dates = [
      { name: 'start_date', value: '08/2024', year: 2024, month: 'August' },
      { name: 'end_date', value: '12/2025', year: 2025, month: 'December' },
    ];
    for (const date of dates) {
      const input = group.querySelector<HTMLInputElement>(`input[name="${date.name}"]`)!;
      input.addEventListener('click', () => {
        document.querySelector('[data-test-picker]')?.remove();
        const picker = document.createElement('div');
        picker.dataset.testPicker = '';
        picker.innerHTML = `
          <div class="react-datepicker-year-header">${date.year}</div>
          <div role="option" aria-label="Choose ${date.month} ${date.year}">${date.month}</div>`;
        picker.querySelector<HTMLElement>('[role="option"]')!.addEventListener('click', () => {
          input.value = date.value;
          picker.remove();
        });
        document.body.append(picker);
      });
    }

    const profile = {
      ...DEFAULT_PROFILE,
      education: [{
        school: 'Example University', degree: 'BS', fieldOfStudy: 'Electrical Engineering',
        startDate: '2024-08', endDate: '2025-12', graduationDate: '', gpa: '4',
      }],
    };

    const summary = await fillWorkableForm(profile);
    expect(summary).toEqual({ filled: 5, flagged: 0 });
    expect(document.execCommand).not.toHaveBeenCalled();
  });
});
