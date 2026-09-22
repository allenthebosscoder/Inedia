import { ProfileFieldKey } from '../storage/profile-schema';

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchesWholeWord(normalizedText: string, phrase: string): boolean {
  return new RegExp(`(^|\\s)${escapeRegExp(phrase)}(\\s|$)`).test(normalizedText);
}

const SYNONYMS: Record<ProfileFieldKey, string[]> = {
  'personal.firstName': ['first name', 'given name', 'legal first name'],
  'personal.middleName': ['middle name', 'legal middle name'],
  'personal.lastName': ['last name', 'family name', 'surname', 'legal last name'],
  'personal.fullName': ['full name', 'your name', 'legal name', 'legal first last name'],
  'personal.email': ['email', 'email address', 'confirm email', 'confirm your email'],
  'personal.phoneType': ['phone type', 'phone device type', 'device type'],
  'personal.phoneCountryCode': [
    'phone country code',
    'country phone code',
    'country territory phone code',
    'country code',
    'country phone',
    'phone number country',
    'dialing code',
    'country calling code',
  ],
  'personal.phone': ['phone', 'phone number', 'mobile number'],
  // Keep Address Line 2 before the broader Address entry so it never receives Line 1.
  'personal.addressLine2': ['address line 2', 'address 2', 'second address line'],
  'personal.address': ['address line 1', 'address 1', 'street address', 'address'],
  'personal.city': ['city'],
  'personal.county': ['county'],
  'personal.state': ['state', 'state province'],
  'personal.zip': ['zip', 'zip code', 'postal code'],
  'workAuthorization.requiresSponsorship': [
    'require sponsorship',
    'require us sponsorship',
    'require u s sponsorship',
    'us sponsorship',
    'u s sponsorship',
    'require visa sponsorship',
    'visa sponsorship',
    'immigration filing',
    'sponsorship to maintain work authorization',
    'need sponsorship',
    'visa status',
    'will you now or in the future require sponsorship',
    'employer support to obtain or maintain authorization',
    'require employer support',
    'need to be sponsored',
    'sponsored for a work visa',
    'require immigration sponsorship',
    'commence sponsor an immigration case',
    'h 1b transfer', 'h 1b lottery', 'register you in the h 1b lottery',
    'non immigrant status',
  ],
  'workAuthorization.plansToUseOPT': [
    'plan to work under optional practical training opt',
    'work under optional practical training',
    'use optional practical training',
    'use opt work authorization',
    'optional practical training',
    'f 1 opt', 'opt ead', 'stem opt', 'curricular practical training', 'cpt',
    'receiving an f 1 opt',
  ],
  // Keep the broader "work authorization" phrases after sponsorship: long sponsorship prompts
  // often end with "to maintain work authorization" and must not be stolen by this key.
  'workAuthorization.authorizedToWork': [
    'are you legally authorized to work',
    'authorized to work',
    'authorised to work',
    'legally authorised to work',
    'legally authorized to work full time in the country',
    'work authorization',
    'legally eligible to work',
    'legally entitled to work',
  ],
  'workAuthorization.usPerson': [
    'are you a us person', 'are you a u s person', 'are you a united states person',
    'us person', 'u s person',
    'us person status', 'u s person status', 'united states person status',
    // Export-control questionnaires sometimes spell out the statutory U.S.-person categories
    // instead of using the term itself.
    'protected person under 8 usc 1324b',
    'us citizen permanent resident of the united states',
  ],
  'workAuthorization.restrictedCountryStatus': [
    // Include the list fingerprint so an answer saved for this exact export-control question is
    // never reused for a superficially similar question containing a different country list.
    'iran cuba north korea syria crimea',
    'are you a citizen of any one of these countries cuba iran north korea or syria',
    'citizen of any of these countries',
    'citizen or lawful permanent resident of any of the following countries',
  ],
  'jobPreferences.availableStartDate': [
    'available start date', 'available date', 'availability date', 'date available to start',
    'when can you start', 'desired start date', 'when is your desired start date',
    'minimum lead time', 'commence the new role',
  ],
  'jobPreferences.atLeast18': [
    'are you at least 18 years old', 'at least 18 years old', 'are you 18 years of age or older',
    '18 years of age or older', 'are you over 18', 'over 18',
    'are you over the age of 18', 'over the age of 18', 'age of 18 or older',
  ],
  'jobPreferences.minimumSalary': [
    'minimum salary requirement', 'minimum salary requirements', 'salary requirement',
    'salary requirements', 'desired salary', 'desired annual salary', 'desired base salary', 'expected salary', 'minimum compensation',
  ],
  // The max half of the desired-pay range; never matched by a label directly (a form asking for a
  // single "maximum salary" is rare and ambiguous). Used only via `jobPreferences.compensationRange`.
  'jobPreferences.compensationMax': [],
  // Range prompts are routed here by an explicit guard in lookupFieldKey; these phrases catch the
  // wordings where "range" is not adjacent to the pay noun.
  'jobPreferences.compensationRange': [
    'salary range', 'compensation range', 'pay range', 'expected salary range',
    'desired salary range', 'expected compensation range', 'expected pay range',
    'target salary range', 'target compensation range', 'salary expectation range',
    'base salary expectation range', 'desired compensation range', 'hourly rate range',
  ],
  'jobPreferences.usCitizen': [
    'are you a united states citizen', 'are you a us citizen', 'us citizenship', 'united states citizenship',
  ],
  'jobPreferences.securityClearance': [
    'security clearance', 'do you have a security clearance', 'hold a security clearance',
  ],
  'jobPreferences.willingToRelocate': [
    'willing to relocate', 'able to relocate', 'are you able to relocate', 'relocation willingness',
    'consider relocating', 'would you consider relocating',
  ],
  'jobPreferences.willingToWorkOnsite': [
    'able to work on site', 'able to work onsite', 'willing to work on site', 'willing to work onsite',
    'work on site', 'work onsite', 'on site work requirement', 'onsite work requirement',
  ],
  'jobPreferences.canCommitInternshipTerm': [
    'able to commit to a twelve week internship', 'commit to a twelve week internship',
    'able to commit to a 12 week internship', 'commit to a 12 week internship',
    'commit to the full internship', 'commit to a full internship term',
    'available for the full internship', 'twelve week internship', '12 week internship',
    'commit to the entire internship', 'able to work the full internship',
  ],
  'professional.hasNonCompeteAgreement': [
    'active non compete agreement', 'have a non compete agreement', 'bound by a non compete agreement',
    'bound by any non compete', 'non compete non solicit or similar agreement',
    'subject to a non compete agreement', 'active non compete',
  ],
  'professional.everTerminated': [
    'have you ever been terminated or asked to resign', 'ever been terminated or asked to resign',
    'been terminated or asked to resign by a previous employer', 'ever been terminated by an employer',
    'ever been asked to resign', 'ever been discharged or forced to resign', 'ever been fired',
    'terminated for cause', 'involuntarily terminated by a previous employer',
  ],
  'professional.highestEducation': [
    'highest level of education', 'highest education level', 'highest level of education completed',
  ],
  // Deliberately narrow, single-word/short phrases only — kept distinct from the broader "highest
  // level of education" prompt above, which asks for a category (Bachelor's/Master's/etc.), not a
  // specific school or program.
  'education.school': ['school or university', 'school name', 'university name', 'college or university'],
  'education.degree': ['degree'],
  'education.fieldOfStudy': ['field of study', 'major', 'course of study'],
  'education.gpa': ['overall result', 'overall result gpa', 'grade point average', 'cumulative gpa'],
  'professional.skills': [
    'skills', 'list your skills', 'top skills', 'key skills', 'technical skills',
    'relevant skills', 'core skills', 'skill set', 'areas of expertise',
  ],
  'disclosures.hispanicOrLatino': [
    'are you hispanic or latino', 'hispanic or latino', 'hispanic latino status',
    'please indicate if you are hispanic latino',
  ],
  'disclosures.gender': ['what is your gender', 'gender', 'gender identity'],
  'disclosures.raceEthnicity': [
    'race ethnicity single select', 'race ethnicity', 'race and ethnicity', 'racial ethnic identity', 'ethnicity',
    'select the races you identify with',
    'please select the ethnicity which most accurately describes how you identify yourself',
    'what is your ethnicity',
  ],
  'disclosures.veteranStatus': [
    'veteran status select one', 'veterans status select one', 'veteran status', 'veterans status',
    'protected veteran status', 'veteran',
    'identify as one of the following protected veterans',
    'identify as one or more protected veteran categories',
  ],
  'disclosures.disabilityStatus': [
    'disability status', 'self identification of disability', 'i have a disability', 'disability',
  ],
  // Keep broad "country" matching after the more specific work-authorization questions, which
  // often contain phrases such as "sponsorship to work in this country."
  'personal.country': ['country', 'country region'],
  'links.linkedin': ['linkedin', 'linkedin url', 'linkedin profile'],
  'links.portfolio': ['portfolio', 'website', 'personal website'],
  'links.github': ['github', 'github url'],
};

