import { describe, it, expect, vi } from 'vitest';
import { fillFields, setNativeValue, flagField, findMatchIndex, buildCandidates, uploadResumeToDropZones, resolveProfileValueForField } from '../src/fill-engine/fill-engine';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';

describe('multiple-choice summary counting', () => {
  it('defaults source questions to Company Website across text and native select controls', () => {
    const text = document.createElement('input');
    const select = document.createElement('select');
    select.innerHTML = '<option value="">Select one</option><option value="fair">Career Fair</option><option value="site">Company Website</option>';
    const fields = [
      { element: text, label: 'How did you hear about this position?', kind: 'text' as const, profileKey: null },
      { element: select, label: 'Applicant Source', kind: 'select' as const, profileKey: null },
    ];

    expect(fillFields(fields, DEFAULT_PROFILE)).toEqual({ filled: 2, flagged: 0 });
    expect(text.value).toBe('Company Website');
    expect(select.value).toBe('site');
  });

  it('preserves an existing source answer and rejects unrelated source options', () => {
    const existing = document.createElement('input');
    existing.value = 'Employee Referral';
    const select = document.createElement('select');
    select.required = true;
    select.innerHTML = '<option value="">Select one</option><option value="fair">Career Fair</option><option value="linkedin">LinkedIn</option>';
    const fields = [
      { element: existing, label: 'How did you find this role?', kind: 'text' as const, profileKey: null },
      { element: select, label: 'Recruitment Source', kind: 'select' as const, profileKey: null },
    ];

    expect(fillFields(fields, DEFAULT_PROFILE)).toEqual({ filled: 1, flagged: 1 });
    expect(existing.value).toBe('Employee Referral');
    expect(select.value).toBe('');
  });

  it('maps negative EEO and clearance values to ATS option wording', () => {
    expect(buildCandidates('disclosures.hispanicOrLatino', 'No')).toContain('Not Hispanic or Latino');
    expect(buildCandidates('jobPreferences.securityClearance', 'no')).toContain('None');
    expect(buildCandidates('personal.phoneCountryCode', 'United States')).toContain('(+1) United States');
  });

  it('formats an available start date as a human-readable lead-time answer', () => {
    const field = {
      element: document.createElement('input'),
      label: 'What is the minimum lead time you would require to commence the new role if successful?',
      kind: 'text' as const,
      profileKey: 'jobPreferences.availableStartDate' as const,
    };
    const profile = {
      ...DEFAULT_PROFILE,
      jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, availableStartDate: '2027-05-03' },
    };

    expect(resolveProfileValueForField(profile, field)).toBe('Available May 3, 2027');
  });
  it('formats a desired-pay range from the min and max, inferring hourly vs annual', () => {
    const rangeField = {
      element: document.createElement('input'),
      label: 'What is your desired salary range?',
      kind: 'text' as const,
      profileKey: 'jobPreferences.compensationRange' as const,
    };
    const minField = { ...rangeField, label: 'Minimum salary requirement', profileKey: 'jobPreferences.minimumSalary' as const };

    const internship = { ...DEFAULT_PROFILE, jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, minimumSalary: '25', compensationMax: '35' } };
    expect(resolveProfileValueForField(internship, rangeField)).toBe('$25 - $35 per hour');
    expect(resolveProfileValueForField(internship, minField)).toBe('25');

    const entryLevel = { ...DEFAULT_PROFILE, jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, minimumSalary: '85000', compensationMax: '100000' } };
    expect(resolveProfileValueForField(entryLevel, rangeField)).toBe('$85,000 - $100,000 per year');
    expect(resolveProfileValueForField(entryLevel, minField)).toBe('85000');

    const minOnly = { ...DEFAULT_PROFILE, jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, minimumSalary: '90000', compensationMax: '' } };
    expect(resolveProfileValueForField(minOnly, rangeField)).toBe('$90,000');
  });
  it('resolves a single School/Degree/Field of Study/GPA prompt from the first education entry', () => {
    const profile = {
      ...DEFAULT_PROFILE,
      education: [{
        school: 'Duke University', degree: 'BS', fieldOfStudy: 'Electrical and Computer Engineering',
        graduationDate: '05/2027', gpa: '4.0',
      }],
    };
    const fieldFor = (profileKey: 'education.school' | 'education.degree' | 'education.fieldOfStudy' | 'education.gpa') => ({
      element: document.createElement('input'), label: 'test', kind: 'text' as const, profileKey,
    });

    expect(resolveProfileValueForField(profile, fieldFor('education.school'))).toBe('Duke University');
    expect(resolveProfileValueForField(profile, fieldFor('education.degree'))).toBe('BS');
    expect(resolveProfileValueForField(profile, fieldFor('education.fieldOfStudy'))).toBe('Electrical and Computer Engineering');
    expect(resolveProfileValueForField(profile, fieldFor('education.gpa'))).toBe('4.0');
    expect(resolveProfileValueForField({ ...DEFAULT_PROFILE, education: [] }, fieldFor('education.school'))).toBeNull();
  });

  it('resolves the free-text skills field', () => {
    const field = {
      element: document.createElement('textarea'),
      label: 'Skills',
      kind: 'textarea' as const,
      profileKey: 'professional.skills' as const,
    };
    const profile = {
      ...DEFAULT_PROFILE,
      professional: { ...DEFAULT_PROFILE.professional, skills: 'C++, Python, PCB Design, Verilog' },
    };

    expect(resolveProfileValueForField(profile, field)).toBe('C++, Python, PCB Design, Verilog');
    expect(fillFields([field], profile)).toEqual({ filled: 1, flagged: 0 });
    expect((field.element as HTMLTextAreaElement).value).toBe('C++, Python, PCB Design, Verilog');
  });
  it('uses the saved education GPA for an explicit overall college GPA question', () => {
    const textarea = document.createElement('textarea');
    const profile = {
      ...DEFAULT_PROFILE,
      education: [{
        school: 'Duke University', degree: 'BS', fieldOfStudy: 'ECE', graduationDate: '05/2027',
        gpa: '4.0',
      }],
    };
    const field = {
      element: textarea,
      label: 'What is your overall college GPA?*',
      kind: 'textarea' as const,
      profileKey: null,
    };

    expect(resolveProfileValueForField(profile, field)).toBe('4.0');
    expect(fillFields([field], profile)).toEqual({ filled: 1, flagged: 0 });
    expect(textarea.value).toBe('4.0');
  });

  it('combines GPA and degree when one prompt explicitly requests both', () => {
    const input = document.createElement('input');
    const profile = {
      ...DEFAULT_PROFILE,
      education: [{
        school: 'Duke University', degree: 'BS', fieldOfStudy: 'ECE', graduationDate: '05/2027',
        gpa: '4.0',
      }],
    };
    const field = {
      element: input,
      label: 'What was your cumulative GPA upon graduation from your highest level degree obtained?',
      kind: 'text' as const,
      profileKey: null,
    };

    expect(resolveProfileValueForField(profile, field)).toBe('4.0, BS');
    expect(fillFields([field], profile)).toEqual({ filled: 1, flagged: 0 });
    expect(input.value).toBe('4.0, BS');
  });

  it('does not infer GPA for an ambiguous grade question', () => {
    const field = {
      element: document.createElement('input'),
      label: 'What grade did you receive?',
      kind: 'text' as const,
      profileKey: null,
    };
    const profile = {
      ...DEFAULT_PROFILE,
      education: [{
        school: 'Duke University', degree: 'BS', fieldOfStudy: 'ECE', graduationDate: '05/2027',
        gpa: '4.0',
      }],
    };

    expect(resolveProfileValueForField(profile, field)).toBeNull();
  });

  it('reuses a No restricted-country answer for a subset but does not infer subset Yes', () => {
    const field = {
      element: document.createElement('button'),
      label: 'Are you a citizen of any one of these countries: Cuba, Iran, North Korea, or Syria?',
      kind: 'combobox' as const,
      profileKey: 'workAuthorization.restrictedCountryStatus' as const,
    };
    const noProfile = {
      ...DEFAULT_PROFILE,
      workAuthorization: { ...DEFAULT_PROFILE.workAuthorization, restrictedCountryStatus: 'no' as const },
    };
    const yesProfile = {
      ...DEFAULT_PROFILE,
      workAuthorization: { ...DEFAULT_PROFILE.workAuthorization, restrictedCountryStatus: 'yes' as const },
    };

    expect(resolveProfileValueForField(noProfile, field)).toBe('no');
    expect(resolveProfileValueForField(yesProfile, field)).toBeNull();
  });
  it('includes an optional middle name when resolving the full name', () => {
    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, firstName: 'Allen', middleName: 'J', lastName: 'Ryu' },
    };
    const input = document.createElement('input');
    fillFields([{ element: input, label: 'Full Name', kind: 'text', profileKey: 'personal.fullName' }], profile);
    expect(input.value).toBe('Allen J Ryu');
  });
  it('selects the native iCIMS salary band containing the saved numeric requirement', () => {
    document.body.innerHTML = `
      <select id="salary">
        <option value="">Make a Selection</option>
        <option>$70,000 - $80,000</option>
        <option>$80,000 - $90,000</option>
        <option>$90,000 - $100,000</option>
        <option>$100,000 +</option>
      </select>
    `;
    const select = document.getElementById('salary') as HTMLSelectElement;
    const profile = {
      ...DEFAULT_PROFILE,
      jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, minimumSalary: '$85,000 annually' },
    };

    expect(fillFields([{
      element: select,
      label: 'Desired Base Salary',
      kind: 'select',
      profileKey: 'jobPreferences.minimumSalary',
    }], profile)).toEqual({ filled: 1, flagged: 0 });
    expect(select.value).toBe('$80,000 - $90,000');
  });
  it('maps the saved highest-education level to an iCIMS option label', () => {
    document.body.innerHTML = `
      <select id="education-level">
        <option value="">Make a Selection</option>
        <option>Some College</option>
        <option>Bachelor's Degree</option>
        <option>Master's Degree</option>
      </select>
    `;
    const select = document.getElementById('education-level') as HTMLSelectElement;
    const profile = {
      ...DEFAULT_PROFILE,
      professional: { ...DEFAULT_PROFILE.professional, highestEducation: 'bachelors' as const },
    };

    expect(fillFields([{
      element: select,
      label: 'What is your highest level of education?',
      kind: 'select',
      profileKey: 'professional.highestEducation',
    }], profile)).toEqual({ filled: 1, flagged: 0 });
    expect(select.value).toBe("Bachelor's Degree");
  });
  it('does not flag a prefilled field without a profile mapping', () => {
    document.body.innerHTML = '<input id="language" value="English" data-autofill-flag="needs-input" style="outline: 2px solid orange" />';
    const input = document.getElementById('language') as HTMLInputElement;
    const summary = fillFields([{ element: input, label: 'Language', kind: 'text', profileKey: null }], DEFAULT_PROFILE);
    expect(summary).toEqual({ filled: 0, flagged: 0 });
    expect(input.dataset.autofillFlag).toBeUndefined();
    expect(input.style.outline).toBe('');
  });

  it('does not flag an optional mapped field that is intentionally blank in the profile', () => {
    document.body.innerHTML = '<input id="address2" data-autofill-flag="needs-input" style="outline: 2px solid orange" />';
    const input = document.getElementById('address2') as HTMLInputElement;

    const summary = fillFields(
      [{ element: input, label: 'Address 2', kind: 'text', profileKey: 'personal.addressLine2' }],
      DEFAULT_PROFILE
    );

    expect(summary).toEqual({ filled: 0, flagged: 0 });
    expect(input.dataset.autofillFlag).toBeUndefined();
    expect(input.style.outline).toBe('');
  });

  it('still flags a required mapped field when its profile value is blank', () => {
    document.body.innerHTML = '<input id="address2" aria-required="true" />';
    const input = document.getElementById('address2') as HTMLInputElement;

    expect(fillFields(
      [{ element: input, label: 'Address 2*', kind: 'text', profileKey: 'personal.addressLine2' }],
      DEFAULT_PROFILE
    )).toEqual({ filled: 0, flagged: 1 });
    expect(input.dataset.autofillFlag).toBe('needs-input');
  });

  it('leaves a blank optional phone extension unflagged', () => {
    document.body.innerHTML = '<input id="extension" data-autofill-flag="needs-input" />';
    const input = document.getElementById('extension') as HTMLInputElement;

    expect(fillFields(
      [{ element: input, label: 'Phone Extension', kind: 'text', profileKey: null }],
      DEFAULT_PROFILE
    )).toEqual({ filled: 0, flagged: 0 });
    expect(input.dataset.autofillFlag).toBeUndefined();
  });

  it('counts a radio group once while flagging every answer choice', () => {
    document.body.innerHTML = `
      <input id="heard-job-board" type="radio" name="how-heard" />
      <input id="heard-referral" type="radio" name="how-heard" />
      <input id="heard-other" type="radio" name="how-heard" />
      <input id="worked-yes" type="radio" name="worked-before" />
      <input id="worked-no" type="radio" name="worked-before" />
      <input id="extension" type="text" />
    `;
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
    const fields = inputs.map((element) => ({
      element,
      label: '',
      kind: element.type === 'radio' ? 'radio' as const : 'text' as const,
      profileKey: null,
    }));

    const summary = fillFields(fields, DEFAULT_PROFILE);

    expect(summary).toEqual({ filled: 0, flagged: 3 });
    expect(inputs.every((input) => input.dataset.autofillFlag === 'needs-input')).toBe(true);
  });

  it('accepts an unsupported radio group when any option is already checked', () => {
    document.body.innerHTML = `
      <input id="previous-yes" type="radio" name="candidateIsPreviousWorker"
        data-autofill-flag="needs-input" style="outline: 2px solid orange" />
      <input id="previous-no" type="radio" name="candidateIsPreviousWorker" checked />
    `;
    const fields = Array.from(document.querySelectorAll<HTMLInputElement>('input')).map((element) => ({
      element,
      label: element.id === 'previous-yes' ? 'Yes' : 'No',
      kind: 'radio' as const,
      profileKey: null,
    }));

    expect(fillFields(fields, DEFAULT_PROFILE)).toEqual({ filled: 0, flagged: 0 });
    expect(fields.every(({ element }) => element.dataset.autofillFlag === undefined)).toBe(true);
  });

  it('does not count an unsupported unchecked checkbox as missing input', () => {
    document.body.innerHTML = `<input id="preferred" type="checkbox" />`;
    const checkbox = document.getElementById('preferred') as HTMLInputElement;

    const summary = fillFields(
      [{ element: checkbox, label: 'I have a preferred name', kind: 'checkbox', profileKey: null }],
      DEFAULT_PROFILE
    );

    expect(summary).toEqual({ filled: 0, flagged: 0 });
    expect(checkbox.dataset.autofillFlag).toBeUndefined();
  });

  it('counts an unanswered required Workday checkbox group once', () => {
    document.body.innerHTML = `
      <fieldset id="supplementaryQuestionnaire--education" aria-required="true">
        <input id="degree-bs" type="checkbox" aria-required="true" />
        <input id="degree-ms" type="checkbox" aria-required="true" />
        <input id="degree-none" type="checkbox" aria-required="true" />
      </fieldset>
    `;
    const fields = Array.from(document.querySelectorAll<HTMLInputElement>('input')).map((element) => ({
      element, label: element.id, kind: 'checkbox' as const, profileKey: null,
    }));

    expect(fillFields(fields, DEFAULT_PROFILE)).toEqual({ filled: 0, flagged: 1 });
    expect(fields.every(({ element }) => element.dataset.autofillFlag === 'needs-input')).toBe(true);
  });

  it('accepts a required Workday checkbox group that already has one answer', () => {
    document.body.innerHTML = `
      <fieldset id="supplementaryQuestionnaire--education" aria-required="true">
        <input id="degree-bs" type="checkbox" aria-required="true" checked />
        <input id="degree-ms" type="checkbox" aria-required="true"
          data-autofill-flag="needs-input" style="outline: 2px solid orange" />
      </fieldset>
    `;
    const fields = Array.from(document.querySelectorAll<HTMLInputElement>('input')).map((element) => ({
      element, label: element.id, kind: 'checkbox' as const, profileKey: null,
    }));

    expect(fillFields(fields, DEFAULT_PROFILE)).toEqual({ filled: 0, flagged: 0 });
    expect(fields.every(({ element }) => element.dataset.autofillFlag === undefined)).toBe(true);
  });

  it('selects the saved answer in a Workday disability checkbox group', () => {
    document.body.innerHTML = `
      <fieldset id="selfIdentifiedDisabilityData--disabilityStatus">
        <input id="disability-yes" type="checkbox" /><label for="disability-yes">Yes, I have a disability, or have had one in the past</label>
        <input id="disability-no" type="checkbox" /><label for="disability-no">No, I do not have a disability and have not had one in the past</label>
        <input id="disability-decline" type="checkbox" /><label for="disability-decline">I do not want to answer</label>
      </fieldset>`;
    const profile = {
      ...DEFAULT_PROFILE,
      disclosures: {
        ...DEFAULT_PROFILE.disclosures,
        disabilityStatus: 'No, I do not have a disability and have not had one in the past',
      },
    };
    const fields = Array.from(document.querySelectorAll<HTMLInputElement>('input')).map((element) => ({
      element, label: 'Disability Status', kind: 'checkbox' as const,
      profileKey: 'disclosures.disabilityStatus' as const,
    }));

    expect(fillFields(fields, profile)).toEqual({ filled: 1, flagged: 0 });
    expect((document.getElementById('disability-no') as HTMLInputElement).checked).toBe(true);
  });

  it('uses browser editing for Workday questionnaire text so its form model receives the value', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    const inputEvents: string[] = [];
    textarea.addEventListener('input', () => inputEvents.push(textarea.value));
    const originalExecCommand = document.execCommand;
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn((_command: string, _showUi: boolean, value: string) => {
        const active = document.activeElement as HTMLTextAreaElement;
        active.value = value;
        active.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        return true;
      }),
    });
    const profile = {
      ...DEFAULT_PROFILE,
      jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, minimumSalary: '85000' },
    };

    try {
      expect(fillFields(
        [{ element: textarea, label: 'Minimum salary requirements', kind: 'textarea', profileKey: 'jobPreferences.minimumSalary' }],
        profile,
        { browserEditing: true }
      )).toEqual({ filled: 1, flagged: 0 });
      expect(document.execCommand).toHaveBeenCalledWith('insertText', false, '85000');
      expect(inputEvents).toEqual(['85000']);
      expect(textarea.value).toBe('85000');
    } finally {
      Object.defineProperty(document, 'execCommand', { configurable: true, value: originalExecCommand });
    }
  });
});

