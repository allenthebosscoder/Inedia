import { EducationEntry, Profile, ProfileFieldKey } from '../storage/profile-schema';
import {
  buildCandidates,
  findMatchIndex,
  flagField,
  resolveProfileValue,
  setNativeValue,
} from './fill-engine';
import { lookupFieldKey, normalize } from './synonym-dictionary';
import { expandStateAbbreviation } from './us-states';
import { FillSummary } from './types';
import { COMPANY_WEBSITE_SOURCE, isSourceQuestion } from './source-answer';

export const GREENHOUSE_REACT_SELECT_SELECTOR =
  'input.select__input[role="combobox"][aria-haspopup="true"]';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface GreenhouseFillOptions {
  pollIntervalMs?: number;
  maxAttempts?: number;
}

interface SelectionPlan {
  candidates: string[];
  query: string;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearFlag(element: HTMLElement): void {
  delete element.dataset.autofillFlag;
  element.style.outline = '';
}

function labelFor(input: HTMLInputElement): string {
  const labelledBy = input.getAttribute('aria-labelledby') ?? '';
  const labelledText = labelledBy.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return input.labels?.[0]?.textContent?.trim() || input.getAttribute('aria-label')?.trim() || labelledText;
}

function parseMonthYear(value: string): { month: number; year: number } | null {
  const monthFirst = value.match(/^(\d{1,2})\/(\d{4})$/);
  if (monthFirst) return { month: Number(monthFirst[1]), year: Number(monthFirst[2]) };
  const iso = value.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (iso) return { month: Number(iso[2]), year: Number(iso[1]) };
  const year = value.match(/^(\d{4})$/);
  return year ? { month: 5, year: Number(year[1]) } : null;
}

function educationDate(entry: EducationEntry | undefined, side: 'start' | 'end'): { month: number; year: number } | null {
  if (!entry) return null;
  const value = side === 'start'
    ? entry.startDate || entry.startYear || ''
    : entry.endDate || entry.graduationDate || entry.endYear || '';
  return parseMonthYear(value);
}

function educationRowOrdinals(): number[] {
  const ids = new Set<number>();
  document.querySelectorAll<HTMLElement>('[id^="school--"], [id^="degree--"], [id^="start-year--"], [id^="end-year--"]')
    .forEach((el) => {
      const m = el.id.match(/--(\d+)$/);
      if (m) ids.add(Number(m[1]));
    });
  return Array.from(ids).sort((a, b) => a - b);
}

function educationFor(input: HTMLInputElement, profile: Profile): EducationEntry | undefined {
  const idIndex = Number(input.id.match(/--(\d+)$/)?.[1] ?? '0');
  // Greenhouse's education rows are not always 0-indexed (a removed first row leaves the second as
  // `--1`). Map the k-th *rendered* row to `profile.education[k]` rather than trusting the raw id.
  const ordinal = educationRowOrdinals().indexOf(idIndex);
  return profile.education[ordinal >= 0 ? ordinal : idIndex];
}

function degreeCandidates(degree: string): string[] {
  const value = normalize(degree);
  if (/\b(?:phd|doctor|doctoral)\b/.test(value)) return ['Doctor of Philosophy (Ph.D.)'];
  if (/\b(?:mba)\b/.test(value)) return ['Master of Business Administration (M.B.A.)'];
  if (/\b(?:master|masters|ma|ms|msc)\b/.test(value)) return ["Master's Degree"];
  if (/\b(?:associate|associates|aa|as)\b/.test(value)) return ["Associate's Degree"];
  if (/\b(?:bachelor|bachelors|ba|bs|bsc)\b/.test(value)) return ["Bachelor's Degree"];
  if (/\bhigh school\b/.test(value)) return ['High School'];
  return degree ? [degree] : [];
}

function disciplinePlan(fieldOfStudy: string): SelectionPlan | null {
  if (!fieldOfStudy) return null;
  const normalized = normalize(fieldOfStudy);
  if (normalized === 'electrical and computer engineering' || normalized === 'electrical computer engineering') {
    // Greenhouse's standard discipline catalog has Electrical Engineering but no combined ECE
    // entry. This is a deliberate canonical mapping (like BS -> Bachelor's Degree), not a fuzzy
    // nearest-major fallback. Other unrecognized majors remain flagged for review.
    return {
      candidates: [fieldOfStudy, 'Electrical Engineering'],
      query: 'Electrical Engineering',
    };
  }
  return { candidates: [fieldOfStudy], query: fieldOfStudy };
}

function graduationRange(end: { month: number; year: number } | null): string | null {
  if (!end) return null;
  if (end.year === 2027 && end.month >= 9) return 'Sept - Dec 2027';
  if (end.year === 2028 && end.month <= 4) return 'Jan - April 2028';
  if (end.year === 2028 && end.month <= 8) return 'May - Aug 2028';
  if (end.year === 2028) return 'Sept - Dec 2028';
  return 'Other';
}

function gpaRange(gpa: string | undefined): string | null {
  const value = Number(gpa);
  if (!Number.isFinite(value)) return null;
  if (value >= 3.7) return '3.7 - 4.0';
  if (value >= 3.1) return '3.1 - 3.6';
  return '3.0 or under';
}

function internshipSeason(value: string): string | null {
  const date = value.match(/^(\d{4})-(\d{2})/);
  if (!date) return null;
  const year = Number(date[1]);
  const month = Number(date[2]);
  return `${month <= 4 ? 'Winter' : 'Summer'} ${year}`;
}

function genericProfilePlan(profile: Profile, label: string): SelectionPlan | null {
  const profileKey = lookupFieldKey(label);
  if (!profileKey) return null;
  const value = resolveProfileValue(profile, profileKey);
  if (!value) return null;
  return {
    candidates: buildCandidates(profileKey as ProfileFieldKey, value),
    query: value,
  };
}

function profileFieldPlan(profile: Profile, profileKey: ProfileFieldKey): SelectionPlan | null {
  const value = resolveProfileValue(profile, profileKey);
  if (!value) return null;
  return { candidates: buildCandidates(profileKey, value), query: value };
}

function yesNoPlan(value: string | undefined): SelectionPlan | null {
  const normalized = normalize(value ?? '');
  if (normalized !== 'yes' && normalized !== 'no') return null;
  const answer = normalized === 'yes' ? 'Yes' : 'No';
  return { candidates: [answer], query: '' };
}

function previousEmployerPlan(profile: Profile, label: string): SelectionPlan | null {
  const employer = label.match(/(?:ever|previously)\s+(?:been\s+)?employed\s+by\s+(.+?)(?:\?|\*|$)/i)?.[1]?.trim();
  if (!employer) return null;
  const employerName = normalize(employer);
  const workedThere = profile.workHistory.some((entry) => {
    const company = normalize(entry.company);
    return company === employerName || company.includes(employerName) || employerName.includes(company);
  });
  return yesNoPlan(workedThere ? 'yes' : 'no');
}

function greenhouseQuestionPlan(input: HTMLInputElement, profile: Profile, label: string): SelectionPlan | null {
  const question = normalize(label);
  if (question.includes('at least 18 years of age') || question.includes('18 years of age or older')) {
    return yesNoPlan(profile.jobPreferences.atLeast18);
  }
  if (question.includes('what year do you graduate') || question.includes('expected year of graduation')) {
    const end = educationDate(profile.education[0], 'end');
    return end ? { candidates: [String(end.year)], query: '' } : null;
  }
  if (/\bable to work\b.*\bon site\b/.test(question)) {
    if (normalize(profile.jobPreferences.willingToWorkOnsite ?? '') !== 'yes') {
      return yesNoPlan(profile.jobPreferences.willingToWorkOnsite);
    }
    const candidates = ['Yes'];
    if (normalize(profile.jobPreferences.willingToRelocate ?? '') === 'yes') {
      candidates.push('I am open to relocation with assistance');
    }
    return { candidates, query: '' };
  }
  if (
    question.includes('provide verification') &&
    question.includes('identity') &&
    question.includes('authorization to work')
  ) {
    return yesNoPlan(profile.workAuthorization.authorizedToWork);
  }
  if (
    question.includes('export administration controlled technology') &&
    question.includes('coordinate') &&
    question.includes('licensing')
  ) {
    // This asks whether the applicant will cooperate with the employer's licensing process; it is
    // not asking whether the applicant is a U.S. person. A willing Yes is the compatible answer
    // for a profile that explicitly says it is a Non-US Person and will require sponsorship.
    return normalize(profile.workAuthorization.usPerson ?? '') === 'no' &&
      normalize(profile.workAuthorization.requiresSponsorship ?? '') === 'yes'
      ? yesNoPlan('yes')
      : null;
  }
  if (
    question.includes('contractual obligations') &&
    (question.includes('impact') || question.includes('impede') || question.includes('interfere'))
  ) {
    return yesNoPlan(profile.professional?.hasNonCompeteAgreement);
  }
  if (question.includes('employed by')) return previousEmployerPlan(profile, label);
  return null;
}

function selectionPlan(input: HTMLInputElement, profile: Profile): SelectionPlan | null {
  const label = labelFor(input);
  const normalizedLabel = normalize(label);
  const education = educationFor(input, profile);

  if (input.id === 'country') {
    const raw = (profile.personal.country || profile.personal.phoneCountryCode || '').trim();
    if (!raw) return null;
    if (/^(usa|us|u\.?\s?s\.?\s?a?\.?|united states.*|america)$/i.test(raw)) {
      // Greenhouse's country/phone-country menu labels this "United States" (and, for phone,
      // "United States +1" that renders as just "+1"). Offer every representation.
      return { candidates: ['United States', 'United States of America', 'United States +1', '+1'], query: 'United States' };
    }
    return { candidates: [raw], query: raw };
  }
  const standardSelectKeys: Record<string, ProfileFieldKey> = {
    gender: 'disclosures.gender',
    hispanic_ethnicity: 'disclosures.hispanicOrLatino',
    race: 'disclosures.raceEthnicity',
    veteran_status: 'disclosures.veteranStatus',
    disability_status: 'disclosures.disabilityStatus',
  };
  if (standardSelectKeys[input.id]) {
    // These are stable field IDs in Greenhouse's official application UI. Use them directly so
    // punctuation and tenant label variations (notably "Hispanic/Latino") cannot break EEO fill.
    const plan = profileFieldPlan(profile, standardSelectKeys[input.id]);
    return plan ? { ...plan, query: '' } : null;
  }
  if (/^school--\d+$/.test(input.id)) {
    return education?.school ? { candidates: [education.school], query: education.school } : null;
  }
  if (/^degree--\d+$/.test(input.id)) {
    const candidates = degreeCandidates(education?.degree ?? '');
    return candidates.length > 0 ? { candidates, query: candidates[0] } : null;
  }
  if (/^discipline--\d+$/.test(input.id)) {
    // Only explicit canonical mappings are allowed here. Never broaden a missing major to generic
    // Engineering or Computer Science merely because the tenant omits the exact saved program.
    return disciplinePlan(education?.fieldOfStudy ?? '');
  }
  const monthSide = input.id.match(/^(start|end)-month--\d+$/)?.[1] as 'start' | 'end' | undefined;
  if (monthSide) {
    const date = educationDate(education, monthSide);
    return date ? { candidates: [MONTHS[date.month - 1]], query: MONTHS[date.month - 1] } : null;
  }
  if (normalizedLabel.includes('when do you graduate')) {
    const range = graduationRange(educationDate(profile.education[0], 'end'));
    return range ? { candidates: [range], query: range } : null;
  }
  if (
    normalizedLabel.includes('graduation date') ||
    (normalizedLabel.includes('graduate') && normalizedLabel.includes('date'))
  ) {
    const end = educationDate(profile.education[0], 'end');
    if (!end) return null;
    const monthName = MONTHS[end.month - 1];
    const season = end.month <= 5 ? 'Spring' : end.month <= 8 ? 'Summer' : 'Fall';
    return {
      candidates: [
        `${monthName} ${end.year}`, `${String(end.month).padStart(2, '0')}/${end.year}`,
        `${season} ${end.year}`, String(end.year),
      ],
      query: `${monthName} ${end.year}`,
    };
  }
  if (normalizedLabel.includes('what is your gpa')) {
    const range = gpaRange(profile.education[0]?.gpa);
    return range ? { candidates: [range], query: range } : null;
  }
  if (normalizedLabel.includes('winter or summer internship')) {
    const season = internshipSeason(profile.jobPreferences.availableStartDate);
    return season ? { candidates: [season], query: season } : null;
  }
  if (input.id === 'candidate-location') {
    const state = expandStateAbbreviation(profile.personal.state) || profile.personal.state;
    const city = profile.personal.city;
    if (!city) return null;
    const candidates = [
      [city, state, profile.personal.country].filter(Boolean).join(', '),
      [city, state].filter(Boolean).join(', '),
    ].filter(Boolean);
    return { candidates, query: [city, state].filter(Boolean).join(', ') };
  }
  const questionPlan = greenhouseQuestionPlan(input, profile, label);
  if (questionPlan) return questionPlan;
  return genericProfilePlan(profile, label);
}

function liveInput(input: HTMLInputElement): HTMLInputElement {
  return (input.id ? document.getElementById(input.id) : null) as HTMLInputElement | null ?? input;
}

function controlWrapper(input: HTMLInputElement): HTMLElement {
  const control = input.closest<HTMLElement>('.select__control');
  return control?.parentElement ?? control ?? input;
}

function selectedText(input: HTMLInputElement): string {
  return input.closest<HTMLElement>('.select__control')
    ?.querySelector<HTMLElement>('.select__single-value')?.textContent?.trim() ?? '';
}

function selectedMatches(input: HTMLInputElement, candidates: string[]): boolean {
  const text = selectedText(input);
  return Boolean(text) && findMatchIndex([text], candidates) !== null;
}

function closeMenu(input: HTMLInputElement): void {
  if (input.getAttribute('aria-expanded') !== 'true') return;
  controlWrapper(input).dispatchEvent(new KeyboardEvent('keyup', {
    key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
  }));
}

function openMenu(input: HTMLInputElement): void {
  if (input.getAttribute('aria-expanded') === 'true') return;
  input.focus();
  controlWrapper(input).dispatchEvent(new MouseEvent('mouseup', {
    bubbles: true, cancelable: true, button: 0,
  }));
}

function clickOption(option: HTMLElement): void {
  option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
  option.click();
}

async function optionsFor(
  original: HTMLInputElement,
  candidates: string[],
  pollIntervalMs: number,
  maxAttempts: number
): Promise<HTMLElement[]> {
  let latest: HTMLElement[] = [];
  const startedAt = Date.now();
  let stableFingerprint = '';
  let stableSince = startedAt;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const input = liveInput(original);
    const controls = input.getAttribute('aria-controls');
    const listbox = controls ? document.getElementById(controls) : null;
    latest = listbox ? Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]')) : [];
    if (findMatchIndex(latest.map((option) => option.textContent ?? ''), candidates) !== null) return latest;
    const elapsed = Date.now() - startedAt;
    const noOptions = listbox?.querySelector('.select__menu-notice--no-options') ||
      /no options/i.test(listbox?.textContent ?? '');
    if (attempt > 0 && noOptions) return latest;
    // Once a populated menu remains stable for a short settling window, it is the tenant's full
    // result set. Do not leave Autofill spinning for several seconds merely to prove an exact
    // school/major/answer is absent.
    const fingerprint = latest.map((option) => option.textContent ?? '').join('\u0000');
    if (fingerprint !== stableFingerprint) {
      stableFingerprint = fingerprint;
      stableSince = Date.now();
    }
    const loading = /loading/i.test(listbox?.textContent ?? '');
    if (
      latest.length > 0 &&
      !loading &&
      Date.now() - stableSince >= Math.max(1_000, pollIntervalMs * 5)
    ) return latest;
    if (elapsed >= 8_000) break;
    await wait(pollIntervalMs);
  }
  return latest;
}

