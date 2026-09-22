import { getProfile, listProfiles } from './storage/profile-store';
import { FillSummary } from './fill-engine/types';
import { Profile } from './storage/profile-schema';
import { isBrowserProtectedPage } from './browser-protected-page';
import { aggregateFrameSummaries } from './fill-engine/frame-summary';
import { selectAutofillFrameIds } from './autofill-frame-selection';
import type { InternationalFitSummary } from './international-fit-types';
import { syncProfileFromJobTracker } from './profile-sync';
import { getWorkdaySkillCatalogCache, mergeWorkdaySkillCatalogCache } from './storage/workday-skill-catalog-cache';

const PROFILE_SYNC_ALARM = 'syncProfileFromJobTracker';

// Keeps the active stored profile warm from JobTracker so RUN_AUTOFILL never
// has to wait on a network call: sync on startup, on a recurring alarm, and
// on navigation to a fresh page. JobTracker being offline is silent/expected.
chrome.alarms.create(PROFILE_SYNC_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PROFILE_SYNC_ALARM) void syncProfileFromJobTracker();
});
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) void syncProfileFromJobTracker();
});
void syncProfileFromJobTracker();

const visibilityKey = (tabId: number) => `autofillWidgetVisible:${tabId}`;
const selectedProfileKey = (tabId: number) => `autofillWidgetProfile:${tabId}`;
const activeRuns = new Map<number, { cancelled: boolean }>();

async function replaceStaleWidgetsAfterExtensionReload(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.allSettled(tabs.map(async (tab) => {
    if (typeof tab.id !== 'number') return;
    // Reloading an unpacked extension invalidates existing content-script contexts but leaves
    // their closed-shadow widget DOM behind. Reinjecting the widget removes that orphan (the
    // content entry does this before initialization) and restores a live runtime message channel.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['dist/content-widget.js'] });
  }));
}

chrome.runtime.onInstalled.addListener(() => {
  void replaceStaleWidgetsAfterExtensionReload();
});

async function applicationFrameIds(tabId: number, topHostname: string): Promise<number[]> {
  const browserFrames = await chrome.webNavigation.getAllFrames({ tabId });
  return selectAutofillFrameIds(browserFrames ?? [], topHostname);
}

async function injectEngine(tabId: number, frameIds: number[]): Promise<number[]> {
  const injected: number[] = [];
  for (const frameId of frameIds) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] }, files: ['dist/fill-engine.js'], world: 'MAIN',
      });
      injected.push(frameId);
    } catch {
      // The page may replace an application iframe while an upload or redirect is settling.
    }
  }
  return injected;
}

async function checkInternationalFitInFrames(
  tabId: number,
  frameIds: number[],
  clear: boolean
): Promise<InternationalFitSummary> {
  const summary: InternationalFitSummary = {
    restrictive: 0,
    supportive: 0,
    review: 0,
    total: 0,
    cleared: clear,
  };
  for (const frameId of frameIds) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ['dist/international-fit-check.js'],
        world: 'MAIN',
      });
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world: 'MAIN',
        args: [clear],
        func: (shouldClear: boolean) => window.__jobAutofillCheckInternationalFit?.({ clear: shouldClear }),
      });
      if (!result) continue;
      summary.restrictive += result.restrictive;
      summary.supportive += result.supportive;
      summary.review += result.review;
      summary.total += result.total;
    } catch {
      // Ignore inaccessible and transient frames while still checking the visible application.
    }
  }
  return summary;
}

async function runInFrames(
  tabId: number,
  frameIds: number[],
  profile: Profile,
  skipResume = false
): Promise<Array<{ result?: FillSummary }>> {
  const results: Array<{ result?: FillSummary }> = [];
  // Read once for the whole run rather than per frame: every frame should search with whatever's
  // already known, and none of them should be racing each other to persist their own discoveries
  // mid-run.
  const skillCatalogCache = await getWorkdaySkillCatalogCache();
  for (const frameId of frameIds) {
    try {
      const frameResults = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] }, world: 'MAIN', args: [profile, skipResume, skillCatalogCache],
        func: (injectedProfile: Profile, shouldSkipResume: boolean, cache: Record<string, string>) => {
          const runner = (
            window as unknown as {
              __jobAutofillRunWithProfile?: (
                profile: Profile,
                options?: { skipResume?: boolean; skillCatalogCache?: Record<string, string> }
              ) => Promise<FillSummary>
            }
          ).__jobAutofillRunWithProfile;
          return typeof runner === 'function'
            ? runner(injectedProfile, { skipResume: shouldSkipResume, skillCatalogCache: cache })
            : { filled: 0, flagged: 0 };
        },
      });
      results.push(...frameResults);
      try {
        // A small separate read rather than changing what runWithProfile returns: the primary
        // FillSummary contract (and every existing caller/aggregator of it) stays untouched, this
        // just also picks up whatever runWithProfile stashed on window as a side effect.
        const cacheResults = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] }, world: 'MAIN',
          func: () => (window as unknown as { __jobAutofillSkillCatalogCache?: Record<string, string> })
            .__jobAutofillSkillCatalogCache ?? {},
        });
        const discovered = cacheResults[0]?.result;
        if (discovered && Object.keys(discovered).length > 0) {
          await mergeWorkdaySkillCatalogCache(discovered);
        }
      } catch {
        // Losing a newly-discovered label just means re-discovering it next time — never worth
        // failing the fill over.
      }
    } catch {
      // Continue filling remaining application frames if one was replaced mid-run.
    }
  }
  return results;
}