describe('resume upload', () => {
  it('attaches the stored resume to a recognized file input', () => {
    document.body.innerHTML = `<input id="resume" type="file" />`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const profile = {
      ...DEFAULT_PROFILE,
      resume: {
        name: 'Jorge Resume.pdf',
        type: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,SGVsbG8=',
      },
    };

    const summary = fillFields(
      [{ element: input, label: 'Resume', kind: 'file', profileKey: null }],
      profile
    );

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(input.files?.[0]?.name).toBe('Jorge Resume.pdf');
  });

  it('does not attach a duplicate when an ATS already renders the saved filename', () => {
    document.body.innerHTML = `
      <div>Jorge Resume.pdf</div>
      <input id="resume" type="file" />
    `;
    const input = document.getElementById('resume') as HTMLInputElement;
    let changes = 0;
    input.addEventListener('change', () => changes++);
    const profile = {
      ...DEFAULT_PROFILE,
      resume: {
        name: 'Jorge Resume.pdf',
        type: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,SGVsbG8=',
      },
    };

    const summary = fillFields(
      [{ element: input, label: 'Resume', kind: 'file', profileKey: null }],
      profile
    );

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(changes).toBe(0);
    expect(input.files).toHaveLength(0);
  });

  it('attaches the resume to a Greenhouse file input labelled only "Attach"', () => {
    document.body.innerHTML = `
      <div>
        <h3>Resume/CV</h3>
        <button type="button">Attach</button>
        <label class="visually-hidden" for="resume">Attach</label>
        <input id="resume" class="visually-hidden" type="file" accept=".pdf,.doc,.docx,.txt,.rtf" />
      </div>`;
    const input = document.getElementById('resume') as HTMLInputElement;
    const profile = {
      ...DEFAULT_PROFILE,
      resume: { name: 'Allen Ryu Resume.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,SGVsbG8=' },
    };

    const summary = fillFields([{ element: input, label: 'Attach', kind: 'file', profileKey: null }], profile);

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(input.files?.[0]?.name).toBe('Allen Ryu Resume.pdf');
  });

  it('ignores an optional cover-letter upload instead of attaching the resume', () => {
    document.body.innerHTML = `<input id="cover-letter" type="file" />`;
    const input = document.getElementById('cover-letter') as HTMLInputElement;
    const profile = {
      ...DEFAULT_PROFILE,
      resume: { name: 'resume.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,SGVsbG8=' },
    };

    const summary = fillFields(
      [{ element: input, label: 'Cover Letter', kind: 'file', profileKey: null }],
      profile
    );

    expect(summary).toEqual({ filled: 0, flagged: 0 });
    expect(input.files).toHaveLength(0);
  });

  it('does not attach the resume to a cover-letter field sharing a generic "Attach" label and a nearby Resume heading', () => {
    // Reproduces a live bug: Greenhouse's newer layout labels every file input just "Attach", and
    // when a Resume/CV heading sits above both fields in a shared section (no per-field wrapper
    // div around the cover letter input specifically), the nearest-heading lookup used to pick up
    // the wrong field's heading and treat the cover letter input as the resume input too.
    document.body.innerHTML = `
      <div id="attachments">
        <h3>Resume/CV</h3>
        <label for="resume">Attach</label>
        <input id="resume" type="file" accept=".pdf,.doc,.docx,.txt,.rtf" />
        <label for="cover_letter">Attach</label>
        <input id="cover_letter" type="file" accept=".pdf,.doc,.docx,.txt,.rtf" />
      </div>`;
    const resumeInput = document.getElementById('resume') as HTMLInputElement;
    const coverLetterInput = document.getElementById('cover_letter') as HTMLInputElement;
    const profile = {
      ...DEFAULT_PROFILE,
      resume: { name: 'Allen Ryu Resume.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,SGVsbG8=' },
    };

    const summary = fillFields(
      [
        { element: resumeInput, label: 'Attach', kind: 'file', profileKey: null },
        { element: coverLetterInput, label: 'Attach', kind: 'file', profileKey: null },
      ],
      profile
    );

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(resumeInput.files?.[0]?.name).toBe('Allen Ryu Resume.pdf');
    expect(coverLetterInput.files).toHaveLength(0);
  });

  it('still flags an unsupported required attachment', () => {
    document.body.innerHTML = `<input id="transcript" type="file" aria-required="true" />`;
    const input = document.getElementById('transcript') as HTMLInputElement;

    const summary = fillFields(
      [{ element: input, label: 'Official Transcript*', kind: 'file', profileKey: null }],
      DEFAULT_PROFILE
    );

    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect(input.dataset.autofillFlag).toBe('needs-input');
  });

  it('drops the stored resume onto Workday resumeAttachments', () => {
    document.body.innerHTML = `
      <div data-automation-id="file-upload-drop-zone">
        <button id="resumeAttachments--attachments" data-automation-id="select-files">Select files</button>
      </div>
    `;
    const zone = document.querySelector<HTMLElement>('[data-automation-id="file-upload-drop-zone"]')!;
    let droppedFile: File | undefined;
    zone.addEventListener('drop', (event) => {
      droppedFile = (event as DragEvent).dataTransfer?.files[0];
    });
    const profile = {
      ...DEFAULT_PROFILE,
      resume: { name: 'resume.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,SGVsbG8=' },
    };

    expect(uploadResumeToDropZones(profile)).toEqual({ filled: 1, flagged: 0 });
    expect(droppedFile?.name).toBe('resume.pdf');
  });

  it('does not drop the resume onto an unrelated attachment zone', () => {
    document.body.innerHTML = `
      <div data-automation-id="file-upload-drop-zone">
        <button id="coverLetterAttachments--attachments">Select files</button>
      </div>
    `;
    const profile = {
      ...DEFAULT_PROFILE,
      resume: { name: 'resume.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,SGVsbG8=' },
    };
    expect(uploadResumeToDropZones(profile)).toEqual({ filled: 0, flagged: 0 });
  });

  it('skips synthetic drop when Workday exposes its real hidden file input', () => {
    document.body.innerHTML = `
      <div data-automation-id="file-upload-drop-zone">
        <button id="resumeAttachments--attachments">Select files</button>
      </div>
      <input data-automation-id="file-upload-input-ref" type="file" />
    `;
    let dropCount = 0;
    document.querySelector('[data-automation-id="file-upload-drop-zone"]')!.addEventListener('drop', () => dropCount++);
    const profile = {
      ...DEFAULT_PROFILE,
      resume: { name: 'resume.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,SGVsbG8=' },
    };

    expect(uploadResumeToDropZones(profile)).toEqual({ filled: 0, flagged: 0 });
    expect(dropCount).toBe(0);
  });
});

