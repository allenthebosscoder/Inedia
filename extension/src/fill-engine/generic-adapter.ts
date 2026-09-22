import { lookupFieldKey } from './synonym-dictionary';
import { Adapter, FieldDescriptor, FieldKind } from './types';
import { MONIKER_TRIGGER_SELECTOR, STANDARD_COMBOBOX_TRIGGER_SELECTOR } from './combobox-fill';

function resolveLabel(element: HTMLElement): string {
  let fallbackLabel = '';
  // Workable gives the hidden upload control an authoritative data-ui value. Its visible label
  // only says "Choose file", while nearby required employer attachments (such as Transcript)
  // use the same presentation. Resolve this before generic label heuristics so only Resume gets
  // the stored resume.
  if (
    element instanceof HTMLInputElement &&
    element.type === 'file' &&
    element.getAttribute('data-ui') === 'resume'
  ) {
    return 'Resume';
  }
  const rawMetadata = `${element.id} ${element.getAttribute('name') ?? ''} ${element.getAttribute('aria-labelledby') ?? ''}`;
  // Oracle Candidate Experience gives its phone-country grid the visible label "Phone Number".
  // Its stable ID is the only signal that this combobox owns the dialing code rather than the
  // adjacent national phone input.
  if (element instanceof HTMLInputElement && /^country-codes-dropdown/i.test(element.id)) {
    return 'Phone Country Code';
  }
  // Some Oracle/Phenom-style forms label the Hispanic/Latino control only "Ethnicity" and expose
  // Race as a separate adjacent control. Its stable EEO metadata is the only unambiguous signal;
  // without it the generic dictionary reasonably treats bare "Ethnicity" as race/ethnicity.
  if (/EEO2c[_\s-]*Ethnicity/i.test(rawMetadata)) return 'Hispanic or Latino';
  const id = element.getAttribute('id');
  const metadataLabel = `${element.getAttribute('name') ?? ''} ${id ?? ''}`
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Oracle Recruiting connects each native Yes/No input to the answer text, while the actual
  // question labels the enclosing radiogroup. Resolve that group before returning the explicit
  // answer label so recognized questions such as work authorization use the saved profile value.
  if (element instanceof HTMLInputElement && element.type === 'radio') {
    const group = element.closest<HTMLElement>('[role="radiogroup"], fieldset');
    const groupLabelledBy = group?.getAttribute('aria-labelledby');
    if (groupLabelledBy) {
      const text = groupLabelledBy
        .split(/\s+/)
        .map((labelId) => document.getElementById(labelId)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text && lookupFieldKey(text)) return text;
    }
  }

  // iCIMS radio labels describe the individual answer ("Yes"/"No"), while the stable group
  // name describes the question. Prefer recognized group metadata before the answer label.
  if (
    element instanceof HTMLInputElement &&
    element.type === 'radio' &&
    metadataLabel &&
    lookupFieldKey(metadataLabel)
  ) {
    return metadataLabel;
  }

  // Workday renders multi-select disclosures as one checkbox per answer. Each checkbox's own
  // label is an answer (for example "Asian (...)"), while the containing fieldset identifies
  // the profile question (for example personalInfoUS--ethnicityMulti). Resolve the group before
  // treating the answer label as authoritative so the engine can select the saved answer.
  if (element instanceof HTMLInputElement && element.type === 'checkbox') {
    const group = element.closest<HTMLElement>('fieldset, [role="group"]');
    const groupMetadata = `${group?.id ?? ''} ${group?.getAttribute('data-automation-id') ?? ''}`
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const groupMetadataKey = groupMetadata ? lookupFieldKey(groupMetadata) : null;
    if (groupMetadataKey?.startsWith('disclosures.')) return groupMetadata;
    const groupLabelledBy = group?.getAttribute('aria-labelledby');
    if (groupLabelledBy) {
      const text = groupLabelledBy
        .split(/\s+/)
        .map((labelId) => document.getElementById(labelId)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const groupLabelKey = text ? lookupFieldKey(text) : null;
      if (groupLabelKey?.startsWith('disclosures.')) return text;
    }
  }

  if (id) {
    const elementRoot = element.getRootNode();
    const labelRoot = elementRoot instanceof Document || elementRoot instanceof ShadowRoot
      ? elementRoot
      : document;
    const labelEl = labelRoot.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (labelEl?.textContent) {
      const text = labelEl.textContent.trim();
      // iCIMS compound dates label their three controls only Month, Day, and Year. The id/name
      // carries the actual prompt, such as DateAvailableToStart, and is the authoritative context.
      if (/^(?:month|day|date|year)$/i.test(text) && lookupFieldKey(metadataLabel)) {
        return metadataLabel;
      }
      // Liberty Mutual's iCIMS login form labels its phone-number input only "Number" while the
      // stable id/name are phoneNumber/css_phoneNumber. Use that unambiguous metadata rather than
      // treating a generic word as an unsupported field.
      if (!lookupFieldKey(text) && /^number$/i.test(text) && lookupFieldKey(metadataLabel)) {
        return metadataLabel;
      }
      // Workable's real Resume and employer-specific attachment inputs are hidden behind a
      // generic "Choose file" label. Keep looking through aria-labelledby/ancestors so the
      // resume receives the stored resume while a Transcript remains a distinct manual upload.
      if (
        element instanceof HTMLInputElement &&
        element.type === 'file' &&
        /^(?:attach|choose|select|browse|upload)(?:\s+(?:a\s+)?file)?$/i.test(text)
      ) {
        fallbackLabel ||= text;
      } else {
        // An explicit label belongs to this exact control and is authoritative even when the
        // profile does not model it. Continuing into ancestor heuristics can mistake a selected
        // value (for example "State of NC Career Website") for a different profile field.
        return text;
      }
    }
  }
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) {
    const text = ariaLabel.trim();
    if (lookupFieldKey(text)) return text;
    fallbackLabel ||= text;
  }
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const elementRoot = element.getRootNode();
    const labelRoot = elementRoot instanceof Document || elementRoot instanceof ShadowRoot
      ? elementRoot
      : document;
    const text = labelledBy
      .split(/\s+/)
      .map((labelId) => labelRoot.querySelector<HTMLElement>(`#${CSS.escape(labelId)}`)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) {
      if (lookupFieldKey(text)) return text;
      if (element instanceof HTMLInputElement && element.type === 'file' && !/choose\s+file/i.test(text)) {
        // The accessible heading is more specific than Workable's earlier generic chooser label.
        fallbackLabel = text;
      } else {
        fallbackLabel ||= text;
      }
    }
  }
  if (element instanceof HTMLInputElement && element.type === 'radio') {
    const group = element.closest<HTMLElement>('fieldset, [role="radiogroup"]');
    const groupLabelledBy = group?.getAttribute('aria-labelledby');
    if (groupLabelledBy) {
      const text = groupLabelledBy
        .split(/\s+/)
        .map((labelId) => document.getElementById(labelId)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text && lookupFieldKey(text)) return text;
    }
  }
  const closestLabel = element.closest('label');
  if (closestLabel?.textContent) {
    const text = closestLabel.textContent.trim();
    if (lookupFieldKey(text)) return text;
    fallbackLabel ||= text;
  }
  const placeholder = element.getAttribute('placeholder');
  if (placeholder) {
    const text = placeholder.trim();
    if (lookupFieldKey(text)) return text;
    fallbackLabel ||= text;
  }
  // Some Workday disclosure controls omit every accessible label even though their stable
  // id/name describes the question (for example, personalInfoUS--hispanicOrLatino). Treat that
  // metadata as a label only when the synonym dictionary recognizes it.
  if (metadataLabel && lookupFieldKey(metadataLabel)) return metadataLabel;
  if (fallbackLabel && element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
    return fallbackLabel;
  }
  if (element instanceof HTMLInputElement && element.type === 'file') {
    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && depth < 5; depth++, ancestor = ancestor.parentElement) {
      // Do not let a Resume heading elsewhere in the form relabel a nearby Cover Letter input.
      // File controls must be identified by their own local upload component.
      if (ancestor.matches('form, body, html')) break;
      const text = ancestor.textContent?.trim() ?? '';
      if (/\b(resume|curriculum vitae|cv)\b/i.test(text)) return text;
      const automationId = ancestor.getAttribute('data-automation-id') ?? '';
      if (/resume|curriculum.?vitae/i.test(automationId)) return 'Resume';
    }
    const ownMetadata = `${element.id} ${element.name} ${element.getAttribute('data-automation-id') ?? ''}`;
    if (/resume|curriculum.?vitae/i.test(ownMetadata)) return 'Resume';
    if (element.getAttribute('data-automation-id') === 'file-upload-input-ref') {
      // Workday renders its hidden input in a sibling branch from the visible Resume button, so
      // neither one's ancestors contain the other. When this is the sole Workday upload input,
      // associate it with the explicit resumeAttachments control elsewhere in the component.
      const workdayInputs = document.querySelectorAll('input[data-automation-id="file-upload-input-ref"]');
      if (workdayInputs.length === 1 && document.getElementById('resumeAttachments--attachments')) {
        return 'Resume';
      }
    }
  }

  // Workday questionnaire dropdowns are often wrapped by a fieldset whose legend contains the
  // full prompt. Export-control and sponsorship prompts can include long legal explanations, so
  // read the direct legend without applying the generic ancestor text-length limit below.
  const fieldset = element.closest('fieldset');
  const legend = fieldset?.querySelector<HTMLElement>(':scope > legend');
  if (legend) {
    const text = (legend.innerText || legend.textContent || '').replace(/\s+/g, ' ').trim();
    if (text && lookupFieldKey(text)) return text;
    // Workday questionnaire buttons expose only the generic aria-label "Select One Required".
    // The fieldset legend is the actual question and also carries its required asterisk. Return
    // it even when unsupported so the engine can accurately flag every unanswered question.
    if (text && /^(?:primary|secondary)Questionnaire--/.test(element.id)) return text;
  }

  // Workday questionnaire controls often place the question in a surrounding component instead
  // of connecting it with label[for] or aria-labelledby. Walk only the nearby component ancestry
  // and accept text when the synonym dictionary recognizes it. This avoids treating a whole form
  // section as one label while supporting tenant-generated question IDs that cannot be hardcoded.
  let ancestor = element.parentElement;
  for (let depth = 0; ancestor && depth < 7; depth++, ancestor = ancestor.parentElement) {
    if (ancestor.matches('form, body, html')) break;
    const text = (ancestor.innerText || ancestor.textContent || '').replace(/\s+/g, ' ').trim();
    const controlCount = ancestor.querySelectorAll('input, textarea, select, button[aria-haspopup="listbox"]').length;
    if (controlCount <= 3 && text.length > 0 && text.length <= 600 && lookupFieldKey(text)) return text;
  }
  return fallbackLabel;
}

