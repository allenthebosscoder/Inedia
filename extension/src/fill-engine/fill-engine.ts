import { Profile } from '../storage/profile-schema';
import { matchesWholeWord, normalize } from './synonym-dictionary';
import { expandStateAbbreviation } from './us-states';
import { FieldDescriptor, FillSummary } from './types';
import { COMPANY_WEBSITE_SOURCE, findCompanyWebsiteSourceIndex, isSourceQuestion } from './source-answer';

export function setNativeValue(element: HTMLElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function valueForField(field: FieldDescriptor, value: string): string {
  if (field.profileKey !== 'jobPreferences.availableStartDate') return value;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  const id = field.element.id;
  if (id.includes('dateSectionMonth-input')) return String(Number(match[2]));
  if (id.includes('dateSectionDay-input')) return String(Number(match[3]));
  if (id.includes('dateSectionYear-input')) return match[1];
  if (/_Month$/i.test(id)) return match[2];
  if (/(?:_Date|_Day)$/i.test(id)) return String(Number(match[3]));
  if (/_Year$/i.test(id)) return match[1];
  return value;
}

export function flagField(element: HTMLElement): void {
  element.style.outline = '2px solid #f5a623';
  element.dataset.autofillFlag = 'needs-input';
}

function storedResumeFile(profile: Profile): File | null {
  const stored = profile.resume;
  if (!stored) return null;
  const commaIndex = stored.dataUrl.indexOf(',');
  if (commaIndex === -1) return null;
  const metadata = stored.dataUrl.slice(0, commaIndex);
  const payload = stored.dataUrl.slice(commaIndex + 1);
  const binary = metadata.includes(';base64') ? atob(payload) : decodeURIComponent(payload);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new File([bytes], stored.name, { type: stored.type });
}

// Greenhouse's newer layout labels the resume file input just "Attach". Recognise it by id/name,
// nearby heading text, or (as a last resort) a document-only file input that is the only one on
// the page.
// Greenhouse's newer file field ("Attach / Dropbox / Enter manually") manages upload state inside
// a React component that throws ("...reading 'uploadFile'") when a FileList is set on the hidden
// input directly. Only a real click on "Attach" works, so leave it for the applicant.
function isUnsettableUploadWidget(input: HTMLInputElement): boolean {
  const container = input.closest('div, fieldset, section');
  const text = (container?.textContent ?? '').toLowerCase();
  return /\bdropbox\b/.test(text) && /enter manually/.test(text);
}

function looksLikeResumeInput(input: HTMLInputElement, label: string): boolean {
  const labelledById = input.getAttribute('aria-labelledby');
  const nearby = input.closest('fieldset, [class*="field" i], div')
    ?.querySelector('label, legend, h1, h2, h3, h4')?.textContent ?? '';
  const hay = normalize([
    label,
    input.id,
    input.name,
    input.getAttribute('aria-label') ?? '',
    labelledById ? document.getElementById(labelledById)?.textContent ?? '' : '',
    nearby,
  ].join(' '));
  // A clear cover-letter (or other attachment) signal always wins, even if some other check below
  // would otherwise say "resume" — confirmed live: a Greenhouse embed with separate Resume and
  // Cover Letter uploads sent the resume into the cover letter slot. Greenhouse's newer layout
  // labels both file inputs just "Attach", so field.label alone doesn't distinguish them, and
  // `closest('div')`'s nearby-heading lookup is not scoped tightly enough to guarantee it only ever
  // finds *this* input's own heading rather than a sibling upload's. Checking the input's own
  // id/name first (Greenhouse's own markup uses literal ids like "cover_letter") catches this
  // before the looser signals below get a chance to.
  if (/\b(cover[\s_-]?letter|coverletter)\b/.test(normalize([input.id, input.name].join(' ')))) return false;
  if (/\b(resume|resume cv|curriculum vitae|cv)\b/.test(hay) && !/\bcover[\s_-]?letter\b/.test(hay)) return true;
  const accept = (input.accept || '').toLowerCase();
  const documentOnly = /pdf|\.doc|\.txt|\.rtf|word/.test(accept) && !/image|\.png|\.jpe?g/.test(accept);
  return documentOnly && document.querySelectorAll('input[type="file"]').length === 1;
}

export function attachStoredResume(input: HTMLInputElement, profile: Profile): boolean {
  const file = storedResumeFile(profile);
  if (!file) return false;
  // File inputs are cleared after most ATS upload flows. The rendered attachment name is the
  // reliable signal that the resume is already present; attaching again can create duplicates.
  if (document.body.textContent?.includes(file.name)) {
    return true;
  }

  if (typeof DataTransfer !== 'undefined') {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
  } else {
    // jsdom and a few older browser environments lack DataTransfer construction. The browser
    // path above is preferred; this fallback keeps the property shape testable.
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  }
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  delete input.dataset.autofillFlag;
  input.style.outline = '';
  return true;
}

function transferForFile(file: File): DataTransfer | { files: File[]; items: File[]; types: string[] } {
  if (typeof DataTransfer !== 'undefined') {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    return transfer;
  }
  return { files: [file], items: [file], types: ['Files'] };
}

export function uploadResumeToDropZones(profile: Profile, root: ParentNode = document): FillSummary {
  const file = storedResumeFile(profile);
  if (!file) return { filled: 0, flagged: 0 };

  // Workday normally provides this hidden input alongside its drop zone. Prefer direct FileList
  // assignment; its onDrop implementation expects private drag-library state and throws when a
  // synthetic drop lacks that state. The generic field pass will attach the resume to this input.
  if (root.querySelector('input[data-automation-id="file-upload-input-ref"][type="file"]')) {
    return { filled: 0, flagged: 0 };
  }

  const zones = Array.from(
    root.querySelectorAll<HTMLElement>('[data-automation-id="file-upload-drop-zone"]')
  ).filter((zone) => {
    const button = zone.querySelector<HTMLElement>('button');
    const metadata = `${button?.id ?? ''} ${button?.getAttribute('data-automation-id') ?? ''} ${zone.textContent ?? ''}`;
    return /resume|curriculum.?vitae|\bcv\b/i.test(metadata);
  });

  let filled = 0;
  for (const zone of zones) {
    const transfer = transferForFile(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: transfer });
      zone.dispatchEvent(event);
    }
    zone.dataset.jobAutofillResumeUploaded = 'true';
    filled++;
  }
  return { filled, flagged: 0 };
}

