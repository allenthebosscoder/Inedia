import { createProfile, deleteProfile, getProfile, listProfiles, renameProfile, saveProfile, setActiveProfile } from '../storage/profile-store';
import { serializeProfile, populateForm } from './profile-form';
import {
  parseWorkHistory,
  renderWorkHistoryEntry,
  parseEducation,
  renderEducationEntry,
  parseOverrides,
  renderOverrideRow,
} from './profile-lists';
import { Profile } from '../storage/profile-schema';
import { US_STATES } from '../fill-engine/us-states';

/**
 * Converts a "data:<mime>;base64,<data>" URL into a Blob. Chrome blocks
 * script-initiated window.open() navigation directly to a data: URL (it's
 * silently refused as a top-level navigation), so previewing a stored
 * resume has to go through a blob: URL instead, which isn't restricted the
 * same way.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(',', 2);
  const mimeMatch = /^data:([^;]+);base64$/.exec(header);
  const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

async function main(): Promise<void> {
  const form = document.getElementById('profile-form') as HTMLFormElement;
  const workHistoryList = document.getElementById('work-history-list')!;
  const educationList = document.getElementById('education-list')!;
  const overridesList = document.getElementById('overrides-list')!;
  const profileSummaries = await listProfiles();
  const activeSummary = profileSummaries.find((entry) => entry.active) ?? profileSummaries[0];
  const activeProfileId = activeSummary.id;
  const profileSelector = document.getElementById('profile-selector')!;
  profileSummaries.forEach((entry) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'selected-profile';
    input.value = entry.id;
    input.checked = entry.id === activeProfileId;
    label.append(input, document.createTextNode(` ${entry.name}`));
    profileSelector.appendChild(label);
  });
  (document.getElementById('delete-profile') as HTMLButtonElement).disabled = profileSummaries.length === 1;
  profileSelector.addEventListener('change', async (event) => {
    const selected = event.target as HTMLInputElement;
    if (!selected.matches('input[type="radio"]')) return;
    await setActiveProfile(selected.value);
    location.reload();
  });
  const profile = await getProfile();
  let selectedResume = profile.resume;
  const resumeInput = document.getElementById('resume-file') as HTMLInputElement;
  const resumeStatus = document.getElementById('resume-file-status')!;
  const previewResumeButton = document.getElementById('preview-resume') as HTMLButtonElement;
  const updateResumeStatus = (message: string): void => {
    resumeStatus.textContent = message;
    previewResumeButton.disabled = !selectedResume;
  };
  updateResumeStatus(selectedResume ? `Saved: ${selectedResume.name}` : 'No resume saved.');

  resumeInput.addEventListener('change', async () => {
    const file = resumeInput.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      resumeInput.value = '';
      updateResumeStatus('Resume must be 5 MB or smaller.');
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result)));
      reader.addEventListener('error', () => reject(reader.error));
      reader.readAsDataURL(file);
    });
    selectedResume = { name: file.name, type: file.type || 'application/octet-stream', dataUrl };
    updateResumeStatus(`Selected: ${file.name}. Click Save to keep it.`);
  });

  previewResumeButton.addEventListener('click', () => {
    if (!selectedResume) return;
    const blobUrl = URL.createObjectURL(dataUrlToBlob(selectedResume.dataUrl));
    window.open(blobUrl, '_blank');
    // Give the new tab a moment to actually load the blob before revoking it —
    // revoking immediately can race the tab's fetch of the URL.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
  });

  const stateSelect = form.elements.namedItem('personal.state') as HTMLSelectElement;
  US_STATES.forEach(({ abbreviation, name }) => {
    const option = document.createElement('option');
    option.value = abbreviation;
    option.textContent = name;
    stateSelect.appendChild(option);
  });

  populateForm(form, profile);
  profile.workHistory.forEach((entry) => workHistoryList.appendChild(renderWorkHistoryEntry(entry)));
  profile.education.forEach((entry) => educationList.appendChild(renderEducationEntry(entry)));
  Object.entries(profile.overrides).forEach(([label, fieldKey]) =>
    overridesList.appendChild(renderOverrideRow(label, fieldKey))
  );

  const collectProfile = (): Profile => serializeProfile(form, {
    ...profile,
    resume: selectedResume,
    workHistory: parseWorkHistory(workHistoryList),
    education: parseEducation(educationList),
    overrides: parseOverrides(overridesList),
  });
  document.getElementById('create-profile')!.addEventListener('click', async () => {
    const nameInput = document.getElementById('new-profile-name') as HTMLInputElement;
    await createProfile(nameInput.value, collectProfile());
    location.reload();
  });
  document.getElementById('rename-profile')!.addEventListener('click', async () => {
    const name = window.prompt('Rename this profile to:', activeSummary.name);
    if (name === null) return;
    await renameProfile(activeProfileId, name);
    location.reload();
  });
  document.getElementById('delete-profile')!.addEventListener('click', async () => {
    await deleteProfile(activeProfileId);
    location.reload();
  });
  const transferStatus = document.getElementById('profile-transfer-status')!;

  document.getElementById('export-profile')!.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(collectProfile(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'job-autofill-profile.json';
    link.click();
    URL.revokeObjectURL(url);
    transferStatus.textContent = 'Profile exported. Resume data is included.';
  });

  document.getElementById('import-profile')!.addEventListener('change', async (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text()) as Partial<Profile>;
      if (imported.version !== 1 || !imported.personal || !Array.isArray(imported.workHistory) || !Array.isArray(imported.education)) {
        throw new Error('Invalid profile shape');
      }
      await saveProfile(imported as Profile, activeProfileId);
      transferStatus.textContent = 'Profile imported. Reloading…';
      location.reload();
    } catch {
      input.value = '';
      transferStatus.textContent = 'Could not import that profile file.';
    }
  });

  document.getElementById('add-work-entry')!.addEventListener('click', () => {
    workHistoryList.appendChild(
      renderWorkHistoryEntry({ company: '', title: '', location: '', startDate: '', endDate: '', currentlyWorksHere: false, description: '' })
    );
  });

  document.getElementById('add-education-entry')!.addEventListener('click', () => {
    educationList.appendChild(
      renderEducationEntry({ school: '', degree: '', fieldOfStudy: '', graduationDate: '', startYear: '', endYear: '', gpa: '' })
    );
  });

  document.getElementById('add-override')!.addEventListener('click', () => {
    overridesList.appendChild(renderOverrideRow());
  });

  workHistoryList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.matches('[data-remove]')) {
      target.closest('[data-work-entry]')?.remove();
    }
  });

  educationList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.matches('[data-remove]')) {
      target.closest('[data-education-entry]')?.remove();
    }
  });

  overridesList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.matches('[data-remove]')) {
      target.closest('[data-override-row]')?.remove();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveProfile(collectProfile(), activeProfileId);
    document.getElementById('save-status')!.textContent = 'Saved.';
  });
}

main().catch((error) => {
  console.error('Failed to initialize options page:', error);
});
