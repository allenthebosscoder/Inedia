import { formatSummary, detectAdapterId } from './popup-logic';
import { FillSummary } from '../fill-engine/types';
import { listProfiles } from '../storage/profile-store';

async function main(): Promise<void> {
  const siteLabel = document.getElementById('site-label')!;
  const statusEl = document.getElementById('status')!;

  const activeTab = async (): Promise<chrome.tabs.Tab | undefined> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  };

  const updateSiteLabel = async (): Promise<void> => {
    const tab = await activeTab();
    const hostname = tab?.url ? new URL(tab.url).hostname : '';
    siteLabel.textContent = `Detected: ${detectAdapterId(hostname)}`;
  };

  try {
    await updateSiteLabel();
    const profileChoices = document.getElementById('profile-choices') ?? document.createElement('div');
    void listProfiles().then((profiles) => profiles.forEach((profile) => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio'; input.name = 'popup-profile'; input.value = profile.id; input.checked = profile.active;
        label.append(input, document.createTextNode(profile.name));
        profileChoices.appendChild(label);
      })
    );
    chrome.tabs.onUpdated?.addListener((_tabId, changeInfo, tab) => {
      if (changeInfo.url) void updateSiteLabel();
    });

    const fillButton = document.getElementById('fill-button') as HTMLButtonElement;
    let filling = false;
    fillButton.addEventListener('click', async () => {
      const tab = await activeTab();
      if (!tab?.id) return;
      if (filling) {
        statusEl.textContent = 'Stopping…';
        await chrome.runtime.sendMessage({ type: 'CANCEL_AUTOFILL', tabId: tab.id }).catch(() => undefined);
        return;
      }
      filling = true;
      fillButton.textContent = 'Stop autofill';
      statusEl.textContent = 'Filling…';

      try {
        const profileId = profileChoices.querySelector<HTMLInputElement>('input:checked')?.value;
        if (chrome.runtime?.sendMessage) {
          await chrome.runtime.sendMessage({ type: 'SHOW_AUTOFILL_WIDGET', tabId: tab.id, profileId });
        }
        const response = await chrome.runtime.sendMessage({ type: 'RUN_AUTOFILL', tabId: tab.id, profileId }) as {
          summary?: FillSummary; stopped?: boolean; error?: string;
        };
        if (response.stopped) {
          statusEl.textContent = 'Autofill stopped.';
          return;
        }
        const result = response.summary;
        if (!result) {
          statusEl.textContent = 'Autofill failed: this page could not be filled.';
          return;
        }

        statusEl.textContent = formatSummary(result);
      } catch (error) {
        statusEl.textContent = 'Autofill failed: this page could not be filled.';
      } finally {
        filling = false;
        fillButton.textContent = 'Autofill this page';
      }
    });
  } catch (error) {
    siteLabel.textContent = 'Unable to detect this page.';
    statusEl.textContent = 'Something went wrong. Try reloading the page.';
  }
}

main().catch(() => {
  const siteLabel = document.getElementById('site-label');
  const statusEl = document.getElementById('status');
  if (siteLabel) siteLabel.textContent = 'Unable to detect this page.';
  if (statusEl) statusEl.textContent = 'Something went wrong. Try reloading the page.';
});