function fillGreenhouseCustomText(profile: Profile, root: ParentNode): FillSummary {
  let filled = 0;
  let flagged = 0;
  for (const input of Array.from(root.querySelectorAll<HTMLInputElement>('input[type="text"]'))) {
    if (input.matches(GREENHOUSE_REACT_SELECT_SELECTOR) || input.dataset.jobAutofillHandled === 'true') continue;
    const label = labelFor(input);
    let value = '';
    if (/what city do you currently reside in/i.test(label)) value = profile.personal.city;
    if (!value) continue;
    if (input.value !== value) setNativeValue(input, value);
    input.blur();
    if (input.value.trim()) {
      clearFlag(input);
      input.dataset.jobAutofillHandled = 'true';
      filled++;
    } else {
      flagField(input);
      flagged++;
    }
  }
  return { filled, flagged };
}

async function selectValue(
  original: HTMLInputElement,
  plan: SelectionPlan,
  pollIntervalMs: number,
  maxAttempts: number
): Promise<boolean> {
  let input = liveInput(original);
  if (selectedMatches(input, plan.candidates)) {
    clearFlag(input);
    closeMenu(input);
    return true;
  }

  document.querySelectorAll<HTMLInputElement>(GREENHOUSE_REACT_SELECT_SELECTOR).forEach((candidate) => {
    if (candidate !== input) closeMenu(candidate);
  });
  openMenu(input);
  input = liveInput(original);
  if (plan.query) setNativeValue(input, plan.query);

  let options = await optionsFor(original, plan.candidates, pollIntervalMs, maxAttempts);
  let match = findMatchIndex(options.map((option) => option.textContent ?? ''), plan.candidates);
  if (match === null && plan.query) {
    // A saved answer can be more specific than a tenant's wording. For example, searching for
    // "I am not a veteran" hides Greenhouse's "I am not a protected veteran" fallback even
    // though it is the correct available choice. Clear the filter once and match the full menu.
    input = liveInput(original);
    setNativeValue(input, '');
    options = await optionsFor(original, plan.candidates, pollIntervalMs, maxAttempts);
    match = findMatchIndex(options.map((option) => option.textContent ?? ''), plan.candidates);
  }
  if (match === null) {
    input = liveInput(original);
    setNativeValue(input, '');
    closeMenu(input);
    flagField(input);
    return false;
  }

  clickOption(options[match]);
  const startedAt = Date.now();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await wait(pollIntervalMs);
    input = liveInput(original);
    if (selectedMatches(input, plan.candidates)) {
      clearFlag(input);
      closeMenu(input);
      return true;
    }
    if (Date.now() - startedAt >= 8_000) break;
  }
  input = liveInput(original);
  closeMenu(input);
  flagField(input);
  return false;
}

