import { chromium } from '@playwright/test';
import path from 'node:path';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const valueAfter = (name) => {
  const equals = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const requestedUrl = valueAfter('--url') || 'https://www.google.com/search?q=site%3Amyworkdayjobs.com+jobs';
const profilePath = valueAfter('--profile');
const allowSubmit = process.argv.includes('--allow-submit');
const canonicalWorkdayUrl = (value) => {
  try {
    const url = new URL(value);
    if (!/\.myworkdayjobs\.com$/i.test(url.hostname)) return value;
    url.pathname = url.pathname.replace(/(\/job\/.*?)\/apply(?:\/.*)?$/i, '$1');
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
};
const targetUrl = canonicalWorkdayUrl(requestedUrl);
const extensionPath = path.resolve('.');
const userDataDir = path.resolve('.playwright/ats-profile');
await mkdir(userDataDir, { recursive: true });

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: false,
  // Without an explicit window size, Chromium can pick a window/device-scale-factor combination
  // (seen on Retina displays) where native <select> popups mismeasure and render oversized and
  // mispositioned relative to their trigger. Pinning a concrete size avoids that miscalculation.
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--window-size=1280,900',
  ],
  viewport: null,
  downloadsPath: path.resolve('.playwright/downloads'),
});

let [extensionWorker] = context.serviceWorkers();
if (!extensionWorker) extensionWorker = await context.waitForEvent('serviceworker');
const currentExtensionWorker = async () => {
  const isUsable = async (worker) => {
    if (!worker || !context.serviceWorkers().includes(worker)) return false;
    return worker.evaluate(() => typeof chrome?.runtime?.id === 'string').catch(() => false);
  };
  if (!await isUsable(extensionWorker)) {
    extensionWorker = undefined;
    for (const candidate of [...context.serviceWorkers()].reverse()) {
      if (await isUsable(candidate)) {
        extensionWorker = candidate;
        break;
      }
    }
    if (!extensionWorker) {
      do {
        extensionWorker = await context.waitForEvent('serviceworker');
      } while (!await isUsable(extensionWorker));
    }
  }
  return extensionWorker;
};

// Chromium can reuse a cached MV3 service worker for an unpacked extension even when dist files
// changed between test sessions. Force one runtime reload so browser QA always exercises the
// bundle that was built immediately before this launcher started.
await extensionWorker.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
await new Promise((resolve) => setTimeout(resolve, 500));
extensionWorker = undefined;
await currentExtensionWorker();

if (profilePath) {
  const importedProfile = JSON.parse(await readFile(path.resolve(profilePath), 'utf8'));
  await (await currentExtensionWorker()).evaluate(async (profile) => chrome.storage.local.set({ profile }), importedProfile);
  console.log(`Imported extension profile from ${path.resolve(profilePath)}`);
}