function formatPay(raw: string): string {
  const n = Number((raw.match(/[\d.,]+/)?.[0] ?? '').replace(/,/g, ''));
  if (!n || Number.isNaN(n)) return raw.trim();
  return n < 2000 ? `$${n}` : `$${n.toLocaleString('en-US')}`;
}

export function resolveProfileValue(profile: Profile, key: string): string | null {
  if (key === 'personal.fullName') {
    const fullName = [profile.personal.firstName, profile.personal.middleName, profile.personal.lastName]
      .filter(Boolean).join(' ').trim();
    return fullName.length > 0 ? fullName : null;
  }
  if (key === 'jobPreferences.compensationRange') {
    const min = profile.jobPreferences.minimumSalary?.trim() ?? '';
    const max = profile.jobPreferences.compensationMax?.trim() ?? '';
    if (!min && !max) return null;
    if (!max || max === min) return formatPay(min || max);
    const low = Number((min.match(/[\d.,]+/)?.[0] ?? '').replace(/,/g, ''));
    const unit = low && low < 2000 ? ' per hour' : ' per year';
    return `${formatPay(min)} - ${formatPay(max)}${unit}`;
  }
  // Confirmed on SuccessFactors and Activision's career site: a single School/Degree/Field of
  // Study/GPA prompt outside any repeatable section, unlike Workday's fully-repeatable education.
  // The profile's own options UI treats the first entry as primary, so use it here too.
  if (key.startsWith('education.')) {
    const entry = profile.education[0];
    if (!entry) return null;
    const field = key.slice('education.'.length);
    if (field === 'school') return entry.school || null;
    if (field === 'degree') return entry.degree || null;
    if (field === 'fieldOfStudy') return entry.fieldOfStudy || null;
    if (field === 'gpa') return entry.gpa || null;
    return null;
  }
  const [section, field] = key.split('.') as [keyof Profile, string];
  const sectionValue = profile[section] as Record<string, unknown>;
  const value = sectionValue?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function resolveProfileValueForField(profile: Profile, field: FieldDescriptor): string | null {
  let value = field.profileKey ? resolveProfileValue(profile, field.profileKey) : null;
  if (!field.profileKey) {
    const normalizedLabel = normalize(field.label);
    if (
      matchesWholeWord(normalizedLabel, 'cumulative gpa') &&
      (matchesWholeWord(normalizedLabel, 'degree obtained') || matchesWholeWord(normalizedLabel, 'degree completed'))
    ) {
      const education = profile.education.find((entry) => entry.gpa?.trim() && entry.degree?.trim());
      if (education) return `${education.gpa!.trim()}, ${education.degree.trim()}`;
    }
    // GPA belongs to an education entry rather than a top-level profile field. Reuse it only for
    // an explicit college/overall GPA prompt; broad "grade" questions can refer to a course,
    // high school, grading scale, or another education entry and must remain manual.
    if (
      matchesWholeWord(normalizedLabel, 'college gpa') ||
      matchesWholeWord(normalizedLabel, 'overall gpa') ||
      matchesWholeWord(normalizedLabel, 'overall college gpa')
    ) {
      const gpa = profile.education.find((entry) => entry.gpa?.trim())?.gpa?.trim();
      return gpa || null;
    }
  }
  if (
    field.profileKey === 'workAuthorization.restrictedCountryStatus' &&
    normalize(value ?? '') === 'yes'
  ) {
    const normalizedLabel = normalize(field.label);
    // A saved Yes to the full profile list does not prove Yes to a narrower subset: the person
    // could match only Crimea, Donetsk, or Luhansk. A saved No is safe for every subset. Reuse Yes
    // only when the application asks the full list represented by the profile field.
    const asksFullSavedList = ['iran', 'cuba', 'north korea', 'syria', 'crimea', 'donetsk', 'luhansk']
      .every((country) => matchesWholeWord(normalizedLabel, country));
    if (!asksFullSavedList) return null;
  }
  if (
    field.profileKey === 'jobPreferences.availableStartDate' &&
    value &&
    /minimum lead time|commence (?:the )?(?:new )?role/i.test(field.label)
  ) {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      value = `Available ${date.toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
      })}`;
    }
  }
  return value;
}

