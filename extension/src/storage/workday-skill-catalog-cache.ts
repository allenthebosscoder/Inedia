// Workday's Skills Cloud catalogue often qualifies a skill with wording the profile doesn't use
// verbatim (searching "C" only ever returns "C (Programming Language)", "ANSI C", etc — never bare
// "C"). Once a search has found the real catalogue label for a given skill, remembering it lets
// every later run type that exact label straight away instead of re-discovering it by search each
// time — faster (an exact known label matches on the first response, no guessing) and more
// reliable (skips the ambiguity that caused misses in the first place). The catalogue itself is
// Workday's own shared ontology, not something each employer authors, so one cache serves every
// Workday tenant rather than needing to be kept separately per company site.

const STORAGE_KEY = 'workdaySkillCatalogCache';

export type SkillCatalogCache = Record<string, string>;

export async function getWorkdaySkillCatalogCache(): Promise<SkillCatalogCache> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const cache = result[STORAGE_KEY] as SkillCatalogCache | undefined;
  return cache ?? {};
}

// Merges rather than replaces: two frames/tabs can discover different skills in the same run, and
// this must never drop an earlier entry neither of them happened to rediscover this time.
export async function mergeWorkdaySkillCatalogCache(discovered: SkillCatalogCache): Promise<void> {
  if (Object.keys(discovered).length === 0) return;
  const existing = await getWorkdaySkillCatalogCache();
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...existing, ...discovered } });
}
