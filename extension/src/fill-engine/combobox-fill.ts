import { Profile } from '../storage/profile-schema';
import { flagField, resolveProfileValueForField, buildCandidates, findMatchIndex, setNativeValue } from './fill-engine';
import { normalize } from './synonym-dictionary';
import { FieldDescriptor, FillSummary } from './types';
import { findCompanyWebsiteSourceIndex, isSourceQuestion } from './source-answer';
import { isCancelled } from './cancellation';

export interface ComboboxFillOptions {
  pollIntervalMs?: number;
  maxAttempts?: number;
  selectionSettleMs?: number;
  queryCommitDelayMs?: number;
  /** Internal: process a Workday skills multiselect as one value per saved skill. */
  splitSkillValues?: boolean;
  /** Internal: retain other committed values while adding another multiselect item. */
  preserveMismatchedSelections?: boolean;
  /**
   * Internal: type the value one character at a time instead of setting it in one shot. Workday's
   * Skills catalogue box (unlike the Enter-committed School/Country moniker widgets) appears to
   * filter live as the user types; a single native-setter call plus one Enter never fires its
   * debounced search, which is why every skill — including catalogue certainties like "Python" —
   * was matching zero options. Scoped to the skills flow only so School/Country, which already
   * work with the bulk-set path, can't regress.
   */
  incrementalType?: boolean;
  /**
   * Internal: reports the exact option labels this attempt matched against, straight from the
   * live dropdown at match time — the same elements the real matching logic reads. Diagnostics
   * must hook in here rather than re-querying the DOM afterward: by the time a caller regains
   * control the popup has already been torn down (closePopup/leaveMonikerWidget), so a DOM query
   * done outside this function only ever finds whatever's left over — confirmed selected chips —
   * regardless of what was actually searched.
   */
  debugOptionTexts?: (texts: string[]) => void;
  /**
   * Internal: known skill -> Workday catalogue label mappings, keyed by normalizeSkill(coreSkillName)
   * — not the generic normalize(), which strips "+"/"#" and so cannot tell "C" and "C++" apart.
   * fillWorkdaySkills reads this to search with the already-known exact label instead of guessing
   * (fast, unambiguous match) and writes newly-discovered labels into it as a side effect — the
   * same object flows both directions, mutated in place, so the caller can persist it afterward.
   */
  skillCatalogCache?: Record<string, string>;
  /**
   * Internal: reports the exact label that was clicked once a match is found. A callback rather
   * than reading candidates[0] here: the caller (fillWorkdaySkills) may have put a cached label
   * first in candidates to search with, and the cache must stay keyed by the original bare skill
   * name regardless of which candidate the search happened to be run against.
   */
  onMatch?: (label: string) => void;
  /**
   * Internal: use waitForSettledOptions instead of a fixed poll budget — wait for the rendered
   * option list to actually stop changing (this many ms at most) rather than guessing how long a
   * search takes. Fixed-budget guesses (plus a reactivation retry, plus a longer fallback wait)
   * kept losing races on slower Workday tenants without ever improving the odds of a real match.
   */
  settleWaitMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_SELECTION_SETTLE_MS = 250;
const DEFAULT_QUERY_COMMIT_DELAY_MS = 200;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Workday's "moniker search box" widget (confirmed on the Phone Country Code field, see
// docs/QA-FINDINGS.md Bug 7) has none of the ARIA markers the pattern above relies on — no
// aria-haspopup, role, or aria-controls anywhere in its ancestor chain. It shares
// data-uxi-widget-type="selectinput" with the ARIA-pattern School field, so absence of
// aria-haspopup is what distinguishes this variant. This selector is the single source of truth
// for "is this trigger the moniker widget" — generic-adapter.ts imports it too, for both its
// detection query and its native-query skip check, so the two files can't drift out of sync the
// way an earlier version of this code did (see commit 230c44a).
export const MONIKER_TRIGGER_SELECTOR = 'input[data-uxi-widget-type="selectinput"]:not([aria-haspopup="listbox"])';
// Most accessible comboboxes expose aria-haspopup=listbox. Liberty Mutual's iCIMS login form
// instead exposes role=combobox plus aria-controls, which is sufficient to locate its listbox.
export const STANDARD_COMBOBOX_TRIGGER_SELECTOR =
  '[aria-haspopup="listbox"], [role="combobox"][aria-controls]';

function isMonikerWidget(trigger: HTMLElement): boolean {
  return trigger.matches(MONIKER_TRIGGER_SELECTOR);
}

function isSearchInputWidget(trigger: HTMLElement): trigger is HTMLInputElement {
  return trigger instanceof HTMLInputElement && trigger.matches('input[data-uxi-widget-type="selectinput"]');
}

function isOracleGridCombobox(trigger: HTMLElement): boolean {
  return trigger.matches('.cx-select-input, [role="combobox"][aria-haspopup="grid"]');
}

function liveTrigger(trigger: HTMLElement): HTMLElement {
  return trigger.id ? document.getElementById(trigger.id) ?? trigger : trigger;
}

async function waitForOptions(
  trigger: HTMLElement,
  pollIntervalMs: number,
  maxAttempts: number,
  staleOptions: Set<HTMLElement> | null,
  candidates: string[]
): Promise<HTMLElement[]> {
  const monikerWidget = isMonikerWidget(trigger);
  const findOptions = monikerWidget
    ? () =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-automation-id="promptOption"]'))
          .filter((el) => !staleOptions?.has(el))
          // Workday can render this sentinel while its debounced remote search is still pending.
          // It is not a final empty result and can be replaced by real options hundreds of
          // milliseconds later.
          .filter((el) => !/^no items?\.?$/i.test(
            (el.getAttribute('data-automation-label') || el.textContent || '').trim()
          ))
    : () => {
        // Re-read aria-controls on every attempt, not just once up front: some widgets
        // (confirmed on real Workday) don't attach it to the trigger until the popup actually
        // mounts, which can happen asynchronously after the click that opens it.
        const controlsId = liveTrigger(trigger).getAttribute('aria-controls');
        const container = controlsId ? document.getElementById(controlsId) : null;
        // Oracle Recruiting renders its searchable select popup as an ARIA grid. The selectable
        // rows are gridcells rather than options, but otherwise follow the same aria-controls
        // contract as listbox comboboxes.
        return container
          ? Array.from(container.querySelectorAll<HTMLElement>('[role="option"], [role="gridcell"]'))
          : [];
      };

