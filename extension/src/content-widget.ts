import { formatSummary } from './popup/popup-logic';
import { FillSummary } from './fill-engine/types';
import type { ProfileSummary } from './storage/profile-store';
import type { InternationalFitSummary } from './international-fit-types';

const HOST_ID = 'job-autofill-control-host';
let widgetTabId: number | undefined;
// Reloading an unpacked extension invalidates the old content-script context but leaves its DOM
// behind. Remove that orphan before wiring a fresh widget so its button can message the new worker.
document.getElementById(HOST_ID)?.remove();

function ensureWidget(): HTMLElement {
  const existing = document.getElementById(HOST_ID);
  if (existing) return existing;
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;top:72px;right:16px;z-index:2147483647;display:none;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      .card{box-sizing:border-box;width:220px;padding:10px;border:1px solid #c7cdd4;border-radius:10px;background:#fff;box-shadow:0 4px 18px rgba(0,0,0,.2);font:13px/1.35 system-ui,sans-serif;color:#24292f}
      .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}.title{font-weight:650}.close{border:0;background:transparent;color:#59636e;font-size:18px;line-height:1;cursor:pointer;padding:0 2px}
      .profiles{display:flex;flex-wrap:wrap;gap:5px;margin:0 0 8px}.profileChoice{display:inline-flex;align-items:center;gap:3px;padding:4px 6px;border:1px solid #c7cdd4;border-radius:999px;background:#f6f8fa;cursor:pointer}.profileChoice input{margin:0}.fill,.check{box-sizing:border-box;width:100%;border:0;border-radius:7px;color:#fff;font-weight:650;padding:8px;cursor:pointer}.fill{background:#0875e1}.check{margin-top:7px;background:#435466}.fill:disabled,.check:disabled{opacity:.65;cursor:wait}
      .status,.fitStatus{min-height:18px;margin-top:7px;color:#4b5560}.fitStatus:empty{display:none}.key{display:inline-flex;align-items:center;gap:5px;margin-right:7px}.dot{width:8px;height:8px;border-radius:2px}.red{background:#d1242f}.green{background:#1a7f37}.yellow{background:#bf8700}.profile{display:inline-block;margin-top:4px;color:#0969da;text-decoration:none;cursor:pointer}
    </style>
    <div class="card"><div class="top"><span class="title">Job Autofill</span><button class="close" title="Close" aria-label="Close">×</button></div><div class="profiles" aria-label="Profile"></div><button class="fill">Autofill this page</button><div class="status" aria-live="polite"></div><button class="check">Check international fit</button><div class="fitStatus" aria-live="polite"></div><a class="profile" role="button" tabindex="0">Edit profiles</a></div>`;
  const profileChoices = shadow.querySelector<HTMLElement>('.profiles')!;
  void chrome.runtime.sendMessage({ type: 'LIST_AUTOFILL_PROFILES' }).then((profiles: ProfileSummary[]) => {
    profileChoices.replaceChildren(...profiles.map((profile) => {
      const label = document.createElement('label');
      label.className = 'profileChoice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'autofill-profile';
      input.value = profile.id;
      input.checked = profile.active;
      label.append(input, document.createTextNode(` ${profile.name}`));
      return label;
    }));
  });
  profileChoices.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'radio' || !input.checked) return;
    void chrome.runtime.sendMessage({
      type: 'SELECT_AUTOFILL_PROFILE',
      tabId: widgetTabId,
      profileId: input.value,
    }).catch(() => undefined);
  });
  const fillButton = shadow.querySelector<HTMLButtonElement>('.fill')!;
  const status = shadow.querySelector<HTMLElement>('.status')!;
  let filling = false;
  fillButton.addEventListener('click', async () => {
    if (filling) {
      status.textContent = 'Stopping…';
      await chrome.runtime.sendMessage({ type: 'CANCEL_AUTOFILL', tabId: widgetTabId }).catch(() => undefined);
      return;
    }
    filling = true;
    fillButton.textContent = 'Stop autofill';
    status.textContent = 'Filling…';
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'RUN_AUTOFILL',
        tabId: widgetTabId,
        profileId: profileChoices.querySelector<HTMLInputElement>('input:checked')?.value,
      }) as { summary?: FillSummary; stopped?: boolean; error?: string };
      status.textContent = response?.stopped ? 'Autofill stopped.'
        : response?.summary ? formatSummary(response.summary)
        : `Autofill failed${response?.error ? `: ${response.error}` : ' on this page.'}`;
    } catch (error) {
      status.textContent = `Autofill failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      filling = false;
      fillButton.textContent = 'Autofill this page';
    }
  });
  const checkButton = shadow.querySelector<HTMLButtonElement>('.check')!;
  const fitStatus = shadow.querySelector<HTMLElement>('.fitStatus')!;
  let fitHighlightsVisible = false;
  checkButton.addEventListener('click', async () => {
    checkButton.disabled = true;
    fitStatus.textContent = fitHighlightsVisible ? 'Clearing highlights…' : 'Checking job description…';
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CHECK_INTERNATIONAL_FIT',
        tabId: widgetTabId,
        clear: fitHighlightsVisible,
      }) as { summary?: InternationalFitSummary; error?: string };
      if (!response?.summary) {
        fitStatus.textContent = `Check failed${response?.error ? `: ${response.error}` : '.'}`;
        return;
      }
      if (fitHighlightsVisible) {
        fitHighlightsVisible = false;
        checkButton.textContent = 'Check international fit';
        fitStatus.textContent = 'Highlights cleared.';
      } else {
        const { restrictive, supportive, review, total } = response.summary;
        if (!total) {
          fitStatus.textContent = 'No sponsorship, visa, citizenship, or clearance wording found.';
          return;
        }
        fitHighlightsVisible = true;
        checkButton.textContent = 'Clear fit highlights';
        const parts = [
          restrictive ? `<span class="key"><i class="dot red"></i>${restrictive} restrictive</span>` : '',
          supportive ? `<span class="key"><i class="dot green"></i>${supportive} supportive</span>` : '',
          review ? `<span class="key"><i class="dot yellow"></i>${review} review</span>` : '',
        ].filter(Boolean);
        fitStatus.innerHTML = parts.join('');
      }
    } catch (error) {
      fitStatus.textContent = `Check failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      checkButton.disabled = false;
    }
  });
  shadow.querySelector('.close')!.addEventListener('click', () => {
    host.style.display = 'none';
    void chrome.runtime.sendMessage({ type: 'HIDE_AUTOFILL_WIDGET' });
  });
  shadow.querySelector('.profile')!.addEventListener('click', () => {
    void chrome.runtime.sendMessage({ type: 'OPEN_AUTOFILL_PROFILE' });
  });
  document.documentElement.appendChild(host);
  return host;
}

function showWidget(): void { ensureWidget().style.display = 'block'; }

chrome.runtime.onMessage.addListener((message: { type?: string; tabId?: number }) => {
  if (message.type === 'SHOW_AUTOFILL_WIDGET') {
    widgetTabId = message.tabId;
    showWidget();
  }
});
void chrome.runtime.sendMessage({ type: 'GET_AUTOFILL_WIDGET_VISIBILITY' }).then((state: boolean | { visible?: boolean; tabId?: number }) => {
  const visible = typeof state === 'boolean' ? state : Boolean(state?.visible);
  if (typeof state === 'object') widgetTabId = state?.tabId;
  if (visible) showWidget();
}).catch(() => undefined);