function fillEducationYears(profile: Profile, root: ParentNode): FillSummary {
  let filled = 0;
  let flagged = 0;
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>(
    'input[id^="start-year--"], input[id^="end-year--"]'
  ));
  for (const input of inputs) {
    const side = input.id.startsWith('start-year--') ? 'start' : 'end';
    const date = educationDate(educationFor(input, profile), side);
    if (!date) {
      if (input.getAttribute('aria-required') === 'true') {
        flagField(input);
        flagged++;
      }
      continue;
    }
    if (input.value !== String(date.year)) setNativeValue(input, String(date.year));
    input.blur();
    clearFlag(input);
    filled++;
  }
  return { filled, flagged };
}

function fillGreenhouseSource(root: ParentNode): FillSummary {
  const source = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="text"]')).find((input) =>
    isSourceQuestion(input.getAttribute('aria-label') ?? '')
  );
  if (!source) return { filled: 0, flagged: 0 };
  if (!source.value.trim()) setNativeValue(source, COMPANY_WEBSITE_SOURCE);
  source.blur();
  if (!source.value.trim()) {
    flagField(source);
    return { filled: 0, flagged: 1 };
  }
  source.dataset.jobAutofillHandled = 'true';
  clearFlag(source);
  return { filled: 1, flagged: 0 };
}

