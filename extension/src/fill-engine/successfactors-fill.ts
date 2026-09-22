export const SUCCESSFACTORS_HOST_PATTERN = /(^|\.)successfactors\.com$/i;

// SAP SuccessFactors career-site application forms render every section (Profile Information,
// Current or Previous Employment, Formal Education, ...) inside a collapsed accordion panel — their
// fields exist in the DOM with clean, standard labels ("* First Name:", "* Last Name:") but stay
// invisible, and therefore correctly unfilled, until each panel is expanded. Rather than hunting
// down and clicking every individual section's own toggle (each with its own generated numeric id,
// e.g. "97:topBar"), the site ships one stable control that expands all of them at once.
export function expandSuccessFactorsSections(): boolean {
  const expandAll = document.querySelector<HTMLElement>('[id$="_expandAllSections"]');
  if (!expandAll) return false;
  expandAll.click();
  return true;
}

// SAP SuccessFactors' resume/attachment widget has no <input type="file"> anywhere in the DOM —
// its "+" trigger fires an internal SAP event handler (juic.fire) that presumably opens the native
// OS file picker directly. A synthetic click from a content script does not run inside a trusted,
// freshly-originated user gesture (this executes asynchronously, well after the original "Run
// Autofill" button press), so browsers will not honor a picker request triggered this way — there
// is no safe way to attach a file here automatically, only for the applicant to do it by hand.
// Flag it the same way any other genuinely-unsupported required field is flagged, since without an
// <input> element it never enters the normal field-extraction pipeline and would otherwise be
// invisible to the extension (and the applicant) that anything still needs attention here.
export function flagSuccessFactorsAttachments(): number {
  let flagged = 0;
  document.querySelectorAll<HTMLElement>('.attachmentField').forEach((field) => {
    if (!field.querySelector('.requiredField')) return;
    // Already attached: the "download this file" label (or a success icon) becomes visible in
    // place of the "Upload a Resume" prompt once a file is on record.
    if (field.querySelector('[id$="_attachDownloadLabel"]:not(.displayNone), [id$="_attachSuccess"]:not(.displayNone)')) {
      return;
    }
    const target = field.querySelector<HTMLElement>('.attachmentBtn') ?? field;
    if (target.dataset.autofillFlag === 'needs-input') return;
    target.style.outline = '2px solid #f5a623';
    target.dataset.autofillFlag = 'needs-input';
    flagged++;
  });
  return flagged;
}