  let latestOptions: HTMLElement[] = [];
  const normalizedCandidates = candidates.map(normalize);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (isCancelled()) return latestOptions;
    const options = findOptions();
    if (options.length > 0) {
      latestOptions = options;
      if (!monikerWidget) return options;
      if (candidates.length === 0) return options;
      // Workday streams large search result sets into the portal. Wait for an exact saved value
      // instead of returning on the first partial batch and selecting a broader whole-word match
      // such as "BA - Duke University" before "Duke University" arrives.
      const hasExactMatch = options.some((option) => normalizedCandidates.includes(normalize(
        option.getAttribute('data-automation-label') || option.textContent || ''
      )));
      if (hasExactMatch) return options;
    }
    await wait(pollIntervalMs);
  }
  return latestOptions;
}

// Workday's skills catalogue streams results in over some tenant-dependent, sometimes slow and
// inconsistent amount of time — a fixed poll budget plus a reactivation retry plus a longer
// fallback wait (the previous approach) was three separate guesses at "how long is enough" and
// still lost races on slower tenants without actually raising the odds of a real match. Replacing
// all of that with one loop that waits for the rendered list to stop changing is simpler and
// adapts itself: fast tenants settle almost immediately, slow ones just take longer, and there's
// nothing left to retry because this always waits for the actual render to finish rather than a
// guess at its duration.
async function waitForSettledOptions(
  trigger: HTMLElement,
  pollIntervalMs: number,
  maxWaitMs: number,
  staleOptions: Set<HTMLElement> | null
): Promise<HTMLElement[]> {
  const readOptions = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-automation-id="promptOption"]'))
      .filter((el) => !staleOptions?.has(el))
      .filter((el) => !/^no items?\.?$/i.test(
        (el.getAttribute('data-automation-label') || el.textContent || '').trim()
      ));
  const signature = (opts: HTMLElement[]) =>
    opts.map((opt) => opt.getAttribute('data-automation-label') || opt.textContent || '').join('␟');

  let lastSignature: string | null = null;
  let lastOptions: HTMLElement[] = [];
  let stableStreak = 0;
  const startedAt = Date.now();
  const deadline = startedAt + maxWaitMs;
  // Confirmed on Micron's tenant: the same "Signal Generator" query returned a full 7-result batch
  // (including the correct generic "Signal Generators") on one run and only 2 results on another —
  // Workday streams results in over multiple batches, and "stable for two consecutive polls" is not
  // proof the render is actually finished, only that it hasn't changed in the last poll interval.
  // Refuse to settle before a floor has elapsed at all, so a short gap between an early, incomplete
  // batch and the fuller one that follows can't be mistaken for "done".
  const MIN_SETTLE_MS = 300;
  while (Date.now() < deadline) {
    if (isCancelled()) return lastOptions;
    const current = readOptions();
    const sig = signature(current);
    if (current.length > 0 && sig === lastSignature) {
      stableStreak++;
      if (stableStreak >= 2 && Date.now() - startedAt >= MIN_SETTLE_MS) return current;
    } else {
      stableStreak = 0;
    }
    lastSignature = sig;
    lastOptions = current;
    await wait(pollIntervalMs);
  }
  return lastOptions;
}

function pressKey(element: HTMLElement, key: string, code: string, keyCode: number): void {
  const init: KeyboardEventInit = {
    key,
    code,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
  };
  element.dispatchEvent(new KeyboardEvent('keydown', init));
  element.dispatchEvent(new KeyboardEvent('keypress', init));
  element.dispatchEvent(new KeyboardEvent('keyup', init));
}

function closePopup(trigger: HTMLElement): void {
  pressKey(trigger, 'Escape', 'Escape', 27);
}

function closeOracleGrid(trigger: HTMLElement): void {
  if (trigger.getAttribute('aria-expanded') !== 'true') return;
  const toggle = trigger.id ? document.getElementById(`${trigger.id}-toggle-button`) : null;
  if (toggle instanceof HTMLElement) toggle.click();
  else closePopup(trigger);
}

function leaveMonikerWidget(trigger: HTMLElement): void {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) closePopup(activeElement);
  if (activeElement !== trigger) closePopup(trigger);
  const liveTrigger = trigger.id ? document.getElementById(trigger.id) ?? trigger : trigger;
  liveTrigger.blur();

  // Selection can replace the original search input with a new React-rendered instance. Moving
  // focus to the next real control triggers Workday's focus-out close path even when `trigger`
  // itself is detached and a synthetic click-away is ignored by the tenant.
  const focusables = Array.from(document.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]):not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
  )).filter((element) => element.getClientRects().length > 0 || element.offsetParent !== null);
  const liveIndex = focusables.indexOf(liveTrigger);
  const nextControl = focusables.slice(liveIndex + 1).find((element) =>
    element !== liveTrigger && !element.closest('[data-automation-id="multiselectInputContainer"]')
  );
  nextControl?.focus();

  // Workday closes this menu through a click-away handler. A physical click starts with pointer
  // events before its compatibility mouse events; React's onPointerDown does not see a sequence
  // made only from MouseEvents.
  const outsideTarget = document.body;
  const PointerEventConstructor = window.PointerEvent ?? MouseEvent;
  outsideTarget.dispatchEvent(new PointerEventConstructor('pointerdown', { bubbles: true, cancelable: true }));
  outsideTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  outsideTarget.dispatchEvent(new PointerEventConstructor('pointerup', { bubbles: true, cancelable: true }));
  outsideTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  outsideTarget.click();
}

function clearFieldFlag(element: HTMLElement): void {
  if (element.dataset.autofillFlag !== 'needs-input') return;
  delete element.dataset.autofillFlag;
  element.style.outline = '';
}

function clickWithoutDefault(element: HTMLElement): void {
  const cancelDefault = (event: Event) => event.preventDefault();
  element.addEventListener('click', cancelDefault);
  try {
    // Dispatch mousedown/mouseup ahead of the click, not just the click itself: some widgets
    // (confirmed on real Workday, for its search-combobox option list) bind selection to
    // mousedown rather than click, to commit the selection before a blur/click-outside handler
    // can dismiss the popup first. element.click() alone only synthesizes a click event, so it
    // silently no-ops against a mousedown-driven handler even though it "looks like" a click.
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    element.click();
  } finally {
    element.removeEventListener('click', cancelDefault);
  }
}

function clickOption(element: HTMLElement): void {
  // Unlike a bare button trigger, an option has no form-submit default to suppress. Workday's
  // delegated handler uses the uncancelled click to finish selection and close the popup.
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  element.click();
}

