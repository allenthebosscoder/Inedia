import { describe, it, expect } from 'vitest';
import { serializeProfile, populateForm } from '../src/options/profile-form';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';

const FORM_HTML = `
  <form id="profile-form">
    <input name="personal.firstName" />
    <input name="personal.middleName" />
    <input name="personal.lastName" />
    <input name="personal.email" />
    <input name="personal.phone" />
    <select name="personal.phoneType">
      <option value="">--</option>
      <option value="mobile">Mobile</option>
      <option value="home">Home</option>
      <option value="work">Work</option>
      <option value="other">Other</option>
    </select>
    <input name="personal.phoneCountryCode" />
    <input name="personal.country" />
    <input name="personal.address" />
    <input name="personal.addressLine2" />
    <input name="personal.city" />
    <input name="personal.county" />
    <select name="personal.state">
      <option value="">--</option>
      <option value="NC">North Carolina</option>
      <option value="CA">California</option>
    </select>
    <input name="personal.zip" />
    <select name="workAuthorization.authorizedToWork">
      <option value="">--</option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
    <select name="workAuthorization.requiresSponsorship">
      <option value="">--</option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
    <select name="workAuthorization.plansToUseOPT">
      <option value="">--</option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
    <select name="workAuthorization.usPerson">
      <option value="">--</option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
    <select name="workAuthorization.restrictedCountryStatus">
      <option value="">--</option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
    <input name="jobPreferences.availableStartDate" type="date" />
    <select name="jobPreferences.atLeast18"><option value="">--</option><option value="yes">Yes</option><option value="no">No</option></select>
    <input name="jobPreferences.minimumSalary" />
    <input name="jobPreferences.compensationMax" />
    <select name="jobPreferences.usCitizen"><option value="">--</option><option value="yes">Yes</option><option value="no">No</option></select>
    <select name="jobPreferences.securityClearance"><option value="">--</option><option value="yes">Yes</option><option value="no">No</option></select>
    <select name="jobPreferences.willingToRelocate"><option value="">--</option><option value="yes">Yes</option><option value="no">No</option></select>
    <select name="jobPreferences.willingToWorkOnsite"><option value="">--</option><option value="yes">Yes</option><option value="no">No</option></select>
    <select name="jobPreferences.canCommitInternshipTerm"><option value="">--</option><option value="yes">Yes</option><option value="no">No</option></select>
    <select name="professional.hasNonCompeteAgreement"><option value="">--</option><option value="yes">Yes</option><option value="no">No</option></select>
    <select name="professional.everTerminated"><option value="">--</option><option value="yes">Yes</option><option value="no">No</option></select>
    <select name="professional.highestEducation"><option value="">--</option><option value="bachelors">Bachelor's Degree</option></select>
    <textarea name="professional.skills"></textarea>
    <input name="links.linkedin" />
    <input name="links.portfolio" />
    <input name="links.github" />
  </form>
`;

