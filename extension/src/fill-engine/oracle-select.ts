import { findMatchIndex, flagField } from './fill-engine';
import { normalize } from './synonym-dictionary';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clickOption(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  element.click();
}

function exactValue(input: HTMLInputElement, candidates: string[]): boolean {
  const value = normalize(input.value);
  return Boolean(value) && candidates.map(normalize).includes(value);
}

function clearFlag(element: HTMLElement): void {
  delete element.dataset.autofillFlag;
  element.style.outline = '';
}

type OracleRoot = ParentNode | (() => ParentNode | null);

function resolveRoot(root: OracleRoot): ParentNode | null {
  return typeof root === 'function' ? root() : root;
}

function liveInput(root: OracleRoot, selector: string): HTMLInputElement | null {
  return resolveRoot(root)?.querySelector<HTMLInputElement>(selector) ?? null;
}

async function closeExpandedGrids(root: OracleRoot): Promise<void> {
  const currentRoot = resolveRoot(root);
  if (!currentRoot) return;
  const expanded = Array.from(currentRoot.querySelectorAll<HTMLInputElement>(
    'input.cx-select-input[aria-expanded="true"], input[role="combobox"][aria-haspopup="grid"][aria-expanded="true"]'
  ));
  for (const input of expanded) {
    const toggle = input.id ? document.getElementById(`${input.id}-toggle-button`) : null;
    if (toggle instanceof HTMLElement) toggle.click();
    else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    await wait(50);
  }
}

export async function selectOracleGridValue(
  root: OracleRoot,
  selector: string,
  candidates: string[],
  options: { pollIntervalMs?: number; maxAttempts?: number } = {}
): Promise<boolean> {
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const maxAttempts = options.maxAttempts ?? 60;
  await closeExpandedGrids(root);

  let input = liveInput(root, selector);
  if (!input) return false;
  if (exactValue(input, candidates)) {
    clearFlag(input);
    return true;
  }

  const toggle = input.id ? document.getElementById(`${input.id}-toggle-button`) : null;
  if (toggle instanceof HTMLElement) toggle.click();
  else input.click();

  let optionsList: HTMLElement[] = [];
  const pollStartedAt = Date.now();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    input = liveInput(root, selector) ?? input;
    // Oracle frequently replaces the combobox after the click and commits the selected/default
    // value before it mounts a grid. In that state aria-expanded can remain stale even though the
    // value is already final, so waiting for grid cells would only stall the entire fill pass.
    if (exactValue(input, candidates)) {
      clearFlag(input);
      await closeExpandedGrids(root);
      return true;
    }
    const controls = input.getAttribute('aria-controls');
    const container = controls ? document.getElementById(controls) : null;
    optionsList = container
      ? Array.from(container.querySelectorAll<HTMLElement>('[role="gridcell"], [role="option"]'))
      : [];
    if (optionsList.length > 0) break;
    if (Date.now() - pollStartedAt >= 8_000) break;
    await wait(pollIntervalMs);
  }

  const match = findMatchIndex(optionsList.map((option) => option.textContent ?? ''), candidates);
  if (match === null) {
    input = liveInput(root, selector) ?? input;
    flagField(input);
    await closeExpandedGrids(root);
    return false;
  }

  clickOption(optionsList[match]);
  const commitStartedAt = Date.now();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await wait(Math.max(50, pollIntervalMs));
    input = liveInput(root, selector) ?? input;
    if (exactValue(input, candidates)) {
      await closeExpandedGrids(root);
      input = liveInput(root, selector) ?? input;
      clearFlag(input);
      return true;
    }
    if (Date.now() - commitStartedAt >= 8_000) break;
  }
  await closeExpandedGrids(root);
  input = liveInput(root, selector) ?? input;
  flagField(input);
  return false;
}