function isIcimsNonApplicantField(element: HTMLElement): boolean {
  const metadata = `${element.id} ${element.getAttribute('name') ?? ''}`;
  return (
    /(?:^|\s)icims_\d+_(?:Ref\d*|Sup|Emp|School|Education|Degree|Major|GPA|Graduation)/i.test(metadata) ||
    /(?:^|\s)icims_\d+_PhoneExtension\b/i.test(metadata) ||
    (/\bicims_/i.test(metadata) &&
      /(?:employer|company|supervisor|reference|\bemp\b|\bsup\b|\bref\b).*phone|phone.*(?:employer|company|supervisor|reference|\bemp\b|\bsup\b|\bref\b)/i.test(
        metadata.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ')
      ))
  );
}

function isFillable(element: HTMLElement): boolean {
  const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (input.disabled) return false;
  if ('readOnly' in input && input.readOnly) return false;
  // React Select and similar controls render a hidden required-value proxy beside the actual
  // combobox. It is validation plumbing, not a user-editable field, and must never be counted or
  // outlined as needing input.
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if (element.hidden) return false;
  let node: HTMLElement | null = element;
  while (node) {
    if (node.style.display === 'none' || node.style.visibility === 'hidden') return false;
    const computed = window.getComputedStyle(node);
    if (computed.display === 'none' || computed.visibility === 'hidden') return false;
    node = node.parentElement;
  }
  return true;
}

