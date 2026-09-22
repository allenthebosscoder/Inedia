export function isBrowserProtectedPage(rawUrl?: string): boolean {
  // Confirmed live: clicking the toolbar icon on Chrome's own New Tab Page reports tab.url as
  // empty/undefined rather than its real chrome:// address — Chrome deliberately withholds it from
  // every extension there (it can show your most-visited sites), even with activeTab access. A
  // missing URL was previously treated as "safe, go ahead and inject" — the opposite of what Chrome
  // not telling you the URL actually means — so this silently tried and failed to inject into the
  // New Tab Page instead of correctly falling back to opening the options page. Assume the
  // conservative case when the URL is unknown, not the permissive one.
  if (!rawUrl) return true;
  try {
    const url = new URL(rawUrl);
    if (['chrome:', 'chrome-extension:', 'edge:', 'about:', 'devtools:', 'view-source:'].includes(url.protocol)) {
      return true;
    }
    return url.hostname === 'chromewebstore.google.com' ||
      (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'));
  } catch {
    return false;
  }
}
