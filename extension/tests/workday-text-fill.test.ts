import { describe, expect, it, vi } from 'vitest';
import { commitPendingWorkdayTextFields, fillWorkdayTextFields } from '../src/fill-engine/workday-text-fill';
import { DEFAULT_PROFILE, Profile } from '../src/storage/profile-schema';

describe('fillWorkdayTextFields', () => {
  it('commits text through the mounted Workday React handlers before blur validation', async () => {
    document.body.innerHTML = '<input id="legalNameSection_firstName" type="text" />';
    const input = document.querySelector('input') as HTMLInputElement;
    let modelValue = '';
    const onInput = vi.fn((event: { target: HTMLInputElement }) => {
      modelValue = event.target.value;
    });
    const onChange = vi.fn((event: { target: HTMLInputElement }) => {
      modelValue = event.target.value;
    });
    const onBlur = vi.fn(() => {
      if (!modelValue) input.setAttribute('aria-invalid', 'true');
    });
    Object.defineProperty(input, '__reactProps$fixture', {
      configurable: true,
      value: { onInput, onChange, onBlur },
    });
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, firstName: 'Allen' },
    };

    const result = await fillWorkdayTextFields([{
      element: input,
      label: 'First Name',
      kind: 'text',
      profileKey: 'personal.firstName',
    }], profile);

    expect(result.summary).toEqual({ filled: 1, flagged: 0 });
    expect(result.handled.has(input)).toBe(true);
    expect(result.pending).toEqual([]);
    expect(input.value).toBe('Allen');
    expect(modelValue).toBe('Allen');
    expect(onInput).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onBlur).toHaveBeenCalledOnce();
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
  });

  it('leaves unmapped text fields for the generic missing-field pass', async () => {
    document.body.innerHTML = '<input id="customQuestion" type="text" />';
    const input = document.querySelector('input') as HTMLInputElement;

    const result = await fillWorkdayTextFields([{
      element: input,
      label: 'Employer-specific question',
      kind: 'text',
      profileKey: null,
    }], DEFAULT_PROFILE);

    expect(result.summary).toEqual({ filled: 0, flagged: 0 });
    expect(result.handled.size).toBe(0);
    expect(result.pending).toEqual([]);
  });

  it('initializes and later commits newer Workday controls with an InputEvent', async () => {
    document.body.innerHTML = '<input id="phoneNumber--phoneNumber" type="text" />';
    const input = document.querySelector('input') as HTMLInputElement;
    const eventTypes: string[] = [];
    input.addEventListener('input', (event) => {
      eventTypes.push(event instanceof InputEvent ? `input:${event.inputType}` : 'input:plain');
    });
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phone: '9196856669' },
    };

    const result = await fillWorkdayTextFields([{
      element: input,
      label: 'Phone Number',
      kind: 'text',
      profileKey: 'personal.phone',
    }], profile);
    expect(eventTypes).toEqual(['input:plain']);
    expect(result.pending).toEqual([{ id: 'phoneNumber--phoneNumber', value: '9196856669' }]);

    const originalExecCommand = document.execCommand;
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    await commitPendingWorkdayTextFields(result.pending);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: originalExecCommand,
    });
    expect(eventTypes).toEqual(['input:plain', 'input:insertText']);
  });
});