function classifyKind(element: HTMLElement): FieldKind | null {
  if (element instanceof HTMLTextAreaElement) return 'textarea';
  if (element instanceof HTMLSelectElement) return 'select';
  if (element instanceof HTMLInputElement) {
    if (element.type === 'file') return 'file';
    if (element.type === 'radio') return 'radio';
    if (element.type === 'checkbox') return 'checkbox';
    if (['text', 'email', 'tel', 'url', 'number', 'date', ''].includes(element.type)) return 'text';
  }
  return null;
}

function isRepeatableWorkdayField(element: HTMLElement): boolean {
  let node: HTMLElement | null = element;
  while (node) {
    if (/^(workExperience|education)-.+--/.test(node.id)) return true;
    node = node.parentElement;
  }
  return false;
}

export function extractFields(root: ParentNode = document): FieldDescriptor[] {
  const elements = root.querySelectorAll('input, select, textarea');
  const fields: FieldDescriptor[] = [];

  elements.forEach((el) => {
    const element = el as HTMLElement;
    if (isIcimsNonApplicantField(element)) return;
    if (isRepeatableWorkdayField(element)) return;
    if (element.dataset.jobAutofillRepeatable === 'true') return;
    // Platform-specific passes mark controls they have already committed (or intentionally
    // classified as optional). Reprocessing those controls generically can overwrite a correct
    // answer or report a false missing-field warning.
    if (element.dataset.jobAutofillHandled === 'true') return;
    // iCIMS decorates ordinary native selects with role=combobox and aria-controls. They must stay
    // native `select` fields; treating them as custom popup triggers makes the engine search for a
    // separate listbox and leaves every option untouched.
    if (!(element instanceof HTMLSelectElement) && element.matches(STANDARD_COMBOBOX_TRIGGER_SELECTOR)) return;
    if (element.matches(MONIKER_TRIGGER_SELECTOR)) return;
    const kind = classifyKind(element);
    if (!kind) return;
    // ATS file controls are commonly visually hidden behind a styled upload button. They are
    // still the real writable upload target, so visibility filtering does not apply to them.
    if (kind !== 'file' && !isFillable(element)) return;
    if (kind === 'file' && (element as HTMLInputElement).disabled) return;

    const label = resolveLabel(element);
    if (!label) return;
    const profileKey = label ? lookupFieldKey(label) : null;
    fields.push({ element, label, kind, profileKey });
  });

  const comboboxTriggers = root.querySelectorAll(
    `${STANDARD_COMBOBOX_TRIGGER_SELECTOR}, ${MONIKER_TRIGGER_SELECTOR}`
  );

  comboboxTriggers.forEach((el) => {
    const element = el as HTMLElement;
    if (element instanceof HTMLSelectElement) return;
    // Workday's account/settings menu advertises itself as a listbox, but it is site chrome rather
    // than an application field. Its surrounding header begins with the tenant name (for example,
    // "State of North Carolina Careers"), which can otherwise be mistaken for an address label.
    if (element.getAttribute('data-automation-id') === 'utilityMenuButton') return;
    if (isRepeatableWorkdayField(element)) return;
    if (element.dataset.jobAutofillRepeatable === 'true') return;
    if (element.dataset.jobAutofillHandled === 'true') return;
    if (!isFillable(element)) return;

    const label = resolveLabel(element);
    if (!label) return;
    const profileKey = label ? lookupFieldKey(label) : null;
    fields.push({ element, label, kind: 'combobox', profileKey });
  });

  return fields;
}

export const genericAdapter: Adapter = {
  id: 'generic',
  matchesHostname: () => true,
  extractFields,
};
