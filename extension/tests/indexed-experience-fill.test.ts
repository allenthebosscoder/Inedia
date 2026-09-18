import { describe, it, expect } from 'vitest';
import { fillIndexedExperienceDescriptions } from '../src/fill-engine/indexed-experience-fill';
import { DEFAULT_PROFILE, Profile } from '../src/storage/profile-schema';

// Reproduces Activision's career site: rows already exist (populated by the site's own
// resume-parse), addressed directly by array index, with only roleDescription left blank.
function row(index: number, company: string, title: string, description = ''): string {
  return `
    <input id="experienceData[${index}].companyName" value="${company}">
    <input id="experienceData[${index}].title" value="${title}">
    <textarea id="experienceData[${index}].roleDescription">${description}</textarea>`;
}

describe('fillIndexedExperienceDescriptions', () => {
  it('fills each row\'s description from the profile entry matched by company and title, not row order', () => {
    // Resume-parse produced rows in the opposite order from profile.workHistory.
    document.body.innerHTML = row(0, 'Pratt School of Engineering', 'ECE Teaching Assistant') +
      row(1, 'Duke Electric Vehicles', 'Power Systems Lead');
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      workHistory: [
        {
          company: 'Duke Electric Vehicles', title: 'Power Systems Lead', location: '',
          startDate: '08/2024', endDate: '', currentlyWorksHere: true,
          description: '- Led the vehicle\'s power systems team',
        },
        {
          company: 'Pratt School of Engineering', title: 'ECE Teaching Assistant', location: '',
          startDate: '01/2026', endDate: '', currentlyWorksHere: true,
          description: '- Independently instructing 10+ students',
        },
      ],
    };

    const summary = fillIndexedExperienceDescriptions(profile);

    expect(summary).toEqual({ filled: 2, flagged: 0 });
    expect((document.getElementById('experienceData[0].roleDescription') as HTMLTextAreaElement).value)
      .toBe('- Independently instructing 10+ students');
    expect((document.getElementById('experienceData[1].roleDescription') as HTMLTextAreaElement).value)
      .toBe('- Led the vehicle\'s power systems team');
  });

  it('leaves an already-filled description alone', () => {
    document.body.innerHTML = row(0, 'Duke Electric Vehicles', 'Power Systems Lead', 'Already written by hand');
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      workHistory: [{
        company: 'Duke Electric Vehicles', title: 'Power Systems Lead', location: '',
        startDate: '08/2024', endDate: '', currentlyWorksHere: true, description: 'Should not overwrite',
      }],
    };

    const summary = fillIndexedExperienceDescriptions(profile);

    expect(summary).toEqual({ filled: 0, flagged: 0 });
    expect((document.getElementById('experienceData[0].roleDescription') as HTMLTextAreaElement).value)
      .toBe('Already written by hand');
  });

  it('flags a required description with no matching profile entry, and ignores an optional one', () => {
    document.body.innerHTML = `
      <input id="experienceData[0].companyName" value="Unknown Company">
      <input id="experienceData[0].title" value="Unknown Title">
      <textarea id="experienceData[0].roleDescription" required></textarea>`;

    const summary = fillIndexedExperienceDescriptions({ ...DEFAULT_PROFILE, workHistory: [] });

    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect((document.getElementById('experienceData[0].roleDescription') as HTMLTextAreaElement).dataset.autofillFlag)
      .toBe('needs-input');
  });

  it('does nothing on a page without this array-indexed field convention', () => {
    document.body.innerHTML = '<input id="companyName">';

    expect(fillIndexedExperienceDescriptions(DEFAULT_PROFILE)).toEqual({ filled: 0, flagged: 0 });
  });
});
