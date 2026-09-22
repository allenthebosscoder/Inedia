import { describe, it, expect, beforeEach } from 'vitest';
import { extractFields } from '../src/fill-engine/generic-adapter';
import { fillFields } from '../src/fill-engine/fill-engine';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';

describe('extractFields', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves label via label[for]', () => {
    document.body.innerHTML = `
      <label for="fname">First Name</label>
      <input id="fname" type="text" />
    `;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].label).toBe('First Name');
    expect(fields[0].profileKey).toBe('personal.firstName');
  });

  it('resolves label via aria-label when no label element exists', () => {
    document.body.innerHTML = `<input type="text" aria-label="Email Address" />`;
    const fields = extractFields(document);
    expect(fields[0].profileKey).toBe('personal.email');
  });

  it('resolves Workday question text referenced by aria-labelledby', () => {
    document.body.innerHTML = `
      <div id="relocation-question">If the position requires, are you able to relocate?</div>
      <button aria-haspopup="listbox" aria-labelledby="relocation-question">Select One</button>
    `;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].label).toBe('If the position requires, are you able to relocate?');
    expect(fields[0].profileKey).toBe('jobPreferences.willingToRelocate');
  });

  it('falls back to placeholder text', () => {
    document.body.innerHTML = `<input type="text" placeholder="Phone Number" />`;
    const fields = extractFields(document);
    expect(fields[0].profileKey).toBe('personal.phone');
  });

  it('uses iCIMS phone metadata when its visible label is only Number', () => {
    document.body.innerHTML = `
      <label for="phoneNumber">Number</label>
      <input id="phoneNumber" name="css_phoneNumber" type="text" />
    `;
    expect(extractFields(document)).toEqual([
      expect.objectContaining({ kind: 'text', profileKey: 'personal.phone' }),
    ]);
  });

  it('recognizes an iCIMS role combobox that omits aria-haspopup', () => {
    document.body.innerHTML = `
      <a id="dropdown" role="combobox" aria-controls="dropdownOptions"
        aria-label="Country Code — Make a Selection —" aria-required="true"></a>
      <div id="dropdownOptions"><ul role="listbox"><li role="option">(+1) United States</li></ul></div>
    `;
    expect(extractFields(document)).toEqual([
      expect.objectContaining({ kind: 'combobox', profileKey: 'personal.phoneCountryCode' }),
    ]);
  });

  it('keeps an iCIMS native select as a select even when it declares role=combobox', () => {
    document.body.innerHTML = `
      <label id="label_Q109" for="Q109">Are you authorized to work for any employer in the United States?*</label>
      <select id="Q109" role="combobox" aria-controls="Q109_listbox" aria-labelledby="label_Q109">
        <option value="">Make a Selection</option><option>Yes</option><option>No</option>
      </select>
    `;

    expect(extractFields(document)).toEqual([
      expect.objectContaining({ kind: 'select', profileKey: 'workAuthorization.authorizedToWork' }),
    ]);
  });

  it('maps and corrects an iCIMS US-sponsorship native select', () => {
    document.body.innerHTML = `
      <label id="label_Q1846" for="Q1846">Do you require US sponsorship now or in the future?*</label>
      <select id="Q1846" name="Q1846" role="combobox" aria-labelledby="label_Q1846">
        <option value="">Make a Selection</option><option value="Yes">Yes</option><option value="No" selected>No</option>
      </select>
    `;
    const profile = {
      ...DEFAULT_PROFILE,
      workAuthorization: { ...DEFAULT_PROFILE.workAuthorization, requiresSponsorship: 'yes' as const },
    };

    const fields = extractFields(document);
    expect(fields).toEqual([
      expect.objectContaining({ kind: 'select', profileKey: 'workAuthorization.requiresSponsorship' }),
    ]);
    expect(fillFields(fields, profile)).toEqual({ filled: 1, flagged: 0 });
    expect((document.getElementById('Q1846') as HTMLSelectElement).value).toBe('Yes');
  });

  it('uses EEO metadata to distinguish Hispanic/Latino ethnicity from the separate Race field', () => {
    document.body.innerHTML = `
      <span id="Additional_Questions___US_EEO2c_Ethnicity_label">Ethnicity</span>
      <input id="ethnicity" role="combobox" aria-controls="ethnicity-options"
        aria-labelledby="Additional_Questions___US_EEO2c_Ethnicity_label" />
      <span id="Additional_Questions___US_EEO2C_1_Race_label">Race - Select the races you identify with</span>
      <input id="race" role="combobox" aria-controls="race-options"
        aria-labelledby="Additional_Questions___US_EEO2C_1_Race_label" />
    `;

    expect(extractFields(document).map(({ profileKey }) => profileKey)).toEqual([
      'disclosures.hispanicOrLatino',
      'disclosures.raceEthnicity',
    ]);
  });

  it('recognizes generic start-date and numeric salary inputs', () => {
    document.body.innerHTML = `
      <label for="available">Available start date</label><input id="available" type="date" />
      <label for="salary">Minimum salary requirement</label><input id="salary" type="number" />
    `;
    const fields = extractFields(document);
    expect(fields.map(({ profileKey }) => profileKey)).toEqual([
      'jobPreferences.availableStartDate',
      'jobPreferences.minimumSalary',
    ]);
  });

  it('uses iCIMS group metadata for age radios and compound available-start-date controls', () => {
    document.body.innerHTML = `
      <input id="icims_f_Over_18_Yes" name="icims_f_Over_18" type="radio" value="Yes" />
      <label for="icims_f_Over_18_Yes">Yes</label>
      <select id="icims_f_DateAvailableToStart_Month" name="icims_f_DateAvailableToStart_Month">
        <option value="0"></option><option value="09">Sep</option>
      </select><label for="icims_f_DateAvailableToStart_Month">Month</label>
      <input id="icims_f_DateAvailableToStart_Year" name="icims_f_DateAvailableToStart_Year" />
      <label for="icims_f_DateAvailableToStart_Year">Year</label>
    `;

    expect(extractFields(document).map(({ profileKey }) => profileKey)).toEqual([
      'jobPreferences.atLeast18',
      'jobPreferences.availableStartDate',
      'jobPreferences.availableStartDate',
    ]);
  });

  it('fills the iCIMS CandProfileFields AvailableDate month, day, and year variant', () => {
    document.body.innerHTML = `
      <span id="label_CandProfileFields.AvailableDate">Avail. Date (Month / Day / Year)</span>
      <label id="available-month-label" for="CandProfileFields.AvailableDate_Month">Month</label>
      <select id="CandProfileFields.AvailableDate_Month" name="CandProfileFields.AvailableDate_Month"
        aria-labelledby="label_CandProfileFields.AvailableDate available-month-label">
        <option value="0"></option><option value="05">May</option>
      </select>
      <label id="available-day-label" for="CandProfileFields.AvailableDate_Date">Day</label>
      <select id="CandProfileFields.AvailableDate_Date" name="CandProfileFields.AvailableDate_Date"
        aria-labelledby="label_CandProfileFields.AvailableDate available-day-label">
        <option value="0"></option><option value="3">3</option>
      </select>
      <label id="available-year-label" for="CandProfileFields.AvailableDate_Year">Year</label>
      <input id="CandProfileFields.AvailableDate_Year" name="CandProfileFields.AvailableDate_Year"
        aria-labelledby="label_CandProfileFields.AvailableDate available-year-label" />
    `;
    const profile = {
      ...DEFAULT_PROFILE,
      jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, availableStartDate: '2027-05-03' },
    };

    const fields = extractFields(document);
    expect(fields.map(({ profileKey }) => profileKey)).toEqual([
      'jobPreferences.availableStartDate',
      'jobPreferences.availableStartDate',
      'jobPreferences.availableStartDate',
    ]);
    expect(fillFields(fields, profile)).toEqual({ filled: 3, flagged: 0 });
    expect((document.getElementById('CandProfileFields.AvailableDate_Month') as HTMLSelectElement).value).toBe('05');
    expect((document.getElementById('CandProfileFields.AvailableDate_Date') as HTMLSelectElement).value).toBe('3');
    expect((document.getElementById('CandProfileFields.AvailableDate_Year') as HTMLInputElement).value).toBe('2027');
  });

  it('uses a Workable radiogroup label for U.S.-person yes/no inputs', () => {
    document.body.innerHTML = `
      <span id="us-person-label">U.S. Person</span>
      <fieldset role="radiogroup" aria-labelledby="us-person-label">
        <label><input type="radio" name="QA_1" value="true" />YES</label>
        <label><input type="radio" name="QA_1" value="false" />NO</label>
      </fieldset>
    `;

    expect(extractFields(document).map(({ profileKey }) => profileKey)).toEqual([
      'workAuthorization.usPerson',
      'workAuthorization.usPerson',
    ]);
  });

  it('distinguishes Workable Resume from a required Transcript upload', () => {
    document.body.innerHTML = `
      <div><strong id="resume-label">Resume</strong><label for="resume">Choose file</label>
        <input id="resume" type="file" aria-labelledby="resume-label" required /></div>
      <div><strong id="transcript-label">Transcript</strong><label for="transcript">Choose file</label>
        <input id="transcript" type="file" aria-labelledby="transcript-label" required /></div>
    `;

    expect(extractFields(document).map(({ label }) => label)).toEqual(['Resume', 'Transcript']);
  });

  it('does not treat iCIMS references, supervisors, education, or phone extensions as applicant identity', () => {
    document.body.innerHTML = `
      <input id="icims_0_Ref1FirstName" aria-label="Ref1FirstName" />
      <input id="icims_0_Ref1Email" aria-label="Ref1Email" />
      <input id="icims_0_SupPhone" aria-label="SupPhone" />
      <input id="icims_0_GPA" />
      <input id="icims_0_PhoneExtension" aria-label="PhoneExtension" />
      <input id="icims_f_EmployerPhoneNumber" aria-label="Employer Phone Number" />
    `;

    expect(extractFields(document)).toEqual([]);
  });

  it('does not copy address line 1 into Workday address line 2 or county', () => {
    document.body.innerHTML = `
      <label for="line1">Address Line 1</label><input id="line1" />
      <label for="line2">Address Line 2</label><input id="line2" />
      <label for="county">County</label><input id="county" />
    `;

    expect(extractFields(document).map(({ profileKey }) => profileKey)).toEqual([
      'personal.address',
      'personal.addressLine2',
      'personal.county',
    ]);
  });

  it('recognizes a Workday-style question whose control has no direct label association', () => {
    document.body.innerHTML = `
      <section><div>Are you a United States citizen?<span>*</span></div>
        <div><button aria-haspopup="listbox" aria-controls="answers">Select One</button></div>
      </section><div id="answers"></div>
    `;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].profileKey).toBe('jobPreferences.usCitizen');
  });

  it('uses a long Workday fieldset legend for sponsorship and U.S. person dropdowns', () => {
    const explanation = 'Export-control and immigration legal explanation '.repeat(30);
    document.body.innerHTML = `
      <fieldset><legend>${explanation} Will you now or in the future require sponsorship for an immigration-related employment benefit?</legend>
        <button aria-haspopup="listbox" aria-label="Select One Required">Select One</button>
      </fieldset>
      <fieldset><legend>${explanation} Are you a U.S. person?</legend>
        <button aria-haspopup="listbox" aria-label="Select One Required">Select One</button>
      </fieldset>
    `;

    expect(extractFields(document).map(({ profileKey }) => profileKey)).toEqual([
      'workAuthorization.requiresSponsorship',
      'workAuthorization.usPerson',
    ]);
  });

  it('uses unsupported Workday questionnaire legends so required questions are not missed', () => {
    document.body.innerHTML = `
      <fieldset><legend>Are you currently employed by the State of North Carolina?*</legend>
        <button id="primaryQuestionnaire--tenant-id" aria-haspopup="listbox"
          aria-label=" Select One Required">Select One</button>
      </fieldset>
    `;

    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      label: 'Are you currently employed by the State of North Carolina?*',
      profileKey: null,
    });
  });

  it('uses full legends for Workday secondary questionnaire dropdowns', () => {
    document.body.innerHTML = `
      <fieldset><legend>Did you attend an NVIDIA university event in the past 3 months?*</legend>
        <button id="secondaryQuestionnaire--event" aria-haspopup="listbox"
          aria-label="Select One Required">Select One</button>
      </fieldset>
    `;

    expect(extractFields(document)).toEqual([expect.objectContaining({
      label: 'Did you attend an NVIDIA university event in the past 3 months?*',
      kind: 'combobox',
      profileKey: null,
    })]);
  });

  it('recognizes Workday voluntary-disclosure dropdowns with tenant-specific labeling', () => {
    document.body.innerHTML = `
      <button aria-haspopup="listbox" name="hispanicOrLatino"
        id="personalInfoUS--hispanicOrLatino">Select One</button>
      <button aria-haspopup="listbox" name="ethnicity" id="personalInfoUS--ethnicity"
        aria-label="Please select the ethnicity which most accurately describes how you identify yourself: Select One Required">Select One</button>
    `;

    expect(extractFields(document).map(({ profileKey }) => profileKey)).toEqual([
      'disclosures.hispanicOrLatino',
      'disclosures.raceEthnicity',
    ]);
  });

  it('recognizes the plural Veterans status label used by Analog Devices Workday', () => {
    document.body.innerHTML = `
      <button id="personalInfoUS--veteranStatus" name="veteranStatus"
        aria-haspopup="listbox" aria-label="Veterans status Select One Required">Select One</button>
    `;

    expect(extractFields(document)).toEqual([
      expect.objectContaining({
        kind: 'combobox',
        profileKey: 'disclosures.veteranStatus',
      }),
    ]);
  });

  it('maps Workday ethnicity checkbox answers through their group metadata', () => {
    document.body.innerHTML = `
      <fieldset id="personalInfoUS--ethnicityMulti" data-automation-id="ethnicityMulti-CheckboxGroup"
        aria-required="true">
        <input id="race-asian" type="checkbox" aria-required="true" />
        <label for="race-asian">Asian (Not Hispanic or Latino) (United States of America)</label>
        <input id="race-white" type="checkbox" aria-required="true" />
        <label for="race-white">White (Not Hispanic or Latino) (United States of America)</label>
      </fieldset>
    `;

    expect(extractFields(document)).toEqual([
      expect.objectContaining({ profileKey: 'disclosures.raceEthnicity' }),
      expect.objectContaining({ profileKey: 'disclosures.raceEthnicity' }),
    ]);
  });

  it('associates all sections of a Workday composite date with its surrounding question', () => {
    document.body.innerHTML = `
      <section><div>Please provide your available start date.</div><div data-automation-id="dateInputWrapper">
        <input id="available-dateSectionMonth-input" aria-label="Month" />
        <input id="available-dateSectionDay-input" aria-label="Day" />
        <input id="available-dateSectionYear-input" aria-label="Year" />
      </div></section>
    `;
    expect(extractFields(document).map(({ profileKey }) => profileKey)).toEqual([
      'jobPreferences.availableStartDate',
      'jobPreferences.availableStartDate',
      'jobPreferences.availableStartDate',
    ]);
  });

  it('leaves profileKey null for unrecognized fields, e.g. essay questions', () => {
    document.body.innerHTML = `
      <label for="essay">Why do you want to work here?</label>
      <textarea id="essay"></textarea>
    `;
    const fields = extractFields(document);
    expect(fields[0].kind).toBe('textarea');
    expect(fields[0].profileKey).toBeNull();
  });

  it('resolves a Lever-style "Full name" field to personal.fullName', () => {
    document.body.innerHTML = `
      <label for="name-input">Full name</label>
      <input id="name-input" type="text" />
    `;
    const fields = extractFields(document);
    expect(fields[0].profileKey).toBe('personal.fullName');
  });

  it('excludes disabled fields even when they would otherwise match a synonym', () => {
    document.body.innerHTML = `<input type="text" aria-label="Email Address" disabled />`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(0);
  });

  it('excludes readonly fields', () => {
    document.body.innerHTML = `<input type="text" aria-label="Email Address" readonly />`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(0);
  });

  it('excludes hidden fields (the hidden attribute)', () => {
    document.body.innerHTML = `<input type="text" aria-label="Email Address" hidden />`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(0);
  });

  it('excludes fields inline-styled display:none, including via a hidden ancestor', () => {
    document.body.innerHTML = `
      <input type="text" aria-label="Email Address" style="display:none" />
      <div style="display:none"><input type="text" aria-label="Phone Number" /></div>
    `;
    const fields = extractFields(document);
    expect(fields).toHaveLength(0);
  });

  it('excludes fields inline-styled visibility:hidden', () => {
    document.body.innerHTML = `<input type="text" aria-label="Email Address" style="visibility:hidden" />`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(0);
  });

  it('excludes fields hidden by a stylesheet class on an inactive application step', () => {
    const style = document.createElement('style');
    style.textContent = '.inactive-step { display: none; }';
    document.head.appendChild(style);
    document.body.innerHTML = `<section class="inactive-step"><input aria-label="First Name" /></section>`;
    expect(extractFields(document)).toHaveLength(0);
    style.remove();
  });

  it('does not inherit an ancestor First Name label for a directly labelled preferred-name checkbox', () => {
    document.body.innerHTML = `
      <section><label for="first">First Name</label><input id="first" />
        <label for="preferred">I have a preferred name</label><input id="preferred" type="checkbox" />
      </section>
    `;
    const fields = extractFields(document);
    expect(fields[1]).toMatchObject({ label: 'I have a preferred name', profileKey: null });
  });

  it('does not map a preferred-name checkbox from a generic Name fieldset', () => {
    document.body.innerHTML = `
      <fieldset id="name">
        <legend>Name</legend>
        <label for="preferred">I have a preferred name</label>
        <input id="preferred" name="preferredCheck" type="checkbox" />
      </fieldset>
    `;

    const [field] = extractFields(document);

    expect(field).toMatchObject({ label: 'I have a preferred name', profileKey: null });
  });

  it('still includes ordinary visible, enabled, editable fields', () => {
    document.body.innerHTML = `<input type="text" aria-label="Email Address" />`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].profileKey).toBe('personal.email');
  });

  it('excludes unlabeled internal inputs and combobox buttons', () => {
    document.body.innerHTML = `
      <input type="text" />
      <button id="settingsSelectorButton" aria-haspopup="listbox" type="submit">Settings</button>
    `;
    expect(extractFields(document)).toHaveLength(0);
  });

  it('detects a hidden resume file input through its Workday container', () => {
    document.body.innerHTML = `
      <div data-automation-id="resumeUpload"><span>Upload your resume</span>
        <input id="resume-file" type="file" style="display: none" />
      </div>
    `;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe('file');
    expect(fields[0].label).toContain('resume');
  });

  it('uses Workable data-ui metadata to distinguish Resume from another upload', () => {
    document.body.innerHTML = `
      <div><label for="resume-upload">Choose file</label>
        <input id="resume-upload" data-ui="resume" type="file" required /></div>
      <div><strong id="transcript-heading">Transcript</strong><label for="transcript-upload">Choose file</label>
        <input id="transcript-upload" data-ui="QA_123" aria-labelledby="transcript-heading" type="file" required /></div>
    `;

    const fields = extractFields(document);
    expect(fields.find((field) => field.element.id === 'resume-upload')?.label).toBe('Resume');
    expect(fields.find((field) => field.element.id === 'transcript-upload')?.label).toContain('Transcript');
  });

  it('attaches a stored resume only to Workable Resume and leaves Transcript manual', () => {
    document.body.innerHTML = `
      <div><label for="resume-upload">Choose file</label>
        <input id="resume-upload" data-ui="resume" type="file" required /></div>
      <div><strong id="transcript-heading">Transcript</strong><label for="transcript-upload">Choose file</label>
        <input id="transcript-upload" data-ui="QA_123" aria-labelledby="transcript-heading" type="file" required /></div>
    `;
    const profile = {
      ...DEFAULT_PROFILE,
      resume: {
        name: 'synthetic-resume.pdf',
        type: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,JVBERi0xLjQ=',
      },
    };

    const summary = fillFields(extractFields(document), profile);
    const resume = document.getElementById('resume-upload') as HTMLInputElement;
    const transcript = document.getElementById('transcript-upload') as HTMLInputElement;
    expect(resume.files?.[0]?.name).toBe('synthetic-resume.pdf');
    expect(transcript.files).toHaveLength(0);
    expect(transcript.dataset.autofillFlag).toBe('needs-input');
    expect(summary).toEqual({ filled: 1, flagged: 1 });
  });

  it('associates Workday file-upload-input-ref with its sibling resume button', () => {
    document.body.innerHTML = `
      <div><button id="resumeAttachments--attachments" data-automation-id="select-files">Select files</button></div>
      <div><input data-automation-id="file-upload-input-ref" type="file" multiple style="display:none" /></div>
    `;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ kind: 'file', label: 'Resume' });
  });

  it('detects an ARIA combobox trigger via aria-haspopup="listbox"', () => {
    document.body.innerHTML = `<button aria-haspopup="listbox" aria-label="State North Carolina Required">North Carolina</button>`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe('combobox');
    expect(fields[0].profileKey).toBe('personal.state');
  });

  it('excludes Workday account settings from application comboboxes', () => {
    document.body.innerHTML = `
      <header>State of North Carolina Careers
        <button id="settingsSelectorButton" data-automation-id="utilityMenuButton"
          aria-haspopup="listbox">Settings</button>
      </header>
    `;

    expect(extractFields(document)).toEqual([]);
  });

  it('excludes a disabled combobox trigger', () => {
    document.body.innerHTML = `<button aria-haspopup="listbox" aria-label="State" disabled>--</button>`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(0);
  });

  it('detects a combobox trigger with no recognized label, leaving profileKey null', () => {
    document.body.innerHTML = `<button aria-haspopup="listbox" aria-label="Preferred Pronouns">--</button>`;
    const fields = extractFields(document);
    expect(fields[0].kind).toBe('combobox');
    expect(fields[0].profileKey).toBeNull();
  });

  it('does not replace an explicit unsupported label with a recognized selected value', () => {
    document.body.innerHTML = `
      <label for="source--source">How Did You Hear About Us?*</label>
      <div data-automation-id="multiselectInputContainer">
        <input id="source--source" data-uxi-widget-type="selectinput" />
        <ul data-automation-id="selectedItemList"><li><div role="option">State of NC Career Website</div></li></ul>
      </div>
    `;

    const [field] = extractFields(document);
    expect(field).toMatchObject({
      label: 'How Did You Hear About Us?*',
      kind: 'combobox',
      profileKey: null,
    });
  });

  it('classifies an input with aria-haspopup="listbox" as a combobox, not a plain text field', () => {
    document.body.innerHTML = `<input type="text" aria-label="School" aria-haspopup="listbox" />`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe('combobox');
  });

  it('classifies a moniker-search-box input (data-uxi-widget-type=selectinput, no aria-haspopup) as a combobox', () => {
    document.body.innerHTML = `<input type="text" aria-label="Country Phone Code" data-uxi-widget-type="selectinput" data-automation-id="searchBox" />`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe('combobox');
    expect(fields[0].profileKey).toBe('personal.phoneCountryCode');
  });

  it('still classifies a data-uxi-widget-type=selectinput input WITH aria-haspopup as a combobox (the already-handled ARIA path, not double-counted)', () => {
    document.body.innerHTML = `<input type="text" aria-label="School" data-uxi-widget-type="selectinput" aria-haspopup="listbox" />`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe('combobox');
  });

  it('excludes a disabled moniker-search-box input', () => {
    document.body.innerHTML = `<input type="text" aria-label="Country Phone Code" data-uxi-widget-type="selectinput" disabled />`;
    const fields = extractFields(document);
    expect(fields).toHaveLength(0);
  });

  it('uses the Oracle radiogroup question instead of its Yes/No answer labels', () => {
    document.body.innerHTML = `
      <div id="auth-label">Are you legally authorized to work in the United States?</div>
      <div role="radiogroup" aria-labelledby="auth-label">
        <input id="auth-yes" name="auth" type="radio" /><label for="auth-yes">Yes</label>
        <input id="auth-no" name="auth" type="radio" /><label for="auth-no">No</label>
      </div>`;

    const fields = extractFields(document);
    expect(fields).toHaveLength(2);
    expect(fields.every((field) => field.profileKey === 'workAuthorization.authorizedToWork')).toBe(true);
  });

  it('uses the Oracle checkbox-group question for individual race choices', () => {
    document.body.innerHTML = `
      <div id="race-label">Select the races you identify with.</div>
      <div role="group" aria-labelledby="race-label">
        <input id="asian" type="checkbox" /><label for="asian">Asian</label>
        <input id="white" type="checkbox" /><label for="white">White</label>
      </div>`;

    const fields = extractFields(document);
    expect(fields).toHaveLength(2);
    expect(fields.every((field) => field.profileKey === 'disclosures.raceEthnicity')).toBe(true);
  });

  it('ignores aria-hidden required-value proxies rendered beside custom selects', () => {
    document.body.innerHTML = `
      <label for="country">Country*</label>
      <input id="country" class="MDFSelectBox__input" role="combobox" aria-haspopup="true" />
      <input required tabindex="-1" aria-hidden="true" />
    `;

    const fields = extractFields(document);

    expect(fields).toHaveLength(1);
    expect(fields[0].element.id).toBe('country');
  });
});