function fillGreenhouseOptionalLinks(profile: Profile, root: ParentNode): FillSummary {
  const mappings = [
    { pattern: /^linkedin profile$/i, value: profile.links.linkedin },
    { pattern: /^(?:personal )?website$/i, value: profile.links.portfolio || profile.links.github },
  ];
  let filled = 0;
  for (const input of Array.from(root.querySelectorAll<HTMLInputElement>('input[type="text"]'))) {
    const label = input.getAttribute('aria-label')?.trim() ?? '';
    const mapping = mappings.find((candidate) => candidate.pattern.test(label));
    if (!mapping) continue;
    if (mapping.value) {
      if (input.value !== mapping.value) setNativeValue(input, mapping.value);
      input.blur();
      filled++;
    } else if (input.getAttribute('aria-required') === 'true') {
      continue;
    }
    input.dataset.jobAutofillHandled = 'true';
    clearFlag(input);
  }
  return { filled, flagged: 0 };
}

export async function fillGreenhouseForm(
  profile: Profile,
  root: ParentNode = document,
  options: GreenhouseFillOptions = {}
): Promise<FillSummary> {
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const maxAttempts = options.maxAttempts ?? 40;
  let filled = 0;
  let flagged = 0;

  for (const input of Array.from(root.querySelectorAll<HTMLInputElement>(GREENHOUSE_REACT_SELECT_SELECTOR))) {
    const plan = selectionPlan(input, profile);
    if (!plan) {
      if (input.getAttribute('aria-required') === 'true') {
        flagField(input);
        flagged++;
      }
      continue;
    }
    if (await selectValue(input, plan, pollIntervalMs, maxAttempts)) filled++;
    else flagged++;
  }

  const years = fillEducationYears(profile, root);
  const source = fillGreenhouseSource(root);
  const links = fillGreenhouseOptionalLinks(profile, root);
  const customText = fillGreenhouseCustomText(profile, root);
  return {
    filled: filled + years.filled + source.filled + links.filled + customText.filled,
    flagged: flagged + years.flagged + source.flagged + links.flagged + customText.flagged,
  };
}
