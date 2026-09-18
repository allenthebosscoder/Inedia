import { createProfile, getProfile, listProfiles, renameProfile, saveProfile, setActiveProfile } from './storage/profile-store';
import { DEFAULT_PROFILE, Profile } from './storage/profile-schema';

const JOBTRACKER_PROFILE_URL = 'http://localhost:8080/api/profile';
export const JOBTRACKER_PROFILE_NAME = 'Custom';

// The profile JobTracker owns is tracked by a stable ID, not by its display
// name -- that's what lets syncProfileFromJobTracker() rename it to show the
// currently-primed role (e.g. "Custom (Amazon - Cloud Hardware Intern)")
// without losing track of it on the next sync and creating a stray
// duplicate, which is exactly what happened before this existed (see
// job_tracker_autofill_extension memory). The same tracking applies to a
// named sync target (see `targetProfileName` below): each base name gets
// its own remembered ID, keyed off that name, so a targeted profile can be
// renamed to show its role label too without breaking the next lookup.
const JOBTRACKER_PROFILE_ID_KEY = 'jobTrackerProfileId';
const TARGET_PROFILE_ID_KEY_PREFIX = 'jobTrackerTargetProfileId:';

// JobTracker's /api/profile response is Profile plus these UI-only fields
// (which name to show, and an optional explicit sync target); neither is
// ever written into storage as profile data.
type RemoteProfile = Profile & { profileLabel?: string; targetProfileName?: string };

function isBlank(value: unknown): boolean {
  return value === '' || value === null || value === undefined;
}

/**
 * Field-by-field merge: a non-blank value from JobTracker wins (it's the
 * source of truth for what it actually knows — name, work authorization,
 * work history, education, resume); a blank JobTracker value keeps whatever
 * is already stored locally, so fields JobTracker doesn't track (address,
 * EEO disclosures, job preferences the user filled in by hand) never get
 * clobbered by an empty string.
 */
function mergeSection<T extends Record<string, unknown>>(local: T, remote: T): T {
  const merged = { ...local };
  for (const key of Object.keys(remote) as (keyof T)[]) {
    if (!isBlank(remote[key])) merged[key] = remote[key];
  }
  return merged;
}

function mergeProfiles(local: Profile, remote: Profile): Profile {
  return {
    ...local,
    personal: mergeSection(local.personal, remote.personal),
    workAuthorization: mergeSection(local.workAuthorization, remote.workAuthorization),
    jobPreferences: mergeSection(local.jobPreferences, remote.jobPreferences),
    professional: mergeSection(local.professional, remote.professional),
    disclosures: mergeSection(local.disclosures, remote.disclosures),
    links: mergeSection(local.links, remote.links),
    // Work history, education, and resume are wholly JobTracker-owned content —
    // replace outright when JobTracker has something to say, keep local otherwise.
    workHistory: remote.workHistory.length > 0 ? remote.workHistory : local.workHistory,
    education: remote.education.length > 0 ? remote.education : local.education,
    resume: remote.resume ?? local.resume,
  };
}

function displayNameFor(baseName: string, label: string | undefined): string {
  return label ? `${baseName} (${label})` : baseName;
}

async function getStoredProfileId(storageKey: string): Promise<string | undefined> {
  const result = await chrome.storage.local.get(storageKey);
  return result[storageKey] as string | undefined;
}

async function rememberProfileId(storageKey: string, id: string): Promise<void> {
  await chrome.storage.local.set({ [storageKey]: id });
}

/**
 * Finds (or creates) the profile identified by `baseName`, so syncing never
 * touches whatever profile the user happens to have active for other
 * purposes. Resolved by a remembered stable ID first (so renaming the
 * profile to show the current role never breaks the lookup); falls back to
 * matching by name (exact `baseName`, or `"<baseName> (...)"` from an
 * earlier rename) for a profile created before that ID existed under this
 * key, or if the stored ID was somehow lost. createProfile() switches the
 * active profile as a side effect — on first creation, restore whatever was
 * active before so this never hijacks the user's current selection.
 *
 * `storageKey` is the chrome.storage.local key this particular base name's
 * ID is remembered under: the primary JobTracker slot and every distinct
 * named sync target each get their own key, so they're tracked (and can be
 * renamed) independently without colliding.
 */
async function getOrCreateNamedProfileId(baseName: string, storageKey: string): Promise<string> {
  const summaries = await listProfiles();

  const storedId = await getStoredProfileId(storageKey);
  if (storedId && summaries.some((entry) => entry.id === storedId)) {
    return storedId;
  }

  const existingByName = summaries.find(
    (entry) => entry.name === baseName || entry.name.startsWith(`${baseName} (`)
  );
  if (existingByName) {
    await rememberProfileId(storageKey, existingByName.id);
    return existingByName.id;
  }

  const previousActive = summaries.find((entry) => entry.active);
  const id = await createProfile(baseName, DEFAULT_PROFILE);
  if (previousActive) await setActiveProfile(previousActive.id);
  await rememberProfileId(storageKey, id);
  return id;
}

/**
 * Pulls the current profile from the local JobTracker server and merges it
 * into a profile in storage, so the autofill widget always reads from
 * chrome.storage.local with no network call in the fill path itself, and
 * other profiles are never touched.
 *
 * Normally that's the single dedicated JobTracker-owned profile (base name
 * "Custom", tracked under JOBTRACKER_PROFILE_ID_KEY). But when JobTracker's
 * response carries a `targetProfileName` (Allen explicitly priming a
 * *different*, by-name profile — e.g. a second one he's using for
 * independent testing, so the primary slot stays untouched), sync goes to
 * that named profile instead, tracked under its own key so it never
 * collides with the primary slot or with a different named target.
 *
 * Either way, the resolved profile gets renamed to show the role JobTracker
 * currently has primed (e.g. "Custom (Amazon - Cloud Hardware Intern)" or
 * "Custom 2 (Garmin - Software Engineering Intern)"), so it's visible at a
 * glance in the profile picker whether a resume was actually just updated,
 * instead of a bare name that looks identical every time. The remembered
 * per-base-name ID is what makes that rename safe: the next sync still
 * finds the same profile by ID even though its display name changed.
 *
 * Called on install/startup, on a recurring alarm, and on navigation to a new
 * page — all fire-and-forget. JobTracker not running is expected and silent;
 * whatever was last synced (or the stored default) stays in place.
 */
export async function syncProfileFromJobTracker(): Promise<boolean> {
  try {
    const response = await fetch(JOBTRACKER_PROFILE_URL);
    if (!response.ok) return false;
    const remote = (await response.json()) as RemoteProfile;

    const baseName = remote.targetProfileName || JOBTRACKER_PROFILE_NAME;
    const storageKey = remote.targetProfileName
      ? `${TARGET_PROFILE_ID_KEY_PREFIX}${remote.targetProfileName}`
      : JOBTRACKER_PROFILE_ID_KEY;
    const profileId = await getOrCreateNamedProfileId(baseName, storageKey);

    const local = await getProfile(profileId);
    await saveProfile(mergeProfiles(local, remote), profileId);

    const targetName = displayNameFor(baseName, remote.profileLabel);
    const current = (await listProfiles()).find((entry) => entry.id === profileId);
    if (current && current.name !== targetName) {
      await renameProfile(profileId, targetName);
    }

    return true;
  } catch {
    return false;
  }
}
