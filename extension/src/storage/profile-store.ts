import { DEFAULT_PROFILE, Profile } from './profile-schema';
import { normalizeStateValue } from '../fill-engine/us-states';

const LEGACY_STORAGE_KEY = 'profile';
const LIBRARY_STORAGE_KEY = 'profileLibrary';
const DEFAULT_PROFILE_ID = 'default';

interface StoredProfileEntry { name: string; profile: Partial<Profile> }
interface ProfileLibrary { activeId: string; profiles: Record<string, StoredProfileEntry> }
export interface ProfileSummary { id: string; name: string; active: boolean }

function mergeProfile(stored?: Partial<Profile>): Profile {
  const merged = {
    ...DEFAULT_PROFILE,
    ...stored,
    personal: { ...DEFAULT_PROFILE.personal, ...stored?.personal },
    workAuthorization: { ...DEFAULT_PROFILE.workAuthorization, ...stored?.workAuthorization },
    jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, ...stored?.jobPreferences },
    professional: { ...DEFAULT_PROFILE.professional, ...stored?.professional },
    disclosures: { ...DEFAULT_PROFILE.disclosures, ...stored?.disclosures },
    links: { ...DEFAULT_PROFILE.links, ...stored?.links },
  };
  return { ...merged, personal: { ...merged.personal, state: normalizeStateValue(merged.personal.state) } };
}

async function getLibrary(): Promise<ProfileLibrary> {
  const result = await chrome.storage.local.get([LIBRARY_STORAGE_KEY, LEGACY_STORAGE_KEY]);
  const existing = result[LIBRARY_STORAGE_KEY] as ProfileLibrary | undefined;
  if (existing?.profiles && Object.keys(existing.profiles).length > 0) return existing;
  const legacy = result[LEGACY_STORAGE_KEY] as Partial<Profile> | undefined;
  const library: ProfileLibrary = {
    activeId: DEFAULT_PROFILE_ID,
    profiles: { [DEFAULT_PROFILE_ID]: { name: 'Default', profile: mergeProfile(legacy) } },
  };
  await chrome.storage.local.set({ [LIBRARY_STORAGE_KEY]: library });
  return library;
}

export async function listProfiles(): Promise<ProfileSummary[]> {
  const library = await getLibrary();
  return Object.entries(library.profiles).map(([id, entry]) => ({ id, name: entry.name, active: id === library.activeId }));
}

export async function getProfile(profileId?: string): Promise<Profile> {
  const library = await getLibrary();
  const id = profileId && library.profiles[profileId] ? profileId : library.activeId;
  return mergeProfile(library.profiles[id]?.profile);
}

export async function saveProfile(profile: Profile, profileId?: string): Promise<void> {
  const library = await getLibrary();
  const id = profileId && library.profiles[profileId] ? profileId : library.activeId;
  const existing = library.profiles[id] ?? { name: 'Default', profile };
  library.profiles[id] = { ...existing, profile };
  await chrome.storage.local.set({
    [LIBRARY_STORAGE_KEY]: library,
    ...(id === library.activeId ? { [LEGACY_STORAGE_KEY]: profile } : {}),
  });
}

export async function setActiveProfile(profileId: string): Promise<void> {
  const library = await getLibrary();
  if (!library.profiles[profileId]) return;
  library.activeId = profileId;
  await chrome.storage.local.set({
    [LIBRARY_STORAGE_KEY]: library,
    [LEGACY_STORAGE_KEY]: mergeProfile(library.profiles[profileId].profile),
  });
}

export async function createProfile(name: string, base?: Profile): Promise<string> {
  const library = await getLibrary();
  const id = crypto.randomUUID();
  library.profiles[id] = { name: name.trim() || `Profile ${Object.keys(library.profiles).length + 1}`, profile: base ?? DEFAULT_PROFILE };
  library.activeId = id;
  await chrome.storage.local.set({ [LIBRARY_STORAGE_KEY]: library, [LEGACY_STORAGE_KEY]: base ?? DEFAULT_PROFILE });
  return id;
}

export async function renameProfile(profileId: string, name: string): Promise<void> {
  const library = await getLibrary();
  const trimmed = name.trim();
  if (!library.profiles[profileId] || !trimmed) return;
  library.profiles[profileId] = { ...library.profiles[profileId], name: trimmed };
  await chrome.storage.local.set({ [LIBRARY_STORAGE_KEY]: library });
}

export async function deleteProfile(profileId: string): Promise<void> {
  const library = await getLibrary();
  if (!library.profiles[profileId] || Object.keys(library.profiles).length === 1) return;
  delete library.profiles[profileId];
  if (library.activeId === profileId) library.activeId = Object.keys(library.profiles)[0];
  await chrome.storage.local.set({
    [LIBRARY_STORAGE_KEY]: library,
    [LEGACY_STORAGE_KEY]: mergeProfile(library.profiles[library.activeId].profile),
  });
}
