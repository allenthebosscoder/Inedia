import { beforeEach, describe, expect, it } from 'vitest';
import { fillAdpForm } from '../src/fill-engine/adp-fill';
import { DEFAULT_PROFILE, Profile } from '../src/storage/profile-schema';

function mountMdfTextbox(id: string, label: string): HTMLInputElement {
  const input = document.createElement('input');
  input.id = id;
  input.setAttribute('aria-label', label);
  input.setAttribute('aria-required', 'true');
  document.body.append(input);

  let hasFocus = false;
  let internalValue = '';
  let modelValue = '';
  input.addEventListener('focus', () => {
    setTimeout(() => { hasFocus = true; }, 0);
  });
  input.addEventListener('input', () => {
    if (hasFocus) internalValue = input.value;
    else input.value = modelValue;
  });
  input.addEventListener('blur', () => {
    modelValue = internalValue;
    input.value = modelValue;
    hasFocus = false;
  });
  return input;
}

function mountMdfSelect(id: string, label: string, options: string[]): HTMLInputElement {
  const container = document.createElement('div');
  container.className = 'css-b62m3t-container';
  const fieldLabel = document.createElement('label');
  fieldLabel.htmlFor = id;
  fieldLabel.textContent = `${label}*`;
  const control = document.createElement('div');
  control.className = 'MDFSelectBox__control';
  const input = document.createElement('input');
  input.id = id;
  input.className = 'MDFSelectBox__input';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-haspopup', 'true');
  input.setAttribute('aria-expanded', 'false');
  const requiredProxy = document.createElement('input');
  requiredProxy.required = true;
  requiredProxy.tabIndex = -1;
  requiredProxy.setAttribute('aria-hidden', 'true');
  requiredProxy.dataset.autofillFlag = 'needs-input';

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', `${id}-listbox`);
    const listbox = document.createElement('div');
    listbox.id = `${id}-listbox`;
    listbox.setAttribute('role', 'listbox');
    for (const value of options) {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.textContent = value;
      option.addEventListener('click', () => {
        control.querySelector('.MDFSelectBox__single-value')?.remove();
        const selected = document.createElement('div');
        selected.className = 'MDFSelectBox__single-value';
        selected.textContent = value;
        control.prepend(selected);
        input.setAttribute('aria-expanded', 'false');
        listbox.remove();
      });
      listbox.append(option);
    }
    document.body.append(listbox);
  });
  control.append(input);
  container.append(fieldLabel, control, requiredProxy);
  document.body.append(container);
  return input;
}

describe('fillAdpForm', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('waits for MDF focus state, types, blurs, and verifies committed contact values', async () => {
    const first = mountMdfTextbox('guestFirstName', 'First Name');
    const last = mountMdfTextbox('guestLastName', 'Last Name');
    const email = mountMdfTextbox('guestEmail', 'Email');
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      personal: {
        ...DEFAULT_PROFILE.personal,
        firstName: 'Allen',
        lastName: 'Ryu',
        email: 'allen@example.com',
      },
    };

    const summary = await fillAdpForm(profile, document, {
      focusSettleMs: 1,
      inputSettleMs: 1,
      blurSettleMs: 1,
    });

    expect(first.value).toBe('Allen');
    expect(last.value).toBe('Ryu');
    expect(email.value).toBe('allen@example.com');
    expect(summary).toEqual({ filled: 3, flagged: 0 });
  });

  it('flags an ADP field when its controlled model rejects the write', async () => {
    const input = document.createElement('input');
    input.id = 'guestFirstName';
    input.setAttribute('aria-label', 'First Name');
    input.setAttribute('aria-required', 'true');
    input.addEventListener('input', () => { input.value = ''; });
    document.body.append(input);
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, firstName: 'Allen' },
    };

    const summary = await fillAdpForm(profile, document, {
      focusSettleMs: 1,
      inputSettleMs: 1,
      blurSettleMs: 1,
    });

    expect(input.dataset.autofillFlag).toBe('needs-input');
    expect(summary).toEqual({ filled: 0, flagged: 1 });
  });

  it('commits the ADP address country through its React Select listbox', async () => {
    const input = mountMdfSelect('PersonalAddress_country', 'Country', [
      'Canada',
      'United States Minor Outlying Islands',
      'United States',
    ]);
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, country: 'United States' },
    };

    const summary = await fillAdpForm(profile, document, {
      focusSettleMs: 1,
      inputSettleMs: 1,
      blurSettleMs: 1,
      selectPollIntervalMs: 1,
      selectMaxAttempts: 3,
    });

    expect(input.closest('.MDFSelectBox__control')?.querySelector('.MDFSelectBox__single-value')?.textContent)
      .toBe('United States');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.parentElement?.parentElement?.querySelector<HTMLElement>('[aria-hidden="true"]')?.dataset.autofillFlag)
      .toBeUndefined();
    expect(summary).toEqual({ filled: 1, flagged: 0 });
  });

  it('does not duplicate address line 1 into optional ADP address line 3', async () => {
    const line3 = document.createElement('input');
    line3.id = 'PersonalAddress_addressLineThree';
    line3.setAttribute('aria-label', 'Address Line 3');
    document.body.append(line3);
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, address: '123 Example Street' },
    };

    const summary = await fillAdpForm(profile, document, {
      focusSettleMs: 1,
      inputSettleMs: 1,
      blurSettleMs: 1,
    });

    expect(line3.value).toBe('');
    expect(line3.dataset.autofillFlag).toBeUndefined();
    expect(summary).toEqual({ filled: 0, flagged: 0 });
  });
});