describe('serializeProfile', () => {
  it('reads form values into a Profile', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    (form.elements.namedItem('personal.firstName') as HTMLInputElement).value = 'Jorge';
    (form.elements.namedItem('personal.middleName') as HTMLInputElement).value = 'Luis';
    (form.elements.namedItem('workAuthorization.authorizedToWork') as HTMLSelectElement).value = 'yes';
    (form.elements.namedItem('workAuthorization.plansToUseOPT') as HTMLSelectElement).value = 'yes';
    (form.elements.namedItem('workAuthorization.usPerson') as HTMLSelectElement).value = 'no';
    (form.elements.namedItem('workAuthorization.restrictedCountryStatus') as HTMLSelectElement).value = 'no';

    const profile = serializeProfile(form, DEFAULT_PROFILE);

    expect(profile.personal.firstName).toBe('Jorge');
    expect(profile.personal.middleName).toBe('Luis');
    expect(profile.workAuthorization.authorizedToWork).toBe('yes');
    expect(profile.workAuthorization.plansToUseOPT).toBe('yes');
    expect(profile.workAuthorization.usPerson).toBe('no');
    expect(profile.workAuthorization.restrictedCountryStatus).toBe('no');
  });

  it('reads phoneType from the form into a Profile', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    (form.elements.namedItem('personal.phoneType') as HTMLSelectElement).value = 'work';

    const profile = serializeProfile(form, DEFAULT_PROFILE);

    expect(profile.personal.phoneType).toBe('work');
  });

  it('reads state from the form into a Profile', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    (form.elements.namedItem('personal.state') as HTMLSelectElement).value = 'NC';

    const profile = serializeProfile(form, DEFAULT_PROFILE);

    expect(profile.personal.state).toBe('NC');
  });

  it('reads and restores separate address line 2 and county values', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    (form.elements.namedItem('personal.addressLine2') as HTMLInputElement).value = 'Apartment 4B';
    (form.elements.namedItem('personal.county') as HTMLInputElement).value = 'Durham';

    const profile = serializeProfile(form, DEFAULT_PROFILE);
    expect(profile.personal.addressLine2).toBe('Apartment 4B');
    expect(profile.personal.county).toBe('Durham');

    (form.elements.namedItem('personal.addressLine2') as HTMLInputElement).value = '';
    (form.elements.namedItem('personal.county') as HTMLInputElement).value = '';
    populateForm(form, profile);
    expect((form.elements.namedItem('personal.addressLine2') as HTMLInputElement).value).toBe('Apartment 4B');
    expect((form.elements.namedItem('personal.county') as HTMLInputElement).value).toBe('Durham');
  });

  it('reads phoneCountryCode from the form into a Profile', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    (form.elements.namedItem('personal.phoneCountryCode') as HTMLInputElement).value = 'Canada';

    const profile = serializeProfile(form, DEFAULT_PROFILE);

    expect(profile.personal.phoneCountryCode).toBe('Canada');
  });

  it('reads reusable job preferences from the form', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    (form.elements.namedItem('jobPreferences.availableStartDate') as HTMLInputElement).value = '2026-09-01';
    (form.elements.namedItem('jobPreferences.atLeast18') as HTMLSelectElement).value = 'yes';
    (form.elements.namedItem('jobPreferences.minimumSalary') as HTMLInputElement).value = '85000';
    (form.elements.namedItem('jobPreferences.usCitizen') as HTMLSelectElement).value = 'yes';
    (form.elements.namedItem('jobPreferences.willingToWorkOnsite') as HTMLSelectElement).value = 'yes';
    const profile = serializeProfile(form, DEFAULT_PROFILE);
    expect(profile.jobPreferences).toMatchObject({ availableStartDate: '2026-09-01', atLeast18: 'yes', minimumSalary: '85000', usCitizen: 'yes', willingToWorkOnsite: 'yes' });
  });

  it('reads reusable professional details from the form', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    (form.elements.namedItem('professional.hasNonCompeteAgreement') as HTMLSelectElement).value = 'no';
    (form.elements.namedItem('professional.highestEducation') as HTMLSelectElement).value = 'bachelors';
    (form.elements.namedItem('professional.skills') as HTMLTextAreaElement).value = 'C++, Python, PCB Design';

    const profile = serializeProfile(form, DEFAULT_PROFILE);
    expect(profile.professional).toEqual({
      hasNonCompeteAgreement: 'no',
      everTerminated: '',
      highestEducation: 'bachelors',
      skills: 'C++, Python, PCB Design',
    });
  });
});

describe('populateForm', () => {
  it('writes a Profile back into the form fields', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, email: 'jorge@example.com' } };

    populateForm(form, profile);

    expect((form.elements.namedItem('personal.email') as HTMLInputElement).value).toBe('jorge@example.com');
  });

  it('writes restricted-country status back into the form', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    const profile = {
      ...DEFAULT_PROFILE,
      workAuthorization: {
        ...DEFAULT_PROFILE.workAuthorization,
        restrictedCountryStatus: 'no' as const,
      },
    };

    populateForm(form, profile);

    expect(
      (form.elements.namedItem('workAuthorization.restrictedCountryStatus') as HTMLSelectElement).value,
    ).toBe('no');
  });

  it('writes phoneType back into the form', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, phoneType: 'home' as const } };

    populateForm(form, profile);

    expect((form.elements.namedItem('personal.phoneType') as HTMLSelectElement).value).toBe('home');
  });

  it('writes state back into the form', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'CA' } };

    populateForm(form, profile);

    expect((form.elements.namedItem('personal.state') as HTMLSelectElement).value).toBe('CA');
  });

  it('writes phoneCountryCode back into the form', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'Canada' } };

    populateForm(form, profile);

    expect((form.elements.namedItem('personal.phoneCountryCode') as HTMLInputElement).value).toBe('Canada');
  });

  it('writes reusable job preferences back into the form', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    const profile = { ...DEFAULT_PROFILE, jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, willingToRelocate: 'yes' as const, willingToWorkOnsite: 'yes' as const, securityClearance: 'no' as const } };
    populateForm(form, profile);
    expect((form.elements.namedItem('jobPreferences.willingToRelocate') as HTMLSelectElement).value).toBe('yes');
    expect((form.elements.namedItem('jobPreferences.willingToWorkOnsite') as HTMLSelectElement).value).toBe('yes');
    expect((form.elements.namedItem('jobPreferences.securityClearance') as HTMLSelectElement).value).toBe('no');
  });

  it('writes reusable professional details back into the form', () => {
    document.body.innerHTML = FORM_HTML;
    const form = document.getElementById('profile-form') as HTMLFormElement;
    const profile = {
      ...DEFAULT_PROFILE,
      professional: {
        hasNonCompeteAgreement: 'no' as const,
        highestEducation: 'bachelors' as const,
        skills: 'C++, Python, PCB Design',
      },
    };
    populateForm(form, profile);
    expect((form.elements.namedItem('professional.hasNonCompeteAgreement') as HTMLSelectElement).value).toBe('no');
    expect((form.elements.namedItem('professional.highestEducation') as HTMLSelectElement).value).toBe('bachelors');
    expect((form.elements.namedItem('professional.skills') as HTMLTextAreaElement).value).toBe('C++, Python, PCB Design');
  });
});
