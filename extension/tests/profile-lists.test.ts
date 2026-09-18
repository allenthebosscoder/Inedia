import { describe, it, expect } from 'vitest';
import {
  parseWorkHistory,
  renderWorkHistoryEntry,
  parseEducation,
  renderEducationEntry,
  parseOverrides,
  renderOverrideRow,
} from '../src/options/profile-lists';
import { WorkHistoryEntry, EducationEntry } from '../src/storage/profile-schema';

describe('renderWorkHistoryEntry / parseWorkHistory', () => {
  it('round-trips a work history entry through the DOM', () => {
    const entry: WorkHistoryEntry = {
      company: 'Acme',
      title: 'Engineer',
      location: 'Raleigh, NC',
      startDate: '01/2020',
      endDate: '01/2022',
      currentlyWorksHere: false,
      description: 'Built things.',
      supervisorName: '',
      supervisorPhone: '',
      mayContact: '',
      reasonForLeaving: '',
    };

    const container = document.createElement('div');
    container.appendChild(renderWorkHistoryEntry(entry));

    expect(parseWorkHistory(container)).toEqual([entry]);
  });

  it('renders a remove button so an entry can be deleted', () => {
    const container = document.createElement('div');
    container.appendChild(
      renderWorkHistoryEntry({ company: '', title: '', startDate: '', endDate: '', description: '' })
    );
    expect(container.querySelector('[data-work-entry] [data-remove]')).not.toBeNull();
  });

  it('round-trips supervisor, phone, may-contact and reason-for-leaving', () => {
    const entry = {
      company: 'Acme', title: 'Engineer', location: 'Durham, NC',
      startDate: '06/2021', endDate: '08/2023', currentlyWorksHere: false,
      description: 'Built things',
      supervisorName: 'Dana Lee', supervisorPhone: '9195551234',
      mayContact: 'yes' as const, reasonForLeaving: 'Career growth',
    };
    const container = document.createElement('div');
    container.appendChild(renderWorkHistoryEntry(entry));
    expect(parseWorkHistory(container)).toEqual([entry]);
  });

  it('round-trips values containing quotes and angle brackets without corrupting the markup', () => {
    const entry: WorkHistoryEntry = {
      company: 'Widgets "R" Us',
      title: 'Lead, <Special> Projects',
      location: 'New York, NY',
      startDate: '01/2020',
      endDate: '01/2022',
      currentlyWorksHere: true,
      description: 'Shipped a "great" feature & handled </textarea> edge cases.',
      supervisorName: '',
      supervisorPhone: '',
      mayContact: '',
      reasonForLeaving: '',
    };

    const container = document.createElement('div');
    container.appendChild(renderWorkHistoryEntry(entry));

    expect(parseWorkHistory(container)).toEqual([entry]);
  });
});

describe('renderEducationEntry / parseEducation', () => {
  it('round-trips an education entry through the DOM', () => {
    const entry: EducationEntry = {
      school: 'State University',
      degree: 'BS',
      fieldOfStudy: 'Computer Science',
      location: 'Raleigh, NC',
      graduationDate: '01/2019',
      startDate: '01/2015',
      endDate: '01/2019',
      startYear: '2015',
      endYear: '2019',
      gpa: '3.8',
    };

    const container = document.createElement('div');
    container.appendChild(renderEducationEntry(entry));

    expect(parseEducation(container)).toEqual([entry]);
  });

  it('renders a remove button so an entry can be deleted', () => {
    const container = document.createElement('div');
    container.appendChild(
      renderEducationEntry({ school: '', degree: '', fieldOfStudy: '', graduationDate: '' })
    );
    expect(container.querySelector('[data-education-entry] [data-remove]')).not.toBeNull();
  });
});

describe('renderOverrideRow / parseOverrides', () => {
  it('round-trips an override row through the DOM', () => {
    const container = document.createElement('div');
    container.appendChild(renderOverrideRow('Do you have a code sample link?', 'links.github'));

    expect(parseOverrides(container)).toEqual({
      'do you have a code sample link': 'links.github',
    });
  });

  it('normalizes labels and pairs them with the chosen profile field key', () => {
    document.body.innerHTML = `
      <div id="overrides">
        <div data-override-row>
          <input name="label" value="Do You Have A Code Sample Link?" />
          <select name="fieldKey"><option value="links.github" selected>GitHub</option></select>
        </div>
      </div>
    `;
    const container = document.getElementById('overrides')!;

    expect(parseOverrides(container)).toEqual({
      'do you have a code sample link': 'links.github',
    });
  });

  it('skips rows with no label or no selected key', () => {
    document.body.innerHTML = `
      <div id="overrides">
        <div data-override-row>
          <input name="label" value="" />
          <select name="fieldKey"><option value="links.github" selected>GitHub</option></select>
        </div>
      </div>
    `;
    const container = document.getElementById('overrides')!;

    expect(parseOverrides(container)).toEqual({});
  });

  it('renders a remove button so an override row can be deleted', () => {
    const container = document.createElement('div');
    container.appendChild(renderOverrideRow());
    expect(container.querySelector('[data-override-row] [data-remove]')).not.toBeNull();
  });
});
