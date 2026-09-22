import { describe, expect, it } from 'vitest';
import { isBrowserProtectedPage } from '../src/browser-protected-page';

describe('isBrowserProtectedPage', () => {
  it('identifies browser-owned pages and the Chrome Web Store', () => {
    expect(isBrowserProtectedPage('chrome://extensions/')).toBe(true);
    expect(isBrowserProtectedPage('chrome-extension://abc/dist/options.html')).toBe(true);
    expect(isBrowserProtectedPage('https://chromewebstore.google.com/detail/example/abc')).toBe(true);
    expect(isBrowserProtectedPage('https://chrome.google.com/webstore/detail/example/abc')).toBe(true);
  });

  it('keeps regular recognized and unrecognized websites eligible for the widget', () => {
    expect(isBrowserProtectedPage('https://example.com/anything')).toBe(false);
    expect(isBrowserProtectedPage('https://tenant.wd5.myworkdayjobs.com/job/apply')).toBe(false);
  });

  it('treats a missing url as protected rather than assuming it is safe to inject', () => {
    // Confirmed live: clicking the toolbar icon on Chrome's own New Tab Page reports tab.url as
    // empty/undefined (Chrome deliberately withholds the real address there, even with activeTab
    // access) - the opposite of "safe, unrecognized site" that an empty url used to be treated as,
    // which made the icon silently do nothing there instead of falling back to the options page.
    expect(isBrowserProtectedPage(undefined)).toBe(true);
    expect(isBrowserProtectedPage('')).toBe(true);
  });
});
