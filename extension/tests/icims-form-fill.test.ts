import { beforeEach, describe, expect, it } from 'vitest';
import { fillIcimsForm } from '../src/fill-engine/icims-form-fill';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';

describe('fillIcimsForm', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('answers the anticipated-graduation and GPA-range job questions from education', () => {
    document.body.innerHTML = `
      <label for="Q237">What is your anticipated graduation date if still in school? Example: May 2029 or NA if already graduated. *</label>
      <input id="Q237" name="Q237" type="text" />
      <label for="Q16">What is/was your cumulative grade point average (GPA) on a 4.0 scale? *</label>
      <select id="Q16" name="Q16">
        <option value="">— Make a Selection —</option>
        <option value="a">2.99 or lower</option>
        <option value="b">3.0 - 3.24</option>
        <option value="c">3.25 - 3.49</option>
        <option value="d">3.50 - 3.74</option>
        <option value="e">3.75 - 3.99</option>
        <option value="f">4.0 or above</option>
      </select>
    `;
    const now = new Date();
    const futureYear = now.getFullYear() + 2;
    const profile = {
      ...DEFAULT_PROFILE,
      education: [{
        school: 'Duke University', degree: 'BSE', fieldOfStudy: 'ECE',
        graduationDate: `05/${futureYear}`, endYear: String(futureYear), gpa: '3.82',
      }],
    };

    expect(fillIcimsForm(profile)).toEqual({ filled: 2, flagged: 0 });
    expect((document.getElementById('Q237') as HTMLInputElement).value).toBe(`May ${futureYear}`);
    expect((document.getElementById('Q16') as HTMLSelectElement).value).toBe('e'); // 3.82 -> 3.75-3.99
  });

  it('converts an annual salary to the matching iCIMS hourly wage-range option', () => {
    document.body.innerHTML = `
      <label for="Q124">What is your expected hourly wage range? *</label>
      <select id="Q124" name="Q124">
        <option value="">— Make a Selection —</option>
        <option value="a">$12.00 - $14.00 per hour</option>
        <option value="b">$18.01 - $21.00 per hour</option>
        <option value="c">$33.01 - $36.00 per hour</option>
        <option value="d">More than $36.00 per hour</option>
      </select>
    `;
    // 85000 / 2080 ≈ $40.87/hr -> "More than $36.00 per hour"
    const profile = { ...DEFAULT_PROFILE, jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, minimumSalary: '85000' } };
    expect(fillIcimsForm(profile)).toEqual({ filled: 1, flagged: 0 });
    expect((document.getElementById('Q124') as HTMLSelectElement).value).toBe('d');
  });

  it('maps a ~$40k salary into a mid hourly band', () => {
    document.body.innerHTML = `
      <label for="Q124">Expected hourly wage range *</label>
      <select id="Q124" name="Q124">
        <option value="">--</option>
        <option value="lo">$12.00 - $14.00 per hour</option>
        <option value="mid">$18.01 - $21.00 per hour</option>
        <option value="hi">More than $36.00 per hour</option>
      </select>
    `;
    // 40000 / 2080 ≈ $19.23/hr
    const profile = { ...DEFAULT_PROFILE, jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, minimumSalary: '$40,000 annually' } };
    expect(fillIcimsForm(profile)).toEqual({ filled: 1, flagged: 0 });
    expect((document.getElementById('Q124') as HTMLSelectElement).value).toBe('mid');
  });

  it('returns "NA" for anticipated graduation when the degree is already complete', () => {
    document.body.innerHTML = `
      <label for="Q237">What is your anticipated graduation date if still in school? *</label>
      <input id="Q237" name="Q237" type="text" />
    `;
    const profile = {
      ...DEFAULT_PROFILE,
      education: [{ school: 'Duke', degree: 'BSE', fieldOfStudy: 'ECE', graduationDate: '05/2019', endYear: '2019' }],
    };
    expect(fillIcimsForm(profile)).toEqual({ filled: 1, flagged: 0 });
    expect((document.getElementById('Q237') as HTMLInputElement).value).toBe('NA');
  });

  it('fills missing iCIMS education GPA and compound dates without rewriting parsed values', () => {
    document.body.innerHTML = `
      <input id="icims_0_School" value="Resume Parsed University" />
      <input id="icims_0_GPA" />
      <select id="icims_0_EducationStartDate_Month"><option value="0"></option><option value="08">Aug</option></select>
      <select id="icims_0_EducationStartDate_Date"><option value="0"></option><option value="1">1</option></select>
      <input id="icims_0_EducationStartDate_Year" />
      <select id="icims_0_GraduationDate_Month"><option value="0"></option><option value="05" selected>May</option></select>
      <select id="icims_0_GraduationDate_Date"><option value="0"></option><option value="1" selected>1</option></select>
      <input id="icims_0_GraduationDate_Year" value="2027" />
    `;
    const profile = {
      ...DEFAULT_PROFILE,
      education: [{
        school: 'Duke University', degree: 'BS', fieldOfStudy: 'ECE', graduationDate: '05/2027',
        startDate: '08/2023', endDate: '05/2027', gpa: '3.8',
      }],
    };

    expect(fillIcimsForm(profile)).toEqual({ filled: 4, flagged: 0 });
    expect((document.getElementById('icims_0_School') as HTMLInputElement).value).toBe('Resume Parsed University');
    expect((document.getElementById('icims_0_GPA') as HTMLInputElement).value).toBe('3.8');
    expect((document.getElementById('icims_0_EducationStartDate_Month') as HTMLSelectElement).value).toBe('08');
    expect((document.getElementById('icims_0_EducationStartDate_Date') as HTMLSelectElement).value).toBe('1');
    expect((document.getElementById('icims_0_EducationStartDate_Year') as HTMLInputElement).value).toBe('2023');
  });

  it('clears applicant contact data from a self-reference and phone extension only', () => {
    document.body.innerHTML = `
      <input id="icims_0_PhoneExtension" value="919-555-0123" />
      <input id="icims_0_EmpPhone" value="919-555-0123" />
      <input id="icims_f_EmployerPhoneNumber" value="(919) 555-0123" />
      <input id="icims_0_SupPhone" value="919-555-0123" />
      <input id="icims_0_Ref1FirstName" value="Jorge" />
      <input id="icims_0_Ref1LastName" value="Rivera" />
      <input id="icims_0_Ref1Email" value="jorge@example.com" />
      <input id="icims_0_Ref1Phone" value="(919) 555-0123" />
      <input id="icims_0_Ref2FirstName" value="Jorge" />
      <input id="icims_0_Ref2LastName" value="Smith" />
      <input id="icims_0_Ref2Email" value="reference@example.com" />
    `;
    const profile = {
      ...DEFAULT_PROFILE,
      personal: {
        ...DEFAULT_PROFILE.personal,
        firstName: 'Jorge', lastName: 'Rivera', email: 'jorge@example.com', phone: '9195550123',
      },
    };

    fillIcimsForm(profile);
    expect((document.getElementById('icims_0_PhoneExtension') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('icims_0_EmpPhone') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('icims_f_EmployerPhoneNumber') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('icims_0_SupPhone') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('icims_0_Ref1FirstName') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('icims_0_Ref1LastName') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('icims_0_Ref1Email') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('icims_0_Ref1Phone') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('icims_0_Ref2FirstName') as HTMLInputElement).value).toBe('Jorge');
    expect((document.getElementById('icims_0_Ref2Email') as HTMLInputElement).value).toBe('reference@example.com');
  });

  it('restores saved line breaks when iCIMS flattened an otherwise identical description', () => {
    document.body.innerHTML = `
      <textarea id="icims_0_EmpDescription">Built the system. - Improved reliability.</textarea>
      <textarea id="icims_1_EmpDescription">Manually edited application text.</textarea>
    `;
    const profile = {
      ...DEFAULT_PROFILE,
      workHistory: [
        { company: '', title: '', startDate: '', endDate: '', description: '- Built the system.\n- Improved reliability.' },
        { company: '', title: '', startDate: '', endDate: '', description: '- Saved profile text.' },
      ],
    };

    expect(fillIcimsForm(profile)).toEqual({ filled: 1, flagged: 0 });
    expect((document.getElementById('icims_0_EmpDescription') as HTMLTextAreaElement).value)
      .toBe('- Built the system.\n- Improved reliability.');
    expect((document.getElementById('icims_1_EmpDescription') as HTMLTextAreaElement).value)
      .toBe('Manually edited application text.');
  });

  it('fills today on an iCIMS voluntary-identification form without checking its signature', () => {
    document.body.innerHTML = `
      <input name="icims_f_Veteran" type="radio" value="NotProtectedVeteran" />
      <select id="icims_f_Date_Month"><option value="0"></option>${Array.from({ length: 12 }, (_, index) =>
        `<option value="${String(index + 1).padStart(2, '0')}">${index + 1}</option>`).join('')}</select>
      <select id="icims_f_Date_Date"><option value="0"></option>${Array.from({ length: 31 }, (_, index) =>
        `<option value="${index + 1}">${index + 1}</option>`).join('')}</select>
      <input id="icims_f_Date_Year" />
      <input id="icims_f_signature" type="checkbox" />
    `;
    const today = new Date();

    expect(fillIcimsForm(DEFAULT_PROFILE)).toEqual({ filled: 3, flagged: 0 });
    expect((document.getElementById('icims_f_Date_Month') as HTMLSelectElement).value)
      .toBe(String(today.getMonth() + 1).padStart(2, '0'));
    expect((document.getElementById('icims_f_Date_Date') as HTMLSelectElement).value)
      .toBe(String(today.getDate()));
    expect((document.getElementById('icims_f_Date_Year') as HTMLInputElement).value)
      .toBe(String(today.getFullYear()));
    expect((document.getElementById('icims_f_signature') as HTMLInputElement).checked).toBe(false);
  });
});