describe('setNativeValue', () => {
  it('sets the value and dispatches an input event', () => {
    document.body.innerHTML = '<input type="text" />';
    const input = document.querySelector('input')!;
    const inputHandler = vi.fn();
    input.addEventListener('input', inputHandler);

    setNativeValue(input, 'hello');

    expect(input.value).toBe('hello');
    expect(inputHandler).toHaveBeenCalledOnce();
  });

  it('sets a select element value via the HTMLSelectElement prototype setter and dispatches both input and change', () => {
    document.body.innerHTML = `
      <select><option value="a">A</option><option value="b">B</option></select>
    `;
    const select = document.querySelector('select')!;
    const inputHandler = vi.fn();
    const changeHandler = vi.fn();
    select.addEventListener('input', inputHandler);
    select.addEventListener('change', changeHandler);

    setNativeValue(select, 'b');

    expect(select.value).toBe('b');
    expect(inputHandler).toHaveBeenCalledOnce();
    expect(changeHandler).toHaveBeenCalledOnce();
  });
});

describe('flagField', () => {
  it('outlines the element and marks it as needing input', () => {
    document.body.innerHTML = '<input type="text" />';
    const input = document.querySelector('input')!;
    flagField(input);
    expect(input.style.outline).toBe('2px solid #f5a623');
    expect(input.dataset.autofillFlag).toBe('needs-input');
  });
});