function activateTrigger(trigger: HTMLElement): void {
  const adjacentButton = trigger instanceof HTMLInputElement && trigger.readOnly
    ? trigger.parentElement?.querySelector<HTMLElement>('button[role="presentation"], button[type="button"]')
    : null;
  if (adjacentButton) clickOption(adjacentButton);
  else clickWithoutDefault(trigger);
}

function isTypeable(element: HTMLElement): element is HTMLInputElement {
  return element instanceof HTMLInputElement && !element.readOnly;
}

function isWorkdayQuestionnaireButton(element: HTMLElement): element is HTMLButtonElement {
  return element instanceof HTMLButtonElement && element.id.startsWith('primaryQuestionnaire--');
}

function pressEnter(element: HTMLElement): void {
  pressKey(element, 'Enter', 'Enter', 13);
}

async function typeAndSearch(
  trigger: HTMLElement,
  value: string,
  monikerWidget: boolean,
  incrementalType: boolean | undefined,
  queryCommitDelayMs: number,
  pollIntervalMs: number
): Promise<void> {
  if (incrementalType && trigger instanceof HTMLInputElement) {
    await typeIncrementally(trigger, value, 20);
    await wait(Math.max(queryCommitDelayMs, 250));
  } else {
    setNativeValue(trigger, value);
    if (monikerWidget && queryCommitDelayMs > 0) await wait(queryCommitDelayMs);
  }
  pressEnter(trigger);
  if (!monikerWidget) await wait(Math.max(pollIntervalMs, 100));
}

// Emulates real keystrokes: each character gets its own native-setter value change plus a
// matching key event trio, so a debounced live-filter listening to keydown/input per character
// (rather than a single Enter-committed search) actually sees each intermediate query.
async function typeIncrementally(trigger: HTMLInputElement, value: string, keyDelayMs: number): Promise<void> {
  setNativeValue(trigger, '');
  let current = '';
  for (const char of value) {
    current += char;
    const code = char === ' ' ? 'Space' : `Key${char.toUpperCase()}`;
    pressKey(trigger, char, code, char.charCodeAt(0));
    setNativeValue(trigger, current);
    await wait(keyDelayMs);
  }
}

function isRequiredField(field: FieldDescriptor): boolean {
  return field.element.getAttribute('aria-required') === 'true' || /\*/.test(field.label);
}

function isSingleLocationField(field: FieldDescriptor): boolean {
  const label = normalize(field.label);
  return matchesLocationPhrase(label, 'preferred location') || matchesLocationPhrase(label, 'position location');
}

function isSourceField(field: FieldDescriptor): boolean {
  return field.element.id === 'source--source' || isSourceQuestion(field.label);
}

function workAuthorizationCandidates(field: FieldDescriptor, profile: Profile, value: string): string[] | null {
  if (
    field.profileKey !== 'workAuthorization.authorizedToWork' ||
    normalize(field.label).replace(/\s+select one$/, '') !== 'work authorization'
  ) return null;

  // Some Workday tenants collapse authorization and sponsorship into a single categorical
  // dropdown instead of Yes/No. Use the saved sponsorship answer to select the truthful category.
  if (normalize(profile.workAuthorization.requiresSponsorship ?? '') === 'yes') {
    return [
      'I require sponsorship to work in the U.S. (F1, H1, L1, J1)',
      'I require sponsorship to work in the US',
    ];
  }
  if (normalize(value) === 'yes') {
    return [
      'I am authorized to work in the U.S. for any employer (Green Card/Citizen)',
      'I am authorized to work in the US for any employer',
    ];
  }
  return ['My status to work in the U.S. is unknown', 'My status to work in the US is unknown'];
}

function matchesLocationPhrase(label: string, phrase: string): boolean {
  return label === phrase || label.startsWith(`${phrase} `) || label.includes(` ${phrase} `);
}

async function selectOnlyAvailableLocation(
  field: FieldDescriptor,
  pollIntervalMs: number,
  maxAttempts: number
): Promise<boolean> {
  let trigger = field.element;
  if (trigger.getAttribute('aria-expanded') !== 'true') {
    trigger.focus();
    trigger = liveTrigger(trigger);
    activateTrigger(trigger);
  }
  let options = await waitForOptions(trigger, pollIntervalMs, maxAttempts, null, []);
  trigger = liveTrigger(trigger);
  if (options.length === 0 && !isTypeable(trigger) && trigger.getAttribute('aria-expanded') !== 'true') {
    activateTrigger(trigger);
    options = await waitForOptions(trigger, pollIntervalMs, maxAttempts, null, []);
    trigger = liveTrigger(trigger);
  }
  const selectable = options.filter((option) =>
    option.getAttribute('aria-disabled') !== 'true' &&
    !option.hasAttribute('disabled') &&
    !/^(?:select|make a selection|--)?$/i.test((option.textContent || '').trim())
  );
  if (selectable.length !== 1) {
    closePopup(trigger);
    return false;
  }
  clickOption(selectable[0].closest<HTMLElement>('[role="option"], [role="gridcell"]') ?? selectable[0]);
  await wait(Math.max(pollIntervalMs, 50));
  clearFieldFlag(liveTrigger(trigger));
  return true;
}

async function selectCompanyWebsiteOption(
  field: FieldDescriptor,
  pollIntervalMs: number,
  maxAttempts: number
): Promise<boolean> {
  let trigger = field.element;
  let staleOptions = new Set(
    document.querySelectorAll<HTMLElement>('[data-automation-id="promptOption"]')
  );
  if (trigger.getAttribute('aria-expanded') !== 'true') {
    trigger.focus();
    trigger = liveTrigger(trigger);
    activateTrigger(trigger);
  }
  let insideCompanyWebsiteBranch = false;
  for (let depth = 0; depth < 5; depth++) {
    const options = await waitForOptions(trigger, pollIntervalMs, maxAttempts, staleOptions, []);
    trigger = liveTrigger(trigger);
    const selectable = options.filter((option) =>
      option.getAttribute('aria-disabled') !== 'true' &&
      !option.hasAttribute('disabled') &&
      !/^(?:select|make a selection|--)?$/i.test((option.textContent || '').trim())
    );
    const match = insideCompanyWebsiteBranch
      ? (selectable.length > 0 ? 0 : null)
      : findCompanyWebsiteSourceIndex(selectable.map((option) => option.textContent ?? ''));
    if (match === null) break;
    const selectedOption = selectable[match];
    const leaf = selectedOption.closest<HTMLElement>(
      '[data-automation-id="promptLeafNode"], [role="option"], [role="gridcell"]'
    ) ?? selectedOption;
    const hasChildren = leaf.getAttribute('data-uxi-multiselectlistitem-hassidecharm') === 'true';
    staleOptions = new Set(
      document.querySelectorAll<HTMLElement>('[data-automation-id="promptOption"]')
    );
    clickOption(leaf);
    await wait(Math.max(pollIntervalMs, 100));
    trigger = liveTrigger(trigger);
    if (hasChildren) {
      insideCompanyWebsiteBranch = true;
      continue;
    }
    if (selectedItemsNear(trigger).length > 0) {
      if (isMonikerWidget(trigger)) leaveMonikerWidget(trigger);
      else closePopup(trigger);
      clearFieldFlag(trigger);
      return true;
    }
    break;
  }
  closePopup(trigger);
  return false;
}