export function buildCandidates(profileKey: string | null, value: string): string[] {
  if (profileKey === 'personal.phoneCountryCode' && normalize(value) === 'united states') {
    // Prefix the country with its dial code so an exact normalized match wins before territories
    // such as "United States Minor Outlying Islands", which also contain the shorter country name.
    return ['(+1) United States', 'United States (+1)', 'United States of America (+1)', value];
  }
  if (profileKey === 'personal.phoneType' && normalize(value) === 'mobile') {
    // Workday tenants use several labels for a mobile number. NVIDIA's tenant exposes only
    // "Home" and "Home Cellular", so prefer cellular wording over the landline option.
    return [value, 'Mobile', 'Cellular', 'Cell', 'Home Cellular'];
  }
  if (profileKey === 'personal.state') {
    return [value, expandStateAbbreviation(value)].filter((c): c is string => Boolean(c));
  }
  if (profileKey === 'professional.highestEducation') {
    const candidates: Record<string, string[]> = {
      high_school: [value, 'High School or equivalent', 'High School Diploma', 'High School'],
      some_college: [value, 'Some College'],
      associates: [value, 'Associate Degree', "Associate's Degree", 'Associates'],
      bachelors: [value, "Bachelor's Degree", 'Bachelor Degree', 'Bachelors'],
      masters: [value, "Master's Degree", 'Master Degree', 'Masters'],
      doctorate: [value, 'Doctorate', 'Doctoral Degree', 'PhD'],
    };
    return candidates[normalize(value)] ?? [value];
  }
  if (profileKey === 'personal.country' && normalize(value) === 'united states') {
    // Workday labels the intended country "United States of America" and may list
    // "United States Minor Outlying Islands" first. Prefer the exact canonical label so the
    // shorter profile value cannot select the territory through whole-word fallback matching.
    return ['United States of America', value];
  }
  if (profileKey === 'disclosures.veteranStatus') {
    const normalized = normalize(value);
    if (normalized.includes('classifications of protected veteran')) {
      return [
        value,
        'I identify as one or more of the classifications of a protected veteran',
        'I identify as one or more classifications of a protected veteran',
        'I identify as one or more of the classifications of protected veterans listed above',
        // iCIMS uses a compact Yes/No/Opt Out select for this same question.
        'Yes',
        // Some iCIMS veteran forms omit labels entirely and expose only these machine values.
        'ProtectedVeteran',
      ];
    }
    if (normalized.includes('veteran just not a protected veteran')) {
      return [value, 'I identify as a veteran, just not a protected veteran', 'No'];
    }
    if (normalized === 'i am not a veteran' || normalized === 'not a veteran') {
      // Some Workday tenants offer a precise non-veteran option while others collapse everyone
      // outside protected-veteran classifications into "not a protected veteran." Prefer the
      // precise answer and use the broader tenant wording only when it is unavailable.
      return [
        value,
        'I am not a veteran',
        'I am not a protected veteran',
        'No, I am not a protected veteran',
        'Not a protected veteran',
        'No',
        'NotProtectedVeteran',
      ];
    }
    if (normalized.includes('not wish to answer') || normalized.includes('prefer not')) {
      return [value, "I don't wish to answer", 'Decline to self-identify', 'Opt Out', 'optout'];
    }
  }
  if (profileKey === 'disclosures.hispanicOrLatino') {
    const normalized = normalize(value);
    if (normalized === 'no' || normalized.startsWith('not hispanic')) {
      return [value, 'Not Hispanic or Latino', 'Not Hispanic/Latino', 'No, not Hispanic or Latino'];
    }
    if (normalized === 'yes' || normalized === 'hispanic or latino') {
      return [value, 'Hispanic or Latino', 'Hispanic/Latino', 'Yes, Hispanic or Latino'];
    }
  }
  if (profileKey === 'jobPreferences.securityClearance' && normalize(value) === 'no') {
    return [value, 'None', 'No Clearance', 'I do not have a security clearance'];
  }
  if (profileKey === 'disclosures.disabilityStatus') {
    const normalized = normalize(value);
    // Test the negative wording first: the saved "No" answer still contains the phrase
    // "have a disability" later in the sentence ("do not have a disability").
    if (normalized.startsWith('no') || normalized.includes('do not have a disability')) {
      return [
        value,
        'I do not identify as having a disability or a reco',
        'No',
      ];
    }
    if (normalized.startsWith('yes') || normalized.includes('have a disability')) {
      return [
        value,
        // Some iCIMS tenants send truncated option values as well as truncated visible labels.
        'I identify as having a disability or a record of d',
        'Yes',
      ];
    }
    if (normalized.includes('not want to answer') || normalized.includes('not wish to answer') || normalized.includes('prefer not')) {
      return [value, 'Opt Out', 'Decline to self-identify'];
    }
  }
  return [value];
}

