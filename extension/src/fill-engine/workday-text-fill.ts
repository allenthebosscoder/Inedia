import { Profile } from '../storage/profile-schema';
import { resolveProfileValueForField } from './fill-engine';
import { FieldDescriptor, FillSummary } from './types';

type ReactHandler = (event: Record<string, unknown>) => void;

function invokeReactHandler(element: HTMLElement, handlerName: 'onInput' | 'onChange' | 'onBlur'): void {
  const propsKey = Object.getOwnPropertyNames(element).find((key) => key.startsWith('__reactProps$'));
  if (!propsKey) return;
  const props = (element as unknown as Record<string, unknown>)[propsKey] as Record<string, unknown> | undefined;
  const handler = props?.[handlerName] as ReactHandler | undefined;
  if (typeof handler !== 'function') return;

  const type = handlerName === 'onInput' ? 'input' : handlerName === 'onChange' ? 'change' : 'blur';
  const nativeEvent = new Event(type, { bubbles: true, cancelable: true });
  let defaultPrevented = false;
  let propagationStopped = false;
  handler({
    type,
    target: element,
    currentTarget: element,
    nativeEvent,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    eventPhase: Event.AT_TARGET,
    isTrusted: false,
    timeStamp: nativeEvent.timeStamp,
    preventDefault: () => { defaultPrevented = true; },
    isDefaultPrevented: () => defaultPrevented,
    stopPropagation: () => { propagationStopped = true; },
    isPropagationStopped: () => propagationStopped,
    persist: () => undefined,
    isPersistent: () => true,
  });
}

function hasReactProps(element: HTMLElement): boolean {
  return Object.getOwnPropertyNames(element).some((key) => key.startsWith('__reactProps$'));
}

function setWorkdayEditedValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(element, value);

  // Newer Workday tenants do not expose React props on ordinary controls and distinguish a plain
  // Event('input') from the InputEvent produced by an actual edit. Supplying its edit metadata is
  // what makes their form model accept the visible value on Save and Continue.
  element.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    composed: true,
    inputType: 'insertText',
    data: value,
  }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function primeWorkdayValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

/**
 * Commits ordinary Workday text fields through the handlers owned by the mounted component.
 * A DOM value plus a synthetic input event is not sufficient for several Workday tenants: the
 * value is visible, but Save and Continue validates the component's still-empty form model.
 */
export async function fillWorkdayTextFields(
  fields: FieldDescriptor[],
  profile: Profile
): Promise<{
  summary: FillSummary;
  handled: Set<HTMLElement>;
  pending: Array<{ id: string; value: string }>;
}> {
  const handled = new Set<HTMLElement>();
  const pending: Array<{ id: string; value: string }> = [];
  let filled = 0;

  for (const field of fields) {
    if (field.kind !== 'text' && field.kind !== 'textarea') continue;
    const value = resolveProfileValueForField(profile, field);
    if (!value) continue;
    if (!(field.element instanceof HTMLInputElement || field.element instanceof HTMLTextAreaElement)) continue;

    const element = field.element;
    handled.add(element);
    delete element.dataset.autofillFlag;
    element.style.outline = '';
    element.focus();

    // The prototype setter leaves React's instance value tracker at its previous value. Workday's
    // own onInput handler then observes a genuine old-to-new transition and updates form state.
    const exposesReactHandlers = hasReactProps(element);
    if (exposesReactHandlers) {
      // Workday ordinary controls expose their state callbacks in the MAIN world. Set the DOM
      // value first because onBlur reads it back, then invoke onChange and onBlur directly. This
      // is the controlled-input transaction used by established open-source Workday fillers.
      element.value = value;
      invokeReactHandler(element, 'onChange');
      invokeReactHandler(element, 'onBlur');
    } else {
      // GlobalFoundries' newer Workday controls initialize their widget state from the first
      // generic edit, then accept the form-model value from a later InputEvent transaction after
      // the page's dropdown renders settle. Record that late commit without rerunning extraction.
      primeWorkdayValue(element, value);
      element.blur();
      if (element.id) pending.push({ id: element.id, value });
    }
    // Give any resulting Workday render a task before processing the next field.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (exposesReactHandlers) element.blur();
    filled++;
  }

  return { summary: { filled, flagged: 0 }, handled, pending };
}

export async function commitPendingWorkdayTextFields(
  pending: Array<{ id: string; value: string }>
): Promise<void> {
  for (const item of pending) {
    const element = document.getElementById(item.id);
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) continue;
    if (hasReactProps(element)) continue;
    element.focus();
    element.select();
    const edited = typeof document.execCommand === 'function' &&
      document.execCommand('insertText', false, item.value);
    if (!edited || element.value !== item.value) setWorkdayEditedValue(element, item.value);
    // Leave the final control focused. Focusing the next control naturally blurs its predecessor
    // only after Workday has had time to commit the current InputEvent.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