function selectedItemsNear(trigger: HTMLElement): HTMLElement[] {
  const selector =
    '[data-automation-id="selectedItem"], [data-automation-id="multiselectInputContainer"] [role="listitem"], ' +
    '[data-automation-id="selectedItemList"] [role="option"]';
  const multiselectId = trigger.getAttribute('data-uxi-multiselect-id');
  const multiselect = multiselectId ? document.getElementById(multiselectId) : null;
  if (multiselect?.contains(trigger)) {
    // Workday gives every multiselect and its search input the same widget id. Staying inside
    // that container prevents an empty field from borrowing a selected chip from another field
    // (for example How Did You Hear About Us? seeing Country Phone Code's selected country).
    return Array.from(multiselect.querySelectorAll<HTMLElement>(selector));
  }
  let scope: HTMLElement | null = trigger.parentElement;
  for (let depth = 0; scope && depth < 10; depth++, scope = scope.parentElement) {
    const triggers = scope.querySelectorAll(
      `${STANDARD_COMBOBOX_TRIGGER_SELECTOR}, ${MONIKER_TRIGGER_SELECTOR}`
    );
    if (triggers.length > 1) break;
    const selected = Array.from(scope.querySelectorAll<HTMLElement>(selector));
    if (selected.length > 0) return selected;
  }
  return [];
}

// Confirmed on Micron's tenant: nearly every search returned a tenant-branded entry ("Verilog HDL
// - Micron", "VLSI Design - Micron", "GitLab - Micron", ...) — this tenant's own internal
// skills-catalogue extension, not a generic skill. Selecting (or caching) one would misleadingly
// imply the applicant already has experience specific to this employer's own program/tooling,
// which is never true for a new applicant.
function isTenantBrandedSkillText(text: string): boolean {
  const hostnameSlug = location.hostname.split('.')[0]?.toLowerCase();
  if (!hostnameSlug || hostnameSlug.length < 3) return false;
  return new RegExp(`-\\s*${hostnameSlug}\\s*$`, 'i').test(text.trim());
}

// Programming-language punctuation is meaningful (C and C++ must remain distinct skills), but a
// hyphen standing in for a space isn't: confirmed the profile's "Test-Driven Development" never
// matched Workday's "Test Driven Development (TDD)" over exactly that difference, while Workday's
// own catalogue isn't even consistent about it ("Information-Flow Control" keeps its hyphen
// elsewhere). Treat hyphen and space as equivalent on both sides, nothing else — deliberately not
// the generic normalize() from synonym-dictionary, which strips ALL punctuation including "+"/"#"
// and so cannot be used anywhere a skill's own identity depends on it (matching, or a cache key —
// normalize("C++") === normalize("C") caused a live bug where "C++" silently reused "C"'s cached
// search label and value every run instead of ever searching for itself).
function normalizeSkill(text: string): string {
  return text.toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

function findFieldMatchIndex(
  texts: string[],
  candidates: string[],
  profileKey: FieldDescriptor['profileKey']
): number | null {
  if (profileKey !== 'professional.skills') return findMatchIndex(texts, candidates);
  const normalizedCandidates = candidates.map(normalizeSkill);
  // Confirmed on Workday's own catalogue: searching "C" correctly returns "C (Programming
  // Language)", "ANSI C", etc, but never bare "C" — short language names are always qualified.
  // coreSkillName() already strips this same shape of trailing parenthetical from the profile's
  // own skill text before searching; mirror that on the option side so "C" matches its qualified
  // catalogue form without loosening the exact-match rule into a fuzzy/substring one.
  const normalizedCandidateCores = candidates.map((c) => normalizeSkill(coreSkillName(c)));
  // Drop tenant-branded options before ranking anything, rather than trusting the matching logic
  // to consistently rank a safer option above them. Original indices are tracked through the
  // filter (rather than just filtering `texts`) because the caller indexes into its own,
  // unfiltered optionElements array with whatever index this function returns.
  const unbranded = texts
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => !isTenantBrandedSkillText(text));
  // Confirmed on Cisco's tenant: "C++ Programming Language" was the exact real catalogue entry
  // for "C++", but ranked 6th in that tenant's own search results — outside a top-5 cutoff, which
  // left it unmatched even though it's unambiguously correct. An exact/qualified-form match is
  // safe regardless of its rank (unlike the fuzzy tier below, nothing here is a guess), so it
  // searches the full result list; only the fuzzy tier trusts Workday's relevance ranking enough
  // to stop at the top few.
  const exact = unbranded.find(({ text }) => {
    const normalizedText = normalizeSkill(text);
    return normalizedCandidates.includes(normalizedText) ||
      normalizedCandidateCores.includes(normalizeSkill(coreSkillName(text)));
  });
  if (exact) return exact.index;

  // No exact/qualified-form hit: accept the most specific top-ranked option whose words are a
  // superset of the skill's own words (e.g. "PCB Design" inside "PCB Layout Design", "Onshape"
  // inside "PTC Onshape", "Codex" inside "OpenAI Codex") — every word the profile actually claims
  // must be present, so this can't drift onto an unrelated skill. Only a short (<=2 letter) single
  // word is excluded, where this would be too ambiguous ("C" is technically "inside" both "C-Arm"
  // and "C NMR") — those are already handled safely by the qualified-form tier above, and a longer
  // single word ("Vivado", "Onshape") is distinctive enough to fuzzy-match safely. Trusting
  // Workday's own relevance ranking (rather than the full, increasingly-unrelated tail) matters
  // here, unlike for the exact tier above, since a fuzzy word-superset match is inherently a guess
  // — though confirmed live on Cisco's tenant, "C++ Programming Language" (a real, correct,
  // word-superset match) ranked 6th out of 31 results for "C++", so the cutoff needs enough room
  // for a real match to still be findable, not just the top handful.
  const candidateWordSets = candidates
    .map((c) => wordSet(coreSkillName(c)))
    .filter((words) => words.size >= 2 || [...words].every((word) => word.length > 2));
  if (candidateWordSets.length === 0) return null;
  let bestIndex: number | null = null;
  let bestExtraWords = Infinity;
  unbranded.slice(0, 10).forEach(({ text, index }) => {
    const optionWords = wordSet(coreSkillName(text));
    for (const words of candidateWordSets) {
      if (![...words].every((word) => optionWords.has(word))) continue;
      const extraWords = optionWords.size - words.size;
      if (extraWords < bestExtraWords) {
        bestExtraWords = extraWords;
        bestIndex = index;
      }
    }
  });
  return bestIndex;
}