export function findMatchIndex(texts: string[], candidates: string[]): number | null {
  const normalizedTexts = texts.map(normalize);
  const normalizedCandidates = candidates.map(normalize);

  for (const candidate of normalizedCandidates) {
    const index = normalizedTexts.findIndex((text) => text === candidate);
    if (index !== -1) return index;
  }

  const byLengthDesc = [...normalizedCandidates].sort((a, b) => b.length - a.length);
  for (const candidate of byLengthDesc) {
    const index = normalizedTexts.findIndex((text) => matchesWholeWord(text, candidate));
    if (index !== -1) return index;
  }

  return null;
}

function selectOptionByText(select: HTMLSelectElement, candidates: string[]): boolean {
  const options = Array.from(select.options);
  const normalizedCandidates = candidates.map(normalize);
  const valueIndex = options.findIndex((option) => normalizedCandidates.includes(normalize(option.value)));
  if (valueIndex !== -1) {
    setNativeValue(select, options[valueIndex].value);
    return true;
  }
  const optionTexts = options.map((opt) => opt.textContent ?? '');
  const index = findMatchIndex(optionTexts, candidates);
  if (index === null) return false;
  setNativeValue(select, options[index].value);
  return true;
}

function salaryAmount(value: string): number | null {
  const compact = value.toLowerCase().replace(/[$,]/g, '').trim();
  const thousands = compact.match(/(\d+(?:\.\d+)?)\s*k\b/);
  if (thousands) return Number(thousands[1]) * 1000;
  const amount = compact.match(/\d+(?:\.\d+)?/);
  return amount ? Number(amount[0]) : null;
}

