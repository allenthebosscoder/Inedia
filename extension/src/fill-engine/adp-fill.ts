import { Profile } from '../storage/profile-schema';
import {
  buildCandidates,
  findMatchIndex,
  flagField,
  resolveProfileValue,
  resolveProfileValueForField,
} from './fill-engine';
import { extractFields } from './generic-adapter';
import { FieldDescriptor, FillSummary } from './types';

interface AdpFillOptions {
  focusSettleMs?: number;
  inputSettleMs?: number;
  blurSettleMs?: number;
  selectPollIntervalMs?: number;
  selectMaxAttempts?: number;
}

export const ADP_REACT_SELECT_SELECTOR =
  'input.MDFSelectBox__input[role="combobox"][aria-haspopup="true"]';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearFlag(element: HTMLElement): void {
  delete element.dataset.autofillFlag;
  element.style.outline = '';
}

function clearSelectFlags(input: HTMLInputElement): void {
  clearFlag(input);
  const container = input.closest<HTMLElement>('.css-b62m3t-container') ?? input.parentElement?.parentElement;
  container?.querySelectorAll<HTMLElement>('[aria-hidden="true"]').forEach(clearFlag);
}

function liveControl(field: FieldDescriptor): HTMLInputElement | HTMLTextAreaElement | null {
  const original = field.element;
  if (!(original instanceof HTMLInputElement || original instanceof HTMLTextAreaElement)) return null;
  if (original.id) {
    const live = document.getElementById(original.id);
    if (live instanceof HTMLInputElement || live instanceof HTMLTextAreaElement) return live;
  }
  return original.isConnected ? original : null;
}

function dispatchAdpInput(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    composed: true,
    data: value,
    inputType: 'insertText',
  }));
}

async function commitAdpValue(
  field: FieldDescriptor,
  value: string,
  options: Required<AdpFillOptions>
): Promise<boolean> {
  let element = liveControl(field);
  if (!element) return false;
  if (element.value === value) {
    clearFlag(element);
    return true;
  }

  // MDF TextBox derives its internal value from props until its asynchronous hasFocus state is
  // true. Writing in the same turn as focus makes it immediately restore the old value. A real
  // focus transition plus a short render boundary is therefore part of the value transaction.
  if (document.activeElement === element) {
    element.blur();
    await wait(options.focusSettleMs);
    element = liveControl(field);
    if (!element) return false;
  }
  element.focus();
  await wait(options.focusSettleMs);

  element = liveControl(field);
  if (!element) return false;
  dispatchAdpInput(element, value);
  await wait(options.inputSettleMs);

  element = liveControl(field);
  if (!element || element.value !== value) return false;
  element.blur();
  await wait(options.blurSettleMs);

  element = liveControl(field);
  const committed = element?.value === value;
  if (committed && element) clearFlag(element);
  return committed;
}

function isRequiredField(field: FieldDescriptor): boolean {
  return field.element.matches('[required], [aria-required="true"]') || /\*/.test(field.label);
}

function liveSelect(input: HTMLInputElement): HTMLInputElement | null {
  if (input.id) {
    const live = document.getElementById(input.id);
    if (live instanceof HTMLInputElement) return live;
  }
  return input.isConnected ? input : null;
}

function selectedText(input: HTMLInputElement): string {
  return input.closest<HTMLElement>('.MDFSelectBox__control')
    ?.querySelector<HTMLElement>('.MDFSelectBox__single-value')?.textContent?.trim() ?? '';
}

function selectedMatches(input: HTMLInputElement, candidates: string[]): boolean {
  const selected = selectedText(input);
  return Boolean(selected) && findMatchIndex([selected], candidates) !== null;
}

function sendSelectKey(input: HTMLInputElement, key: 'ArrowDown' | 'Escape'): void {
  const keyCode = key === 'ArrowDown' ? 40 : 27;
  input.dispatchEvent(new KeyboardEvent('keydown', {
    key,
    code: key,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
  }));
}

