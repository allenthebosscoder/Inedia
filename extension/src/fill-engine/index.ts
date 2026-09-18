import { getProfile } from '../storage/profile-store';
import { pickAdapter } from './site-detector';
import { ADAPTERS } from './adapter-registry';
import { fillFields, uploadResumeToDropZones } from './fill-engine';
import { fillComboboxFields } from './combobox-fill';
import { normalize } from './synonym-dictionary';
import { FillSummary } from './types';
import { FieldDescriptor } from './types';
import { fillWorkdayCompositeProfileDate, fillWorkdayRepeatableSections, prepareNextWorkdayRepeatableRow } from './workday-repeatable-fill';
import { Profile } from '../storage/profile-schema';
import { fillIcimsForm } from './icims-form-fill';
import { fillSmartRecruitersForm } from './smartrecruiters-fill';
import { fillWorkableForm } from './workable-fill';
import { fillOracleForm } from './oracle-fill';
import { fillOracleRepeatableSections } from './oracle-repeatable-fill';
import { fillGreenhouseForm } from './greenhouse-fill';
import { fillAdpForm } from './adp-fill';
import { fillAdpRecruitingForm } from './adp-recruiting-fill';
import { fillWorkdayProfileQuestions } from './workday-profile-fill';
import { commitPendingWorkdayTextFields, fillWorkdayTextFields } from './workday-text-fill';
import { fillUltiProForm, ULTIPRO_HOST_PATTERN } from './ultipro-fill';
import { fillAppleForm } from './apple-fill';
import { SUCCESSFACTORS_HOST_PATTERN, expandSuccessFactorsSections, flagSuccessFactorsAttachments } from './successfactors-fill';
import { fillIndexedExperienceDescriptions } from './indexed-experience-fill';
import { dumpPageDiagnostics } from './page-diagnostics';
import { isCancelled, resetCancellation } from './cancellation';

function applyOverrides(fields: FieldDescriptor[], overrides: Record<string, FieldDescriptor['profileKey']>): void {
  for (const field of fields) {
    const key = normalize(field.label);
    const overrideKey = Object.hasOwn(overrides, key) ? overrides[key] : undefined;
    if (overrideKey) field.profileKey = overrideKey;
  }
}

