import { chromium, test as base, type BrowserContext, type Worker } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type ExtensionFixtures = {
  context: BrowserContext;
  extensionWorker: Worker;
  extensionId: string;
};

export const test = base.extend<ExtensionFixtures>({
  context: async ({ headless }, use) => {
    const extensionPath = path.resolve('.');
    const userDataDir = await mkdtemp(path.join(tmpdir(), 'job-autofill-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless,
      // See e2e/launch-ats.mjs for why --window-size + viewport: null are paired here: without
      // them, native <select> popups can mismeasure and render oversized/mispositioned in headed
      // automated sessions (--headed / e2e:headed).
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--window-size=1280,900',
      ],
      viewport: null,
    });
    await use(context);
    await context.close();
  },

  extensionWorker: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker);
  },

  extensionId: async ({ extensionWorker }, use) => {
    await use(new URL(extensionWorker.url()).host);
  },
});

export const expect = test.expect;
