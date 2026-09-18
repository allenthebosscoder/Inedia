export interface WorkHistoryEntry {
  company: string;
  title: string;
  location?: string;
  startDate: string;
  endDate: string;
  currentlyWorksHere?: boolean;
  description: string;
  supervisorName?: string;
  supervisorPhone?: string;
  mayContact?: 'yes' | 'no' | '';
  reasonForLeaving?: string;
}

export interface EducationEntry {
  school: string;
  degree: string;
  fieldOfStudy: string;
  graduationDate: string;
  // "City, State, Country" — some ATS (e.g. ADP recruiting) require the school's location.
  location?: string;
  startDate?: string;
  endDate?: string;
  startYear?: string;
  endYear?: string;
  gpa?: string;
}

export interface StoredResume {
  name: string;
  type: string;
  dataUrl: string;
}

export type ProfileFieldKey =
  | 'personal.firstName'
  | 'personal.lastName'
  | 'personal.middleName'
  | 'personal.fullName'
  | 'personal.email'
  | 'personal.phone'
  | 'personal.address'
  | 'personal.addressLine2'
  | 'personal.city'
  | 'personal.county'
  | 'personal.country'
  | 'personal.state'
  | 'personal.zip'
  | 'personal.phoneType'
  | 'personal.phoneCountryCode'
  | 'workAuthorization.authorizedToWork'
  | 'workAuthorization.requiresSponsorship'
  | 'workAuthorization.plansToUseOPT'
  | 'workAuthorization.usPerson'
  | 'workAuthorization.restrictedCountryStatus'
  | 'jobPreferences.availableStartDate'
  | 'jobPreferences.atLeast18'
  | 'jobPreferences.minimumSalary'
  | 'jobPreferences.compensationMax'
  | 'jobPreferences.compensationRange'
  | 'jobPreferences.usCitizen'
  | 'jobPreferences.securityClearance'
  | 'jobPreferences.willingToRelocate'
  | 'jobPreferences.willingToWorkOnsite'
  | 'jobPreferences.canCommitInternshipTerm'
  | 'professional.hasNonCompeteAgreement'
  | 'professional.everTerminated'
  | 'professional.highestEducation'
  | 'professional.skills'
  // Virtual: many ATS forms (confirmed on SuccessFactors and Activision's career site) ask for a
  // single School/Degree/Field of Study/GPA rather than a repeatable education section. These
  // resolve from the profile's first education entry — see resolveProfileValue().
  | 'education.school'
  | 'education.degree'
  | 'education.fieldOfStudy'
  | 'education.gpa'
  | 'disclosures.hispanicOrLatino'
  | 'disclosures.gender'
  | 'disclosures.raceEthnicity'
  | 'disclosures.veteranStatus'
  | 'disclosures.disabilityStatus'
  | 'links.linkedin'
  | 'links.portfolio'
  | 'links.github';

export interface Profile {
  version: 1;
  resume: StoredResume | null;
  personal: {
    firstName: string;
    middleName: string;
    lastName: string;
    email: string;
    phone: string;
    address: string;
    addressLine2: string;
    city: string;
    county: string;
    country: string;
    state: string;
    zip: string;
    phoneType: 'mobile' | 'home' | 'work' | 'other' | '';
    phoneCountryCode: string;
  };
  workAuthorization: {
    authorizedToWork: 'yes' | 'no' | '';
    requiresSponsorship: 'yes' | 'no' | '';
    plansToUseOPT?: 'yes' | 'no' | '';
    usPerson?: 'yes' | 'no' | '';
    restrictedCountryStatus?: 'yes' | 'no' | '';
  };
  jobPreferences: {
    availableStartDate: string;
    atLeast18: 'yes' | 'no' | '';
    // Desired pay. `minimumSalary` is the low end (also used verbatim when a form asks for a
    // minimum / desired figure); `compensationMax` is the high end, used to answer range prompts.
    minimumSalary: string;
    compensationMax?: string;
    usCitizen: 'yes' | 'no' | '';
    securityClearance: 'yes' | 'no' | '';
    willingToRelocate: 'yes' | 'no' | '';
    willingToWorkOnsite?: 'yes' | 'no' | '';
    canCommitInternshipTerm?: 'yes' | 'no' | '';
  };
  professional: {
    hasNonCompeteAgreement: 'yes' | 'no' | '';
    everTerminated?: 'yes' | 'no' | '';
    highestEducation: 'high_school' | 'some_college' | 'associates' | 'bachelors' | 'masters' | 'doctorate' | '';
    // Free-text, comma-separated — fills a form's plain "Skills" text field/textarea.
    skills: string;
  };
  disclosures: {
    hispanicOrLatino: string;
    gender: string;
    raceEthnicity: string;
    veteranStatus: string;
    disabilityStatus: string;
  };
  links: {
    linkedin: string;
    portfolio: string;
    github: string;
  };
  workHistory: WorkHistoryEntry[];
  education: EducationEntry[];
  overrides: Record<string, ProfileFieldKey>;
}

export const DEFAULT_PROFILE: Profile = {
  version: 1,
  resume: null,
  personal: { firstName: '', middleName: '', lastName: '', email: '', phone: '', address: '', addressLine2: '', city: '', county: '', country: 'United States', state: '', zip: '', phoneType: 'mobile', phoneCountryCode: 'United States' },
  workAuthorization: { authorizedToWork: '', requiresSponsorship: '', plansToUseOPT: '', usPerson: '', restrictedCountryStatus: '' },
  jobPreferences: { availableStartDate: '', atLeast18: '', minimumSalary: '', compensationMax: '', usCitizen: '', securityClearance: '', willingToRelocate: '', willingToWorkOnsite: '', canCommitInternshipTerm: 'yes' },
  professional: { hasNonCompeteAgreement: '', highestEducation: '', skills: '', everTerminated: 'no' },
  disclosures: { hispanicOrLatino: '', gender: '', raceEthnicity: '', veteranStatus: '', disabilityStatus: '' },
  links: { linkedin: '', portfolio: '', github: '' },
  workHistory: [],
  education: [],
  overrides: {},
};
