import { Profile } from '../storage/profile-schema';
import { FieldDescriptor, FillSummary } from './types';
import { resolveProfileValueForField } from './fill-engine';
import { extractFields } from './generic-adapter';

// Temporary instrumentation for bringing up support on a new ATS. Dumps every form control on the
// page — whether the generic field-matcher detected it, which profile key it mapped to, and what
// it would fill. iCIMS renders its application form in an iframe, so each frame posts its payload
// to the top window, which shows them all in one fixed panel. Gated to iCIMS hosts for now.

interface DiagPayload {
  href: string;
  inIframe: boolean;
  summary: FillSummary;
  controls: number;
  detected: number;
  headings?: string[];
  workdayExperienceTrace?: unknown[];
  skillsTrace?: unknown[];
  oracleTrace?: unknown[];
  collapsedSections?: unknown[];
  resumeSectionHtml?: string;
  successFactorsAttachments?: unknown[];
  fields: unknown[];
}

const PANEL_ID = '__job_autofill_diag';
const MSG = '__jobAutofillDiag';

function labelFor(el: HTMLElement): string {
  const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
  const wrap = el.closest('label');
  const aria = el.getAttribute('aria-label') ?? '';
  const labelledby = el.getAttribute('aria-labelledby');
  const byId = labelledby ? document.getElementById(labelledby)?.textContent ?? '' : '';
  return (byFor?.textContent || wrap?.textContent || aria || byId || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function buildPayload(profile: Profile, summary: FillSummary): DiagPayload {
  const extracted: FieldDescriptor[] = extractFields(document);
  const byEl = new Map(extracted.map((f) => [f.element, f]));
  const fields: unknown[] = [];
  document.querySelectorAll<HTMLElement>(
    'input, select, textarea, [role="combobox"], [aria-haspopup="listbox"], [role="radiogroup"], [role="spinbutton"]'
  ).forEach((el) => {
    const input = el as HTMLInputElement;
    if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(input.type)) return;
    let visible = true;
    try {
      const s = getComputedStyle(el);
      visible = s.display !== 'none' && s.visibility !== 'hidden' &&
        (el.offsetParent !== null || el.getClientRects().length > 0);
    } catch { /* keep visible=true */ }
    const f = byEl.get(el);
    fields.push({
      id: input.id || undefined,
      name: input.name || undefined,
      autoId: el.getAttribute('data-automation-id') || undefined,
      tag: el.tagName.toLowerCase(),
      type: input.type || el.getAttribute('role') || undefined,
      label: f?.label || labelFor(el) || (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) || undefined,
      value: (input.value || '').slice(0, 40) || undefined,
      visible: visible || undefined,
      detected: Boolean(f) || undefined,
      kind: f?.kind || undefined,
      profileKey: f?.profileKey ?? undefined,
      wouldFill: f ? resolveProfileValueForField(profile, f) ?? undefined : undefined,
    });
  });
  const wdTrace = (window as unknown as { __jobAutofillWdTrace?: unknown[] }).__jobAutofillWdTrace;
  const skillsTrace = (window as unknown as { __jobAutofillSkillsTrace?: unknown[] }).__jobAutofillSkillsTrace;
  const oracleTrace = (window as unknown as { __jobAutofillOracleTrace?: unknown[] }).__jobAutofillOracleTrace;
  const headings = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, [role="heading"]'))
    .map((h) => (h.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter((t) => t && t.length < 60)
    .slice(0, 25);
  // When most/all fields on a control-heavy page report invisible, the likely cause is a collapsed
  // accordion/panel section rather than a page still loading. Surface every plausible toggle
  // element (broad net — real markup varies a lot per ATS) so a new one can be supported from this
  // dump instead of needing live DevTools access to the page.
  const hiddenFieldCount = fields.filter((f) => !(f as { visible?: boolean }).visible).length;
  let collapsedSections: unknown[] | undefined;
  if (fields.length >= 5 && hiddenFieldCount / fields.length > 0.5) {
    collapsedSections = Array.from(document.querySelectorAll<HTMLElement>(
      '[aria-expanded], [role="button"], button, summary, [class*="accordion" i], [class*="panel" i][class*="head" i], [class*="collaps" i]'
    )).slice(0, 60).map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      class: el.className && typeof el.className === 'string' ? el.className.slice(0, 100) : undefined,
      role: el.getAttribute('role') || undefined,
      ariaExpanded: el.getAttribute('aria-expanded') || undefined,
      ariaControls: el.getAttribute('aria-controls') || undefined,
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || undefined,
    }));
  }
  // No <input type="file"> found anywhere, yet the page clearly has an upload trigger (e.g. SAP
  // SuccessFactors' "Upload a Resume"). Two rounds of id/class/text heuristics each grabbed a
  // plausible-looking but wrong element (a <script> whose filename said "attachment"; then the
  // field's own short "* Resume" question label instead of the actual clickable trigger — SAP does
  // not seem to share one id prefix across a field's pieces the way it first looked). Stop
  // guessing at a selector from fragments and dump the real markup directly: the closest
  // section-like ancestor of whichever heading says "My Documents" (or, failing that, "resume"),
  // truncated, so the actual structure — file input or otherwise — is visible outright.
  let resumeSectionHtml: string | undefined;
  if (!document.querySelector('input[type="file"]')) {
    const heading = Array.from(document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, button, [role="heading"]'))
      .find((el) => /my documents/i.test((el.textContent ?? '').trim())) ??
      Array.from(document.querySelectorAll<HTMLElement>('*'))
        .find((el) => el.children.length === 0 && /resume/i.test((el.textContent ?? '').trim()) &&
          (el.textContent ?? '').trim().length < 40);
    // Start from the parent, not the heading itself: SAP's own section-header button carries a
    // class like "rcmFormSectionTopBar", which would otherwise self-match "section" and return
    // just the header with none of the actual content beneath it.
    const section = heading?.parentElement?.closest<HTMLElement>(
      '[class*="section" i], [class*="panel" i], fieldset, section'
    ) ?? heading?.parentElement;
    if (section) resumeSectionHtml = section.outerHTML.slice(0, 4000);
  }
  // Self-check for flagSuccessFactorsAttachments(), read straight from the live DOM after the fill
  // already ran (this runs at the end of it) — confirms directly whether the selector actually
  // found the field, judged it required and not-yet-attached, and applied the flag, rather than
  // guessing from the visible outline alone.
  const successFactorsAttachments = Array.from(document.querySelectorAll<HTMLElement>('.attachmentField'))
    .map((field) => {
      const target = field.querySelector<HTMLElement>('.attachmentBtn') ?? field;
      return {
        fieldClass: typeof field.className === 'string' ? field.className : undefined,
        required: Boolean(field.querySelector('.requiredField')),
        alreadyAttached: Boolean(field.querySelector(
          '[id$="_attachDownloadLabel"]:not(.displayNone), [id$="_attachSuccess"]:not(.displayNone)'
        )),
        flaggedByUs: target.dataset.autofillFlag === 'needs-input',
        targetOutline: target.style.outline || undefined,
      };
    });
  return {
    href: location.href,
    inIframe: window.top !== window.self,
    summary,
    controls: fields.length,
    detected: extracted.length,
    headings,
    ...(wdTrace && wdTrace.length ? { workdayExperienceTrace: wdTrace } : {}),
    ...(skillsTrace && skillsTrace.length ? { skillsTrace } : {}),
    ...(oracleTrace && oracleTrace.length ? { oracleTrace } : {}),
    ...(collapsedSections && collapsedSections.length ? { collapsedSections } : {}),
    ...(resumeSectionHtml ? { resumeSectionHtml } : {}),
    ...(successFactorsAttachments.length ? { successFactorsAttachments } : {}),
    fields,
  };
}

function renderPanel(payloads: DiagPayload[]): void {
  try {
    document.getElementById(PANEL_ID)?.remove();
    const box = document.createElement('textarea');
    box.id = PANEL_ID;
    box.readOnly = true;
    box.value = JSON.stringify(payloads.length === 1 ? payloads[0] : { frames: payloads }, null, 1);
    box.setAttribute(
      'style',
      'position:fixed;bottom:8px;right:8px;width:460px;height:300px;z-index:2147483647;' +
      'font:11px/1.35 monospace;background:#111;color:#0f0;border:2px solid #0f0;padding:6px;' +
      'white-space:pre;overflow:auto;opacity:.96'
    );
    box.title = 'autofill diagnostics — click, Cmd+A, Cmd+C, paste to support. Double-click to dismiss.';
    box.addEventListener('dblclick', () => box.remove());
    (document.body ?? document.documentElement).appendChild(box);
  } catch { /* ignore */ }
}

export function dumpPageDiagnostics(profile: Profile, summary: FillSummary): void {
  try {
    const payload = buildPayload(profile, summary);
    // eslint-disable-next-line no-console
    console.log('[autofill:page-diag] ' + JSON.stringify(payload));

    if (payload.inIframe) {
      // The form iframe can't render a panel the user will find (it's taller than the viewport).
      // Push the payload to the top window, retrying so it lands whether the top ran before or
      // after this frame.
      let tries = 0;
      const post = () => {
        try { window.top?.postMessage({ [MSG]: payload }, '*'); } catch { /* cross-origin */ }
        if (++tries >= 20) clearInterval(timer);
      };
      const timer = setInterval(post, 200);
      post();
      return;
    }

    const collected = new Map<string, DiagPayload>();
    collected.set(payload.href, payload);
    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      const frame = data && (data[MSG] as DiagPayload | undefined);
      if (frame && frame.href) {
        collected.set(frame.href, frame);
        renderPanel([...collected.values()]);
      }
    });
    renderPanel([...collected.values()]);
  } catch {
    // diagnostics must never break a fill run
  }
}
