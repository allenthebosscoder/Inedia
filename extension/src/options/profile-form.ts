import { Profile } from '../storage/profile-schema';

export function serializeProfile(form: HTMLFormElement, base: Profile): Profile {
  const data = new FormData(form);
  const get = (name: string) => (data.get(name) as string) ?? '';

  return {
    ...base,
    personal: {
      firstName: get('personal.firstName'),
      middleName: get('personal.middleName'),
      lastName: get('personal.lastName'),
      email: get('personal.email'),
      phone: get('personal.phone'),
      phoneType: get('personal.phoneType') as 'mobile' | 'home' | 'work' | 'other' | '',
      phoneCountryCode: get('personal.phoneCountryCode'),
      address: get('personal.address'),
      addressLine2: get('personal.addressLine2'),
      city: get('personal.city'),
      county: get('personal.county'),
      country: get('personal.country'),
      state: get('personal.state'),
      zip: get('personal.zip'),
    },
    workAuthorization: {
      authorizedToWork: get('workAuthorization.authorizedToWork') as 'yes' | 'no' | '',
      requiresSponsorship: get('workAuthorization.requiresSponsorship') as 'yes' | 'no' | '',
      plansToUseOPT: get('workAuthorization.plansToUseOPT') as 'yes' | 'no' | '',
      usPerson: get('workAuthorization.usPerson') as 'yes' | 'no' | '',
      restrictedCountryStatus: get('workAuthorization.restrictedCountryStatus') as 'yes' | 'no' | '',
    },
    jobPreferences: {
      availableStartDate: get('jobPreferences.availableStartDate'),
      atLeast18: get('jobPreferences.atLeast18') as 'yes' | 'no' | '',
      minimumSalary: get('jobPreferences.minimumSalary'),
      compensationMax: get('jobPreferences.compensationMax'),
      usCitizen: get('jobPreferences.usCitizen') as 'yes' | 'no' | '',
      securityClearance: get('jobPreferences.securityClearance') as 'yes' | 'no' | '',
      willingToRelocate: get('jobPreferences.willingToRelocate') as 'yes' | 'no' | '',
      willingToWorkOnsite: get('jobPreferences.willingToWorkOnsite') as 'yes' | 'no' | '',
      canCommitInternshipTerm: get('jobPreferences.canCommitInternshipTerm') as 'yes' | 'no' | '',
    },
    professional: {
      hasNonCompeteAgreement: get('professional.hasNonCompeteAgreement') as 'yes' | 'no' | '',
      everTerminated: get('professional.everTerminated') as 'yes' | 'no' | '',
      highestEducation: get('professional.highestEducation') as Profile['professional']['highestEducation'],
      skills: get('professional.skills'),
    },
    disclosures: {
      hispanicOrLatino: get('disclosures.hispanicOrLatino'),
      gender: get('disclosures.gender'),
      raceEthnicity: get('disclosures.raceEthnicity'),
      veteranStatus: get('disclosures.veteranStatus'),
      disabilityStatus: get('disclosures.disabilityStatus'),
    },
    links: {
      linkedin: get('links.linkedin'),
      portfolio: get('links.portfolio'),
      github: get('links.github'),
    },
  };
}

export function populateForm(form: HTMLFormElement, profile: Profile): void {
  const setValue = (name: string, value: string) => {
    const field = form.elements.namedItem(name);
    if (field instanceof RadioNodeList) {
      field.value = value;
    } else if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLSelectElement ||
      field instanceof HTMLTextAreaElement
    ) {
      field.value = value;
    }
  };

  setValue('personal.firstName', profile.personal.firstName);
  setValue('personal.middleName', profile.personal.middleName);
  setValue('personal.lastName', profile.personal.lastName);
  setValue('personal.email', profile.personal.email);
  setValue('personal.phone', profile.personal.phone);
  setValue('personal.phoneType', profile.personal.phoneType);
  setValue('personal.phoneCountryCode', profile.personal.phoneCountryCode);
  setValue('personal.address', profile.personal.address);
  setValue('personal.addressLine2', profile.personal.addressLine2 ?? '');
  setValue('personal.city', profile.personal.city);
  setValue('personal.county', profile.personal.county ?? '');
  setValue('personal.country', profile.personal.country);
  setValue('personal.state', profile.personal.state);
  setValue('personal.zip', profile.personal.zip);
  setValue('workAuthorization.authorizedToWork', profile.workAuthorization.authorizedToWork);
  setValue('workAuthorization.requiresSponsorship', profile.workAuthorization.requiresSponsorship);
  setValue('workAuthorization.plansToUseOPT', profile.workAuthorization.plansToUseOPT ?? '');
  setValue('workAuthorization.usPerson', profile.workAuthorization.usPerson ?? '');
  setValue('workAuthorization.restrictedCountryStatus', profile.workAuthorization.restrictedCountryStatus ?? '');
  setValue('jobPreferences.availableStartDate', profile.jobPreferences.availableStartDate);
  setValue('jobPreferences.atLeast18', profile.jobPreferences.atLeast18 ?? '');
  setValue('jobPreferences.minimumSalary', profile.jobPreferences.minimumSalary);
  setValue('jobPreferences.compensationMax', profile.jobPreferences.compensationMax ?? '');
  setValue('jobPreferences.usCitizen', profile.jobPreferences.usCitizen);
  setValue('jobPreferences.securityClearance', profile.jobPreferences.securityClearance);
  setValue('jobPreferences.willingToRelocate', profile.jobPreferences.willingToRelocate);
  setValue('jobPreferences.willingToWorkOnsite', profile.jobPreferences.willingToWorkOnsite ?? '');
  setValue('jobPreferences.canCommitInternshipTerm', profile.jobPreferences.canCommitInternshipTerm ?? '');
  setValue('professional.hasNonCompeteAgreement', profile.professional?.hasNonCompeteAgreement ?? '');
  setValue('professional.everTerminated', profile.professional?.everTerminated ?? '');
  setValue('professional.highestEducation', profile.professional?.highestEducation ?? '');
  setValue('professional.skills', profile.professional?.skills ?? '');
  setValue('disclosures.hispanicOrLatino', profile.disclosures.hispanicOrLatino);
  setValue('disclosures.gender', profile.disclosures.gender);
  setValue('disclosures.raceEthnicity', profile.disclosures.raceEthnicity);
  setValue('disclosures.veteranStatus', profile.disclosures.veteranStatus);
  setValue('disclosures.disabilityStatus', profile.disclosures.disabilityStatus);
  setValue('links.linkedin', profile.links.linkedin);
  setValue('links.portfolio', profile.links.portfolio);
  setValue('links.github', profile.links.github);
}