// Confirmed on Workday's own catalogue: "MS Office" only ever surfaces "Microsoft Office" as the
// real entry, and plain word-matching can't bridge that — "ms" and "microsoft" share no letters in
// common. A handful of unambiguous, purely-abbreviation forms like this are safe to fold together;
// this is not a general abbreviation expander (nothing here guesses at meaning), just the couple of
// confirmed real gaps.
const SKILL_WORD_ALIASES: Record<string, string> = { ms: 'microsoft' };

// Confirmed on Micron's tenant: "Signal Generator" never fuzzy-matched "Signal Generators" (the
// correct, generic catalogue entry) over the plural "s" alone, and picked "Vector Signal
// Generator" instead — a real but more specific/different piece of equipment — purely because it
// was the only top-5 option with the literal singular word. A simple trailing-"s" strip (skipped
// for short words and words already ending "ss", so "gas"/"process" are untouched) makes plurals
// match their singular form without attempting real stemming.
function singularize(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function wordSet(text: string): Set<string> {
  // "+" and "#" are kept as word characters, not treated as separators like other punctuation:
  // confirmed live, splitting on them reduced "C++" to bare "c" — indistinguishable from "C" and
  // then excluded outright as too ambiguous a short word — so it could never fuzzy-match "C++
  // Programming Language" even once the query itself was searching for the right thing.
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').split(' ').filter(Boolean)
      .map((word) => SKILL_WORD_ALIASES[word] ?? word)
      .map(singularize)
  );
}

function alreadyHasSelection(
  trigger: HTMLElement,
  candidates: string[],
  profileKey: FieldDescriptor['profileKey'] = null
): boolean {
  const selected = selectedItemsNear(trigger);
  if (selected.length > 0 && findFieldMatchIndex(
    selected.map((item) => item.textContent ?? ''), candidates, profileKey
  ) !== null) {
    return true;
  }
  // Workday questionnaire dropdowns render their committed answer directly in a button. Their
  // `value` is an opaque tenant ID, so compare the visible text/accessible label to the saved
  // answer. Besides recognizing success after a click, this prevents later Autofill runs from
  // reopening and rewriting buttons that are already filled.
  if (!(trigger instanceof HTMLInputElement)) {
    const renderedValues = [trigger.textContent ?? '', trigger.getAttribute('aria-label') ?? ''];
    if (findFieldMatchIndex(renderedValues, candidates, profileKey) !== null) return true;
  }
  if (trigger instanceof HTMLInputElement && trigger.value.trim()) {
    // React search/select controls used outside Workday render their committed selection directly
    // in the trigger input. Accept only an exact candidate here: whole-word matching would treat
    // "United States Minor Outlying Islands" as the saved "United States" phone-code choice.
    const normalizedValue = normalize(trigger.value);
    // Oracle Recruiting automatically opens the first month/year grid when an Education or
    // Experience editor mounts. The input still contains its committed value and the grid marks
    // that row selected; requiring aria-expanded=false sends the engine into a no-op click on an
    // already-selected row. Exact Oracle values are therefore committed even while that grid is
    // momentarily open.
    if (isOracleGridCombobox(trigger) && candidates.map(normalize).includes(normalizedValue)) {
      return true;
    }
    if (
      trigger.getAttribute('aria-controls') &&
      trigger.getAttribute('aria-expanded') !== 'true' &&
      candidates.map(normalize).includes(normalizedValue)
    ) {
      return true;
    }
    return false;
  }
  let scope: HTMLElement | null = trigger.parentElement;
  for (let depth = 0; scope && depth < 10; depth++, scope = scope.parentElement) {
    const widgetInputs = scope.querySelectorAll('input[data-uxi-widget-type="selectinput"]');
    if (widgetInputs.length !== 1) continue;
    const renderedText = (scope.innerText || scope.textContent || '').replace(/\s+/g, ' ').trim();
    if (renderedText && findFieldMatchIndex([renderedText], candidates, profileKey) !== null) return true;
  }
  return false;
}

async function removeMismatchedSelections(trigger: HTMLElement, candidates: string[], pollIntervalMs: number): Promise<void> {
  const selected = selectedItemsNear(trigger);
  if (selected.length === 0 || findMatchIndex(selected.map((item) => item.textContent ?? ''), candidates) !== null) return;
  for (const item of selected) {
    const remove = item.querySelector<HTMLElement>(
      'button, [role="button"], [data-automation-id*="remove"], [aria-label*="remove" i]'
    );
    (remove ?? item).click();
    await wait(Math.max(pollIntervalMs, 50));
  }
}

// Split on commas/semicolons/newlines, but not inside parentheses: a profile skill like
// "Firebase (Firestore, Cloud Functions, Auth)" is one entry, not three fragments that would
// never match anything in an ATS's skill catalogue.
function splitSkills(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,;\n]/.test(char)) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return Array.from(new Set(parts.map((skill) => skill.trim()).filter(Boolean)));
}

// The parenthetical is usually elaboration ("MIPS (Assembly)", "AI-Assisted Development (Claude
// Code, Codex)"), not part of the catalogue tag itself. Search/match on the bare name first.
function coreSkillName(skill: string): string {
  const stripped = skill.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return stripped || skill;
}

