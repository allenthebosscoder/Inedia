import { extractFields } from './generic-adapter';
import type { Adapter, FieldDescriptor } from './types';
import { lookupFieldKey } from './synonym-dictionary';

function splShadowRoots(root: ParentNode): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  const visit = (parent: ParentNode): void => {
    parent.querySelectorAll<HTMLElement>('*').forEach((element) => {
      // SmartRecruiters nests its SPL controls inside product-specific hosts such as
      // sr-screening-questions-form. Restricting traversal to spl-* hosts skips the entire
      // screening form, including the legal-name field and required attestations.
      if (!element.shadowRoot) return;
      roots.push(element.shadowRoot);
      visit(element.shadowRoot);
    });
  };
  visit(root);
  return roots;
}

function composedHosts(element: Element): HTMLElement[] {
  const hosts: HTMLElement[] = [];
  let root: Node = element;
  while (true) {
    const currentRoot = root.getRootNode();
    if (!(currentRoot instanceof ShadowRoot)) break;
    hosts.push(currentRoot.host as HTMLElement);
    root = currentRoot.host;
  }
  return hosts;
}

function isRequired(field: FieldDescriptor): boolean {
  if (field.element.matches('[required], [aria-required="true"]') || /\*/.test(field.label)) return true;
  return composedHosts(field.element).some((host) => host.matches('[required], [aria-required="true"]'));
}

export function extractSmartRecruitersFields(root: ParentNode = document): FieldDescriptor[] {
  const roots = [root, ...splShadowRoots(root)];
  const checkboxFields = roots.flatMap((candidateRoot) =>
    Array.from(candidateRoot.querySelectorAll<HTMLElement>('spl-checkbox')).flatMap((host): FieldDescriptor[] => {
      const input = host.shadowRoot?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const label = (host.innerText || host.textContent || '').replace(/\s+/g, ' ').trim();
      return input && label
        ? [{ element: input, label, kind: 'checkbox', profileKey: lookupFieldKey(label) }]
        : [];
    })
  );
  // Put host-derived checkboxes first. Their native input is also discovered inside the shadow
  // root, but its slotted legal text is not part of label.textContent.
  const fields = [...checkboxFields, ...roots.flatMap((candidateRoot) => extractFields(candidateRoot))];
  for (const candidateRoot of roots) {
    if (!(candidateRoot instanceof ShadowRoot) || !candidateRoot.host.matches('spl-dropzone[data-test="resume-upload"]')) continue;
    const input = candidateRoot.querySelector<HTMLInputElement>('input[type="file"]');
    if (input) fields.push({ element: input, label: 'Resume *', kind: 'file', profileKey: null });
  }
  const seen = new Set<HTMLElement>();
  return fields.flatMap((field): FieldDescriptor[] => {
    if (seen.has(field.element)) return [];
    seen.add(field.element);
    const hosts = composedHosts(field.element);
    const dropzone = hosts.find((host) => host.tagName === 'SPL-DROPZONE');
    const autocomplete = hosts.find((host) => host.tagName === 'SPL-AUTOCOMPLETE');
    const controlHost = hosts.find((host) =>
      ['SPL-INPUT', 'SPL-TEXTAREA', 'SPL-CHECKBOX'].includes(host.tagName)
    );
    const composedLabel = (controlHost?.innerText || controlHost?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    const composedProfileKey = composedLabel ? lookupFieldKey(composedLabel) : null;
    const resolvedField = composedLabel && (composedProfileKey || /^\s*\*?\s*$/.test(field.label))
      ? { ...field, label: composedLabel, profileKey: composedProfileKey }
      : field;

    // The first upload control parses a resume to prefill the form; the second is the real Resume
    // attachment. Uploading both creates duplicate attachments.
    if (dropzone?.getAttribute('data-test') === 'apply-with-resume-container') return [];
    if (dropzone?.getAttribute('data-test') === 'resume-upload') {
      return [{ ...field, label: 'Resume *', profileKey: null }];
    }

    // These are implementation details inside SmartRecruiters components. Their enclosing custom
    // controls are handled separately; treating the calendar year spinner or dropdown search as
    // applicant fields produces false missing-input flags.
    if (hosts.some((host) => ['SPL-DATE-FIELD', 'SPL-DATE-PICKER', 'SPL-DROPDOWN-SEARCH'].includes(host.tagName))) return [];
    // Autocomplete values are not committed by writing their internal input. The SmartRecruiters
    // interaction layer waits for and clicks a real option instead.
    if (autocomplete) return [];
    if (field.element.getAttribute('aria-label')?.startsWith('Search by country')) return [];

    if (field.element.id === 'confirm-email-input') {
      return [{ ...field, label: 'Confirm your email', profileKey: 'personal.email' }];
    }

    // Facebook, X, and the hiring-team note are optional and not represented in the profile.
    // Leave them alone instead of reporting them as missing.
    if (!resolvedField.profileKey && !isRequired(resolvedField)) return [];
    return [resolvedField];
  });
}

export const smartRecruitersAdapter: Adapter = {
  id: 'smartrecruiters',
  matchesHostname: (hostname) => /(^|\.)smartrecruiters\.com$/i.test(hostname),
  extractFields: extractSmartRecruitersFields,
};