function closeSelect(input: HTMLInputElement): void {
  if (input.getAttribute('aria-expanded') === 'true') sendSelectKey(input, 'Escape');
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
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const input = liveSelect(original);
    if (!input) return [];
    const controlsId = input.getAttribute('aria-controls');
    const listbox = controlsId ? document.getElementById(controlsId) : null;
    latest = listbox ? Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]')) : [];
    if (findMatchIndex(latest.map((option) => option.textContent ?? ''), candidates) !== null) return latest;
    await wait(pollIntervalMs);
  }
  return latest;
}

async function selectAdpValue(
  original: HTMLInputElement,
  candidates: string[],
  pollIntervalMs: number,
  maxAttempts: number
): Promise<boolean> {
  let input = liveSelect(original);
  if (!input) return false;
  if (selectedMatches(input, candidates)) {
    clearSelectFlags(input);
    closeSelect(input);
    return true;
  }

  document.querySelectorAll<HTMLInputElement>(ADP_REACT_SELECT_SELECTOR).forEach((candidate) => {
    if (candidate !== input) closeSelect(candidate);
  });
  input.focus();
  if (input.getAttribute('aria-expanded') !== 'true') sendSelectKey(input, 'ArrowDown');

  const options = await optionsFor(original, candidates, pollIntervalMs, maxAttempts);
  const match = findMatchIndex(options.map((option) => option.textContent ?? ''), candidates);
  if (match === null) {
    input = liveSelect(original);
    if (input) {
      closeSelect(input);
      flagField(input);
    }
    return false;
  }

  clickOption(options[match]);
  input = liveSelect(original);
  if (input && selectedMatches(input, candidates)) {
    clearSelectFlags(input);
    closeSelect(input);
    return true;
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await wait(pollIntervalMs);
    input = liveSelect(original);
    if (!input) return false;
    if (selectedMatches(input, candidates)) {
      clearSelectFlags(input);
      closeSelect(input);
      return true;
    }
  }
  input = liveSelect(original);
  if (input) {
    closeSelect(input);
    flagField(input);
  }
  return false;
}

export async function fillAdpForm(
  profile: Profile,
  root: ParentNode = document,
  options: AdpFillOptions = {}
): Promise<FillSummary> {
  const timing: Required<AdpFillOptions> = {
    focusSettleMs: options.focusSettleMs ?? 75,
    inputSettleMs: options.inputSettleMs ?? 75,
    blurSettleMs: options.blurSettleMs ?? 100,
    selectPollIntervalMs: options.selectPollIntervalMs ?? 50,
    selectMaxAttempts: options.selectMaxAttempts ?? 40,
  };
  const extracted = extractFields(root);
  const selectFields = extracted.filter((field) => field.element.matches(ADP_REACT_SELECT_SELECTOR));
  const fields = extracted.filter((field) =>
    (field.kind === 'text' || field.kind === 'textarea') &&
    !field.element.matches(ADP_REACT_SELECT_SELECTOR)
  );
  let filled = 0;
  let flagged = 0;

  for (const field of selectFields) {
    const input = field.element as HTMLInputElement;
    const value = field.profileKey ? resolveProfileValue(profile, field.profileKey) : null;
    if (!value) {
      if (selectedText(input) || !isRequiredField(field)) {
        clearSelectFlags(input);
      } else {
        flagField(input);
        flagged++;
      }
      continue;
    }
    const candidates = buildCandidates(field.profileKey, value);
    if (await selectAdpValue(
      input,
      candidates,
      timing.selectPollIntervalMs,
      timing.selectMaxAttempts
    )) {
      filled++;
    } else {
      flagged++;
    }
  }

  for (const field of fields) {
    const value = resolveProfileValueForField(profile, field);
    let element = liveControl(field);
    if (!element) continue;

    if (!value) {
      if (element.value.trim() || !isRequiredField(field)) {
        clearFlag(element);
      } else {
        flagField(element);
        flagged++;
      }
      continue;
    }

    if (await commitAdpValue(field, value, timing)) {
      filled++;
    } else {
      element = liveControl(field);
      if (element) flagField(element);
      flagged++;
    }
  }

  return { filled, flagged };
}