function selectSalaryRange(select: HTMLSelectElement, value: string): boolean {
  const desired = salaryAmount(value);
  if (desired === null) return false;
  const parsed = Array.from(select.options).map((option) => ({
    option,
    amounts: (option.textContent ?? '')
      .match(/\d[\d,]*/g)
      ?.map((amount) => Number(amount.replace(/,/g, '')))
      .filter(Number.isFinite) ?? [],
    plus: /\+/.test(option.textContent ?? ''),
  }));
  const plusMatch = parsed.find(({ amounts, plus }) => plus && amounts.length === 1 && desired >= amounts[0]);
  const rangeMatch = parsed.find(({ amounts, plus }) =>
    !plus && amounts.length >= 2 && desired >= amounts[0] && desired < amounts[1]
  );
  const match = plusMatch ?? rangeMatch;
  if (!match) return false;
  setNativeValue(select, match.option.value);
  return true;
}

function setBrowserEditedValue(element: HTMLElement, value: string): void {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    setNativeValue(element, value);
    return;
  }
  element.focus();
  element.select();
  // Workday questionnaire textareas can accept a prototype-set DOM value while retaining an
  // empty form-model value. insertText follows the browser's editing path and emits the same input
  // transaction as typing, so Save and Continue sees the answer instead of erasing it.
  const inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, value);
  if (!inserted || element.value !== value) setNativeValue(element, value);
  element.blur();
}