async function fillWorkdaySkills(
  field: FieldDescriptor,
  profile: Profile,
  value: string,
  options: ComboboxFillOptions
): Promise<FillSummary> {
  const skills = splitSkills(value);
  if (skills.length === 0) return { filled: 0, flagged: 0 };

  // Repair values produced by the old implementation, which submitted the full comma-separated
  // profile string as one Workday chip. Do not remove genuine individual selections the applicant
  // may already have added.
  for (const item of selectedItemsNear(field.element)) {
    if (!/[,;\n]/.test(item.textContent ?? '')) continue;
    const remove = item.querySelector<HTMLElement>(
      'button, [role="button"], [data-automation-id="DELETE_charm"], ' +
      '[data-automation-id*="remove" i], [aria-label*="remove" i]'
    );
    (remove ?? item).click();
    await wait(Math.max(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 50));
  }

  const w = window as unknown as { __jobAutofillSkillsTrace?: unknown[] };
  // One-time snapshot of the trigger's own attributes/classification: if every skill (including
  // ones any catalogue would have, like "Python") fails to match, this reveals whether the widget
  // is even being recognised as the moniker/search-input type the type-then-Enter flow expects.
  const probe = {
    type: 'probe',
    triggerId: field.element.id || undefined,
    tag: field.element.tagName,
    attrs: Array.from((field.element as HTMLElement).attributes ?? []).map((a) => `${a.name}="${a.value}"`),
    isMonikerWidget: isMonikerWidget(field.element),
    isSearchInputWidget: isSearchInputWidget(field.element),
    isTypeable: isTypeable(field.element),
  };
  (w.__jobAutofillSkillsTrace ??= []).push(probe);
  // eslint-disable-next-line no-console
  console.log('[autofill:skills] probe', JSON.stringify(probe));

  const summary: FillSummary = { filled: 0, flagged: 0 };
  // settleWaitMs (below) now governs how long a search is allowed to take overall — it waits for
  // the render to actually finish rather than guessing a duration. skillPollIntervalMs is just its
  // poll cadence; skillMaxAttempts no longer applies to skills (settleWaitMs supersedes it) but is
  // still accepted for whatever non-skill combobox path a caller might layer on top of this.
  const skillMaxAttempts = Math.min(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 12);
  const skillPollIntervalMs = Math.min(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 60);
  // Used to cap at 25 as a time-budget guard, but that silently dropped anything past it with no
  // flag or indication — a 29-skill profile lost its last 4 skills with zero visibility. The actual
  // time cost is a timing concern (already addressed above and by the catalogue cache), not a
  // reason to drop data the user asked to be filled in.
  for (const skill of skills) {
    if (isCancelled()) break;
    // Search on the bare name — a catalogue widget's own search rarely matches a query that
    // still has "(Firestore, Cloud Functions, Auth)" attached — but accept either as a match, in
    // case the tenant's tag does include the parenthetical verbatim.
    const core = coreSkillName(skill);
    // A prior run may already have discovered this skill's real catalogue label (e.g. "C" -> "C
    // (Programming Language)"). Search with that exact label instead of guessing again: it matches
    // on the first response with no ambiguity, instead of racing an uncertain query. Never trust a
    // tenant-branded cached label though (confirmed live: a stale one from before this exclusion
    // existed made every later run visibly search for "<Skill> - Micron" itself) — fall back to
    // the bare name instead, exactly as if nothing were cached.
    const rawCachedLabel = options.skillCatalogCache?.[normalizeSkill(core)];
    const cachedLabel = rawCachedLabel && !isTenantBrandedSkillText(rawCachedLabel) ? rawCachedLabel : undefined;
    const skillProfile: Profile = {
      ...profile,
      professional: { ...profile.professional, skills: cachedLabel ?? core },
    };
    // Captured straight from the real matching code's own live-dropdown read (see
    // debugOptionTexts) — not re-queried afterward, which previously only ever found whatever
    // confirmed chips were left over once the popup had already closed, regardless of the query.
    let matchedOptionTexts: string[] = [];
    const result = await fillComboboxFields(
      [{ ...field, candidates: cachedLabel ? [cachedLabel, core, skill] : [core, skill] }],
      skillProfile,
      {
        ...options,
        splitSkillValues: false,
        preserveMismatchedSelections: true,
        maxAttempts: skillMaxAttempts,
        pollIntervalMs: skillPollIntervalMs,
        incrementalType: true,
        settleWaitMs: 3000,
        debugOptionTexts: (texts) => { matchedOptionTexts = texts; },
        onMatch: (label) => {
          // findFieldMatchIndex already excludes tenant-branded options from ever being clicked,
          // so this should be unreachable with a branded label — kept as a defensive guard so a
          // future change to that logic can't silently start poisoning the persisted cache again.
          if (options.skillCatalogCache && !isTenantBrandedSkillText(label)) {
            options.skillCatalogCache[normalizeSkill(core)] = label;
          }
        },
      }
    );
    summary.filled += result.filled;
    summary.flagged += result.flagged;
    if (result.flagged > 0) {
      // Surfaced in the widget's own status text after the run (see runWithProfile/formatSummary)
      // so the applicant can see exactly which skills need adding by hand, instead of having to
      // open the diagnostic panel to find out. window, not a return value: fillWorkdaySkills's
      // caller only ever sees a plain FillSummary, and threading a skill-name list through every
      // combobox-fill call site for this one purpose isn't worth the churn.
      (window as unknown as { __jobAutofillFlaggedSkills?: string[] }).__jobAutofillFlaggedSkills
        ??= [];
      (window as unknown as { __jobAutofillFlaggedSkills: string[] }).__jobAutofillFlaggedSkills
        .push(skill);
    }
    const entry = {
      skill, core, filled: result.filled, flagged: result.flagged,
      // What Workday's search actually returned for this query, in the moment: empty means the
      // search genuinely found nothing (or never fired); non-empty but no match to core/skill means
      // it's using a different canonical name than the profile does.
      matchedOptionTexts,
    };
    // eslint-disable-next-line no-console
    console.log('[autofill:skills]', JSON.stringify(entry));
    (w.__jobAutofillSkillsTrace ??= []).push(entry);

    // On a miss, this skill's real search response can still be in flight (there's no way to
    // cancel Workday's own XHR from here) and land later, in the DOM, while the NEXT skill is
    // already searching — that's exactly how "MIPS" ended up reading Rust's results above. Give a
    // straggler a chance to land now, while it's still attributed to nothing, so the next attempt's
    // stale-options snapshot correctly excludes it instead of mistaking it for a fresh match.
    if (result.flagged > 0) await wait(Math.max(skillPollIntervalMs, 150));
  }
  return summary;
}