async function uploadResumeInFrames(
  tabId: number,
  frameIds: number[],
  profile: Profile
): Promise<Array<{ result?: FillSummary }>> {
  const results: Array<{ result?: FillSummary }> = [];
  for (const frameId of frameIds) {
    try {
      const frameResults = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] }, world: 'MAIN', args: [profile],
        func: (injectedProfile: Profile) => {
          const uploader = (
            window as unknown as {
              __jobAutofillUploadResumeWithProfile?: (profile: Profile) => FillSummary
            }
          ).__jobAutofillUploadResumeWithProfile;
          return typeof uploader === 'function'
            ? uploader(injectedProfile)
            : { filled: 0, flagged: 0 };
        },
      });
      results.push(...frameResults);
    } catch {
      // The file change can immediately replace the frame after the synchronous upload returns.
    }
  }
  return results;
}

async function icimsResumeNeedsUpload(
  tabId: number,
  frameIds: number[],
  filename: string | undefined
): Promise<boolean> {
  if (!filename) return false;
  for (const frameId of frameIds) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] }, world: 'MAIN', args: [filename],
        func: (resumeName: string) => Boolean(
          document.querySelector('input[type="file"]') &&
          !document.body.textContent?.includes(resumeName)
        ),
      });
      if (result) return true;
    } catch {
      // Ignore non-form or transient frames.
    }
  }
  return false;
}

async function waitForIcimsResumeNavigation(
  tabId: number,
  topHostname: string,
  filename: string
): Promise<number[]> {
  // iCIMS submits and replaces its candidate iframe after a file-input change. Wait for the new
  // form to finish rendering, then return its fresh frame IDs for the profile-fill phase.
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const frameIds = await applicationFrameIds(tabId, topHostname);
    for (const frameId of frameIds) {
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] }, world: 'MAIN', args: [filename],
          func: (resumeName: string) =>
            document.readyState === 'complete' &&
            Boolean(document.body.textContent?.includes(resumeName)) &&
            document.querySelectorAll('input, select, textarea').length > 3,
        });
        if (result) return frameIds;
      } catch {
        // Keep polling while the candidate iframe is being replaced.
      }
    }
  }
  return applicationFrameIds(tabId, topHostname);
}

async function showWidget(tabId: number, profileId?: string): Promise<void> {
    await chrome.storage.session.set({
      [visibilityKey(tabId)]: true,
      ...(profileId ? { [selectedProfileKey(tabId)]: profileId } : {}),
    });
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'SHOW_AUTOFILL_WIDGET', tabId });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['dist/content-widget.js'] });
      await chrome.tabs.sendMessage(tabId, { type: 'SHOW_AUTOFILL_WIDGET', tabId });
    }
}

