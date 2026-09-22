import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeStorageMock } from './chrome-mock';
import { createProfile, getProfile, listProfiles, renameProfile, saveProfile, setActiveProfile } from '../src/storage/profile-store';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';

describe('profile-store', () => {
  beforeEach(() => {
    installChromeStorageMock();
  });

  it('returns the default profile when nothing is stored', async () => {
    const profile = await getProfile();
    expect(profile).toEqual(DEFAULT_PROFILE);
  });

  it('round-trips a saved profile', async () => {
    const custom = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Jorge' } };
    await saveProfile(custom);
    const profile = await getProfile();
    expect(profile.personal.firstName).toBe('Jorge');
  });

  it('migrates the legacy profile into a named default profile', async () => {
    await chrome.storage.local.set({
      profile: { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Legacy' } },
    });
    const summaries = await listProfiles();
    expect(summaries).toEqual([{ id: 'default', name: 'Default', active: true }]);
    expect((await getProfile()).personal.firstName).toBe('Legacy');
  });

  it('creates and selects multiple independent profiles', async () => {
    const tailored = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Tailored' } };
    const id = await createProfile('Technical', tailored);
    expect((await listProfiles()).find((entry) => entry.id === id)).toMatchObject({ name: 'Technical', active: true });
    expect((await getProfile(id)).personal.firstName).toBe('Tailored');
    await setActiveProfile('default');
    expect((await listProfiles()).find((entry) => entry.id === 'default')?.active).toBe(true);
  });

  it('fills in missing fields on a profile stored before they existed', async () => {
    const oldPersonal: Record<string, string> = { ...DEFAULT_PROFILE.personal, firstName: 'Jorge' };
    delete oldPersonal.phoneType;
    const oldProfile = { ...DEFAULT_PROFILE, personal: oldPersonal };
    await chrome.storage.local.set({ profile: oldProfile });

    const profile = await getProfile();
    expect(profile.personal.phoneType).toBe(DEFAULT_PROFILE.personal.phoneType);
    expect(profile.personal.firstName).toBe('Jorge');
    expect(profile.professional).toEqual(DEFAULT_PROFILE.professional);
    expect(profile.workAuthorization.plansToUseOPT).toBe('');
    expect(profile.jobPreferences.willingToWorkOnsite).toBe('');
  });

  it('renames an existing profile', async () => {
    const id = await createProfile('Technical', { ...DEFAULT_PROFILE });
    await renameProfile(id, 'Technical Roles');
    expect((await listProfiles()).find((entry) => entry.id === id)?.name).toBe('Technical Roles');
  });

  it('does not rename a profile to a blank name', async () => {
    const id = await createProfile('Technical', { ...DEFAULT_PROFILE });
    await renameProfile(id, '   ');
    expect((await listProfiles()).find((entry) => entry.id === id)?.name).toBe('Technical');
  });

  it('ignores a rename request for an unknown profile id', async () => {
    const before = await listProfiles();
    await renameProfile('does-not-exist', 'Anything');
    expect(await listProfiles()).toEqual(before);
  });

  it('normalizes a legacy free-text state value to its abbreviation', async () => {
    const oldProfile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'North Carolina' } };
    await chrome.storage.local.set({ profile: oldProfile });

    const profile = await getProfile();
    expect(profile.personal.state).toBe('NC');
  });
});
