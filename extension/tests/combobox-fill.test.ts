import { describe, it, expect, vi } from 'vitest';
import { fillComboboxFields } from '../src/fill-engine/combobox-fill';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';
import { FieldDescriptor } from '../src/fill-engine/types';

function makeField(element: HTMLElement, profileKey: FieldDescriptor['profileKey']): FieldDescriptor {
  return { element, label: 'test', kind: 'combobox', profileKey };
}

describe('fillComboboxFields', () => {
  it('accepts and closes an already-selected Oracle grid that auto-opens with the editor', async () => {
    document.body.innerHTML = `
      <input id="month" class="cx-select-input" role="combobox" aria-haspopup="grid"
        aria-controls="months" aria-expanded="true" value="August" />
      <div id="months" role="grid"><div role="gridcell" aria-selected="true">August</div></div>`;
    const trigger = document.getElementById('month') as HTMLInputElement;
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') trigger.setAttribute('aria-expanded', 'false');
    });
    const profile = { ...DEFAULT_PROFILE, jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, availableStartDate: '2026-08-01' } };
    const field: FieldDescriptor = {
      element: trigger,
      label: 'Start month',
      kind: 'combobox',
      profileKey: 'jobPreferences.availableStartDate',
      candidates: ['August', 'Aug', '8', '08'],
    };

    expect(await fillComboboxFields([field], profile)).toEqual({ filled: 1, flagged: 0 });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('accepts Oracle phone country +1 as committed United States without opening the shared-code grid', async () => {
    document.body.innerHTML = `
      <input id="country-codes-dropdownphoneNumber" class="cx-select-input" role="combobox"
        aria-haspopup="grid" aria-controls="phone-country-grid" aria-expanded="false" value="+1" />
      <div id="phone-country-grid" role="grid"></div>`;
    const trigger = document.getElementById('country-codes-dropdownphoneNumber') as HTMLInputElement;
    let clicks = 0;
    trigger.addEventListener('click', () => { clicks++; });
    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };

    expect(await fillComboboxFields([makeField(trigger, 'personal.phoneCountryCode')], profile, {
      pollIntervalMs: 1, maxAttempts: 2,
    })).toEqual({ filled: 1, flagged: 0 });
    expect(clicks).toBe(0);
  });

  it('selects Oracle Recruiting gridcell options', async () => {
    document.body.innerHTML = `
      <input id="gender" role="combobox" aria-controls="gender-grid" aria-expanded="false" />
      <div id="gender-grid" role="grid"></div>`;
    const trigger = document.getElementById('gender') as HTMLInputElement;
    const grid = document.getElementById('gender-grid')!;
    trigger.addEventListener('click', () => {
      trigger.setAttribute('aria-expanded', 'true');
      grid.innerHTML = '<div role="row"><div role="gridcell">Female</div></div><div role="row"><div role="gridcell">Male</div></div>';
      grid.querySelectorAll<HTMLElement>('[role="gridcell"]').forEach((option) => {
        option.addEventListener('click', () => {
          trigger.value = option.textContent ?? '';
          trigger.setAttribute('aria-expanded', 'false');
        });
      });
    });
    const profile = { ...DEFAULT_PROFILE, disclosures: { ...DEFAULT_PROFILE.disclosures, gender: 'Male' } };

    expect(await fillComboboxFields([makeField(trigger, 'disclosures.gender')], profile, {
      pollIntervalMs: 1, maxAttempts: 2,
    })).toEqual({ filled: 1, flagged: 0 });
    expect(trigger.value).toBe('Male');
  });

  it('opens a readonly React combobox on its focus-then-second-click path', async () => {
    document.body.innerHTML = `
      <input id="state" role="combobox" aria-controls="states" aria-expanded="false" readonly />
      <ul id="states" role="listbox"></ul>
    `;
    const trigger = document.getElementById('state') as HTMLInputElement;
    const list = document.getElementById('states')!;
    let clicks = 0;
    trigger.addEventListener('click', () => {
      clicks++;
      if (clicks === 2) {
        trigger.setAttribute('aria-expanded', 'true');
        list.innerHTML = '<button role="option">North Carolina</button>';
      }
    });
    list.addEventListener('click', () => {
      trigger.value = 'North Carolina';
      trigger.setAttribute('aria-expanded', 'false');
    });
    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'NC' } };

    expect(await fillComboboxFields([makeField(trigger, 'personal.state')], profile, {
      pollIntervalMs: 1, maxAttempts: 2,
    })).toEqual({ filled: 1, flagged: 0 });
    expect(clicks).toBe(2);
    expect(trigger.value).toBe('North Carolina');
  });

  it('does not reopen a React combobox whose input contains an exact committed answer', async () => {
    document.body.innerHTML = `
      <input id="gender" role="combobox" aria-controls="genders" aria-expanded="false" value="Male" />
      <div id="genders"></div>
    `;
    const trigger = document.getElementById('gender')!;
    const clicked = vi.fn();
    trigger.addEventListener('click', clicked);
    const profile = { ...DEFAULT_PROFILE, disclosures: { ...DEFAULT_PROFILE.disclosures, gender: 'Male' } };

    expect(await fillComboboxFields([makeField(trigger, 'disclosures.gender')], profile))
      .toEqual({ filled: 1, flagged: 0 });
    expect(clicked).not.toHaveBeenCalled();
  });

  it('selects an unsupported required preferred-location combobox when it has one option', async () => {
    document.body.innerHTML = `
      <div><input id="location" role="combobox" aria-controls="locations" aria-expanded="false"
        aria-required="true" readonly /><button id="location-arrow" role="presentation" type="button">Open</button></div>
      <ul id="locations" role="listbox"></ul>
    `;
    const trigger = document.getElementById('location') as HTMLInputElement;
    const arrow = document.getElementById('location-arrow')!;
    const list = document.getElementById('locations')!;
    let clicks = 0;
    arrow.addEventListener('click', () => {
      clicks++;
      trigger.setAttribute('aria-expanded', 'true');
      list.innerHTML = '<button role="option">Baton Rouge, Louisiana, United States</button>';
    });
    list.addEventListener('click', () => { trigger.value = 'Baton Rouge, Louisiana, United States'; });
    const field: FieldDescriptor = {
      element: trigger,
      label: 'Preferred location for Undergraduate Electrical Engineer',
      kind: 'combobox',
      profileKey: null,
    };

    expect(await fillComboboxFields([field], DEFAULT_PROFILE, { pollIntervalMs: 1, maxAttempts: 2 }))
      .toEqual({ filled: 1, flagged: 0 });
    expect(clicks).toBe(1);
    expect(trigger.value).toBe('Baton Rouge, Louisiana, United States');
  });
  it('ignores an unsupported optional combobox instead of flagging it', async () => {
    document.body.innerHTML = `<input id="skills" aria-haspopup="listbox" aria-label="Type to Add Skills" />`;
    const trigger = document.getElementById('skills')!;
    const summary = await fillComboboxFields([
      { element: trigger, label: 'Type to Add Skills', kind: 'combobox', profileKey: null },
    ], DEFAULT_PROFILE);
    expect(summary).toEqual({ filled: 0, flagged: 0 });
    expect(trigger.dataset.autofillFlag).toBeUndefined();
  });

  it('flags an unsupported required Workday questionnaire combobox', async () => {
    document.body.innerHTML = `<button id="question" aria-haspopup="listbox">Select One</button>`;
    const trigger = document.getElementById('question')!;
    const summary = await fillComboboxFields([
      { element: trigger, label: 'Are you currently employed by the State of North Carolina?*', kind: 'combobox', profileKey: null },
    ], DEFAULT_PROFILE);
    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect(trigger.dataset.autofillFlag).toBe('needs-input');
  });

  it('selects the sponsorship category for a combined Workday authorization dropdown', async () => {
    document.body.innerHTML = `
      <button id="primaryQuestionnaire--authorization" aria-haspopup="listbox" aria-controls="authorization-options">Select One</button>
      <div id="authorization-options"></div>
    `;
    const trigger = document.getElementById('primaryQuestionnaire--authorization') as HTMLButtonElement;
    const options = document.getElementById('authorization-options')!;
    trigger.addEventListener('click', () => {
      options.innerHTML = `
        <div role="option">I am authorized to work in the U.S. for any employer (Green Card/Citizen)</div>
        <div role="option">I am authorized to work in the U.S. for my present employer only (H1, L1, J1)</div>
        <div role="option">My status to work in the U.S. is unknown</div>
        <div role="option">I require sponsorship to work in the U.S. (F1, H1, L1, J1)</div>
      `;
    });
    options.addEventListener('click', (event) => {
      trigger.textContent = (event.target as HTMLElement).textContent;
      trigger.value = 'selected';
    });
    const profile = {
      ...DEFAULT_PROFILE,
      workAuthorization: {
        ...DEFAULT_PROFILE.workAuthorization,
        authorizedToWork: 'yes' as const,
        requiresSponsorship: 'yes' as const,
      },
    };

    expect(await fillComboboxFields([{
      element: trigger,
      label: 'Work Authorization*',
      kind: 'combobox',
      profileKey: 'workAuthorization.authorizedToWork',
    }], profile, { pollIntervalMs: 2, maxAttempts: 5 })).toEqual({ filled: 1, flagged: 0 });
    expect(trigger.textContent).toContain('I require sponsorship');
  });

  it('accepts an unsupported required Workday multiselect with an existing selected option', async () => {
    document.body.innerHTML = `
      <div data-automation-id="multiselectInputContainer">
        <input id="source" data-uxi-widget-type="selectinput" aria-required="true"
          data-autofill-flag="needs-input" style="outline: 2px solid orange" />
        <ul data-automation-id="selectedItemList">
          <li role="presentation"><div role="option">State of NC Career Website</div></li>
        </ul>
      </div>
    `;
    const trigger = document.getElementById('source')!;

    const summary = await fillComboboxFields([{
      element: trigger,
      label: 'How Did You Hear About Us?*',
      kind: 'combobox',
      profileKey: null,
    }], DEFAULT_PROFILE);

    expect(summary).toEqual({ filled: 0, flagged: 0 });
    expect(trigger.dataset.autofillFlag).toBeUndefined();
  });

  it('chooses the company website branch instead of the first Workday source option', async () => {
    document.body.innerHTML = `
      <div data-automation-id="promptLeafNode"><div data-automation-id="promptOption">United States of America (+1)</div></div>
      <div data-automation-id="multiselectInputContainer">
        <input id="source--source" data-uxi-widget-type="selectinput" aria-required="true" />
      </div>
    `;
    const trigger = document.getElementById('source--source') as HTMLInputElement;
    trigger.addEventListener('click', () => {
      const menu = document.createElement('div');
      menu.innerHTML = `
        <div data-automation-id="promptLeafNode" data-uxi-multiselectlistitem-hassidecharm="true">
          <div data-automation-id="promptOption">Career Fair/Conference/Event</div>
        </div>
        <div data-automation-id="promptLeafNode" data-uxi-multiselectlistitem-hassidecharm="true">
          <div data-automation-id="promptOption">Company Website</div>
        </div>
      `;
      menu.querySelectorAll<HTMLElement>('[data-automation-id="promptLeafNode"]')[1]?.addEventListener('click', () => {
        menu.innerHTML = `
          <div data-automation-id="promptLeafNode" data-uxi-multiselectlistitem-hassidecharm="false">
            <div data-automation-id="promptOption">Company Careers Site</div>
          </div>
          <div data-automation-id="promptLeafNode" data-uxi-multiselectlistitem-hassidecharm="false">
            <div data-automation-id="promptOption">Other Company Site</div>
          </div>
        `;
        menu.querySelectorAll<HTMLElement>('[data-automation-id="promptLeafNode"]').forEach((option) => {
          option.addEventListener('click', () => {
            const selected = document.createElement('div');
            selected.setAttribute('data-automation-id', 'selectedItem');
            selected.textContent = option.textContent;
            trigger.parentElement?.append(selected);
            menu.remove();
          });
        });
      });
      document.body.append(menu);
    });

    const summary = await fillComboboxFields([{
      element: trigger,
      label: 'How Did You Hear About Us?*',
      kind: 'combobox',
      profileKey: null,
    }], DEFAULT_PROFILE, { pollIntervalMs: 1, maxAttempts: 3 });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(document.querySelector('[data-automation-id="selectedItem"]')?.textContent).toContain('Company Careers Site');
  });

  it('does not choose an unrelated Workday source when no company website option exists', async () => {
    document.body.innerHTML = `
      <div data-automation-id="multiselectInputContainer">
        <input id="source--source" data-uxi-widget-type="selectinput" aria-required="true" />
      </div>
    `;
    const trigger = document.getElementById('source--source') as HTMLInputElement;
    trigger.addEventListener('click', () => {
      const menu = document.createElement('div');
      menu.innerHTML = `
        <div data-automation-id="promptLeafNode" data-uxi-multiselectlistitem-hassidecharm="false"><div data-automation-id="promptOption">Career Fair</div></div>
        <div data-automation-id="promptLeafNode" data-uxi-multiselectlistitem-hassidecharm="false"><div data-automation-id="promptOption">LinkedIn</div></div>
      `;
      document.body.append(menu);
    });

    const summary = await fillComboboxFields([{
      element: trigger,
      label: 'How Did You Hear About Us?*',
      kind: 'combobox',
      profileKey: null,
    }], DEFAULT_PROFILE, { pollIntervalMs: 1, maxAttempts: 3 });

    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect(document.querySelector('[data-automation-id="selectedItem"]')).toBeNull();
  });

  it('does not borrow a selected chip from a different Workday multiselect', async () => {
    document.body.innerHTML = `
      <div id="source-widget" data-automation-id="multiSelectContainer">
        <input id="source" data-uxi-widget-type="selectinput"
          data-uxi-multiselect-id="source-widget" aria-required="true" />
      </div>
      <div id="phone-widget" data-automation-id="multiSelectContainer">
        <input id="phone-code" data-uxi-widget-type="selectinput"
          data-uxi-multiselect-id="phone-widget" />
        <div data-automation-id="selectedItem">United States of America (+1)</div>
      </div>
    `;
    const trigger = document.getElementById('source')!;

    const summary = await fillComboboxFields([{
      element: trigger,
      label: 'How Did You Hear About Us?*',
      kind: 'combobox',
      profileKey: null,
    }], DEFAULT_PROFILE);

    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect(trigger.dataset.autofillFlag).toBe('needs-input');
  });

  it('maps a mobile phone profile to Workday Home Cellular', async () => {
    document.body.innerHTML = `
      <button id="phone-type" aria-haspopup="listbox">Select One</button>
      <div id="phone-options"></div>
    `;
    const trigger = document.getElementById('phone-type')!;
    trigger.addEventListener('click', () => {
      trigger.setAttribute('aria-controls', 'phone-options');
      document.getElementById('phone-options')!.innerHTML = `
        <div role="option">Home</div><div role="option">Home Cellular</div>
      `;
    });
    document.getElementById('phone-options')!.addEventListener('click', (event) => {
      trigger.textContent = (event.target as HTMLElement).textContent;
    });

    const summary = await fillComboboxFields([
      makeField(trigger, 'personal.phoneType'),
    ], DEFAULT_PROFILE, { pollIntervalMs: 1, maxAttempts: 2 });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(trigger.textContent).toBe('Home Cellular');
  });

  it('fills an iCIMS role combobox that omits aria-haspopup', async () => {
    document.body.innerHTML = `
      <a id="country-code" role="combobox" aria-controls="country-options"
        aria-label="Country Code — Make a Selection —" aria-required="true"></a>
      <div id="country-options" class="hidden"><ul role="listbox">
        <li role="option">(+1) Canada</li>
        <li role="option">(+1) United States</li>
      </ul></div>
    `;
    const trigger = document.getElementById('country-code')!;
    document.getElementById('country-options')!.addEventListener('click', (event) => {
      trigger.textContent = (event.target as HTMLElement).textContent;
    });
    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const summary = await fillComboboxFields([
      makeField(trigger, 'personal.phoneCountryCode'),
    ], profile, { pollIntervalMs: 1, maxAttempts: 2 });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(trigger.textContent).toBe('(+1) United States');
  });

  it('accepts a matching selected chip without reopening an empty search input', async () => {
    document.body.innerHTML = `
      <div><div data-automation-id="selectedItem">Duke University</div>
        <input id="school" data-uxi-widget-type="selectinput" />
      </div>
    `;
    const trigger = document.getElementById('school')!;
    const field: FieldDescriptor = {
      element: trigger, label: 'School', kind: 'combobox', profileKey: 'personal.city',
      candidates: ['Duke University'],
    };
    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, city: 'Duke University' } };
    expect(await fillComboboxFields([field], profile)).toEqual({ filled: 1, flagged: 0 });
  });

  it('finds an existing Workday selected chip through deeply nested widget wrappers', async () => {
    document.body.innerHTML = `
      <div data-field><div data-automation-id="selectedItem">United States of America (+1)</div>
        <div><div><div><div><div><div><input id="phone-code" data-uxi-widget-type="selectinput" /></div></div></div></div></div></div>
      </div>
      <input id="phone-number" />
    `;
    const trigger = document.getElementById('phone-code')!;
    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    expect(await fillComboboxFields([
      makeField(trigger, 'personal.phoneCountryCode'),
    ], profile)).toEqual({ filled: 1, flagged: 0 });
  });

  it('recognizes a committed selection from the single widget wrapper rendered text', async () => {
    document.body.innerHTML = `
      <div data-phone-code-field><span>United States of America (+1)</span>
        <div><div><input id="phone-code-text" data-uxi-widget-type="selectinput" /></div></div>
      </div><input id="next-phone-number" />
    `;
    const trigger = document.getElementById('phone-code-text')!;
    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    expect(await fillComboboxFields([
      makeField(trigger, 'personal.phoneCountryCode'),
    ], profile)).toEqual({ filled: 1, flagged: 0 });
  });

  it('accepts a selection that Workday commits asynchronously after opening the widget', async () => {
    document.body.innerHTML = `
      <div id="phone-code-wrapper"><input id="async-phone-code" data-uxi-widget-type="selectinput" /></div>
      <input id="async-phone-number" />
    `;
    const trigger = document.getElementById('async-phone-code')!;
    trigger.addEventListener('click', () => setTimeout(() => {
      document.getElementById('phone-code-wrapper')!.insertAdjacentHTML(
        'afterbegin', '<span>United States of America (+1)</span>'
      );
    }, 1));
    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    expect(await fillComboboxFields([
      makeField(trigger, 'personal.phoneCountryCode'),
    ], profile, { pollIntervalMs: 2, maxAttempts: 1 })).toEqual({ filled: 1, flagged: 0 });
  });

  it('removes a mismatched selected chip before searching', async () => {
    document.body.innerHTML = `
      <div><div data-automation-id="selectedItem">Agricultural Economics<button type="button">Remove</button></div>
        <input id="field" data-uxi-widget-type="selectinput" aria-haspopup="listbox" aria-controls="options" />
      </div><div id="options"></div>
    `;
    const trigger = document.getElementById('field') as HTMLInputElement;
    document.querySelector('[data-automation-id="selectedItem"] button')!.addEventListener('click', (event) => {
      (event.currentTarget as HTMLElement).closest('[data-automation-id="selectedItem"]')?.remove();
    });
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        document.getElementById('options')!.innerHTML = '<div role="option">Electrical Engineering</div>';
      }
    });
    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, city: 'Electrical Engineering' } };
    const field: FieldDescriptor = { element: trigger, label: 'Field of Study', kind: 'combobox', profileKey: 'personal.city' };
    expect(await fillComboboxFields([field], profile, { pollIntervalMs: 1, maxAttempts: 2 }))
      .toEqual({ filled: 1, flagged: 0 });
    expect(document.querySelector('[data-automation-id="selectedItem"]')).toBeNull();
  });


  it('fills a combobox whose trigger has no aria-controls until after it is clicked', async () => {
    // Reproduces real Workday behavior: aria-controls is absent on the trigger until the
    // widget actually opens and mounts its popup, which happens as a result of the click.
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox">Select One</button>
      <div id="state-listbox"></div>
    `;
    const trigger = document.getElementById('state-trigger')!;
    const listbox = document.getElementById('state-listbox')!;

    trigger.addEventListener('click', () => {
      trigger.setAttribute('aria-controls', 'state-listbox');
      trigger.setAttribute('aria-expanded', 'true');
      listbox.innerHTML = '<li role="option" data-value="NC">North Carolina</li>';
    });

    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'NC' } };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.state')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
  });

  it('re-resolves and clicks a Workday button remounted by its focus-only first click', async () => {
    document.body.innerHTML = `
      <button id="relocation-trigger" type="button" aria-haspopup="listbox">Select One</button>
      <div id="relocation-listbox"></div>
    `;
    const trigger = document.getElementById('relocation-trigger')!;
    const listbox = document.getElementById('relocation-listbox')!;
    let clicks = 0;
    const openOnSecondClick = (live: HTMLElement) => live.addEventListener('click', () => {
      clicks++;
      live.setAttribute('aria-controls', 'relocation-listbox');
      live.setAttribute('aria-expanded', 'true');
      listbox.innerHTML = '<li role="option">Yes</li><li role="option">No</li>';
    });
    trigger.addEventListener('click', () => {
      clicks++;
      // The old reference claims expansion while Workday replaces it with a new, visibly focused
      // but still-closed button. Retrying the old node cannot open the real popup.
      trigger.setAttribute('aria-expanded', 'true');
      const replacement = trigger.cloneNode(true) as HTMLElement;
      replacement.removeAttribute('aria-expanded');
      openOnSecondClick(replacement);
      trigger.replaceWith(replacement);
    });
    const profile = {
      ...DEFAULT_PROFILE,
      jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, willingToRelocate: 'yes' as const },
    };
    const field: FieldDescriptor = {
      element: trigger,
      label: 'If the position requires, are you able to relocate?',
      kind: 'combobox',
      profileKey: 'jobPreferences.willingToRelocate',
    };

    expect(await fillComboboxFields([field], profile, { pollIntervalMs: 1, maxAttempts: 2 }))
      .toEqual({ filled: 1, flagged: 0 });
    expect(clicks).toBe(2);
    expect(document.getElementById('relocation-trigger')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('does not reopen a Workday button whose visible answer already matches', async () => {
    document.body.innerHTML = `
      <button id="relocation-trigger" type="button" aria-haspopup="listbox" value="tenant-yes">Yes</button>
    `;
    const trigger = document.getElementById('relocation-trigger')!;
    const clicked = vi.fn();
    trigger.addEventListener('click', clicked);
    const profile = {
      ...DEFAULT_PROFILE,
      jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, willingToRelocate: 'yes' as const },
    };
    const field: FieldDescriptor = {
      element: trigger,
      label: 'If the position requires, are you able to relocate?',
      kind: 'combobox',
      profileKey: 'jobPreferences.willingToRelocate',
    };

    expect(await fillComboboxFields([field], profile)).toEqual({ filled: 1, flagged: 0 });
    expect(clicked).not.toHaveBeenCalled();
  });

  it('retries a Workday button selection that React rolls back after the first click', async () => {
    document.body.innerHTML = `
      <button id="primaryQuestionnaire--relocation-trigger" type="button" aria-haspopup="listbox">Select One</button>
      <div id="relocation-listbox"></div>
    `;
    const trigger = document.getElementById('primaryQuestionnaire--relocation-trigger') as HTMLButtonElement;
    const listbox = document.getElementById('relocation-listbox')!;
    let selections = 0;
    trigger.addEventListener('click', () => {
      trigger.setAttribute('aria-controls', 'relocation-listbox');
      trigger.setAttribute('aria-expanded', 'true');
      listbox.innerHTML = '<li role="option">Yes</li><li role="option">No</li>';
    });
    listbox.addEventListener('click', (event) => {
      const option = (event.target as Element).closest('[role="option"]');
      if (!option) return;
      selections++;
      trigger.textContent = option.textContent;
      trigger.value = 'tenant-yes';
      trigger.removeAttribute('aria-controls');
      trigger.removeAttribute('aria-expanded');
      listbox.innerHTML = '';
      if (selections === 1) setTimeout(() => {
        trigger.textContent = 'Select One';
        trigger.value = '';
      }, 1);
    });
    const profile = {
      ...DEFAULT_PROFILE,
      jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, willingToRelocate: 'yes' as const },
    };
    const field: FieldDescriptor = {
      element: trigger,
      label: 'If the position requires, are you able to relocate?',
      kind: 'combobox',
      profileKey: 'jobPreferences.willingToRelocate',
    };

    expect(await fillComboboxFields([field], profile, {
      pollIntervalMs: 2,
      maxAttempts: 2,
      selectionSettleMs: 5,
    })).toEqual({ filled: 1, flagged: 0 });
    expect(selections).toBe(2);
    expect(trigger.textContent).toBe('Yes');
    expect(trigger.value).toBe('tenant-yes');
  });

  it('fills a combobox by clicking the trigger, then the matching option', async () => {
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>
      <div id="state-listbox"></div>
    `;
    const trigger = document.getElementById('state-trigger')!;
    const listbox = document.getElementById('state-listbox')!;
    const clickedOptions: string[] = [];

    trigger.addEventListener('click', () => {
      listbox.innerHTML = `
        <li role="option" data-value="NC">North Carolina</li>
        <li role="option" data-value="CA">California</li>
      `;
      listbox.querySelectorAll('[role="option"]').forEach((opt) => {
        opt.addEventListener('click', () => clickedOptions.push(opt.getAttribute('data-value') ?? ''));
      });
    });

    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'NC' } };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.state')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(clickedOptions).toEqual(['NC']);
  });

  it('searches an ARIA Workday selectinput before matching its initially unfiltered options', async () => {
    document.body.innerHTML = `
      <input id="field" data-uxi-widget-type="selectinput" aria-haspopup="listbox" aria-controls="field-options" />
      <div id="field-options"><div role="option">Accounting</div></div>
    `;
    const trigger = document.getElementById('field') as HTMLInputElement;
    const options = document.getElementById('field-options')!;
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        options.innerHTML = '<div role="option">Electrical Engineering</div>';
      }
    });
    let selected = false;
    options.addEventListener('click', () => { selected = true; });
    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, city: 'Electrical Engineering' } };
    const field: FieldDescriptor = {
      element: trigger, label: 'Field of Study', kind: 'combobox', profileKey: 'personal.city',
    };
    expect(await fillComboboxFields([field], profile, { pollIntervalMs: 1, maxAttempts: 2 }))
      .toEqual({ filled: 1, flagged: 0 });
    expect(selected).toBe(true);
  });

  it('waits for the popup to render asynchronously before matching', async () => {
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>
      <div id="state-listbox"></div>
    `;
    const trigger = document.getElementById('state-trigger')!;
    const listbox = document.getElementById('state-listbox')!;

    trigger.addEventListener('click', () => {
      setTimeout(() => {
        listbox.innerHTML = '<li role="option" data-value="NC">North Carolina</li>';
      }, 15);
    });

    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'NC' } };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.state')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 10,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
  });

  it('flags the field and closes the popup when no option matches', async () => {
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>
      <div id="state-listbox"></div>
    `;
    const trigger = document.getElementById('state-trigger')!;
    const listbox = document.getElementById('state-listbox')!;
    const escapePressed = vi.fn();
    trigger.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') escapePressed();
    });
    trigger.addEventListener('click', () => {
      listbox.innerHTML = '<li role="option" data-value="TX">Texas</li>';
    });

    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'NC' } };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.state')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect(escapePressed).toHaveBeenCalledOnce();
    expect(trigger.dataset.autofillFlag).toBe('needs-input');
  });

  it('flags the field if the popup never renders within the timeout', async () => {
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>
      <div id="state-listbox"></div>
    `;
    const trigger = document.getElementById('state-trigger')!;

    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'NC' } };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.state')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 3,
    });

    expect(summary).toEqual({ filled: 0, flagged: 1 });
  });

  it('flags without clicking when there is no profile value', async () => {
    document.body.innerHTML = `<button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>`;
    const trigger = document.getElementById('state-trigger')!;
    const clickHandler = vi.fn();
    trigger.addEventListener('click', clickHandler);

    const summary = await fillComboboxFields([makeField(trigger, 'personal.state')], DEFAULT_PROFILE);

    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect(clickHandler).not.toHaveBeenCalled();
  });

  it('does not re-click an already-expanded trigger', async () => {
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox" aria-expanded="true" aria-controls="state-listbox">--</button>
      <div id="state-listbox"><li role="option" data-value="NC">North Carolina</li></div>
    `;
    const trigger = document.getElementById('state-trigger')!;
    const clickHandler = vi.fn();
    trigger.addEventListener('click', clickHandler);

    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'NC' } };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.state')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 3,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(clickHandler).not.toHaveBeenCalled();
  });

  it('does not submit a form when clicking a bare <button> trigger inside it', async () => {
    document.body.innerHTML = `
      <form id="app-form">
        <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>
        <div id="state-listbox"></div>
      </form>
    `;
    const form = document.getElementById('app-form') as HTMLFormElement;
    const trigger = document.getElementById('state-trigger')!;
    const listbox = document.getElementById('state-listbox')!;
    const submitHandler = vi.fn((event: Event) => event.preventDefault());
    form.addEventListener('submit', submitHandler);
    trigger.addEventListener('click', () => {
      listbox.innerHTML = '<li role="option" data-value="NC">North Carolina</li>';
    });

    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'NC' } };
    await fillComboboxFields([makeField(trigger, 'personal.state')], profile, { pollIntervalMs: 5, maxAttempts: 5 });

    expect(submitHandler).not.toHaveBeenCalled();
  });

  it('sums the results across multiple fields', async () => {
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>
      <div id="state-listbox"></div>
      <button id="phone-trigger" aria-haspopup="listbox" aria-controls="phone-listbox">--</button>
      <div id="phone-listbox"></div>
    `;
    const stateTrigger = document.getElementById('state-trigger')!;
    const stateListbox = document.getElementById('state-listbox')!;
    const phoneTrigger = document.getElementById('phone-trigger')!;
    const phoneListbox = document.getElementById('phone-listbox')!;

    stateTrigger.addEventListener('click', () => {
      stateListbox.innerHTML = '<li role="option" data-value="NC">North Carolina</li>';
    });
    phoneTrigger.addEventListener('click', () => {
      phoneListbox.innerHTML = '<li role="option" data-value="m">Mobile</li>';
    });

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, state: 'NC', phoneType: 'mobile' as const },
    };
    const summary = await fillComboboxFields(
      [makeField(stateTrigger, 'personal.state'), makeField(phoneTrigger, 'personal.phoneType')],
      profile,
      { pollIntervalMs: 5, maxAttempts: 5 }
    );

    expect(summary).toEqual({ filled: 2, flagged: 0 });
  });

  it('processes fields sequentially, not in parallel', async () => {
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>
      <div id="state-listbox"></div>
      <button id="phone-trigger" aria-haspopup="listbox" aria-controls="phone-listbox">--</button>
      <div id="phone-listbox"></div>
    `;
    const stateTrigger = document.getElementById('state-trigger')!;
    const stateListbox = document.getElementById('state-listbox')!;
    const phoneTrigger = document.getElementById('phone-trigger')!;
    const phoneListbox = document.getElementById('phone-listbox')!;
    const events: string[] = [];

    stateTrigger.addEventListener('click', () => {
      events.push('state-click');
      setTimeout(() => {
        stateListbox.innerHTML = '<li role="option" data-value="NC">North Carolina</li>';
        stateListbox.querySelector('[role="option"]')!.addEventListener('click', () => events.push('state-option-click'));
      }, 20);
    });
    phoneTrigger.addEventListener('click', () => {
      events.push('phone-click');
      phoneListbox.innerHTML = '<li role="option" data-value="m">Mobile</li>';
      phoneListbox.querySelector('[role="option"]')!.addEventListener('click', () => events.push('phone-option-click'));
    });

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, state: 'NC', phoneType: 'mobile' as const },
    };
    await fillComboboxFields(
      [makeField(stateTrigger, 'personal.state'), makeField(phoneTrigger, 'personal.phoneType')],
      profile,
      { pollIntervalMs: 5, maxAttempts: 10 }
    );

    expect(events.indexOf('phone-click')).toBeGreaterThan(events.indexOf('state-option-click'));
  });

  it('falls back to typing the value and pressing Enter when the popup is empty after clicking', async () => {
    document.body.innerHTML = `
      <input id="country-trigger" aria-haspopup="listbox" aria-controls="country-listbox" placeholder="Search" />
      <div id="country-listbox"></div>
    `;
    const trigger = document.getElementById('country-trigger') as HTMLInputElement;
    const listbox = document.getElementById('country-listbox')!;
    let typedValue = '';

    trigger.addEventListener('click', () => {
      listbox.innerHTML = '';
    });
    trigger.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        typedValue = trigger.value;
        listbox.innerHTML = '<li role="option" data-value="US">United States</li>';
      }
    });

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.phoneCountryCode')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(typedValue).toBe('United States');
  });

  it('clears the typed value when the type-then-Enter fallback also yields no options', async () => {
    document.body.innerHTML = `
      <input id="country-trigger" aria-haspopup="listbox" aria-controls="country-listbox" placeholder="Search" />
      <div id="country-listbox"></div>
    `;
    const trigger = document.getElementById('country-trigger') as HTMLInputElement;
    // Both the initial click and the fallback's Enter leave the listbox empty, so the fallback
    // never resolves any options.

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.phoneCountryCode')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 3,
    });

    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect(trigger.value).toBe('');
    expect(trigger.dataset.autofillFlag).toBe('needs-input');
  });

  it('does not attempt to type into a non-typeable (button) trigger when the popup is empty', async () => {
    document.body.innerHTML = `
      <button id="state-trigger" aria-haspopup="listbox" aria-controls="state-listbox">--</button>
      <div id="state-listbox"></div>
    `;
    const trigger = document.getElementById('state-trigger')!;
    // Note: closePopup() already dispatches an Escape keydown on the flag path (pre-existing,
    // unrelated behavior), so a raw "keydown never fired" assertion would always fail regardless
    // of this task's fallback. Filter for Enter specifically to isolate what this test is
    // actually regression-testing: that the type-then-Enter fallback never engages for a
    // non-typeable (button) trigger.
    const enterHandler = vi.fn();
    trigger.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') enterHandler();
    });

    const profile = { ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, state: 'NC' } };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.state')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 3,
    });

    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect(enterHandler).not.toHaveBeenCalled();
  });

  it('does not engage the type-then-Enter fallback when the first click-and-wait attempt already finds options', async () => {
    document.body.innerHTML = `
      <input id="country-trigger" aria-haspopup="listbox" aria-controls="country-listbox" placeholder="Search" />
      <div id="country-listbox"></div>
    `;
    const trigger = document.getElementById('country-trigger') as HTMLInputElement;
    const listbox = document.getElementById('country-listbox')!;

    trigger.addEventListener('click', () => {
      listbox.innerHTML = '<li role="option" data-value="US">United States</li>';
    });
    // See the "does not attempt to type into a non-typeable (button) trigger" test above for why
    // this filters for Enter specifically: closePopup() unconditionally dispatches Escape on
    // other paths, so a raw "keydown never fired" assertion would be unrelated noise here. This
    // isolates what's actually being regression-tested: that the fallback never types into a
    // trigger whose first click-and-wait attempt already resolved options.
    const enterHandler = vi.fn();
    trigger.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') enterHandler();
    });

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.phoneCountryCode')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(enterHandler).not.toHaveBeenCalled();
  });

  it('dispatches mousedown on the matched option, for widgets that select on mousedown rather than click', async () => {
    // Reproduces real Workday behavior on the Phone Country Code field: the option-selection
    // handler is bound to mousedown (a common pattern that lets the widget commit the selection
    // before a blur/click-outside handler can dismiss the popup first). A synthetic .click() call
    // alone never fires mousedown, so the option looked "clicked" to our code (no flag, filled++)
    // while Workday's real widget never registered a selection at all.
    document.body.innerHTML = `
      <input id="country-trigger" aria-haspopup="listbox" aria-controls="country-listbox" placeholder="Search" />
      <div id="country-listbox"></div>
    `;
    const trigger = document.getElementById('country-trigger') as HTMLInputElement;
    const listbox = document.getElementById('country-listbox')!;
    let selectedViaMousedown = false;

    trigger.addEventListener('click', () => {
      listbox.innerHTML = '<li role="option" data-value="US">United States of America (+1)</li>';
      listbox.querySelector('[role="option"]')!.addEventListener('mousedown', () => {
        selectedViaMousedown = true;
      });
    });

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.phoneCountryCode')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(selectedViaMousedown).toBe(true);
  });

  it('fills a moniker-search-box field (data-uxi-widget-type=selectinput, no aria-haspopup) via a globally-queried portal popup', async () => {
    // Reproduces the real Workday Phone Country Code widget: the trigger has no
    // aria-haspopup/role/aria-controls at all, and the results popup renders as a
    // portal elsewhere in the DOM with no containment relationship to the trigger
    // (confirmed via live ancestor-chain tracing — see docs/QA-FINDINGS.md Bug 7).
    document.body.innerHTML = `
      <input id="country-trigger" data-uxi-widget-type="selectinput" placeholder="Search" />
      <div id="unrelated-portal-root"></div>
    `;
    const trigger = document.getElementById('country-trigger') as HTMLInputElement;
    const portalRoot = document.getElementById('unrelated-portal-root')!;

    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        portalRoot.innerHTML = `
          <div data-automation-id="promptOption" data-automation-label="United States of America (+1)">United States of America (+1)</div>
        `;
      }
    });

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.phoneCountryCode')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
  });

  it('focuses a moniker search box, presses Enter, and matches its automation label', async () => {
    document.body.innerHTML = `
      <input id="country-trigger" data-uxi-widget-type="selectinput" placeholder="Search" />
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('country-trigger') as HTMLInputElement;
    const portalRoot = document.getElementById('portal-root')!;
    const keyEvents: string[] = [];

    ['keydown', 'keypress', 'keyup'].forEach((eventName) => trigger.addEventListener(eventName, (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        keyEvents.push(eventName);
        if (eventName === 'keyup') {
          setTimeout(() => {
            // Workday exposes the reliable option name in data-automation-label; nested visual
            // content is not guaranteed to contribute usable textContent.
            portalRoot.innerHTML = `
              <div data-automation-id="promptOption"
                   data-automation-label="United States of America (+1)"><span></span></div>
            `;
          }, 5);
        }
      }
    }));

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.phoneCountryCode')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(keyEvents).toEqual(['keydown', 'keypress', 'keyup']);
    expect(document.activeElement).not.toBe(trigger);
  });

  it('waits for a Workday moniker query to reach search state before pressing Enter', async () => {
    document.body.innerHTML = `
      <input id="school-trigger" data-uxi-widget-type="selectinput" placeholder="Search" />
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('school-trigger') as HTMLInputElement;
    const portalRoot = document.getElementById('portal-root')!;
    let queryReady = false;
    trigger.addEventListener('input', () => {
      queryReady = false;
      setTimeout(() => { queryReady = true; }, 5);
    });
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      portalRoot.innerHTML = queryReady
        ? '<div data-automation-id="promptOption" data-automation-label="Duke University">Duke University</div>'
        : '<div data-automation-id="promptOption" data-automation-label="No Items.">No Items.</div>';
    });
    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, city: 'Duke University' },
    };
    const field: FieldDescriptor = {
      element: trigger,
      label: 'School or University',
      kind: 'combobox',
      profileKey: 'personal.city',
      candidates: ['Duke University'],
    };

    expect(await fillComboboxFields([field], profile, {
      pollIntervalMs: 2,
      maxAttempts: 3,
      queryCommitDelayMs: 10,
    })).toEqual({ filled: 1, flagged: 0 });
  });

  it('ignores transient No Items and waits for an exact option in streamed Workday results', async () => {
    document.body.innerHTML = `
      <input id="school-trigger" data-uxi-widget-type="selectinput" placeholder="Search" />
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('school-trigger') as HTMLInputElement;
    const portalRoot = document.getElementById('portal-root')!;
    const clicked: string[] = [];
    portalRoot.addEventListener('click', (event) => {
      const option = (event.target as Element).closest<HTMLElement>('[data-automation-id="promptOption"]');
      if (option) clicked.push(option.textContent ?? '');
    });
    trigger.addEventListener('input', () => {
      portalRoot.innerHTML = '<div data-automation-id="promptOption">No Items.</div>';
    });
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      setTimeout(() => {
        portalRoot.innerHTML = `
          <div data-automation-id="promptOption">BA - Duke University</div>
          <div data-automation-id="promptOption">Big Data and Hadoop - Duke University</div>
        `;
      }, 2);
      setTimeout(() => {
        portalRoot.insertAdjacentHTML(
          'beforeend',
          '<div data-automation-id="promptOption" data-automation-label="Duke University">Duke University</div>'
        );
      }, 8);
    });
    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, city: 'Duke University' },
    };
    const field: FieldDescriptor = {
      element: trigger,
      label: 'School or University',
      kind: 'combobox',
      profileKey: 'personal.city',
      candidates: ['Duke University'],
    };

    expect(await fillComboboxFields([field], profile, {
      pollIntervalMs: 2,
      maxAttempts: 10,
      queryCommitDelayMs: 0,
    })).toEqual({ filled: 1, flagged: 0 });
    expect(clicked).toEqual(['Duke University']);
  });

  it('clicks the Workday prompt leaf and verifies the selected school chip', async () => {
    document.body.innerHTML = `
      <div id="school-widget">
        <input id="school-trigger" data-uxi-widget-type="selectinput" data-job-autofill-repeatable="true" placeholder="Search" />
      </div>
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('school-trigger') as HTMLInputElement;
    const widget = document.getElementById('school-widget')!;
    const portalRoot = document.getElementById('portal-root')!;
    let roleOptionClicked = false;
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      portalRoot.innerHTML = `
        <div role="option" id="duke-row">
          <div data-automation-id="promptLeafNode">
            <div data-automation-id="promptOption" data-automation-label="Duke University">Duke University</div>
          </div>
        </div>
      `;
      const row = document.getElementById('duke-row')!;
      const leaf = row.querySelector<HTMLElement>('[data-automation-id="promptLeafNode"]')!;
      row.addEventListener('click', (clickEvent) => {
        if (clickEvent.target === row) roleOptionClicked = true;
      });
      leaf.addEventListener('click', () => {
        widget.insertAdjacentHTML(
          'afterbegin',
          '<div data-automation-id="selectedItem">Duke University</div>'
        );
        portalRoot.innerHTML = '';
      });
    });
    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, city: 'Duke University' },
    };
    const field: FieldDescriptor = {
      element: trigger,
      label: 'School or University',
      kind: 'combobox',
      profileKey: 'personal.city',
      candidates: ['Duke University'],
    };

    expect(await fillComboboxFields([field], profile, {
      pollIntervalMs: 2,
      maxAttempts: 5,
      queryCommitDelayMs: 0,
    })).toEqual({ filled: 1, flagged: 0 });
    expect(roleOptionClicked).toBe(false);
    expect(widget.querySelector('[data-automation-id="selectedItem"]')?.textContent).toBe('Duke University');
  });

  it('adds each saved Workday skill as its own selected item and repairs a legacy combined item', async () => {
    document.body.innerHTML = `
      <div id="skills-widget">
        <div data-automation-id="selectedItem" id="legacy-skills">C++, C, Rust<div data-automation-id="DELETE_charm"></div></div>
        <input id="skills--skills" data-uxi-widget-type="selectinput" placeholder="Search" />
      </div>
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('skills--skills') as HTMLInputElement;
    const widget = document.getElementById('skills-widget')!;
    const portalRoot = document.getElementById('portal-root')!;
    document.querySelector('#legacy-skills [data-automation-id="DELETE_charm"]')!.addEventListener('click', () => {
      document.getElementById('legacy-skills')?.remove();
    });
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      const skill = trigger.value;
      portalRoot.innerHTML = `
        <div role="option"><div data-automation-id="promptLeafNode">
          <div data-automation-id="promptOption" data-automation-label="${skill}">${skill}</div>
        </div></div>
      `;
      portalRoot.querySelector<HTMLElement>('[data-automation-id="promptLeafNode"]')!.addEventListener('click', () => {
        const selected = document.createElement('div');
        selected.dataset.automationId = 'selectedItem';
        selected.textContent = skill;
        widget.prepend(selected);
        trigger.value = '';
        portalRoot.innerHTML = '';
      });
    });
    const profile = {
      ...DEFAULT_PROFILE,
      professional: { ...DEFAULT_PROFILE.professional, skills: 'C++, C, Rust' },
    };
    const field: FieldDescriptor = {
      element: trigger,
      label: 'Type to Add Skills',
      kind: 'combobox',
      profileKey: 'professional.skills',
    };

    expect(await fillComboboxFields([field], profile, {
      pollIntervalMs: 2,
      maxAttempts: 5,
      queryCommitDelayMs: 0,
    })).toEqual({ filled: 3, flagged: 0 });
    expect(Array.from(widget.querySelectorAll<HTMLElement>('[data-automation-id="selectedItem"]'))
      .map((item) => item.textContent)).toEqual(['Rust', 'C', 'C++']);
    expect(document.getElementById('legacy-skills')).toBeNull();
  });

  it('keeps a parenthetical skill as one entry and searches its bare name', async () => {
    document.body.innerHTML = `
      <div id="skills-widget">
        <input id="skills--skills" data-uxi-widget-type="selectinput" placeholder="Search" />
      </div>
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('skills--skills') as HTMLInputElement;
    const widget = document.getElementById('skills-widget')!;
    const portalRoot = document.getElementById('portal-root')!;
    const searchedQueries: string[] = [];
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      const query = trigger.value;
      searchedQueries.push(query);
      // The catalogue only has the bare tag, not the parenthetical detail.
      const label = query === 'Firebase' ? 'Firebase' : query === 'MIPS' ? 'MIPS' : null;
      portalRoot.innerHTML = label ? `
        <div role="option"><div data-automation-id="promptLeafNode">
          <div data-automation-id="promptOption" data-automation-label="${label}">${label}</div>
        </div></div>
      ` : '';
      portalRoot.querySelector<HTMLElement>('[data-automation-id="promptLeafNode"]')?.addEventListener('click', () => {
        const selected = document.createElement('div');
        selected.dataset.automationId = 'selectedItem';
        selected.textContent = label!;
        widget.prepend(selected);
        trigger.value = '';
        portalRoot.innerHTML = '';
      });
    });
    const profile = {
      ...DEFAULT_PROFILE,
      professional: {
        ...DEFAULT_PROFILE.professional,
        skills: 'Firebase (Firestore, Cloud Functions, Auth), MIPS (Assembly)',
      },
    };
    const field: FieldDescriptor = {
      element: trigger,
      label: 'Type to Add Skills',
      kind: 'combobox',
      profileKey: 'professional.skills',
    };

    const summary = await fillComboboxFields([field], profile, {
      pollIntervalMs: 2,
      maxAttempts: 5,
      queryCommitDelayMs: 0,
    });

    expect(summary).toEqual({ filled: 2, flagged: 0 });
    // Never searched for the mangled fragments a naive comma-split would have produced.
    expect(searchedQueries).not.toContain('Firestore');
    expect(searchedQueries).not.toContain(' Cloud Functions');
    expect(searchedQueries).toContain('Firebase');
    expect(searchedQueries).toContain('MIPS');
    expect(Array.from(widget.querySelectorAll<HTMLElement>('[data-automation-id="selectedItem"]'))
      .map((item) => item.textContent).sort()).toEqual(['Firebase', 'MIPS']);
  });

  it('fuzzy-matches a multi-word skill against the closest catalogue option among the top results', async () => {
    document.body.innerHTML = `
      <div id="skills-widget">
        <input id="skills--skills" data-uxi-widget-type="selectinput" placeholder="Search" />
      </div>
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('skills--skills') as HTMLInputElement;
    const widget = document.getElementById('skills-widget')!;
    const portalRoot = document.getElementById('portal-root')!;
    // No exact match for "PCB Design" itself, but "PCB Layout Design" is a real catalogue entry
    // whose words are a superset of it — confirmed real Workday behavior (Hitachi's tenant).
    const options = ['Power Distribution', 'PCB Layout Design', 'Something Unrelated'];
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      portalRoot.innerHTML = options.map((label) => `
        <div role="option"><div data-automation-id="promptLeafNode">
          <div data-automation-id="promptOption" data-automation-label="${label}">${label}</div>
        </div></div>
      `).join('');
      portalRoot.querySelectorAll<HTMLElement>('[data-automation-id="promptLeafNode"]').forEach((leaf, i) => {
        leaf.addEventListener('click', () => {
          const selected = document.createElement('div');
          selected.dataset.automationId = 'selectedItem';
          selected.textContent = options[i];
          widget.prepend(selected);
          trigger.value = '';
          portalRoot.innerHTML = '';
        });
      });
    });
    const profile = { ...DEFAULT_PROFILE, professional: { ...DEFAULT_PROFILE.professional, skills: 'PCB Design' } };
    const field: FieldDescriptor = {
      element: trigger, label: 'Type to Add Skills', kind: 'combobox', profileKey: 'professional.skills',
    };

    expect(await fillComboboxFields([field], profile, {
      pollIntervalMs: 2, maxAttempts: 5, queryCommitDelayMs: 0,
    })).toEqual({ filled: 1, flagged: 0 });
    expect(widget.querySelector('[data-automation-id="selectedItem"]')?.textContent).toBe('PCB Layout Design');
  });

  it('fuzzy-matches "MS Office" against "Microsoft Office" via a confirmed abbreviation alias', async () => {
    document.body.innerHTML = `
      <div id="skills-widget">
        <input id="skills--skills" data-uxi-widget-type="selectinput" placeholder="Search" />
      </div>
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('skills--skills') as HTMLInputElement;
    const widget = document.getElementById('skills-widget')!;
    const portalRoot = document.getElementById('portal-root')!;
    const options = ['Microsoft Office', 'WPS Office'];
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      portalRoot.innerHTML = options.map((label) => `
        <div role="option"><div data-automation-id="promptLeafNode">
          <div data-automation-id="promptOption" data-automation-label="${label}">${label}</div>
        </div></div>
      `).join('');
      portalRoot.querySelectorAll<HTMLElement>('[data-automation-id="promptLeafNode"]').forEach((leaf, i) => {
        leaf.addEventListener('click', () => {
          const selected = document.createElement('div');
          selected.dataset.automationId = 'selectedItem';
          selected.textContent = options[i];
          widget.prepend(selected);
          trigger.value = '';
          portalRoot.innerHTML = '';
        });
      });
    });
    const profile = { ...DEFAULT_PROFILE, professional: { ...DEFAULT_PROFILE.professional, skills: 'MS Office' } };
    const field: FieldDescriptor = {
      element: trigger, label: 'Type to Add Skills', kind: 'combobox', profileKey: 'professional.skills',
    };

    expect(await fillComboboxFields([field], profile, {
      pollIntervalMs: 2, maxAttempts: 5, queryCommitDelayMs: 0,
    })).toEqual({ filled: 1, flagged: 0 });
    expect(widget.querySelector('[data-automation-id="selectedItem"]')?.textContent).toBe('Microsoft Office');
  });

  it('prefers the plural of a generic catalogue entry over a more specific singular one', async () => {
    // Reproduces a live mismatch on Micron's tenant: "Signal Generator" never matched "Signal
    // Generators" (the correct, generic entry) over the plural "s" alone, and picked the more
    // specific "Vector Signal Generator" instead purely because it was the only option with the
    // literal singular word.
    document.body.innerHTML = `
      <div id="skills-widget">
        <input id="skills--skills" data-uxi-widget-type="selectinput" placeholder="Search" />
      </div>
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('skills--skills') as HTMLInputElement;
    const widget = document.getElementById('skills-widget')!;
    const portalRoot = document.getElementById('portal-root')!;
    const options = ['Vector Signal Generator', 'Signal Generators', 'RF Signal Generators'];
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      portalRoot.innerHTML = options.map((label) => `
        <div role="option"><div data-automation-id="promptLeafNode">
          <div data-automation-id="promptOption" data-automation-label="${label}">${label}</div>
        </div></div>
      `).join('');
      portalRoot.querySelectorAll<HTMLElement>('[data-automation-id="promptLeafNode"]').forEach((leaf, i) => {
        leaf.addEventListener('click', () => {
          const selected = document.createElement('div');
          selected.dataset.automationId = 'selectedItem';
          selected.textContent = options[i];
          widget.prepend(selected);
          trigger.value = '';
          portalRoot.innerHTML = '';
        });
      });
    });
    const profile = { ...DEFAULT_PROFILE, professional: { ...DEFAULT_PROFILE.professional, skills: 'Signal Generator' } };
    const field: FieldDescriptor = {
      element: trigger, label: 'Type to Add Skills', kind: 'combobox', profileKey: 'professional.skills',
    };

    expect(await fillComboboxFields([field], profile, {
      pollIntervalMs: 2, maxAttempts: 5, queryCommitDelayMs: 0,
    })).toEqual({ filled: 1, flagged: 0 });
    expect(widget.querySelector('[data-automation-id="selectedItem"]')?.textContent).toBe('Signal Generators');
  });

  it('never selects a tenant-branded catalogue entry, even when it is the only exact match', async () => {
    // Confirmed on Micron's tenant: nearly every search surfaced a "<Skill> - Micron" entry -
    // that tenant's own internal catalogue extension, not a generic skill. This test's tenant
    // stand-in is "localhost", the hostname location.hostname actually resolves to in this test
    // environment, matching what the real matching code reads live.
    document.body.innerHTML = `
      <div id="skills-widget">
        <input id="skills--skills" data-uxi-widget-type="selectinput" placeholder="Search" />
      </div>
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('skills--skills') as HTMLInputElement;
    const widget = document.getElementById('skills-widget')!;
    const portalRoot = document.getElementById('portal-root')!;
    const options = ['VLSI Design - localhost', 'VLSI Design'];
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      portalRoot.innerHTML = options.map((label) => `
        <div role="option"><div data-automation-id="promptLeafNode">
          <div data-automation-id="promptOption" data-automation-label="${label}">${label}</div>
        </div></div>
      `).join('');
      portalRoot.querySelectorAll<HTMLElement>('[data-automation-id="promptLeafNode"]').forEach((leaf, i) => {
        leaf.addEventListener('click', () => {
          const selected = document.createElement('div');
          selected.dataset.automationId = 'selectedItem';
          selected.textContent = options[i];
          widget.prepend(selected);
          trigger.value = '';
          portalRoot.innerHTML = '';
        });
      });
    });
    const profile = { ...DEFAULT_PROFILE, professional: { ...DEFAULT_PROFILE.professional, skills: 'VLSI' } };
    const field: FieldDescriptor = {
      element: trigger, label: 'Type to Add Skills', kind: 'combobox', profileKey: 'professional.skills',
    };

    expect(await fillComboboxFields([field], profile, {
      pollIntervalMs: 2, maxAttempts: 5, queryCommitDelayMs: 0,
    })).toEqual({ filled: 1, flagged: 0 });
    expect(widget.querySelector('[data-automation-id="selectedItem"]')?.textContent).toBe('VLSI Design');
  });

  it('flags rather than selects when a tenant-branded entry is the only option at all', async () => {
    document.body.innerHTML = `
      <div id="skills-widget">
        <input id="skills--skills" data-uxi-widget-type="selectinput" placeholder="Search" />
      </div>
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('skills--skills') as HTMLInputElement;
    const widget = document.getElementById('skills-widget')!;
    const portalRoot = document.getElementById('portal-root')!;
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      portalRoot.innerHTML = `
        <div role="option"><div data-automation-id="promptLeafNode">
          <div data-automation-id="promptOption" data-automation-label="VLSI Design - localhost">VLSI Design - localhost</div>
        </div></div>
      `;
    });
    const profile = { ...DEFAULT_PROFILE, professional: { ...DEFAULT_PROFILE.professional, skills: 'VLSI' } };
    const field: FieldDescriptor = {
      element: trigger, label: 'Type to Add Skills', kind: 'combobox', profileKey: 'professional.skills',
    };

    expect(await fillComboboxFields([field], profile, {
      pollIntervalMs: 2, maxAttempts: 5, queryCommitDelayMs: 0,
    })).toEqual({ filled: 0, flagged: 1 });
    expect(widget.querySelector('[data-automation-id="selectedItem"]')).toBeNull();
  });

  it('ignores a stale tenant-branded cached label and searches with the bare skill name instead', async () => {
    // Reproduces a live regression: a cache entry written before the tenant-branded exclusion
    // existed ("vlsi" -> "VLSI Design - Micron") made every later run visibly search for that
    // branded label itself, instead of the bare skill name.
    document.body.innerHTML = `
      <div id="skills-widget">
        <input id="skills--skills" data-uxi-widget-type="selectinput" placeholder="Search" />
      </div>
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('skills--skills') as HTMLInputElement;
    const widget = document.getElementById('skills-widget')!;
    const portalRoot = document.getElementById('portal-root')!;
    const searchedQueries: string[] = [];
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      searchedQueries.push(trigger.value);
      portalRoot.innerHTML = `
        <div role="option"><div data-automation-id="promptLeafNode">
          <div data-automation-id="promptOption" data-automation-label="VLSI Design">VLSI Design</div>
        </div></div>
      `;
      portalRoot.querySelector<HTMLElement>('[data-automation-id="promptLeafNode"]')!.addEventListener('click', () => {
        const selected = document.createElement('div');
        selected.dataset.automationId = 'selectedItem';
        selected.textContent = 'VLSI Design';
        widget.prepend(selected);
        trigger.value = '';
        portalRoot.innerHTML = '';
      });
    });
    const profile = { ...DEFAULT_PROFILE, professional: { ...DEFAULT_PROFILE.professional, skills: 'VLSI' } };
    const field: FieldDescriptor = {
      element: trigger, label: 'Type to Add Skills', kind: 'combobox', profileKey: 'professional.skills',
    };
    const skillCatalogCache: Record<string, string> = { vlsi: 'VLSI Design - localhost' };

    const summary = await fillComboboxFields([field], profile, {
      pollIntervalMs: 2, maxAttempts: 5, queryCommitDelayMs: 0, skillCatalogCache,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(searchedQueries).toEqual(['VLSI']);
    // The stale branded entry is overwritten with the real, safe label once a fresh match lands.
    expect(skillCatalogCache.vlsi).toBe('VLSI Design');
  });

  it('searches "C++" on its own instead of reusing "C"\'s cached label', async () => {
    // Reproduces a live regression: the cache key was derived with the generic normalize(), which
    // strips "+" as punctuation — normalize("C++") === normalize("C") === "c", so once "C" was
    // cached, "C++" silently looked up and searched with C's cached label instead of its own,
    // never actually searching for "C++" at all.
    document.body.innerHTML = `
      <div id="skills-widget">
        <input id="skills--skills" data-uxi-widget-type="selectinput" placeholder="Search" />
      </div>
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('skills--skills') as HTMLInputElement;
    const widget = document.getElementById('skills-widget')!;
    const portalRoot = document.getElementById('portal-root')!;
    const searchedQueries: string[] = [];
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      const query = trigger.value;
      searchedQueries.push(query);
      const label = query === 'C' ? 'C (Programming Language)'
        : query === 'C++' ? 'C++ Programming Language'
        : null;
      portalRoot.innerHTML = label ? `
        <div role="option"><div data-automation-id="promptLeafNode">
          <div data-automation-id="promptOption" data-automation-label="${label}">${label}</div>
        </div></div>
      ` : '';
      portalRoot.querySelector<HTMLElement>('[data-automation-id="promptLeafNode"]')?.addEventListener('click', () => {
        const selected = document.createElement('div');
        selected.dataset.automationId = 'selectedItem';
        selected.textContent = label!;
        widget.prepend(selected);
        trigger.value = '';
        portalRoot.innerHTML = '';
      });
    });
    const profile = { ...DEFAULT_PROFILE, professional: { ...DEFAULT_PROFILE.professional, skills: 'C, C++' } };
    const field: FieldDescriptor = {
      element: trigger, label: 'Type to Add Skills', kind: 'combobox', profileKey: 'professional.skills',
    };
    const skillCatalogCache: Record<string, string> = {};

    const summary = await fillComboboxFields([field], profile, {
      pollIntervalMs: 2, maxAttempts: 5, queryCommitDelayMs: 0, skillCatalogCache,
    });

    expect(summary).toEqual({ filled: 2, flagged: 0 });
    expect(searchedQueries).toContain('C');
    expect(searchedQueries).toContain('C++');
    expect(Array.from(widget.querySelectorAll<HTMLElement>('[data-automation-id="selectedItem"]'))
      .map((item) => item.textContent).sort()).toEqual(['C (Programming Language)', 'C++ Programming Language']);
    // Two distinct cache entries, not one overwriting the other.
    expect(Object.keys(skillCatalogCache).sort()).toEqual(['c', 'c++']);
    expect(skillCatalogCache.c).toBe('C (Programming Language)');
    expect(skillCatalogCache['c++']).toBe('C++ Programming Language');
  });

  it('matches an exact catalogue entry regardless of where Workday ranks it, unlike a fuzzy guess', async () => {
    // Reproduces a live bug on Cisco's tenant: "C++ Programming Language" was the exact real
    // catalogue entry for "C++", but ranked 6th in that tenant's own search results - outside the
    // top-5 cutoff meant for the fuzzy/approximate tier, which left it unmatched even though an
    // exact match is unambiguous regardless of its rank.
    document.body.innerHTML = `
      <div id="skills-widget">
        <input id="skills--skills" data-uxi-widget-type="selectinput" placeholder="Search" />
      </div>
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('skills--skills') as HTMLInputElement;
    const widget = document.getElementById('skills-widget')!;
    const portalRoot = document.getElementById('portal-root')!;
    const options = [
      'C (Programming Language)', 'C NMR', 'C-Arm', 'C/AL (Programming Language)', 'Unix C',
      'C++ Programming Language',
    ];
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      portalRoot.innerHTML = options.map((label) => `
        <div role="option"><div data-automation-id="promptLeafNode">
          <div data-automation-id="promptOption" data-automation-label="${label}">${label}</div>
        </div></div>
      `).join('');
      portalRoot.querySelectorAll<HTMLElement>('[data-automation-id="promptLeafNode"]').forEach((leaf, i) => {
        leaf.addEventListener('click', () => {
          const selected = document.createElement('div');
          selected.dataset.automationId = 'selectedItem';
          selected.textContent = options[i];
          widget.prepend(selected);
          trigger.value = '';
          portalRoot.innerHTML = '';
        });
      });
    });
    const profile = { ...DEFAULT_PROFILE, professional: { ...DEFAULT_PROFILE.professional, skills: 'C++' } };
    const field: FieldDescriptor = {
      element: trigger, label: 'Type to Add Skills', kind: 'combobox', profileKey: 'professional.skills',
    };

    expect(await fillComboboxFields([field], profile, {
      pollIntervalMs: 2, maxAttempts: 5, queryCommitDelayMs: 0,
    })).toEqual({ filled: 1, flagged: 0 });
    expect(widget.querySelector('[data-automation-id="selectedItem"]')?.textContent).toBe('C++ Programming Language');
  });

  it('fuzzy-matches a distinctive single-word skill but not a short/ambiguous one', async () => {
    document.body.innerHTML = `
      <div id="skills-widget">
        <input id="skills--skills" data-uxi-widget-type="selectinput" placeholder="Search" />
      </div>
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('skills--skills') as HTMLInputElement;
    const widget = document.getElementById('skills-widget')!;
    const portalRoot = document.getElementById('portal-root')!;
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      const query = trigger.value;
      // "Onshape" (a distinctive 7-letter word) should fuzzy-match "PTC Onshape". "R" (a bare
      // single letter, as ambiguous as "C") must not fuzzy-match "R Programming" the same way.
      const options = query === 'Onshape' ? ['PTC Onshape', 'NetApp Data ONTAP'] : ['R Programming', 'RStudio'];
      portalRoot.innerHTML = options.map((label) => `
        <div role="option"><div data-automation-id="promptLeafNode">
          <div data-automation-id="promptOption" data-automation-label="${label}">${label}</div>
        </div></div>
      `).join('');
      portalRoot.querySelectorAll<HTMLElement>('[data-automation-id="promptLeafNode"]').forEach((leaf, i) => {
        leaf.addEventListener('click', () => {
          const selected = document.createElement('div');
          selected.dataset.automationId = 'selectedItem';
          selected.textContent = options[i];
          widget.prepend(selected);
          trigger.value = '';
          portalRoot.innerHTML = '';
        });
      });
    });
    const profile = { ...DEFAULT_PROFILE, professional: { ...DEFAULT_PROFILE.professional, skills: 'Onshape, R' } };
    const field: FieldDescriptor = {
      element: trigger, label: 'Type to Add Skills', kind: 'combobox', profileKey: 'professional.skills',
    };

    expect(await fillComboboxFields([field], profile, {
      pollIntervalMs: 2, maxAttempts: 5, queryCommitDelayMs: 0,
    })).toEqual({ filled: 1, flagged: 1 });
    expect(widget.querySelector('[data-automation-id="selectedItem"]')?.textContent).toBe('PTC Onshape');
  });

  it('escapes the moniker menu after the selected country has committed', async () => {
    document.body.innerHTML = `
      <input id="country-trigger" data-uxi-widget-type="selectinput" placeholder="Search" />
      <div id="selected-country"></div>
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('country-trigger') as HTMLInputElement;
    const selectedCountry = document.getElementById('selected-country')!;
    const portalRoot = document.getElementById('portal-root')!;

    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      portalRoot.innerHTML = `
        <div data-automation-id="promptOption"
             data-automation-label="United States of America (+1)">United States of America (+1)</div>
      `;
      portalRoot.querySelector<HTMLElement>('[data-automation-id="promptOption"]')!
        .addEventListener('mousedown', () => {
          selectedCountry.textContent = 'United States of America (+1)';
        });
    });
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') portalRoot.innerHTML = '';
    });

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.phoneCountryCode')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(selectedCountry.textContent).toBe('United States of America (+1)');
    expect(portalRoot.children).toHaveLength(0);
  });

  it('does not cancel the option click Workday uses to close the moniker menu', async () => {
    document.body.innerHTML = `
      <input id="country-trigger" data-uxi-widget-type="selectinput" placeholder="Search" />
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('country-trigger') as HTMLInputElement;
    const portalRoot = document.getElementById('portal-root')!;
    let optionClickWasPrevented: boolean | null = null;

    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      portalRoot.innerHTML = `
        <div data-automation-id="promptOption"
             data-automation-label="United States of America (+1)">United States of America (+1)</div>
      `;
      portalRoot.querySelector<HTMLElement>('[data-automation-id="promptOption"]')!
        .addEventListener('click', (clickEvent) => {
          // Model Workday's delegated close behavior, which ignores a cancelled option click.
          optionClickWasPrevented = clickEvent.defaultPrevented;
          if (!clickEvent.defaultPrevented) portalRoot.innerHTML = '';
        });
    });

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.phoneCountryCode')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(optionClickWasPrevented).toBe(false);
    expect(portalRoot.children).toHaveLength(0);
  });

  it('blurs the moniker search input and clicks outside after selection', async () => {
    document.body.innerHTML = `
      <input id="country-trigger" data-uxi-widget-type="selectinput" placeholder="Search" />
      <div id="portal-root"></div>
    `;
    const trigger = document.getElementById('country-trigger') as HTMLInputElement;
    const portalRoot = document.getElementById('portal-root')!;
    let blurred = false;
    let pointerDownOutside = false;
    trigger.dataset.autofillFlag = 'needs-input';
    trigger.style.outline = '2px solid #f5a623';

    trigger.addEventListener('blur', () => {
      blurred = true;
    });
    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      portalRoot.innerHTML = `
        <div data-automation-id="promptOption"
             data-automation-label="United States of America (+1)">United States of America (+1)</div>
      `;
    });
    document.body.addEventListener('pointerdown', (event) => {
      if (event.target === document.body && blurred) {
        pointerDownOutside = true;
        portalRoot.innerHTML = '';
      }
    });

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.phoneCountryCode')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 1, flagged: 0 });
    expect(blurred).toBe(true);
    expect(pointerDownOutside).toBe(true);
    expect(document.activeElement).not.toBe(trigger);
    expect(portalRoot.children).toHaveLength(0);
    expect(trigger.dataset.autofillFlag).toBeUndefined();
    expect(trigger.style.outline).toBe('');
  });

  it('flags a moniker-search-box field when no rendered option matches the typed value', async () => {
    document.body.innerHTML = `
      <input id="country-trigger" data-uxi-widget-type="selectinput" placeholder="Search" />
      <div id="unrelated-portal-root"></div>
    `;
    const trigger = document.getElementById('country-trigger') as HTMLInputElement;
    const portalRoot = document.getElementById('unrelated-portal-root')!;

    trigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        portalRoot.innerHTML = `
          <div data-automation-id="promptOption" data-automation-label="Canada (+1)">Canada (+1)</div>
        `;
      }
    });

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.phoneCountryCode')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });

    expect(summary).toEqual({ filled: 0, flagged: 1 });
  });

  it('flags and clears the typed value for a moniker-search-box field when no options ever render', async () => {
    document.body.innerHTML = `<input id="country-trigger" data-uxi-widget-type="selectinput" placeholder="Search" />`;
    const trigger = document.getElementById('country-trigger') as HTMLInputElement;
    // No keyboard listener: submitting the query never produces promptOption elements.

    const profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const summary = await fillComboboxFields([makeField(trigger, 'personal.phoneCountryCode')], profile, {
      pollIntervalMs: 5,
      maxAttempts: 3,
    });

    expect(summary).toEqual({ filled: 0, flagged: 1 });
    expect(trigger.value).toBe('');
    expect(trigger.dataset.autofillFlag).toBe('needs-input');
  });

  it('does not match a stale promptOption element left over from an earlier moniker field', async () => {
    // Simulates Workday not tearing down a popup's promptOption DOM when it closes: the first
    // field's matched option is deliberately left in place (never removed), and the second
    // field's popup renders a different option. Without the per-field snapshot in
    // fillComboboxFields, the second field's first waitForOptions call would immediately see the
    // first field's leftover option and return early — before the second field's own click/type
    // cycle ever runs — causing it to either flag (no text match) or, worse, be mistaken for the
    // second field's real answer.
    document.body.innerHTML = `
      <input id="first-trigger" data-uxi-widget-type="selectinput" placeholder="Search" />
      <input id="second-trigger" data-uxi-widget-type="selectinput" placeholder="Search" />
      <div id="portal-root"></div>
    `;
    const firstTrigger = document.getElementById('first-trigger') as HTMLInputElement;
    const secondTrigger = document.getElementById('second-trigger') as HTMLInputElement;
    const portalRoot = document.getElementById('portal-root')!;

    firstTrigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      const opt = document.createElement('div');
      opt.setAttribute('data-automation-id', 'promptOption');
      opt.textContent = 'Canada (+1)';
      portalRoot.appendChild(opt);
      // Deliberately does NOT remove this element afterwards, simulating a popup whose DOM
      // isn't torn down when closed.
    });
    secondTrigger.addEventListener('keyup', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      const opt = document.createElement('div');
      opt.setAttribute('data-automation-id', 'promptOption');
      opt.textContent = 'United States of America (+1)';
      portalRoot.appendChild(opt);
    });

    const firstProfile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'Canada' },
    };
    const firstSummary = await fillComboboxFields([makeField(firstTrigger, 'personal.phoneCountryCode')], firstProfile, {
      pollIntervalMs: 5,
      maxAttempts: 5,
    });
    expect(firstSummary).toEqual({ filled: 1, flagged: 0 });

    // The first field's option is still in the DOM at this point (never removed).
    expect(document.querySelectorAll('[data-automation-id="promptOption"]')).toHaveLength(1);

    const secondProfile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, phoneCountryCode: 'United States' },
    };
    const secondSummary = await fillComboboxFields(
      [makeField(secondTrigger, 'personal.phoneCountryCode')],
      secondProfile,
      { pollIntervalMs: 5, maxAttempts: 5 }
    );

    expect(secondSummary).toEqual({ filled: 1, flagged: 0 });
    // Both the stale leftover and the second field's own option are in the DOM; the second field
    // must have waited for and matched its own new option, not returned early on the stale one.
    expect(document.querySelectorAll('[data-automation-id="promptOption"]')).toHaveLength(2);
  });
});