chrome.action.onClicked.addListener((tab) => {
  if (typeof tab.id !== 'number') return;
  if (isBrowserProtectedPage(tab.url)) {
    void chrome.runtime.openOptionsPage();
    return;
  }
  // This works on recognized and unrecognized regular web pages alike. Chrome itself forbids
  // extension injection on protected browser pages such as chrome:// URLs.
  void showWidget(tab.id).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message: { type?: string; profileId?: string; tabId?: number; clear?: boolean }, sender, sendResponse) => {
  if (message.type === 'OPEN_AUTOFILL_PROFILE') {
    void chrome.runtime.openOptionsPage();
    return;
  }
  if (message.type === 'SHOW_AUTOFILL_WIDGET' && typeof message.tabId === 'number') {
    void showWidget(message.tabId, message.profileId).then(() => sendResponse({ shown: true })).catch(() => sendResponse({ shown: false }));
    return true;
  }
  // An explicit target is used by the persistent widget and by trusted extension pages that
  // operate on a different application tab. Fall back to the sender for ordinary content-script
  // messages that do not name a target.
  const tabId = message.tabId ?? sender.tab?.id;
  if (!tabId) return;

  if (message.type === 'CANCEL_AUTOFILL') {
    const run = activeRuns.get(tabId);
    if (run) run.cancelled = true;
    // The fill engine runs as one long injected script in the page's MAIN world and cannot see
    // the background `cancelled` flag. Flip a window flag it polls between items so long loops
    // (Workday skills, repeatable rows) stop promptly.
    void chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => { (window as unknown as { __jobAutofillCancelled?: boolean }).__jobAutofillCancelled = true; },
    }).catch(() => undefined);
    sendResponse({ stopped: Boolean(run) });
    return;
  }

  if (message.type === 'GET_AUTOFILL_WIDGET_VISIBILITY') {
    void chrome.storage.session.get(visibilityKey(tabId)).then((result) =>
      sendResponse({ visible: Boolean(result[visibilityKey(tabId)]), tabId })
    );
    return true;
  }
  if (message.type === 'HIDE_AUTOFILL_WIDGET') {
    void chrome.storage.session.set({ [visibilityKey(tabId)]: false });
    return;
  }
  if (message.type === 'LIST_AUTOFILL_PROFILES') {
    void Promise.all([listProfiles(), chrome.storage.session.get(selectedProfileKey(tabId))]).then(([profiles, stored]) => {
      const selectedId = stored[selectedProfileKey(tabId)] as string | undefined;
      sendResponse(selectedId ? profiles.map((profile) => ({ ...profile, active: profile.id === selectedId })) : profiles);
    });
    return true;
  }
  if (message.type === 'SELECT_AUTOFILL_PROFILE') {
    if (!message.profileId) {
      sendResponse({ selected: false });
      return;
    }
    void chrome.storage.session.set({ [selectedProfileKey(tabId)]: message.profileId }).then(() =>
      sendResponse({ selected: true })
    ).catch(() => sendResponse({ selected: false }));
    return true;
  }
  if (message.type === 'CHECK_INTERNATIONAL_FIT') {
    void (async () => {
      const topTab = await chrome.tabs.get(tabId);
      const topHostname = topTab.url ? new URL(topTab.url).hostname : '';
      const frameIds = await applicationFrameIds(tabId, topHostname);
      if (!frameIds.length) throw new Error('Could not access this page.');
      return checkInternationalFitInFrames(tabId, frameIds, Boolean(message.clear));
    })().then((summary) => sendResponse({ summary })).catch((error) => {
      sendResponse({ error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  if (message.type === 'RUN_AUTOFILL') {
    if (activeRuns.has(tabId)) {
      sendResponse({ error: 'Autofill is already running on this tab.' });
      return;
    }
    void (async () => {
      const run = { cancelled: false };
      activeRuns.set(tabId, run);
      // The widget lives in the application page, so its selected profile must be remembered here.
      // Otherwise a navigation between iCIMS/Workday steps recreates the widget with the default
      // profile even though the user selected a different one on the preceding step.
      if (message.profileId) {
        await chrome.storage.session.set({ [selectedProfileKey(tabId)]: message.profileId });
      }
      const profile = await getProfile(message.profileId);
      const topTab = await chrome.tabs.get(tabId);
      const topHostname = topTab.url ? new URL(topTab.url).hostname : '';
      // iCIMS renders the actual form in a tenant iframe, often alongside advertising, chat,
      // captcha, and sandboxed frames. A single inaccessible frame can reject an `allFrames`
      // injection, so target only the top/same-host/iCIMS frames and tolerate detached frames.
      const candidateFrameIds = await applicationFrameIds(tabId, topHostname);
      const injectedFrameIds = await injectEngine(tabId, candidateFrameIds);
      if (!injectedFrameIds.length) throw new Error('Could not access the application form.');
      const isIcims = /\.icims\.com$/i.test(topHostname);
      const resumeNeedsUpload = isIcims && await icimsResumeNeedsUpload(
        tabId,
        injectedFrameIds,
        profile.resume?.name
      );
      const maximumAdds = profile.workHistory.length + profile.education.length;
      for (let attempt = 0; attempt < maximumAdds; attempt++) {
        if (run.cancelled) break;
        const additions = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN', args: [profile],
          func: (injectedProfile: Profile) => (
            window as unknown as {
              __jobAutofillPrepareWorkdayRepeatables: (profile: Profile) => boolean
            }
          ).__jobAutofillPrepareWorkdayRepeatables(injectedProfile),
        });
        if (!additions[0]?.result) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (run.cancelled) return { summary: undefined, stopped: true };
      const results: Array<{ result?: FillSummary }> = [];
      if (resumeNeedsUpload && profile.resume) {
        // Do not await the full fill routine in a frame that iCIMS is about to destroy. Attach the
        // file synchronously, wait for the replacement form, then perform one stable profile fill.
        results.push(...await uploadResumeInFrames(tabId, injectedFrameIds, profile));
        if (run.cancelled) return { summary: undefined, stopped: true };
        const freshFrameIds = await waitForIcimsResumeNavigation(tabId, topHostname, profile.resume.name);
        const freshInjectedFrameIds = await injectEngine(tabId, freshFrameIds);
        results.push(...await runInFrames(tabId, freshInjectedFrameIds, profile, true));
      } else {
        results.push(...await runInFrames(tabId, injectedFrameIds, profile));
      }
      const summary = aggregateFrameSummaries(results as Array<{ result?: FillSummary }>);
      return { summary, stopped: run.cancelled };
    })().then((result) => sendResponse(result)).catch((error) => {
      sendResponse({ error: error instanceof Error ? error.message : String(error) });
    }).finally(() => activeRuns.delete(tabId));
    return true;
  }
});
