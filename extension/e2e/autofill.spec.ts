import { test, expect } from './extension.fixture';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';

test('loads the real extension and fills a representative application page', async ({
  context,
  extensionWorker,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4173/application');

  const profile = {
    ...DEFAULT_PROFILE,
    personal: { ...DEFAULT_PROFILE.personal, firstName: 'Jorge' },
    jobPreferences: {
      ...DEFAULT_PROFILE.jobPreferences,
      minimumSalary: '85000',
      usCitizen: 'yes' as const,
      willingToRelocate: 'yes' as const,
    },
  };

  await extensionWorker.evaluate(async (savedProfile) => {
    await chrome.storage.local.set({ profile: savedProfile });
  }, profile);

  // Chrome tab IDs are not Playwright page indices, so resolve the application tab by URL from
  // the extension service worker before injecting the production fill engine.
  const tabId = await extensionWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:4173/*' });
    return tabs[0]?.id;
  });
  expect(tabId).toBeTruthy();
  await extensionWorker.evaluate(async ({ resolvedTabId, injectedProfile }) => {
    await chrome.scripting.executeScript({ target: { tabId: resolvedTabId! }, files: ['dist/fill-engine.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({
      target: { tabId: resolvedTabId! }, world: 'MAIN', args: [injectedProfile],
      func: async (value) => {
        await (window as unknown as { __jobAutofillRunWithProfile: (profile: typeof value) => Promise<unknown> })
          .__jobAutofillRunWithProfile(value);
      },
    });
  }, { resolvedTabId: tabId, injectedProfile: profile });

  await expect(page.locator('#first-name')).toHaveValue('Jorge');
  await expect(page.locator('#citizen')).toHaveValue('yes');
  await expect(page.locator('#salary')).toHaveValue('85000');
  await expect(page.locator('#relocate')).toHaveValue('yes');
  await expect(page.locator('#manual')).toHaveValue('');
  await expect(page.locator('#manual')).toHaveAttribute('data-autofill-flag', 'needs-input');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/dist/popup.html`);
  await expect(popup.locator('#fill-button')).toHaveText('Autofill this page');
});