if (!allowSubmit) await context.addInitScript(() => {
  const isFinalSubmission = (target) => {
    const control = target instanceof Element ? target.closest('button, input[type="submit"], [role="button"]') : null;
    const text = `${control?.textContent || ''} ${control?.getAttribute('value') || ''}`.replace(/\s+/g, ' ').trim();
    return /^(submit|submit application|complete application|finish application|apply now)$/i.test(text);
  };
  document.addEventListener('click', (event) => {
    if (!isFinalSubmission(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.alert('Blocked by the Job Autofill test harness: final application submission is disabled.');
  }, true);
  document.addEventListener('submit', (event) => {
    if (!isFinalSubmission(event.submitter)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
});

const pages = context.pages();
const page = pages[0] || await context.newPage();

const runAutotest = async () => {
  const worker = await currentExtensionWorker();
  const activeTab = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id && tab.url ? { id: tab.id, url: tab.url } : undefined;
  });
  const applicationPages = context.pages().filter((candidate) =>
    /^https?:/.test(candidate.url()) && !/google\.com\/search/.test(candidate.url())
  );
  const applicationPage = applicationPages.find((candidate) => candidate.url() === activeTab?.url) ??
    applicationPages.at(-1);
  if (!applicationPage) throw new Error('No application page is open in the automation browser.');
  const reportDir = path.resolve('.playwright/reports');
  await mkdir(reportDir, { recursive: true });
  await applicationPage.screenshot({ path: path.join(reportDir, 'before.png'), fullPage: true });

  const tabId = activeTab?.url === applicationPage.url() ? activeTab.id : await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === url)?.id;
  }, applicationPage.url());
  if (!tabId) throw new Error('Could not associate the application page with a Chrome tab.');

  const responseResults = await worker.evaluate(async (targetTabId) => chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: () => chrome.runtime.sendMessage({ type: 'RUN_AUTOFILL' }),
  }), tabId);
  const response = responseResults[0]?.result;
  if (response?.error) throw new Error(response.error);
  const summary = response?.summary;

  await applicationPage.waitForTimeout(500);
  const diagnostics = await applicationPage.evaluate(() => {
    const describe = (element) => ({
      tag: element.tagName,
      id: element.id,
      name: element.getAttribute('name'),
      label: element.getAttribute('aria-label') ||
        (element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent?.trim() : null),
      value: 'value' in element ? element.value : element.textContent?.trim(),
    });
    const flagged = Array.from(document.querySelectorAll('[data-autofill-flag="needs-input"]')).map(describe);
    const siteErrors = Array.from(document.querySelectorAll('[data-automation-id="inputAlert"], [role="alert"]'))
      .map((element) => element.textContent?.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const emptyRequired = Array.from(document.querySelectorAll('input[required], textarea[required], select[required], [aria-required="true"]'))
      .filter((element) => {
        if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) return false;
        if (
          element.matches('fieldset, [role="group"]') &&
          element.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked')
        ) return false;
        return !('value' in element) || !String(element.value).trim();
      }).map(describe);
    return { title: document.title, url: location.href, flagged, siteErrors, emptyRequired };
  });
  await applicationPage.screenshot({ path: path.join(reportDir, 'after.png'), fullPage: true });
  const report = { createdAt: new Date().toISOString(), summary, ...diagnostics };
  await writeFile(path.join(reportDir, 'latest.json'), JSON.stringify(report, null, 2));
  return report;
};

const controlToken = randomUUID();
const controlServer = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.headers.authorization !== `Bearer ${controlToken}`) {
    response.statusCode = 403;
    response.end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/autotest') {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  try {
    response.end(JSON.stringify(await runAutotest()));
  } catch (error) {
    response.statusCode = 500;
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});
await new Promise((resolve, reject) => {
  controlServer.once('error', reject);
  controlServer.listen(0, '127.0.0.1', resolve);
});
const controlAddress = controlServer.address();
if (!controlAddress || typeof controlAddress === 'string') throw new Error('Could not start the local automation control channel.');
const controlFile = path.resolve('.playwright/control.json');
await writeFile(controlFile, JSON.stringify({ port: controlAddress.port, token: controlToken }));
await chmod(controlFile, 0o600);

await page.goto(targetUrl);
const workdayFailed = async () => /something went wrong/i.test(await page.locator('body').innerText().catch(() => ''));
if (await workdayFailed()) {
  console.log('Workday returned its temporary error page; refreshing once.');
  await page.reload({ waitUntil: 'domcontentloaded' });
}
if (await workdayFailed()) {
  console.log('Workday still rejected this URL. Open the public job posting in this browser and click Apply instead of reusing an in-progress /apply URL.');
}
console.log(`Automation browser ready at ${targetUrl}`);
console.log(`Persistent test profile: ${userDataDir}`);
console.log(`Local automation control ready on port ${controlAddress.port}`);
console.log(allowSubmit
  ? 'Close the browser window to end the session. Manual final submission is enabled.'
  : 'Close the browser window to end the session. Final submission buttons are blocked; restart with --allow-submit to enable manual submission.');

await new Promise((resolve) => context.on('close', resolve));
controlServer.close();
await unlink(controlFile).catch(() => undefined);