const AMBIGUOUS_ADDRESS_KEYS = new Set<ProfileFieldKey>([
  'personal.address',
  'personal.addressLine2',
  'personal.city',
  'personal.county',
  'personal.state',
  'personal.zip',
  'personal.country',
]);

function isAddressComponentLabel(key: ProfileFieldKey, normalized: string): boolean {
  if (!AMBIGUOUS_ADDRESS_KEYS.has(key)) return true;
  const withoutSectionPrefix = normalized.replace(/^address\s+/, '');
  switch (key) {
    case 'personal.addressLine2':
      return /^(?:address )?(?:line 2|2|second address line)(?:\s|$)/.test(normalized);
    case 'personal.address':
      return /^(?:address(?: line 1| 1)?|street address)(?:\s|$)/.test(normalized);
    case 'personal.city':
      return /^city(?:\s|$)/.test(withoutSectionPrefix);
    case 'personal.county':
      return /^county(?:\s|$)/.test(withoutSectionPrefix);
    case 'personal.state':
      return /^state(?: province)?(?:\s|$)/.test(withoutSectionPrefix);
    case 'personal.zip':
      return /^(?:zip(?: code)?|postal code)(?:\s|$)/.test(withoutSectionPrefix);
    case 'personal.country':
      return /^country(?: region)?(?:\s|$)/.test(withoutSectionPrefix);
    default:
      return true;
  }
}

