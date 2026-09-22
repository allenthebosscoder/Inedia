import { beforeEach, describe, expect, it } from 'vitest';
import { fillWorkdayProfileQuestions } from '../src/fill-engine/workday-profile-fill';
import { DEFAULT_PROFILE, Profile } from '../src/storage/profile-schema';

describe('fillWorkdayProfileQuestions', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <fieldset>
        <legend>Have you previously worked as Employee or Intern for GlobalFoundries?</legend>
        <input id="previous-yes" type="radio" name="candidateIsPreviousWorker" value="true" />
        <label for="previous-yes">Yes</label>
        <input id="previous-no" type="radio" name="candidateIsPreviousWorker" value="false" />
        <label for="previous-no">No</label>
      </fieldset>
    `;
  });

  it('selects No when the saved work history does not contain that employer', async () => {
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      workHistory: [{
        company: 'Example University', title: 'Teaching Assistant', startDate: '01/2026',
        endDate: '', currentlyWorksHere: true, description: '',
      }],
    };

    expect(await fillWorkdayProfileQuestions(profile)).toEqual({ filled: 1, flagged: 0 });
    expect((document.getElementById('previous-no') as HTMLInputElement).checked).toBe(true);
  });

  it('selects Yes when the saved work history contains that employer', async () => {
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      workHistory: [{
        company: 'GlobalFoundries', title: 'Intern', startDate: '05/2026',
        endDate: '08/2026', currentlyWorksHere: false, description: '',
      }],
    };

    expect(await fillWorkdayProfileQuestions(profile)).toEqual({ filled: 1, flagged: 0 });
    expect((document.getElementById('previous-yes') as HTMLInputElement).checked).toBe(true);
  });
});