export async function fillComboboxFields(
  fields: FieldDescriptor[],
  profile: Profile,
  options: ComboboxFillOptions = {}
): Promise<FillSummary> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const selectionSettleMs = options.selectionSettleMs ?? DEFAULT_SELECTION_SETTLE_MS;
  const queryCommitDelayMs = options.queryCommitDelayMs ?? DEFAULT_QUERY_COMMIT_DELAY_MS;

  let filled = 0;
  let flagged = 0;

  for (const field of fields) {
    if (isCancelled()) break;
    const value = resolveProfileValueForField(profile, field);

    if (
      options.splitSkillValues !== false &&
      field.profileKey === 'professional.skills' &&
      value &&
      isMonikerWidget(field.element)
    ) {
      const skillSummary = await fillWorkdaySkills(field, profile, value, options);
      filled += skillSummary.filled;
      flagged += skillSummary.flagged;
      continue;
    }

    if (!value) {
      // Source questions default to the employer's own website/careers site. Do not silently pick
      // an unrelated job board or event when the tenant does not offer a company-site option.
      if (!field.profileKey && isRequiredField(field) && isSourceField(field)) {
        if (selectedItemsNear(field.element).length > 0) {
          clearFieldFlag(field.element);
          continue;
        }
        if (await selectCompanyWebsiteOption(field, pollIntervalMs, maxAttempts)) {
          filled++;
          continue;
        }
      }
      if (!field.profileKey && isRequiredField(field) && isSingleLocationField(field)) {
        if (await selectOnlyAvailableLocation(field, pollIntervalMs, maxAttempts)) {
          filled++;
          continue;
        }
      }
      // An unsupported required Workday multiselect can still be satisfied by a value the tenant
      // prefilled or the user selected earlier. Its search input remains empty by design; use the
      // selected-item list as the source of truth instead of flagging that empty search box.
      if (!field.profileKey && selectedItemsNear(field.element).length > 0) {
        clearFieldFlag(field.element);
        continue;
      }
      const currentText = (field.element.textContent || '').replace(/\s+/g, ' ').trim();
      if (!field.profileKey && currentText && !/^(select one|select|--)?$/i.test(currentText)) {
        clearFieldFlag(field.element);
        continue;
      }
      if (!field.profileKey && !isRequiredField(field)) continue;
      flagField(field.element);
      flagged++;
      continue;
    }

    let trigger = field.element;
    const candidates = field.candidates ??
      workAuthorizationCandidates(field, profile, value) ??
      buildCandidates(field.profileKey, value);
    // Oracle's phone-country grid contracts a committed United States selection to just "+1".
    // Do not add "+1" to the global candidate list: several North American countries share that
    // code, so it would make an empty dropdown vulnerable to selecting Canada or a territory.
    const hasCommittedOracleUsCode =
      field.profileKey === 'personal.phoneCountryCode' &&
      isOracleGridCombobox(trigger) &&
      /^country-codes-dropdown/i.test(trigger.id) &&
      normalize(value) === 'united states' &&
      (trigger as HTMLInputElement).value.trim() === '+1';
    if (hasCommittedOracleUsCode) {
      clearFieldFlag(trigger);
      closeOracleGrid(trigger);
      filled++;
      continue;
    }
    if (alreadyHasSelection(trigger, candidates, field.profileKey)) {
      clearFieldFlag(trigger);
      if (isMonikerWidget(trigger)) leaveMonikerWidget(trigger);
      else if (isOracleGridCombobox(trigger)) closeOracleGrid(trigger);
      filled++;
      continue;
    }
    if (!options.preserveMismatchedSelections) {
      await removeMismatchedSelections(trigger, candidates, pollIntervalMs);
    }

    // Snapshot existing promptOption elements before this field's trigger is touched at all, so a
    // stale popup left behind by an earlier field (if Workday doesn't fully tear down its DOM on
    // close) can never be mistaken for this field's newly-rendered options. Taken once per field,
    // before either waitForOptions call below, so this field's own click or type+Enter fallback
    // never self-excludes the options it renders.
    const staleOptions = isMonikerWidget(trigger)
      ? new Set(document.querySelectorAll<HTMLElement>('[data-automation-id="promptOption"]'))
      : null;

    if (trigger.getAttribute('aria-expanded') !== 'true') {
      // Workday's moniker search handler only treats input events as a search while its
      // search box is active. A synthetic click does not reliably focus an input.
      trigger.focus();
      trigger = liveTrigger(trigger);
      activateTrigger(trigger);
    }

    const monikerWidget = isMonikerWidget(trigger);
    const searchInputWidget = isSearchInputWidget(trigger);
    let didTypeFallback = searchInputWidget;

    // The Workday moniker widget opens an empty search popup and only performs the search after
    // Enter. Some tenants debounce the input into separate search state: pressing Enter in the
    // same task as the input event submits the previous empty query and returns "No Items" even
    // when the school exists. Let that state settle before sending the complete key sequence.
    if (searchInputWidget) {
      await typeAndSearch(trigger, value, monikerWidget, options.incrementalType, queryCommitDelayMs, pollIntervalMs);
    }

    let optionElements: HTMLElement[];
    if (options.settleWaitMs && monikerWidget && searchInputWidget) {
      // One wait that tracks the rendered list until it stops changing, instead of three layered
      // guesses at how long is enough (a fixed budget, a reactivation retry, then a longer
      // fallback) — that approach still lost races on slower tenants (Hitachi's) without actually
      // improving the odds of a match, since none of the extra passes changed anything about the
      // search itself. This adapts to however long the render actually takes.
      optionElements = await waitForSettledOptions(trigger, pollIntervalMs, options.settleWaitMs, staleOptions);
      trigger = liveTrigger(trigger);
      // The widget can still fail to even open at all (a real, different failure mode: the
      // activation right after being closed by leaveMonikerWidget only focuses it) — no amount of
      // waiting recovers from that, it needs a second physical activation.
      if (optionElements.length === 0 && trigger.getAttribute('aria-expanded') !== 'true') {
        activateTrigger(trigger);
        await typeAndSearch(trigger, value, monikerWidget, options.incrementalType, queryCommitDelayMs, pollIntervalMs);
        optionElements = await waitForSettledOptions(trigger, pollIntervalMs, options.settleWaitMs, staleOptions);
        trigger = liveTrigger(trigger);
      }
    } else {
      optionElements = await waitForOptions(trigger, pollIntervalMs, maxAttempts, staleOptions, candidates);
      trigger = liveTrigger(trigger);

      // Confirmed on Workday's Skills catalogue box: the activation right after this widget was
      // last closed via leaveMonikerWidget only focuses it — the popup itself doesn't open, so
      // nothing typed reaches a real search. One extra activation reliably recovers from that
      // specific state; beyond that, repeating the identical action against an already-open widget
      // cannot change a deterministic search result, so this does not loop further.
      if (optionElements.length === 0 && monikerWidget && searchInputWidget && trigger.getAttribute('aria-expanded') !== 'true') {
        activateTrigger(trigger);
        await typeAndSearch(trigger, value, monikerWidget, options.incrementalType, queryCommitDelayMs, pollIntervalMs);
        optionElements = await waitForOptions(trigger, pollIntervalMs, maxAttempts, staleOptions, candidates);
        trigger = liveTrigger(trigger);
      }
    }

    if (
      optionElements.length === 0 &&
      !monikerWidget &&
      !isTypeable(trigger) &&
      trigger.getAttribute('aria-expanded') !== 'true'
    ) {
      // Some Workday tenants consume the first synthetic button click only as focus: the field
      // receives its blue focus outline, but no listbox is mounted. A real user's next click opens
      // it. Reproduce that second click only when the first bounded wait produced no options and
      // the newly rendered trigger still does not report itself expanded. Workday can replace the
      // original button on focus, so never retry against the detached pre-focus element.
      activateTrigger(trigger);
      optionElements = await waitForOptions(trigger, pollIntervalMs, maxAttempts, staleOptions, candidates);
      trigger = liveTrigger(trigger);
    }

    if (optionElements.length === 0 && !monikerWidget && isTypeable(trigger) && !isOracleGridCombobox(trigger)) {
      didTypeFallback = true;
      setNativeValue(trigger, value);
      pressEnter(trigger);
      optionElements = await waitForOptions(trigger, pollIntervalMs, maxAttempts, staleOptions, candidates);
    }

    options.debugOptionTexts?.(optionElements.map(
      (opt) => opt.getAttribute('data-automation-label') || opt.textContent || ''
    ));

    if (optionElements.length === 0) {
      // If the type-then-Enter fallback ran but still didn't resolve any options, clear the
      // typed text before flagging: leaving it in place would show a flagged field that still
      // contains free-text the user never entered, and can trip the site's own validation on an
      // unresolved value.
      if (didTypeFallback && isTypeable(trigger)) {
        setNativeValue(trigger, '');
      }
      await wait(Math.max(pollIntervalMs, 100));
      if (alreadyHasSelection(trigger, candidates, field.profileKey)) {
        clearFieldFlag(trigger);
        if (isMonikerWidget(trigger)) leaveMonikerWidget(trigger);
        filled++;
        continue;
      }
      // A moniker widget needs its full click-away teardown here, not just Escape: otherwise its
      // popup and any rendered options linger in the DOM (confirmed — they showed up as stray
      // matches in unrelated later diagnostics) and can interfere with the next field's own
      // activation/search.
      if (isMonikerWidget(trigger)) leaveMonikerWidget(trigger); else closePopup(trigger);
      flagField(trigger);
      flagged++;
      continue;
    }

    const optionTexts = optionElements.map(
      (opt) => opt.getAttribute('data-automation-label') || opt.textContent || ''
    );
    const matchIndex = findFieldMatchIndex(optionTexts, candidates, field.profileKey);

    if (matchIndex === null) {
      if (didTypeFallback && isTypeable(trigger)) setNativeValue(trigger, '');
      await wait(Math.max(pollIntervalMs, 100));
      if (alreadyHasSelection(trigger, candidates, field.profileKey)) {
        clearFieldFlag(trigger);
        if (isMonikerWidget(trigger)) leaveMonikerWidget(trigger);
        filled++;
        continue;
      }
      if (isMonikerWidget(trigger)) leaveMonikerWidget(trigger); else closePopup(trigger);
      flagField(trigger);
      flagged++;
      continue;
    }

    options.onMatch?.(optionTexts[matchIndex]);

    let matchedOption = optionElements[matchIndex];
    const optionClickTarget = monikerWidget
      ? matchedOption.closest<HTMLElement>('[data-automation-id="promptLeafNode"]') ??
        matchedOption.closest<HTMLElement>('[role="option"]') ?? matchedOption
      : matchedOption.closest<HTMLElement>('[role="option"]') ?? matchedOption;
    clickOption(optionClickTarget);

    if (isOracleGridCombobox(trigger)) {
      // Oracle leaves some month/year grids expanded after programmatic option activation. Close
      // the active grid so the next component opens against its own aria-controls target.
      await wait(Math.max(pollIntervalMs, 50));
      trigger = liveTrigger(trigger);
      closeOracleGrid(trigger);
    }

    if (!monikerWidget && isWorkdayQuestionnaireButton(trigger)) {
      // A live Workday questionnaire accepted the option and rendered "Yes", then a pending
      // page-wide React update restored "Select One" about 90 ms later. That is why running
      // Autofill a second time worked. Wait past that update and verify the rendered answer; if it
      // rolled back, reopen the settled control and repeat the same selection in this run.
      await wait(selectionSettleMs);
      trigger = liveTrigger(trigger);
      if (!alreadyHasSelection(trigger, candidates, field.profileKey)) {
        if (trigger.getAttribute('aria-expanded') === 'true') {
          closePopup(trigger);
          await wait(pollIntervalMs);
        }
        if (trigger.getAttribute('aria-expanded') !== 'true') {
          trigger.focus();
          trigger = liveTrigger(trigger);
          activateTrigger(trigger);
        }
        optionElements = await waitForOptions(trigger, pollIntervalMs, maxAttempts, staleOptions, candidates);
        trigger = liveTrigger(trigger);
        const retryTexts = optionElements.map(
          (opt) => opt.getAttribute('data-automation-label') || opt.textContent || ''
        );
        const retryMatchIndex = findFieldMatchIndex(retryTexts, candidates, field.profileKey);
        if (retryMatchIndex !== null) {
          matchedOption = optionElements[retryMatchIndex];
          clickOption(matchedOption.closest<HTMLElement>('[role="option"]') ?? matchedOption);
          await wait(selectionSettleMs);
          trigger = liveTrigger(trigger);
        }
      }
      if (!alreadyHasSelection(trigger, candidates, field.profileKey)) {
        closePopup(trigger);
        flagField(trigger);
        flagged++;
        continue;
      }
    }

    if (monikerWidget) {
      // Workday commits the selected country but leaves this multiselect's menu open. Let the
      // option event finish first, then dismiss the widget without refocusing its search input
      // (refocusing it opens the menu again).
      // Selection clears the query and asynchronously repopulates the unfiltered menu. Wait for
      // that update before clicking away, otherwise the late render can reopen the menu.
      await wait(Math.max(pollIntervalMs, 100));
      trigger = liveTrigger(trigger);
      if (trigger.dataset.jobAutofillRepeatable === 'true' && !alreadyHasSelection(trigger, candidates, field.profileKey)) {
        leaveMonikerWidget(trigger);
        flagField(trigger);
        flagged++;
        continue;
      }
      leaveMonikerWidget(trigger);
    }
    clearFieldFlag(trigger);
    filled++;
  }

  return { filled, flagged };
}
