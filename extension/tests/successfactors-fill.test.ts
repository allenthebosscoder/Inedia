import { describe, it, expect } from 'vitest';
import { expandSuccessFactorsSections, flagSuccessFactorsAttachments } from '../src/fill-engine/successfactors-fill';

// Simplified from a live SAP SuccessFactors "My Documents" section: a required Resume attachment
// with no <input type="file"> anywhere — clicking "+" fires an internal juic.fire() handler that
// (presumably) opens the native OS file picker, which a content script cannot safely trigger.
function attachmentFieldHtml(options: { required: boolean; alreadyAttached: boolean }): string {
  return `
    <div class="RCMFormField rcmFormElement attachmentField">
      <label id="38:" class="rcmFormFieldLabel">
        ${options.required ? '<span class="requiredField">*</span>' : ''}&nbsp;Resume
      </label>
      <div class="attachmentComponentInput">
        <div id="41:_attachWrapper" class="attachWrapper">
          <div id="41:_attach" class="attachmentBtn">
            <div id="41:_attachSuccess" class="glyphicon glyphicon-ok-circle attachSuccessIcon ${options.alreadyAttached ? '' : 'displayNone'}"></div>
            <div id="41:_attachLabel" class="attachmentLabel attachmentText">Upload a Resume</div>
            <div id="41:_attachDownloadLabel" class="attachmentLabel attachmentText ${options.alreadyAttached ? '' : 'displayNone'}">Upload a Resume</div>
            <span id="41:_attachIcon" role="button" class="glyphicon glyphicon-plus-sign addAttachments"></span>
          </div>
        </div>
      </div>
    </div>`;
}

describe('expandSuccessFactorsSections', () => {
  it('clicks the stable "Expand all sections" control regardless of its generated numeric id prefix', () => {
    document.body.innerHTML = `<a id="30:_expandAllSections" role="button">Expand all sections</a>`;
    const control = document.getElementById('30:_expandAllSections') as HTMLElement;
    let clicked = false;
    control.addEventListener('click', () => { clicked = true; });

    expect(expandSuccessFactorsSections()).toBe(true);
    expect(clicked).toBe(true);
  });

  it('does nothing on a page without a SuccessFactors expand-all control', () => {
    document.body.innerHTML = `<button id="unrelated">Submit</button>`;

    expect(expandSuccessFactorsSections()).toBe(false);
  });
});

describe('flagSuccessFactorsAttachments', () => {
  it('flags a required attachment with no file mounted yet, since no click can safely attach one', () => {
    document.body.innerHTML = attachmentFieldHtml({ required: true, alreadyAttached: false });

    expect(flagSuccessFactorsAttachments()).toBe(1);
    const target = document.getElementById('41:_attach') as HTMLElement;
    expect(target.dataset.autofillFlag).toBe('needs-input');
    expect(target.style.outline).toContain('f5a623');
  });

  it('does not flag an optional attachment', () => {
    document.body.innerHTML = attachmentFieldHtml({ required: false, alreadyAttached: false });

    expect(flagSuccessFactorsAttachments()).toBe(0);
    expect((document.getElementById('41:_attach') as HTMLElement).dataset.autofillFlag).toBeUndefined();
  });

  it('does not flag a required attachment that already has a file on record', () => {
    document.body.innerHTML = attachmentFieldHtml({ required: true, alreadyAttached: true });

    expect(flagSuccessFactorsAttachments()).toBe(0);
    expect((document.getElementById('41:_attach') as HTMLElement).dataset.autofillFlag).toBeUndefined();
  });
});