describe('fillFields', () => {
  const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, firstName: 'Jorge' } };

  it('fills a matched text field', () => {
    document.body.innerHTML = '<input type="text" id="fname" />';
    const element = document.getElementById('fname')!;
    const summary = fillFields(
      [{ element, label: 'First Name', kind: 'text', profileKey: 'personal.firstName' }],
      profile
    );
    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect((element as HTMLInputElement).value).toBe('Jorge');
  });

  it('flags a field with no profile match', () => {
    document.body.innerHTML = '<textarea id="essay"></textarea>';
    const element = document.getElementById('essay')!;
    const summary = fillFields([{ element, label: 'Why us?', kind: 'textarea', profileKey: null }], profile);
    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect(element.dataset.autofillFlag).toBe('needs-input');
  });

  it('selects a matching option by visible text', () => {
    document.body.innerHTML = `
      <select id="auth">
        <option value="1">Yes</option>
        <option value="2">No</option>
      </select>
    `;
    const element = document.getElementById('auth') as HTMLSelectElement;
    const authProfile = {
      ...profile,
      workAuthorization: { authorizedToWork: 'yes' as const, requiresSponsorship: '' as const },
    };
    const summary = fillFields(
      [{ element, label: 'Authorized to work?', kind: 'select', profileKey: 'workAuthorization.authorizedToWork' }],
      authProfile
    );
    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(element.value).toBe('1');
  });

  it('dispatches both input and change events when filling a select (React installs value trackers on selects too)', () => {
    document.body.innerHTML = `
      <select id="auth">
        <option value="1">Yes</option>
        <option value="2">No</option>
      </select>
    `;
    const element = document.getElementById('auth') as HTMLSelectElement;
    const inputHandler = vi.fn();
    const changeHandler = vi.fn();
    element.addEventListener('input', inputHandler);
    element.addEventListener('change', changeHandler);
    const authProfile = {
      ...profile,
      workAuthorization: { authorizedToWork: 'yes' as const, requiresSponsorship: '' as const },
    };

    fillFields(
      [{ element, label: 'Authorized to work?', kind: 'select', profileKey: 'workAuthorization.authorizedToWork' }],
      authProfile
    );

    expect(inputHandler).toHaveBeenCalledOnce();
    expect(changeHandler).toHaveBeenCalledOnce();
  });

  it('fills a phone type select field from personal.phoneType', () => {
    document.body.innerHTML = `
      <select id="phoneType">
        <option value="m">Mobile</option>
        <option value="h">Home</option>
        <option value="w">Work</option>
      </select>
    `;
    const element = document.getElementById('phoneType') as HTMLSelectElement;
    const phoneProfile = { ...profile, personal: { ...profile.personal, phoneType: 'mobile' as const } };
    const summary = fillFields(
      [{ element, label: 'Phone Type', kind: 'select', profileKey: 'personal.phoneType' }],
      phoneProfile
    );
    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(element.value).toBe('m');
  });

  it('fills a state select whose options are abbreviations', () => {
    document.body.innerHTML = `
      <select id="state">
        <option value="NC">NC</option>
        <option value="CA">CA</option>
      </select>
    `;
    const element = document.getElementById('state') as HTMLSelectElement;
    const stateProfile = { ...profile, personal: { ...profile.personal, state: 'NC' } };
    const summary = fillFields(
      [{ element, label: 'State', kind: 'select', profileKey: 'personal.state' }],
      stateProfile
    );
    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(element.value).toBe('NC');
  });

  it('fills a state select whose options are full names, from a stored abbreviation', () => {
    document.body.innerHTML = `
      <select id="state">
        <option value="1">North Carolina</option>
        <option value="2">California</option>
      </select>
    `;
    const element = document.getElementById('state') as HTMLSelectElement;
    const stateProfile = { ...profile, personal: { ...profile.personal, state: 'NC' } };
    const summary = fillFields(
      [{ element, label: 'State', kind: 'select', profileKey: 'personal.state' }],
      stateProfile
    );
    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(element.value).toBe('1');
  });

  it('selects the option matching whole-word "no", not one that merely contains "no" as a substring', () => {
    document.body.innerHTML = `
      <select id="auth">
        <option value="1">Yes</option>
        <option value="2">No</option>
        <option value="3">I do not wish to answer</option>
      </select>
    `;
    const element = document.getElementById('auth') as HTMLSelectElement;
    const authProfile = {
      ...profile,
      workAuthorization: { authorizedToWork: 'no' as const, requiresSponsorship: '' as const },
    };

    const summary = fillFields(
      [{ element, label: 'Authorized to work?', kind: 'select', profileKey: 'workAuthorization.authorizedToWork' }],
      authProfile
    );

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(element.value).toBe('2');
  });

  it('resolves personal.fullName by combining firstName and lastName', () => {
    document.body.innerHTML = '<input type="text" id="fullname" />';
    const element = document.getElementById('fullname')!;
    const fullNameProfile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, firstName: 'Jorge', lastName: 'Washingmachine' },
    };

    const summary = fillFields(
      [{ element, label: 'Full name', kind: 'text', profileKey: 'personal.fullName' }],
      fullNameProfile
    );

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect((element as HTMLInputElement).value).toBe('Jorge Washingmachine');
  });

  it('flags personal.fullName when both firstName and lastName are empty', () => {
    document.body.innerHTML = '<input type="text" id="fullname" />';
    const element = document.getElementById('fullname')!;

    const summary = fillFields(
      [{ element, label: 'Full name', kind: 'text', profileKey: 'personal.fullName' }],
      DEFAULT_PROFILE
    );

    expect(summary).toEqual({ filled: 0, flagged: 1 });
  });

  it('prefers the longer whole-word candidate ("Oregon") over the abbreviation ("OR") so it does not match unrelated dropdown chrome', () => {
    document.body.innerHTML = `
      <select id="state">
        <option value="0">-- Select State or Province --</option>
        <option value="OR">OR - Oregon</option>
        <option value="CA">CA - California</option>
      </select>
    `;
    const element = document.getElementById('state') as HTMLSelectElement;
    const stateProfile = { ...profile, personal: { ...profile.personal, state: 'OR' } };
    const summary = fillFields(
      [{ element, label: 'State', kind: 'select', profileKey: 'personal.state' }],
      stateProfile
    );
    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(element.value).toBe('OR');
  });

  it('flags a state select whose options contain neither the abbreviation nor the expanded full name', () => {
    document.body.innerHTML = `
      <select id="state">
        <option value="1">Somewhere Else</option>
        <option value="2">Nowhere</option>
      </select>
    `;
    const element = document.getElementById('state') as HTMLSelectElement;
    const stateProfile = { ...profile, personal: { ...profile.personal, state: 'OR' } };
    const summary = fillFields(
      [{ element, label: 'State', kind: 'select', profileKey: 'personal.state' }],
      stateProfile
    );
    expect(summary).toEqual({ filled: 0, flagged: 1 });
  });

  it('does not apply state-specific candidate expansion to non-state select fields', () => {
    document.body.innerHTML = `
      <select id="auth">
        <option value="1">Yes</option>
        <option value="2">No</option>
        <option value="3">Oregon</option>
      </select>
    `;
    const element = document.getElementById('auth') as HTMLSelectElement;
    const authProfile = {
      ...profile,
      workAuthorization: { authorizedToWork: 'OR' as 'yes' | 'no' | '', requiresSponsorship: '' as const },
    };
    const summary = fillFields(
      [{ element, label: 'Authorized to work?', kind: 'select', profileKey: 'workAuthorization.authorizedToWork' }],
      authProfile
    );
    expect(summary).toEqual({ filled: 0, flagged: 1 });
  });

  it('flags radio and checkbox fields rather than guessing which input to click', () => {
    document.body.innerHTML = '<input type="radio" id="yes" name="auth" />';
    const element = document.getElementById('yes')!;
    const authProfile = {
      ...profile,
      workAuthorization: { authorizedToWork: 'yes' as const, requiresSponsorship: '' as const },
    };
    const summary = fillFields(
      [{ element, label: 'Authorized to work?', kind: 'radio', profileKey: 'workAuthorization.authorizedToWork' }],
      authProfile
    );
    expect(summary).toEqual({ filled: 0, flagged: 1 });
  });

  it('clears stale needs-input flags from a radio group after selecting its saved answer', () => {
    document.body.innerHTML = `
      <label for="yes">Yes</label><input type="radio" id="yes" name="auth" />
      <label for="no">No</label><input type="radio" id="no" name="auth"
        data-autofill-flag="needs-input" style="outline:2px solid orange" />
    `;
    const yes = document.getElementById('yes') as HTMLInputElement;
    const no = document.getElementById('no') as HTMLInputElement;
    yes.dataset.autofillFlag = 'needs-input';
    yes.style.outline = '2px solid orange';
    const authProfile = {
      ...profile,
      workAuthorization: { authorizedToWork: 'no' as const, requiresSponsorship: '' as const },
    };

    expect(fillFields([
      { element: yes, label: 'Authorized to work?', kind: 'radio', profileKey: 'workAuthorization.authorizedToWork' },
      { element: no, label: 'Authorized to work?', kind: 'radio', profileKey: 'workAuthorization.authorizedToWork' },
    ], authProfile)).toEqual({ filled: 1, flagged: 0 });

    expect(no.checked).toBe(true);
    expect(yes.dataset.autofillFlag).toBeUndefined();
    expect(no.dataset.autofillFlag).toBeUndefined();
    expect(yes.style.outline).toBe('');
    expect(no.style.outline).toBe('');
  });

  it('leaves Oracle single-checkbox Hispanic status unchecked for a saved No answer', () => {
    document.body.innerHTML = `
      <input id="hispanic" type="checkbox" checked />
      <label for="hispanic">I am Hispanic or Latino.</label>`;
    const checkbox = document.getElementById('hispanic') as HTMLInputElement;
    const disclosureProfile = {
      ...profile,
      disclosures: { ...profile.disclosures, hispanicOrLatino: 'No' },
    };

    expect(fillFields([{
      element: checkbox,
      label: 'I am Hispanic or Latino.',
      kind: 'checkbox',
      profileKey: 'disclosures.hispanicOrLatino',
    }], disclosureProfile)).toEqual({ filled: 1, flagged: 0 });
    expect(checkbox.checked).toBe(false);
  });
});