export function fillFields(
  fields: FieldDescriptor[],
  profile: Profile,
  options: { browserEditing?: boolean } = {}
): FillSummary {
  let filled = 0;
  let flagged = 0;
  const flaggedRadioGroups = new Set<string>();
  const filledRadioGroups = new Set<string>();
  const satisfiedUnsupportedRadioGroups = new Set<string>();
  const handledCheckboxGroups = new Set<string>();

  for (const field of fields) {
    const value = resolveProfileValueForField(profile, field);

    if (!field.profileKey && isSourceQuestion(field.label)) {
      if ((field.kind === 'text' || field.kind === 'textarea') &&
          (field.element instanceof HTMLInputElement || field.element instanceof HTMLTextAreaElement)) {
        if (!field.element.value.trim()) setNativeValue(field.element, COMPANY_WEBSITE_SOURCE);
        if (field.element.value.trim()) {
          delete field.element.dataset.autofillFlag;
          field.element.style.outline = '';
          filled++;
          continue;
        }
      }
      if (field.kind === 'select' && field.element instanceof HTMLSelectElement) {
        if (field.element.value) {
          delete field.element.dataset.autofillFlag;
          field.element.style.outline = '';
          continue;
        }
        const options = Array.from(field.element.options).filter((option) => option.value.trim());
        const match = findCompanyWebsiteSourceIndex(options.map((option) => option.textContent ?? ''));
        if (match !== null) {
          setNativeValue(field.element, options[match].value);
          filled++;
          continue;
        }
      }
    }

    if (
      (field.profileKey === 'personal.middleName' || field.profileKey === 'personal.addressLine2') &&
      !value &&
      !field.element.matches('[required], [aria-required="true"]') &&
      !/\*/.test(field.label)
    ) {
      // A mapped optional field that the user deliberately left blank is not missing input.
      // Examples include middle name and address line 2.
      delete field.element.dataset.autofillFlag;
      field.element.style.outline = '';
      continue;
    }

    if (field.kind === 'radio' && !field.profileKey && field.element instanceof HTMLInputElement) {
      const radio = field.element;
      const groupKey = radio.name || radio.id;
      if (satisfiedUnsupportedRadioGroups.has(groupKey)) continue;
      const group = radio.name
        ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(radio.name)}"]`))
        : [radio];
      if (group.some((option) => option.checked)) {
        group.forEach((option) => {
          delete option.dataset.autofillFlag;
          option.style.outline = '';
        });
        satisfiedUnsupportedRadioGroups.add(groupKey);
        continue;
      }
    }

    if (field.kind === 'checkbox' && !field.profileKey && field.element instanceof HTMLInputElement) {
      const checkbox = field.element;
      const fieldset = checkbox.closest('fieldset');
      const groupKey = checkbox.name || fieldset?.id || checkbox.id;
      if (handledCheckboxGroups.has(groupKey)) continue;
      const group = fieldset
        ? Array.from(fieldset.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
        : [checkbox];
      const required = checkbox.getAttribute('aria-required') === 'true' ||
        fieldset?.getAttribute('aria-required') === 'true' || /\*/.test(field.label);
      if (!required) {
        group.forEach((option) => {
          delete option.dataset.autofillFlag;
          option.style.outline = '';
        });
        continue;
      }
      if (group.some((option) => option.checked)) {
        group.forEach((option) => {
          delete option.dataset.autofillFlag;
          option.style.outline = '';
        });
      } else {
        group.forEach(flagField);
        flagged++;
      }
      handledCheckboxGroups.add(groupKey);
      continue;
    }

    if (!value && (
      field.element instanceof HTMLInputElement ||
      field.element instanceof HTMLTextAreaElement ||
      field.element instanceof HTMLSelectElement
    )) {
      const control = field.element;
      const hasExistingValue = control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type)
        ? control.checked
        : Boolean(control.value.trim());
      if (hasExistingValue) {
        delete control.dataset.autofillFlag;
        control.style.outline = '';
        continue;
      }
    }

    if (!field.profileKey && /\bif applicable\b/i.test(field.label)) {
      delete field.element.dataset.autofillFlag;
      field.element.style.outline = '';
      continue;
    }

    if (
      !field.profileKey &&
      /\b(?:phone|telephone)\s+extension\b/i.test(field.label) &&
      !field.element.matches('[required], [aria-required="true"]') &&
      !/\*/.test(field.label)
    ) {
      // A blank optional extension is a valid phone number. Never copy the applicant's main
      // number into it, and do not report it as missing unless the tenant explicitly requires it.
      delete field.element.dataset.autofillFlag;
      field.element.style.outline = '';
      continue;
    }

    if (field.kind === 'file' && field.element instanceof HTMLInputElement) {
      if (isUnsettableUploadWidget(field.element)) {
        // Can't attach programmatically; make sure the applicant does it by hand.
        if (!document.body.textContent?.includes(storedResumeFile(profile)?.name ?? ' ')) {
          flagField(field.element);
          flagged++;
        } else {
          delete field.element.dataset.autofillFlag;
          field.element.style.outline = '';
        }
      } else if (looksLikeResumeInput(field.element, field.label) && attachStoredResume(field.element, profile)) {
        filled++;
      } else if (
        field.element.required ||
        field.element.getAttribute('aria-required') === 'true' ||
        /\*/.test(field.label)
      ) {
        flagField(field.element);
        flagged++;
      } else {
        // Optional employer-specific attachments (cover letters, work samples, transcripts) are
        // not missing input when the profile has no matching stored document.
        delete field.element.dataset.autofillFlag;
        field.element.style.outline = '';
      }
      continue;
    }

    // Unsupported required checkbox groups are handled above. Remaining unmodeled checkboxes are
    // optional toggles (such as Workday's "I have a preferred name") and are not missing fields.
    if (field.kind === 'checkbox' && !field.profileKey) continue;

    if (value && field.kind === 'checkbox' && field.element instanceof HTMLInputElement) {
      const checkbox = field.element;
      const fieldset = checkbox.closest<HTMLElement>('fieldset, [role="group"]');
      const groupKey = checkbox.name || fieldset?.id || fieldset?.getAttribute('aria-labelledby') || checkbox.id;
      if (handledCheckboxGroups.has(groupKey)) continue;
      const group = fieldset
        ? Array.from(fieldset.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
        : [checkbox];
      const labels = group.map((option) =>
        document.querySelector(`label[for="${CSS.escape(option.id)}"]`)?.textContent ||
        option.closest('label')?.textContent || option.getAttribute('aria-label') || option.value
      );
      if (group.length === 1 && field.profileKey === 'disclosures.hispanicOrLatino') {
        const normalized = normalize(value);
        const shouldCheck = normalized === 'yes' || normalized === 'hispanic or latino';
        if (checkbox.checked !== shouldCheck) checkbox.click();
        delete checkbox.dataset.autofillFlag;
        checkbox.style.outline = '';
        handledCheckboxGroups.add(groupKey);
        filled++;
        continue;
      }
      const matchIndex = findMatchIndex(labels, buildCandidates(field.profileKey, value));
      if (matchIndex !== null) {
        group.forEach((option, index) => {
          if (option.checked !== (index === matchIndex)) option.click();
          delete option.dataset.autofillFlag;
          option.style.outline = '';
        });
        filled++;
      } else {
        group.forEach(flagField);
        flagged++;
      }
      handledCheckboxGroups.add(groupKey);
      continue;
    }

    if (value && field.kind === 'radio' && field.element instanceof HTMLInputElement) {
      const radio = field.element;
      const groupKey = radio.name || radio.id;
      if (filledRadioGroups.has(groupKey)) continue;
      const group = radio.name
        ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(radio.name)}"]`))
        : [radio];
      const candidates = buildCandidates(field.profileKey, value);
      const labels = group.map((option) =>
        document.querySelector(`label[for="${CSS.escape(option.id)}"]`)?.textContent ||
        option.closest('label')?.textContent || option.getAttribute('aria-label') || option.value
      );
      const matchIndex = findMatchIndex(labels, candidates);
      if (matchIndex !== null) {
        group[matchIndex].click();
        const liveGroup = radio.name
          ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(radio.name)}"]`))
          : group;
        [...group, ...liveGroup].forEach((option) => {
          delete option.dataset.autofillFlag;
          option.style.outline = '';
        });
        filledRadioGroups.add(groupKey);
        filled++;
      } else if (!flaggedRadioGroups.has(groupKey)) {
        group.forEach(flagField);
        flaggedRadioGroups.add(groupKey);
        flagged++;
      }
      continue;
    }

    if (value && (field.kind === 'text' || field.kind === 'textarea')) {
      const fieldValue = valueForField(field, value);
      if (options.browserEditing) setBrowserEditedValue(field.element, fieldValue);
      else setNativeValue(field.element, fieldValue);
      filled++;
    } else if (value && field.kind === 'select') {
      const select = field.element as HTMLSelectElement;
      const candidates = buildCandidates(field.profileKey, valueForField(field, value));
      if (
        (field.profileKey === 'jobPreferences.minimumSalary' && selectSalaryRange(select, value)) ||
        selectOptionByText(select, candidates)
      ) {
        filled++;
      } else {
        flagField(field.element);
        flagged++;
      }
    } else {
      flagField(field.element);
      if (field.kind === 'radio' && field.element instanceof HTMLInputElement && field.element.name) {
        // A radio question is represented by one input per answer choice. Flag every choice for
        // visibility, but report the shared name group as one question needing input.
        if (!flaggedRadioGroups.has(field.element.name)) {
          flaggedRadioGroups.add(field.element.name);
          flagged++;
        }
      } else {
        flagged++;
      }
    }
  }

  return { filled, flagged };
}
