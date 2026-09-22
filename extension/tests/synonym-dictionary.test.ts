import { describe, it, expect } from 'vitest';
import { lookupFieldKey, matchesWholeWord, normalize } from '../src/fill-engine/synonym-dictionary';

describe('normalize', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalize('Are you legally authorized to work in the US?')).toBe(
      'are you legally authorized to work in the us'
    );
  });
});

describe('lookupFieldKey', () => {
  it('matches visa sponsorship phrasing variants', () => {
    expect(lookupFieldKey('Will you now or in the future require visa sponsorship?')).toBe(
      'workAuthorization.requiresSponsorship'
    );
    expect(lookupFieldKey('Do you require sponsorship to work in this country?')).toBe(
      'workAuthorization.requiresSponsorship'
    );
    expect(lookupFieldKey('Will you now or in the future require sponsorship for an immigration-related employment benefit?')).toBe(
      'workAuthorization.requiresSponsorship'
    );
    expect(lookupFieldKey('Do you now or in the future require any immigration filing or visa sponsorship to maintain work authorization, including sponsorship by Workday, renewal/extension of open work permit, permanent residency, etc.?')).toBe(
      'workAuthorization.requiresSponsorship'
    );
    expect(lookupFieldKey('Will you now or in the future require Relay to commence ("sponsor") an immigration case in order to employ you?')).toBe(
      'workAuthorization.requiresSponsorship'
    );
  });

  it('keeps restricted-country citizenship or residency as an explicit export-control answer', () => {
    expect(lookupFieldKey("This information is sought for compliance with U.S. Export Control laws. Are you a current citizen, national or resident of any of the following countries/regions: Iran, Cuba, North Korea, Syria, Crimea, Donetsk People's Republic (DNR), Luhansk People's Republic (LNR) regions of Ukraine?")).toBe(
      'workAuthorization.restrictedCountryStatus'
    );
    expect(lookupFieldKey('Are you a citizen or resident of Russia or Belarus?')).toBeNull();
    expect(lookupFieldKey('Are you a citizen of any one of these countries: Cuba, Iran, North Korea, or Syria?')).toBe(
      'workAuthorization.restrictedCountryStatus'
    );
    expect(lookupFieldKey('Please indicate whether you are either a citizen or lawful permanent resident of any of the following countries: Cuba, Iran, North Korea, Syria or Sudan.')).toBe(
      'workAuthorization.restrictedCountryStatus'
    );
  });

  it('keeps export-control U.S. person status separate from citizenship', () => {
    expect(lookupFieldKey('Are you a U.S. person?')).toBe('workAuthorization.usPerson');
    expect(lookupFieldKey('Are you a United States citizen?')).toBe('jobPreferences.usCitizen');
  });

  it('recognizes Workday export-control prompts that spell out the U.S.-person categories', () => {
    expect(lookupFieldKey(
      'Are you any of the following: US Citizen, Permanent resident of the United States (Green Card), or, Protected person under 8 USC 1324b(a)(3) (including refugees and asylees)?'
    )).toBe('workAuthorization.usPerson');
  });

  it('matches the live eligible-employment authorization wording', () => {
    expect(lookupFieldKey('Are you legally authorized to work in the US? Eligible Employment:')).toBe(
      'workAuthorization.authorizedToWork'
    );
  });

  it('matches first name variants', () => {
    expect(lookupFieldKey('Legal First Name')).toBe('personal.firstName');
  });

  it('returns null for unrecognized text', () => {
    expect(lookupFieldKey('Why do you want to work here?')).toBeNull();
  });

  it('does not treat "city" as a substring match inside unrelated words like "Specificity"', () => {
    expect(lookupFieldKey('Specificity')).toBeNull();
  });

  it('does not treat "state" as a substring match inside unrelated words like "Statement"', () => {
    expect(lookupFieldKey('Statement of purpose')).toBeNull();
  });

  it('still matches "city" and "state" as whole words', () => {
    expect(lookupFieldKey('City')).toBe('personal.city');
    expect(lookupFieldKey('State')).toBe('personal.state');
  });

  it('still resolves "First Name" to personal.firstName, not personal.fullName, despite "name" being a fullName synonym', () => {
    expect(lookupFieldKey('First Name')).toBe('personal.firstName');
    expect(lookupFieldKey('Last Name')).toBe('personal.lastName');
  });

  it('matches "Full Name" to personal.fullName', () => {
    expect(lookupFieldKey('Full Name')).toBe('personal.fullName');
  });

  it('matches an optional middle-name field', () => {
    expect(lookupFieldKey('Middle Name')).toBe('personal.middleName');
  });

  it('matches phone type phrasing variants', () => {
    expect(lookupFieldKey('Phone Type')).toBe('personal.phoneType');
    expect(lookupFieldKey('Phone Device Type')).toBe('personal.phoneType');
    expect(lookupFieldKey('Device Type')).toBe('personal.phoneType');
  });

  it('still resolves plain phone labels to personal.phone, not personal.phoneType', () => {
    expect(lookupFieldKey('Phone')).toBe('personal.phone');
    expect(lookupFieldKey('Phone Number')).toBe('personal.phone');
  });

  it('does not resolve "Phone Extension" to personal.phone (a different, unsupported field)', () => {
    expect(lookupFieldKey('Phone Extension')).toBeNull();
  });

  it('does not copy the primary phone into optional alternate-number prompts', () => {
    expect(lookupFieldKey('Include any additional phone numbers you would like to be reached by.')).toBeNull();
    expect(lookupFieldKey('Alternate telephone number')).toBeNull();
    expect(lookupFieldKey('Secondary phone')).toBeNull();
  });

  it('does not copy the applicant phone into employer or supervisor contact fields', () => {
    expect(lookupFieldKey('Employer Phone Number')).toBeNull();
    expect(lookupFieldKey('Company Telephone')).toBeNull();
    expect(lookupFieldKey("Supervisor's Phone")).toBeNull();
    expect(lookupFieldKey('Reference Phone')).toBeNull();
  });

  it('matches phone country code phrasing variants', () => {
    expect(lookupFieldKey('Phone Country Code')).toBe('personal.phoneCountryCode');
    expect(lookupFieldKey('Country Code')).toBe('personal.phoneCountryCode');
    expect(lookupFieldKey('Dialing Code')).toBe('personal.phoneCountryCode');
  });

  it('still resolves plain phone labels to personal.phone, not personal.phoneCountryCode', () => {
    expect(lookupFieldKey('Phone')).toBe('personal.phone');
    expect(lookupFieldKey('Phone Number')).toBe('personal.phone');
  });

  it('matches phone country code regardless of word order', () => {
    expect(lookupFieldKey('Phone Country Code')).toBe('personal.phoneCountryCode');
    expect(lookupFieldKey('Country Phone Code')).toBe('personal.phoneCountryCode');
    expect(lookupFieldKey('Country / Territory Phone Code')).toBe('personal.phoneCountryCode');
  });

  it('matches a plain country field without stealing phone country code', () => {
    expect(lookupFieldKey('Country')).toBe('personal.country');
    expect(lookupFieldKey('Country/Region')).toBe('personal.country');
    expect(lookupFieldKey('Country Phone Code')).toBe('personal.phoneCountryCode');
  });

  it('keeps address lines and county as separate profile fields', () => {
    expect(lookupFieldKey('Address Line 1')).toBe('personal.address');
    expect(lookupFieldKey('Address Line 2')).toBe('personal.addressLine2');
    expect(lookupFieldKey('Address Line 3')).toBeNull();
    expect(lookupFieldKey('County')).toBe('personal.county');
  });

  it('does not mistake address words inside screening questions for address fields', () => {
    expect(lookupFieldKey('Are you currently employed by the State of North Carolina?')).toBeNull();
    expect(lookupFieldKey('Are you a resident of any country subject to export restrictions?')).toBeNull();
    expect(lookupFieldKey('Do you live in the city where this role is located?')).toBeNull();
  });

  it('matches reusable job preference questions', () => {
    expect(lookupFieldKey('Please provide your available start date.')).toBe('jobPreferences.availableStartDate');
    expect(lookupFieldKey('Cand Profile Fields Available Date Month')).toBe('jobPreferences.availableStartDate');
    expect(lookupFieldKey('Please provide your minimum salary requirements.')).toBe('jobPreferences.minimumSalary');
    expect(lookupFieldKey('Are you a United States citizen?')).toBe('jobPreferences.usCitizen');
    expect(lookupFieldKey('Do you have a Security Clearance?')).toBe('jobPreferences.securityClearance');
    expect(lookupFieldKey('If the position requires, are you able to relocate?')).toBe('jobPreferences.willingToRelocate');
    expect(lookupFieldKey('Would you consider relocating for this role?')).toBe('jobPreferences.willingToRelocate');
    expect(lookupFieldKey('When is your desired start date?')).toBe('jobPreferences.availableStartDate');
    expect(lookupFieldKey('Are you able to work on-site at our headquarters three days per week?')).toBe('jobPreferences.willingToWorkOnsite');
    expect(lookupFieldKey('Do you plan to work under Optional Practical Training (OPT)?')).toBe('workAuthorization.plansToUseOPT');
  });

  it('recognizes employer-support wording as sponsorship', () => {
    expect(lookupFieldKey('Do you require US sponsorship now or in the future?')).toBe(
      'workAuthorization.requiresSponsorship'
    );
    expect(lookupFieldKey(
      'Will you require employer support to obtain or maintain authorization to work in that country? e.g. (work permit)'
    )).toBe('workAuthorization.requiresSponsorship');
  });

  it('recognizes Workday need-to-be-sponsored wording', () => {
    expect(lookupFieldKey(
      'Will you need to be sponsored for a work visa by Analog Devices either now or in the future?'
    )).toBe('workAuthorization.requiresSponsorship');
  });

  it('recognizes iCIMS immigration-sponsorship and desired-base-salary labels', () => {
    expect(lookupFieldKey('Will you now or in the future require immigration sponsorship?')).toBe(
      'workAuthorization.requiresSponsorship'
    );
    expect(lookupFieldKey('Desired Base Salary')).toBe('jobPreferences.minimumSalary');
    expect(lookupFieldKey('What is your desired Annual Salary?')).toBe('jobPreferences.minimumSalary');
  });

  it('recognizes reusable non-compete and highest-education questions', () => {
    expect(lookupFieldKey('Do you have an active non-compete agreement with another company?')).toBe(
      'professional.hasNonCompeteAgreement'
    );
    expect(lookupFieldKey('What is your highest level of education?')).toBe(
      'professional.highestEducation'
    );
  });

  it('recognizes NVIDIA disclosure prompt wording', () => {
    expect(lookupFieldKey('What is your ethnicity?')).toBe('disclosures.raceEthnicity');
    expect(lookupFieldKey(
      'Do you identify as one of the following protected veterans (Disabled Veteran, Recently Separated Veteran)?'
    )).toBe('disclosures.veteranStatus');
  });

  it('does not map employer-specific screening questions to generic preferences', () => {
    expect(lookupFieldKey('Do you have relatives working for Starfish Holdings?')).toBeNull();
    expect(lookupFieldKey('Have you served as a procurement official in the last 365 days?')).toBeNull();
  });

  it('recognizes standard voluntary disclosure questions', () => {
    expect(lookupFieldKey('Are you Hispanic or Latino?')).toBe('disclosures.hispanicOrLatino');
    expect(lookupFieldKey('Please indicate if you are Hispanic/Latino:')).toBe('disclosures.hispanicOrLatino');
    expect(lookupFieldKey('What is your gender?')).toBe('disclosures.gender');
    expect(lookupFieldKey('Race/Ethnicity - Single-Select')).toBe('disclosures.raceEthnicity');
    expect(lookupFieldKey('Ethnicity')).toBe('disclosures.raceEthnicity');
    expect(lookupFieldKey('Please select the ethnicity which most accurately describes how you identify yourself: Select One Required')).toBe('disclosures.raceEthnicity');
    expect(lookupFieldKey('Veteran Status - Select one')).toBe('disclosures.veteranStatus');
    expect(lookupFieldKey('Veterans status Select One Required')).toBe('disclosures.veteranStatus');
    expect(lookupFieldKey('Veteran')).toBe('disclosures.veteranStatus');
    expect(lookupFieldKey('Disability')).toBe('disclosures.disabilityStatus');
    expect(lookupFieldKey(
      'Indicate whether you identify as one or more protected veteran categories: Disabled Veteran, Recently Separated Veteran.'
    )).toBe('disclosures.veteranStatus');
  });

  it('routes pay-range prompts to compensationRange but keeps plain minimum prompts on minimumSalary', () => {
    expect(lookupFieldKey('What is your desired salary range?')).toBe('jobPreferences.compensationRange');
    expect(lookupFieldKey('Expected compensation range')).toBe('jobPreferences.compensationRange');
    expect(lookupFieldKey('Hourly rate range')).toBe('jobPreferences.compensationRange');
    expect(lookupFieldKey('Minimum salary requirement')).toBe('jobPreferences.minimumSalary');
    expect(lookupFieldKey('Desired salary')).toBe('jobPreferences.minimumSalary');
  });

  it('maps Garmin-style iCIMS internship and termination questions', () => {
    expect(lookupFieldKey('Are you over the age of 18?')).toBe('jobPreferences.atLeast18');
    expect(lookupFieldKey('Are you able to commit to a twelve week internship?')).toBe('jobPreferences.canCommitInternshipTerm');
    expect(lookupFieldKey('Have you ever been terminated or asked to resign by a previous employer?')).toBe('professional.everTerminated');
    expect(lookupFieldKey('Are you currently on or in the process of receiving an F-1 OPT/OPT EAD/STEM OPT (Optional Practical Training) or CPT (Curricular Practical Training)?')).toBe('workAuthorization.plansToUseOPT');
  });

  it('leaves a conditional "provide details / leave blank" box unmapped', () => {
    expect(lookupFieldKey('If you have ever been terminated or been asked to resign by a previous employer, please provide the related details. If not applicable, please leave blank.')).toBeNull();
  });

  it('matches skills field phrasing variants', () => {
    expect(lookupFieldKey('Skills')).toBe('professional.skills');
    expect(lookupFieldKey('List your skills')).toBe('professional.skills');
    expect(lookupFieldKey('Top Skills')).toBe('professional.skills');
    expect(lookupFieldKey('Key Skills')).toBe('professional.skills');
    expect(lookupFieldKey('Technical Skills')).toBe('professional.skills');
    expect(lookupFieldKey('Areas of Expertise')).toBe('professional.skills');
  });

  it('matches a single School/Degree/Field of Study/GPA prompt outside any repeatable section', () => {
    // Confirmed unmapped on both SuccessFactors and Activision's career site.
    expect(lookupFieldKey('School or University*')).toBe('education.school');
    expect(lookupFieldKey('Degree*')).toBe('education.degree');
    expect(lookupFieldKey('Field of study*')).toBe('education.fieldOfStudy');
    expect(lookupFieldKey('Major')).toBe('education.fieldOfStudy');
    expect(lookupFieldKey('Overall result (GPA)')).toBe('education.gpa');
    // Distinct from the education-level category prompt, which asks for Bachelor's/Master's/etc.
    expect(lookupFieldKey('Highest Level of Education')).toBe('professional.highestEducation');
  });
});

describe('matchesWholeWord', () => {
  it('matches a phrase bounded by whitespace or string edges', () => {
    expect(matchesWholeWord('city', 'city')).toBe(true);
    expect(matchesWholeWord('please enter your city', 'city')).toBe(true);
    expect(matchesWholeWord('city of residence', 'city')).toBe(true);
  });

  it('does not match a phrase embedded inside a larger word', () => {
    expect(matchesWholeWord('ethnicity', 'city')).toBe(false);
    expect(matchesWholeWord('statement of purpose', 'state')).toBe(false);
  });
});
