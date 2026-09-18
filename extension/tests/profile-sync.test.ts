import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { installChromeStorageMock } from './chrome-mock';
import { syncProfileFromJobTracker, JOBTRACKER_PROFILE_NAME } from '../src/profile-sync';
import { createProfile, getProfile, listProfiles, saveProfile } from '../src/storage/profile-store';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';

function stubFetchOk(profile: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(profile) }));
}

async function getJobTrackerProfile() {
  const summaries = await listProfiles();
  const entry = summaries.find((p) => p.name === JOBTRACKER_PROFILE_NAME);
  expect(entry).toBeDefined();
  return getProfile(entry!.id);
}

describe('syncProfileFromJobTracker', () => {
  beforeEach(() => {
    installChromeStorageMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a dedicated JobTracker profile on first sync and writes non-blank fields into it', async () => {
    stubFetchOk({ ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Allen' } });

    const result = await syncProfileFromJobTracker();

    expect(result).toBe(true);
    expect((await getJobTrackerProfile()).personal.firstName).toBe('Allen');
  });

  it('never touches other profiles, including whichever one is active', async () => {
    await createProfile('SWE May', { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Untouched' } });
    // "SWE May" is now active, simulating the user having it open/selected.
    stubFetchOk({ ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Allen' } });

    await syncProfileFromJobTracker();

    expect((await getProfile()).personal.firstName).toBe('Untouched'); // active profile unchanged
    expect((await getJobTrackerProfile()).personal.firstName).toBe('Allen');
  });

  it('does not change which profile is active when creating the JobTracker profile', async () => {
    const sweMayId = await createProfile('SWE May', DEFAULT_PROFILE);
    stubFetchOk(DEFAULT_PROFILE);

    await syncProfileFromJobTracker();

    const summaries = await listProfiles();
    expect(summaries.find((p) => p.active)?.id).toBe(sweMayId);
  });

  it('reuses the same JobTracker profile on subsequent syncs instead of creating another', async () => {
    stubFetchOk(DEFAULT_PROFILE);
    await syncProfileFromJobTracker();
    await syncProfileFromJobTracker();

    const matches = (await listProfiles()).filter((p) => p.name === JOBTRACKER_PROFILE_NAME);
    expect(matches).toHaveLength(1);
  });

  it('does not clobber a locally-entered address on the JobTracker profile with a blank JobTracker value', async () => {
    stubFetchOk(DEFAULT_PROFILE);
    await syncProfileFromJobTracker(); // creates the JobTracker profile
    const jtId = (await listProfiles()).find((p) => p.name === JOBTRACKER_PROFILE_NAME)!.id;
    const current = await getProfile(jtId);
    await saveProfile({ ...current, personal: { ...current.personal, address: '123 Local St', city: 'Durham' } }, jtId);

    // JobTracker doesn't know Allen's address, so it sends this blank.
    stubFetchOk({ ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Allen' } });
    await syncProfileFromJobTracker();

    const profile = await getJobTrackerProfile();
    expect(profile.personal.firstName).toBe('Allen');
    expect(profile.personal.address).toBe('123 Local St');
    expect(profile.personal.city).toBe('Durham');
  });

  it('does not clobber locally-entered EEO disclosures on the JobTracker profile', async () => {
    stubFetchOk(DEFAULT_PROFILE);
    await syncProfileFromJobTracker();
    const jtId = (await listProfiles()).find((p) => p.name === JOBTRACKER_PROFILE_NAME)!.id;
    const current = await getProfile(jtId);
    await saveProfile({ ...current, disclosures: { ...current.disclosures, veteranStatus: 'not a veteran' } }, jtId);

    stubFetchOk(DEFAULT_PROFILE);
    await syncProfileFromJobTracker();

    expect((await getJobTrackerProfile()).disclosures.veteranStatus).toBe('not a veteran');
  });

  it('replaces work history and education when JobTracker provides them', async () => {
    const remote = {
      ...DEFAULT_PROFILE,
      workHistory: [{ company: 'Duke Electric Vehicles', title: 'Power Systems Lead', startDate: '2024-08', endDate: '', description: '' }],
      education: [{ school: 'Example University', degree: 'BS', fieldOfStudy: 'ECE', graduationDate: 'May 2027' }],
    };
    stubFetchOk(remote);

    await syncProfileFromJobTracker();

    const profile = await getJobTrackerProfile();
    expect(profile.workHistory).toEqual(remote.workHistory);
    expect(profile.education).toEqual(remote.education);
  });

  it('updates the resume when JobTracker has one primed', async () => {
    const resume = { name: 'Allen-Acme-SWE.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,ZmFrZQ==' };
    stubFetchOk({ ...DEFAULT_PROFILE, resume });

    await syncProfileFromJobTracker();

    expect((await getJobTrackerProfile()).resume).toEqual(resume);
  });

  it('keeps the existing resume on the JobTracker profile when JobTracker has none primed yet', async () => {
    stubFetchOk(DEFAULT_PROFILE);
    await syncProfileFromJobTracker();
    const jtId = (await listProfiles()).find((p) => p.name === JOBTRACKER_PROFILE_NAME)!.id;
    const resume = { name: 'existing.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,b2xk' };
    const current = await getProfile(jtId);
    await saveProfile({ ...current, resume }, jtId);

    stubFetchOk({ ...DEFAULT_PROFILE, resume: null });
    await syncProfileFromJobTracker();

    expect((await getJobTrackerProfile()).resume).toEqual(resume);
  });

  it('leaves stored profiles untouched when JobTracker is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const result = await syncProfileFromJobTracker();

    expect(result).toBe(false);
    expect(await getProfile()).toEqual(DEFAULT_PROFILE);
    expect((await listProfiles()).find((p) => p.name === JOBTRACKER_PROFILE_NAME)).toBeUndefined();
  });

  it('leaves stored profiles untouched on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }));

    const result = await syncProfileFromJobTracker();

    expect(result).toBe(false);
    expect(await getProfile()).toEqual(DEFAULT_PROFILE);
  });

  it('renames the JobTracker profile to show the role label JobTracker provides', async () => {
    stubFetchOk({ ...DEFAULT_PROFILE, profileLabel: 'Example Company - Software Intern' });

    await syncProfileFromJobTracker();

    const summaries = await listProfiles();
    expect(summaries.map((p) => p.name)).toContain('Custom (Example Company - Software Intern)');
    expect(summaries.map((p) => p.name)).not.toContain(JOBTRACKER_PROFILE_NAME);
  });

  it('keeps the bare "Custom" name when JobTracker provides no role label', async () => {
    stubFetchOk(DEFAULT_PROFILE);

    await syncProfileFromJobTracker();

    const summaries = await listProfiles();
    expect(summaries.map((p) => p.name)).toContain(JOBTRACKER_PROFILE_NAME);
  });

  it('finds the same JobTracker profile by remembered ID after it has been renamed, instead of creating a duplicate', async () => {
    stubFetchOk({ ...DEFAULT_PROFILE, profileLabel: 'Apple - Camera Hardware' });
    await syncProfileFromJobTracker(); // creates it, renames to "Custom (Apple - Camera Hardware)"

    stubFetchOk({ ...DEFAULT_PROFILE, profileLabel: 'Microchip - Engineer I' });
    await syncProfileFromJobTracker(); // must find the same profile by ID, not create a second one

    const summaries = await listProfiles();
    const jobTrackerProfiles = summaries.filter((p) => p.name === JOBTRACKER_PROFILE_NAME || p.name.startsWith(`${JOBTRACKER_PROFILE_NAME} (`));
    expect(jobTrackerProfiles).toHaveLength(1);
    expect(jobTrackerProfiles[0]?.name).toBe('Custom (Microchip - Engineer I)');
  });

  it('reverts the JobTracker profile back to the bare "Custom" name once no label is primed', async () => {
    stubFetchOk({ ...DEFAULT_PROFILE, profileLabel: 'Salesforce - Software Engineer Intern' });
    await syncProfileFromJobTracker();

    stubFetchOk(DEFAULT_PROFILE);
    await syncProfileFromJobTracker();

    const summaries = await listProfiles();
    expect(summaries.map((p) => p.name)).toContain(JOBTRACKER_PROFILE_NAME);
    expect(summaries.map((p) => p.name)).not.toContain('Custom (Salesforce - Software Engineer Intern)');
  });

  it('finds a profile already named "Custom (...)" from before this ID existed, by name fallback', async () => {
    const legacyId = await createProfile('Custom (Old Manually Renamed Role)', DEFAULT_PROFILE);
    stubFetchOk({ ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Allen' } });

    await syncProfileFromJobTracker();

    expect((await getProfile(legacyId)).personal.firstName).toBe('Allen');
    const summaries = await listProfiles();
    expect(summaries.filter((p) => p.id === legacyId)).toHaveLength(1);
  });

  describe('targetProfileName', () => {
    it('syncs into the named profile instead of the primary JobTracker slot, creating it if missing', async () => {
      stubFetchOk({ ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Allen' }, targetProfileName: 'Custom2' });

      await syncProfileFromJobTracker();

      const summaries = await listProfiles();
      const target = summaries.find((p) => p.name === 'Custom2');
      expect(target).toBeDefined();
      expect((await getProfile(target!.id)).personal.firstName).toBe('Allen');
      expect(summaries.find((p) => p.name === JOBTRACKER_PROFILE_NAME)).toBeUndefined();
    });

    it('leaves the primary JobTracker profile untouched when syncing to a named target', async () => {
      stubFetchOk({ ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Primary' } });
      await syncProfileFromJobTracker(); // populates the primary slot

      stubFetchOk({ ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Targeted' }, targetProfileName: 'Custom2' });
      await syncProfileFromJobTracker();

      expect((await getJobTrackerProfile()).personal.firstName).toBe('Primary');
      const target = (await listProfiles()).find((p) => p.name === 'Custom2')!;
      expect((await getProfile(target.id)).personal.firstName).toBe('Targeted');
    });

    it('reuses the same named profile on subsequent targeted syncs instead of creating another', async () => {
      stubFetchOk({ ...DEFAULT_PROFILE, targetProfileName: 'Custom2' });
      await syncProfileFromJobTracker();
      stubFetchOk({ ...DEFAULT_PROFILE, targetProfileName: 'Custom2' });
      await syncProfileFromJobTracker();

      const matches = (await listProfiles()).filter((p) => p.name.startsWith('Custom2'));
      expect(matches).toHaveLength(1);
    });

    it('renames a name-targeted profile to show the role label, same as the primary slot', async () => {
      stubFetchOk({ ...DEFAULT_PROFILE, profileLabel: 'Garmin - Software Engineering Intern', targetProfileName: 'Custom2' });

      await syncProfileFromJobTracker();

      const summaries = await listProfiles();
      expect(summaries.map((p) => p.name)).toContain('Custom2 (Garmin - Software Engineering Intern)');
      expect(summaries.map((p) => p.name)).not.toContain('Custom2');
    });

    it('keeps finding the same targeted profile by remembered ID after it has been renamed, instead of creating a duplicate', async () => {
      stubFetchOk({ ...DEFAULT_PROFILE, profileLabel: 'Garmin - Software Engineering Intern', targetProfileName: 'Custom2' });
      await syncProfileFromJobTracker(); // creates it, renames to "Custom2 (Garmin - Software Engineering Intern)"

      stubFetchOk({ ...DEFAULT_PROFILE, profileLabel: 'Coinbase - Software Engineer Intern', targetProfileName: 'Custom2' });
      await syncProfileFromJobTracker(); // must find the same profile by ID, not create a second one

      const summaries = await listProfiles();
      const targetedProfiles = summaries.filter((p) => p.name === 'Custom2' || p.name.startsWith('Custom2 ('));
      expect(targetedProfiles).toHaveLength(1);
      expect(targetedProfiles[0]?.name).toBe('Custom2 (Coinbase - Software Engineer Intern)');
    });

    it('reverts a name-targeted profile back to its bare base name once no label is primed', async () => {
      stubFetchOk({ ...DEFAULT_PROFILE, profileLabel: 'Garmin - Software Engineering Intern', targetProfileName: 'Custom2' });
      await syncProfileFromJobTracker();

      stubFetchOk({ ...DEFAULT_PROFILE, targetProfileName: 'Custom2' });
      await syncProfileFromJobTracker();

      const summaries = await listProfiles();
      expect(summaries.map((p) => p.name)).toContain('Custom2');
      expect(summaries.map((p) => p.name)).not.toContain('Custom2 (Garmin - Software Engineering Intern)');
    });

    it('does not change which profile is active when syncing to a named target', async () => {
      const sweMayId = await createProfile('SWE May', DEFAULT_PROFILE);
      stubFetchOk({ ...DEFAULT_PROFILE, targetProfileName: 'Custom2' });

      await syncProfileFromJobTracker();

      const summaries = await listProfiles();
      expect(summaries.find((p) => p.active)?.id).toBe(sweMayId);
    });

    it('syncs into an existing profile matched by exact name rather than creating a duplicate', async () => {
      const existingId = await createProfile('Custom2', { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Old' } });
      stubFetchOk({ ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'New' }, targetProfileName: 'Custom2' });

      await syncProfileFromJobTracker();

      const matches = (await listProfiles()).filter((p) => p.name.startsWith('Custom2'));
      expect(matches).toHaveLength(1);
      expect((await getProfile(existingId)).personal.firstName).toBe('New');
    });

    it('keeps two different named targets independent of each other', async () => {
      stubFetchOk({ ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Two' }, targetProfileName: 'Custom2' });
      await syncProfileFromJobTracker();
      stubFetchOk({ ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Three' }, targetProfileName: 'Custom3' });
      await syncProfileFromJobTracker();

      const summaries = await listProfiles();
      const custom2 = summaries.find((p) => p.name.startsWith('Custom2'))!;
      const custom3 = summaries.find((p) => p.name.startsWith('Custom3'))!;
      expect((await getProfile(custom2.id)).personal.firstName).toBe('Two');
      expect((await getProfile(custom3.id)).personal.firstName).toBe('Three');
    });
  });
});
