import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const valueAfter = (name) => {
  const equals = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const requestedUrl = valueAfter('--url') || 'https://www.google.com/search?q=jobs';
const targetUrl = new URL(requestedUrl);
if (!['http:', 'https:'].includes(targetUrl.protocol)) {
  throw new Error('The manual ATS launcher requires an http(s) URL.');
}

const extensionPath = path.resolve('.');
const userDataDir = path.resolve('.playwright/ats-profile');
await mkdir(userDataDir, { recursive: true });

// Launch the bundled Chrome binary directly instead of through Playwright. Authentication-heavy
// sites can reject Playwright because it exposes navigator.webdriver, even in a headed window.
const chromeArgs = [
  `--user-data-dir=${userDataDir}`,
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
  '--window-size=1280,900',
  '--no-first-run',
  '--no-default-browser-check',
  targetUrl.toString(),
];
const executablePath = chromium.executablePath();
const command = process.platform === 'darwin' ? '/usr/bin/open' : executablePath;
const commandArgs = process.platform === 'darwin'
  // The Playwright-bundled Chrome-for-Testing app exits when launched outside Playwright on some
  // macOS installations. Standard Chrome can use the same isolated profile without exposing
  // navigator.webdriver or touching the user's default Chrome profile.
  ? ['-na', '/Applications/Google Chrome.app', '--args', ...chromeArgs]
  : chromeArgs;
const browser = spawn(command, commandArgs, { stdio: 'inherit' });

console.log(`Manual ATS browser ready at ${targetUrl}`);
console.log(`Persistent test profile: ${userDataDir}`);
console.log('Playwright is not attached; use the extension UI to run autofill.');
console.log('Final submission is not blocked in manual mode.');

const exitCode = await new Promise((resolve, reject) => {
  browser.once('error', reject);
  browser.once('exit', (code) => resolve(code ?? 0));
});
process.exitCode = exitCode;