export function lookupFieldKey(labelText: string): ProfileFieldKey | null {
  const normalized = normalize(labelText);

  if (normalized === 'name') return 'personal.fullName';
  if (matchesWholeWord(normalized, 'legal first and last name')) return 'personal.fullName';

  // The profile intentionally models only two street-address lines. A broad "address" synonym
  // must not duplicate line 1 into an optional third line exposed by some ADP tenants.
  if (/^(?:address )?(?:line 3|3|third address line)(?:\s|$)/.test(normalized)) return null;

  // A pay/salary/compensation RANGE prompt wants both ends; the plain minimum/desired synonyms
  // below would otherwise answer it with just the low number.
  if (
    matchesWholeWord(normalized, 'range') &&
    ['salary', 'compensation', 'pay', 'wage', 'rate', 'hourly'].some((w) => matchesWholeWord(normalized, w))
  ) {
    return 'jobPreferences.compensationRange';
  }

  // "If <condition>, please provide details / explain. If not applicable, leave blank." is a
  // conditional free-text box paired with a Yes/No question — it must not inherit that question's
  // mapping and get answered with "yes"/"no".
  if (
    (/leave (?:it |this )?blank/.test(normalized) || matchesWholeWord(normalized, 'if not applicable')) &&
    ['details', 'describe', 'explain', 'provide', 'elaborate'].some((w) => matchesWholeWord(normalized, w))
  ) {
    return null;
  }

  // "Phone Extension" genuinely contains "phone" as its own word, so it passes the whole-word
  // check for personal.phone even though it's a different, unsupported field (there's no profile
  // field for an extension number). Rather than filling it with the main phone number, leave it
  // unmatched so it gets flagged for manual entry like any other unsupported field.
  if (
    matchesWholeWord(normalized, 'extension') &&
    (matchesWholeWord(normalized, 'phone') || matchesWholeWord(normalized, 'telephone'))
  ) {
    return null;
  }

  // A request for extra contact numbers is not the applicant's primary phone field. Filling it
  // with the saved primary number creates a duplicate contact entry and changes an intentionally
  // optional employer-specific answer. Keep these prompts manual unless the profile eventually
  // grows a dedicated alternate-phone field.
  if (
    (matchesWholeWord(normalized, 'additional') ||
      matchesWholeWord(normalized, 'alternate') ||
      matchesWholeWord(normalized, 'secondary')) &&
    (matchesWholeWord(normalized, 'phone') || matchesWholeWord(normalized, 'telephone'))
  ) {
    return null;
  }

  // Phone fields belonging to an employer, company, supervisor, or reference are not the
  // applicant's primary number. These frequently appear in employment-history sections and must
  // remain manual until the profile models those contacts explicitly.
  if (
    (matchesWholeWord(normalized, 'phone') || matchesWholeWord(normalized, 'telephone')) &&
    ['employer', 'company', 'supervisor', 'reference'].some((role) => matchesWholeWord(normalized, role))
  ) {
    return null;
  }

  // Confirmed live on an Oracle Recruiting employment-history row: "Supervisor Email" matched the
  // plain "email" synonym and was filled with the applicant's own email address — the same
  // employer/supervisor/reference contact-detail mistake as phone above, just never guarded for
  // email specifically.
  if (
    matchesWholeWord(normalized, 'email') &&
    ['employer', 'company', 'supervisor', 'reference'].some((role) => matchesWholeWord(normalized, role))
  ) {
    return null;
  }

  for (const [key, phrases] of Object.entries(SYNONYMS) as [ProfileFieldKey, string[]][]) {
    if (
      isAddressComponentLabel(key, normalized) &&
      phrases.some((phrase) => matchesWholeWord(normalized, phrase))
    ) {
      return key;
    }
  }
  return null;
}
