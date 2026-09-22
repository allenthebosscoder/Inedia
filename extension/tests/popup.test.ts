import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';

const storage = {
  local: {
    get: vi.fn().mockResolvedValue({ profile: DEFAULT_PROFILE }),
    set: vi.fn().mockResolvedValue(undefined),
  },
};

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('popup main', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="site-label">Detecting site…</div>
      <button id="fill-button">Autofill this page</button>
      <div id="status"></div>
    `;
    vi.resetModules();
  });

  it('delegates autofill to the background multi-pass runner', async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ shown: true })
      .mockResolvedValueOnce({ summary: { filled: 1, flagged: 0 } });
    (globalThis as unknown as { chrome: unknown }).chrome = {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://example.com' }]) },
      runtime: { sendMessage },
      storage,
    };

    await import('../src/popup/popup');
    await flush();

    document.getElementById('fill-button')!.click();
    await flush();
    await flush();

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'RUN_AUTOFILL', tabId: 1 }));
    expect(document.getElementById('status')!.textContent).toBe('Filled 1 field, 0 need your input.');
  });

  it('shows a failure message in #status instead of hanging on "Filling…" when the runner rejects', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('cannot access this page'));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://example.com' }]) },
      runtime: { sendMessage },
      storage,
    };

    await import('../src/popup/popup');
    await flush();

    document.getElementById('fill-button')!.click();
    await flush();
    await flush();

    expect(document.getElementById('status')!.textContent).not.toBe('Filling…');
    expect(document.getElementById('status')!.textContent).toMatch(/failed/i);
  });

  it('handles a missing summary without throwing', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    (globalThis as unknown as { chrome: unknown }).chrome = {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://example.com' }]) },
      runtime: { sendMessage },
      storage,
    };

    await import('../src/popup/popup');
    await flush();

    document.getElementById('fill-button')!.click();
    await flush();
    await flush();

    expect(document.getElementById('status')!.textContent).toMatch(/failed/i);
  });

  it('shows a failure message instead of hanging on "Detecting site…" when tab detection throws', async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      tabs: { query: vi.fn().mockRejectedValue(new Error('no active tab')) },
      scripting: { executeScript: vi.fn() },
    };

    await import('../src/popup/popup');
    await flush();
    await flush();

    expect(document.getElementById('site-label')!.textContent).not.toBe('Detecting site…');
  });
});