export async function runWithProfile(
  profile: Profile,
  options: {
    skipResume?: boolean;
    workdayCheckboxSettleMs?: number;
    /** Skill -> Workday catalogue label mappings discovered on a previous run (see
     * src/storage/workday-skill-catalog-cache.ts). Passed in by background.ts, which persists
     * whatever this run adds to it back to chrome.storage.local afterward. */
    skillCatalogCache?: Record<string, string>;
  } = {}
): Promise<FillSummary> {
  const adapter = pickAdapter(location.hostname, ADAPTERS);
  resetCancellation();
  (window as unknown as { __jobAutofillWdTrace?: unknown[] }).__jobAutofillWdTrace = [];
  (window as unknown as { __jobAutofillSkillsTrace?: unknown[] }).__jobAutofillSkillsTrace = [];
  (window as unknown as { __jobAutofillFlaggedSkills?: string[] }).__jobAutofillFlaggedSkills = [];
  // A local mutable copy: fillComboboxFields both reads known labels from this and writes newly
  // discovered ones into it, and exposing the same object on window lets background.ts read back
  // exactly what changed once the run finishes, to persist for next time.
  const skillCatalogCache: Record<string, string> = { ...(options.skillCatalogCache ?? {}) };
  (window as unknown as { __jobAutofillSkillCatalogCache?: Record<string, string> })
    .__jobAutofillSkillCatalogCache = skillCatalogCache;
  // eslint-disable-next-line no-console
  console.log(`[autofill] engine running on ${location.href} (adapter: ${adapter.id}, frame: ${window.top === window.self ? 'top' : 'iframe'})`);
  const appleSummary = adapter.id === 'apple'
    ? await fillAppleForm(profile)
    : { filled: 0, flagged: 0 };
  const greenhouseSummary = adapter.id === 'greenhouse'
    ? await fillGreenhouseForm(profile)
    : { filled: 0, flagged: 0 };
  const adpSummary = adapter.id === 'adp'
    ? await fillAdpForm(profile)
    : { filled: 0, flagged: 0 };
  const adpRecruitingSummary = adapter.id === 'adp-recruiting'
    ? await fillAdpRecruitingForm(profile)
    : { filled: 0, flagged: 0 };
  const ultiProSummary = ULTIPRO_HOST_PATTERN.test(location.hostname)
    ? await fillUltiProForm(profile)
    : { filled: 0, flagged: 0 };
  const icimsSummary = /\.icims\.com$/i.test(location.hostname)
    ? fillIcimsForm(profile)
    : { filled: 0, flagged: 0 };
  const smartRecruitersSummary = adapter.id === 'smartrecruiters'
    ? await fillSmartRecruitersForm(profile)
    : { filled: 0, flagged: 0 };
  const workableSummary = /(^|\.)workable\.com$/i.test(location.hostname)
    ? await fillWorkableForm(profile)
    : { filled: 0, flagged: 0 };
  const oracleSummary = adapter.id === 'oracle'
    ? await fillOracleForm(profile)
    : { filled: 0, flagged: 0 };
  const oracleRepeatableSummary = adapter.id === 'oracle'
    ? await fillOracleRepeatableSections(profile)
    : { filled: 0, flagged: 0 };
  const resumeDropSummary = options.skipResume ? { filled: 0, flagged: 0 } : uploadResumeToDropZones(profile);
  const repeatableSummary = adapter.id === 'workday'
    ? await fillWorkdayRepeatableSections(profile, { requireVisibleExperienceStep: true }).catch((error) => {
        // A single misbehaving repeatable step must not abort the whole run (and the diagnostics).
        // eslint-disable-next-line no-console
        console.error('[autofill] workday repeatable fill threw:', error);
        return { filled: 0, flagged: 0 } as FillSummary;
      })
    : { filled: 0, flagged: 0 };
  const workdayProfileQuestionSummary = adapter.id === 'workday'
    ? await fillWorkdayProfileQuestions(profile)
    : { filled: 0, flagged: 0 };
  if (SUCCESSFACTORS_HOST_PATTERN.test(location.hostname) && expandSuccessFactorsSections()) {
    // Expanding is a synchronous class/attribute toggle, not an XHR, but give its CSS transition
    // and any dependent width/layout recalculation a moment to settle before extracting fields.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const fields = adapter.extractFields(document);
  applyOverrides(fields, profile.overrides);

  const countryFields = fields.filter(
    (field) => field.kind === 'combobox' && field.profileKey === 'personal.country'
  );
  let comboboxFields = fields.filter(
    (field) => field.kind === 'combobox' && field.profileKey !== 'personal.country'
  );
  const workdayStartDateFields = adapter.id === 'workday'
    ? fields.filter((field) =>
        field.profileKey === 'jobPreferences.availableStartDate' &&
        /dateSection(?:Month|Day|Year)-input$/.test(field.element.id)
      )
    : [];
  const workdayStartDateSummary = await fillWorkdayCompositeProfileDate(
    workdayStartDateFields.map((field) => field.element),
    profile.jobPreferences.availableStartDate
  );
  const workdaySignatureDateFields = adapter.id === 'workday'
    ? fields.filter((field) => /selfIdentifiedDisabilityData--dateSignedOn-dateSection(?:Month|Day|Year)-input$/.test(field.element.id))
    : [];
  const today = new Date();
  const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const workdaySignatureDateSummary = await fillWorkdayCompositeProfileDate(
    workdaySignatureDateFields.map((field) => field.element),
    localToday
  );
  const workdayStartDateElements = new Set(workdayStartDateFields.map((field) => field.element));
  const workdaySignatureDateElements = new Set(workdaySignatureDateFields.map((field) => field.element));
  const otherFields = fields.filter((field) =>
    field.kind !== 'combobox' &&
    !workdayStartDateElements.has(field.element) &&
    !workdaySignatureDateElements.has(field.element)
  );

  const workdayTextResult = adapter.id === 'workday'
    ? await fillWorkdayTextFields(otherFields, profile)
    : { summary: { filled: 0, flagged: 0 }, handled: new Set<HTMLElement>(), pending: [] };
  const genericFields = otherFields.filter((field) => !workdayTextResult.handled.has(field.element));
  const syncSummary = fillFields(genericFields, profile, { browserEditing: adapter.id === 'workday' });

  // Committing a native <select> Country makes an SPA (Phenom/SuccessFactors, Oracle, ...) re-render
  // and repopulate the dependent State select, detaching the node fillFields just wrote to (its
  // stale copy keeps the value, so a field-descriptor check can't see the loss). When the page has
  // both a Country and a State <select>, always re-extract once and retry any address <select> that
  // is empty in the LIVE DOM.
  let addressRetrySummary: FillSummary = { filled: 0, flagged: 0 };
  const hasCountrySelect = genericFields.some(
    (field) => field.profileKey === 'personal.country' && field.element instanceof HTMLSelectElement
  );
  const hasStateSelect = genericFields.some(
    (field) => field.profileKey === 'personal.state' && field.element instanceof HTMLSelectElement
  );
  const liveStateSelect = (): HTMLSelectElement | undefined => {
    const field = adapter.extractFields(document).find(
      (candidate) =>
        candidate.profileKey === 'personal.state' &&
        candidate.element instanceof HTMLSelectElement &&
        candidate.element.isConnected
    );
    return field?.element as HTMLSelectElement | undefined;
  };
  if (hasCountrySelect && hasStateSelect) {
    let live = liveStateSelect();
    if (live && !live.value) {
      // Phenom/SuccessFactors fetches the State picklist async after Country commits (~2-3s), and
      // only then swaps in the real <option>s. Poll until the list arrives before retrying.
      for (let attempt = 0; attempt < 16; attempt++) {
        if (!live || live.value || live.options.length > 2) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
        live = liveStateSelect();
      }
      const refreshed = adapter.extractFields(document);
      applyOverrides(refreshed, profile.overrides);
      const pending = refreshed.filter(
        (field) =>
          ['personal.state', 'personal.country', 'personal.city', 'personal.zip'].includes(field.profileKey ?? '') &&
          field.element instanceof HTMLSelectElement &&
          field.element.isConnected &&
          !field.element.value
      );
      addressRetrySummary = fillFields(pending, profile);
    }
  }

  const countrySummary = await fillComboboxFields(countryFields, profile);

  if (countryFields.length > 0) {
    // Selecting Country can replace State/Province and other address controls. Re-extract after
    // Country commits so this run operates on Workday's new elements instead of detached ones.
    const refreshedFields = adapter.extractFields(document);
    applyOverrides(refreshedFields, profile.overrides);
    comboboxFields = refreshedFields.filter(
      (field) => field.kind === 'combobox' && field.profileKey !== 'personal.country'
    );
  }

  const comboboxSummary = await fillComboboxFields(comboboxFields, profile, { skillCatalogCache });

  // Workday can reveal dependent questions only after a preceding dropdown commits (for example,
  // a restricted-country subset after U.S.-person status, or J-1/J-2 history after sponsorship).
  // Rescan once and process only newly mounted questionnaire IDs, avoiding repeated passes over
  // the rest of the page.
  let workdayDependentQuestionSummary: FillSummary = { filled: 0, flagged: 0 };
  if (adapter.id === 'workday') {
    const processedQuestionIds = new Set(
      comboboxFields
        .map((field) => field.element.id)
        .filter((id) => id.startsWith('primaryQuestionnaire--'))
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const refreshedFields = adapter.extractFields(document);
    applyOverrides(refreshedFields, profile.overrides);
    const dependentQuestions = refreshedFields.filter((field) =>
      field.kind === 'combobox' &&
      field.element.id.startsWith('primaryQuestionnaire--') &&
      !processedQuestionIds.has(field.element.id)
    );
    workdayDependentQuestionSummary = await fillComboboxFields(dependentQuestions, profile);
  }

  if (adapter.id === 'workday') {
    await commitPendingWorkdayTextFields(workdayTextResult.pending);
  }

  if (adapter.id === 'workday' && otherFields.some((field) => field.kind === 'checkbox' && field.profileKey)) {
    // Some tenants apply a pending page render shortly after Self Identify mounts. The first
    // disability click looks successful, then that render restores every checkbox to unchecked.
    // Retry only mapped checkbox groups after the render settles; keep the original summary so a
    // successful stabilization never double-counts the same answer.
    await new Promise((resolve) => setTimeout(resolve, options.workdayCheckboxSettleMs ?? 500));
    const refreshedFields = adapter.extractFields(document);
    applyOverrides(refreshedFields, profile.overrides);
    const mappedCheckboxes = refreshedFields.filter((field) => field.kind === 'checkbox' && field.profileKey);
    fillFields(mappedCheckboxes, profile, { browserEditing: true });
  }

  document.querySelectorAll<HTMLElement>('[data-autofill-flag="needs-input"]').forEach((element) => {
    if (element instanceof HTMLInputElement && element.type === 'radio' && element.name) {
      const group = Array.from(document.querySelectorAll<HTMLInputElement>(
        `input[type="radio"][name="${CSS.escape(element.name)}"]`
      ));
      if (group.some((option) => option.checked)) {
        group.forEach((option) => {
          delete option.dataset.autofillFlag;
          option.style.outline = '';
        });
        return;
      }
    }
    const satisfied = element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)
      ? element.checked
      : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
        ? Boolean(element.value.trim())
        : Boolean((element.textContent || '').trim()) && !/^select one$/i.test((element.textContent || '').trim());
    if (satisfied) {
      delete element.dataset.autofillFlag;
      element.style.outline = '';
    }
  });

  // Applied last, not right after expanding sections: SAP's own form framework re-renders this
  // section's DOM in response to later field changes made by the rest of this run (confirmed live
  // — an earlier attempt applied the flag right after expanding sections and it was gone by the
  // time the run finished, exactly the same class of bug as Workday's disability-checkbox rollback
  // elsewhere in this file). Applying it after everything else has already happened is the only
  // way it can survive to when the applicant actually sees the page.
  const successFactorsAttachmentSummary = {
    filled: 0,
    flagged: SUCCESSFACTORS_HOST_PATTERN.test(location.hostname) ? flagSuccessFactorsAttachments() : 0,
  };
  // Self-gating (an empty match on any other site) rather than hostname-scoped: the array-indexed
  // "experienceData[N]." id convention it looks for is what identifies this shape of ATS, not
  // Activision specifically — the same platform may power other employers' career sites too.
  const indexedExperienceSummary = fillIndexedExperienceDescriptions(profile);

  const flaggedSkills = (window as unknown as { __jobAutofillFlaggedSkills?: string[] }).__jobAutofillFlaggedSkills;

  const total: FillSummary = {
    filled: appleSummary.filled + greenhouseSummary.filled + adpSummary.filled + adpRecruitingSummary.filled + ultiProSummary.filled + icimsSummary.filled + smartRecruitersSummary.filled + workableSummary.filled + oracleSummary.filled + oracleRepeatableSummary.filled + resumeDropSummary.filled + repeatableSummary.filled + workdayProfileQuestionSummary.filled + workdayStartDateSummary.filled + workdaySignatureDateSummary.filled + workdayTextResult.summary.filled + syncSummary.filled + addressRetrySummary.filled + countrySummary.filled + comboboxSummary.filled + workdayDependentQuestionSummary.filled + successFactorsAttachmentSummary.filled + indexedExperienceSummary.filled,
    flagged: appleSummary.flagged + greenhouseSummary.flagged + adpSummary.flagged + adpRecruitingSummary.flagged + ultiProSummary.flagged + icimsSummary.flagged + smartRecruitersSummary.flagged + workableSummary.flagged + oracleSummary.flagged + oracleRepeatableSummary.flagged + resumeDropSummary.flagged + repeatableSummary.flagged + workdayProfileQuestionSummary.flagged + workdayStartDateSummary.flagged + workdaySignatureDateSummary.flagged + workdayTextResult.summary.flagged + syncSummary.flagged + addressRetrySummary.flagged + countrySummary.flagged + comboboxSummary.flagged + workdayDependentQuestionSummary.flagged + successFactorsAttachmentSummary.flagged + indexedExperienceSummary.flagged,
    ...(flaggedSkills && flaggedSkills.length ? { flaggedSkills } : {}),
  };

  // Bring-up instrumentation: always on iCIMS and Phenom career sites (unsupported repeatable
  // steps), plus any other page where the run filled and flagged nothing despite a real form
  // being present — so the gap can be read from one run instead of a saved-HTML round trip.
  const visibleFormControls = document.querySelectorAll(
    'input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea'
  ).length;
  const isPhenom = Boolean(
    (window as unknown as { phApp?: unknown }).phApp ||
    document.querySelector('script[src*="phenompeople.com"], script[src*="phenomapptrack"], form.rjsf')
  );
  const embeddedGreenhouse = Boolean(
    document.querySelector('#grnhse_app, form#application-form, [id^="job_application"], script[src*="greenhouse.io/embed"]')
  );
  if (
    /(^|\.)(icims\.com|greenhouse\.io|lever\.co|myworkdayjobs\.com|myworkday\.com|ashbyhq\.com)$/i.test(location.hostname) ||
    isPhenom ||
    embeddedGreenhouse ||
    adapter.id === 'workday' ||
    // Nothing filled and nothing flagged despite a form, or a lot of fields left needing input.
    (visibleFormControls >= 4 && (total.filled + total.flagged === 0 || total.flagged >= 3))
  ) {
    dumpPageDiagnostics(profile, total);
  }

  return total;
}

export function uploadResumeWithProfile(profile: Profile): FillSummary {
  const adapter = pickAdapter(location.hostname, ADAPTERS);
  const dropSummary = uploadResumeToDropZones(profile);
  const fileFields = adapter.extractFields(document).filter((field) => field.kind === 'file');
  applyOverrides(fileFields, profile.overrides);
  const inputSummary = fillFields(fileFields, profile, { browserEditing: adapter.id === 'workday' });
  return {
    filled: dropSummary.filled + inputSummary.filled,
    flagged: dropSummary.flagged + inputSummary.flagged,
  };
}

export async function run(): Promise<FillSummary> {
  return runWithProfile(await getProfile());
}

(window as unknown as Record<string, unknown>).__jobAutofillRun = run;
(window as unknown as Record<string, unknown>).__jobAutofillRunWithProfile = runWithProfile;
(window as unknown as Record<string, unknown>).__jobAutofillUploadResumeWithProfile = uploadResumeWithProfile;
(window as unknown as Record<string, unknown>).__jobAutofillPrepareWorkdayRepeatables = prepareNextWorkdayRepeatableRow;
(window as unknown as Record<string, unknown>).__jobAutofillFillOracleRepeatables = fillOracleRepeatableSections;