describe('findMatchIndex', () => {
  it('finds an exact match across multiple candidates', () => {
    expect(findMatchIndex(['Yes', 'No'], ['no'])).toBe(1);
  });

  it('finds a whole-word match, preferring longer candidates first', () => {
    expect(findMatchIndex(['-- Select State or Province --', 'OR - Oregon'], ['or', 'oregon'])).toBe(1);
  });

  it('returns null when nothing matches', () => {
    expect(findMatchIndex(['Yes', 'No'], ['maybe'])).toBeNull();
  });
});

describe('buildCandidates', () => {
  it('expands state abbreviations', () => {
    expect(buildCandidates('personal.state', 'NC')).toEqual(['NC', 'North Carolina']);
  });

  it('prefers United States of America for the country field', () => {
    expect(buildCandidates('personal.country', 'United States')).toEqual([
      'United States of America',
      'United States',
    ]);
    expect(
      findMatchIndex(
        ['United States Minor Outlying Islands', 'United States of America'],
        buildCandidates('personal.country', 'United States')
      )
    ).toBe(1);
  });

  it('returns a single-item list for non-state fields', () => {
    expect(buildCandidates('workAuthorization.authorizedToWork', 'yes')).toEqual(['yes']);
  });

  it('expands controlled veteran-status wording variants', () => {
    const candidates = buildCandidates(
      'disclosures.veteranStatus',
      'I identify as one or more of the classifications of protected veteran'
    );
    expect(candidates).toContain('I identify as one or more of the classifications of a protected veteran');
    expect(findMatchIndex(
      ['I am not a protected veteran', 'I identify as one or more of the classifications of a protected veteran'],
      candidates
    )).toBe(1);
    const notVeteranCandidates = buildCandidates('disclosures.veteranStatus', 'I am not a veteran');
    expect(notVeteranCandidates).toContain('I am not a protected veteran');
    expect(findMatchIndex(
      ['I am not a protected veteran', 'I am not a veteran'],
      notVeteranCandidates
    )).toBe(1);
    expect(findMatchIndex(['I am not a protected veteran'], notVeteranCandidates)).toBe(0);
    expect(buildCandidates('disclosures.veteranStatus', 'I am not a protected veteran')).toEqual([
      'I am not a protected veteran',
    ]);
  });

  it('maps veteran status to compact iCIMS options', () => {
    expect(buildCandidates(
      'disclosures.veteranStatus',
      'I identify as one or more of the classifications of protected veterans listed above'
    )).toContain('Yes');
    expect(buildCandidates(
      'disclosures.veteranStatus',
      'I identify as one or more of the classifications of protected veterans listed above'
    )).toContain('ProtectedVeteran');
    expect(buildCandidates('disclosures.veteranStatus', 'I am not a veteran')).toContain('No');
    expect(buildCandidates('disclosures.veteranStatus', 'I am not a veteran')).toContain('NotProtectedVeteran');
    expect(buildCandidates('disclosures.veteranStatus', 'I do not wish to answer')).toContain('Opt Out');
    expect(buildCandidates('disclosures.veteranStatus', 'I do not wish to answer')).toContain('optout');
  });

  it('maps disability status to truncated iCIMS options', () => {
    const yesCandidates = buildCandidates(
      'disclosures.disabilityStatus',
      'Yes, I have a disability, or have had one in the past'
    );
    expect(yesCandidates).toContain('I identify as having a disability or a record of d');
    expect(findMatchIndex([
      'I do not identify as having a disability or a reco',
      'I identify as having a disability or a record of d',
      'Opt Out',
    ], yesCandidates)).toBe(1);

    const noCandidates = buildCandidates(
      'disclosures.disabilityStatus',
      'No, I do not have a disability and have not had one in the past'
    );
    expect(findMatchIndex([
      'I do not identify as having a disability or a reco',
      'I identify as having a disability or a record of d',
      'Opt Out',
    ], noCandidates)).toBe(0);
    expect(buildCandidates(
      'disclosures.disabilityStatus',
      'I do not want to answer'
    )).toContain('Opt Out');
  });
});
