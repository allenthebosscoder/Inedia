import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fillAdpRecruitingForm } from '../src/fill-engine/adp-recruiting-fill';
import { DijitRegistry, DijitWidget } from '../src/fill-engine/adp-recruiting-dojo';
import { DEFAULT_PROFILE, Profile } from '../src/storage/profile-schema';

// A jsdom stand-in for the Dijit registry: widgets are registered against their control node.
const widgets = new Map<Node, DijitWidget>();

function registry(): DijitRegistry {
  return {
    byId: () => undefined,
    getEnclosingWidget: (node: Node) => {
      let el: Node | null = node;
      while (el) {
        const w = widgets.get(el);
        if (w) return w;
        el = (el as HTMLElement).parentElement;
      }
      return undefined;
    },
  };
}

function mountText(name: string, label: string, required = true): DijitWidget {
  const wrapper = document.createElement('div');
  wrapper.className = 'dojositeFld';
  wrapper.setAttribute('data-dojosite-fld', encodeURIComponent(JSON.stringify({ name: name })));
  wrapper.innerHTML = `<div class="element"><label>${label}${required ? '**' : ''}</label>
    <input class="dijitInputInner" name="${name}_RTiCandidate" aria-required="${required}"></div>`;
  document.body.append(wrapper);
  const node = wrapper.querySelector('input')!;
  let value = '';
  const widget: DijitWidget = {
    get: () => value,
    set: (_p, v) => { value = String(v); (node as HTMLInputElement).value = value; },
    domNode: node,
  };
  widgets.set(node, widget);
  return widget;
}

function mountSelect(name: string, label: string, options: { value: string; label: string }[]): DijitWidget {
  const wrapper = document.createElement('div');
  wrapper.className = 'dojositeFld';
  wrapper.setAttribute('data-dojosite-fld', encodeURIComponent(JSON.stringify({ name: name })));
  wrapper.innerHTML = `<div class="element"><label>${label}**</label>
    <div class="dijitSelect"><table role="listbox"><input type="hidden" name="${name}_RTiCandidate" aria-hidden="true">
    <span class="dijitSelectLabel"><span class="label"></span></span></table></div></div>`;
  document.body.append(wrapper);
  const node = wrapper.querySelector('table')!;
  // Mirror real Dojo: `domNode` is the outer `.dijitSelect` container, not the inner listbox table.
  const outer = wrapper.querySelector<HTMLElement>('.dijitSelect')!;
  let value = '';
  const widget: DijitWidget = {
    get: () => value,
    set: (_p, v) => {
      value = String(v);
      const hidden = wrapper.querySelector<HTMLInputElement>('input[type="hidden"]')!;
      hidden.value = value;
      const shown = options.find((o) => o.value === value)?.label ?? '';
      wrapper.querySelector('.label')!.textContent = shown;
    },
    getOptions: () => options,
    domNode: outer,
  };
  widgets.set(node, widget);
  return widget;
}

function mountDate(name: string): DijitWidget {
  const wrapper = document.createElement('div');
  wrapper.className = 'dojositeFld';
  wrapper.setAttribute('data-dojosite-fld', encodeURIComponent(JSON.stringify({ name })));
  wrapper.innerHTML = `<div class="element"><label>Start Date**</label>
    <input class="dijitInputInner" role="textbox" name="${name}_RTiCandidate">
    <input type="hidden" name="${name}_RTiCandidateDate"></div>`;
  document.body.append(wrapper);
  const node = wrapper.querySelector<HTMLElement>('input.dijitInputInner')!;
  let value: unknown = '';
  const widget: DijitWidget = {
    get: () => value,
    set: (_p, v) => { value = v; },
    domNode: node,
  };
  widgets.set(node, widget);
  return widget;
}

function mountEmployerRow(row: number): Record<string, DijitWidget> {
  return {
    type: mountSelect(`$$employerType_${row}`, 'Type', [
      { value: '00001000', label: 'Current' }, { value: '00002000', label: 'Previous' },
    ]),
    name: mountText(`$$employerName_${row}`, 'Employer'),
    city: mountText(`$$employerCity_${row}`, 'City'),
    startTitle: mountText(`$$employerStartTitle_${row}`, 'Start Position/Title'),
    startDate: mountDate(`$$employerStartDate_${row}`),
    duties: mountText(`$$employerJobDuties_${row}`, 'Job Duties'),
    supvName: mountText(`$$employerSupvName_${row}`, "Supervisor's Name"),
  };
}

beforeEach(() => { widgets.clear(); document.body.innerHTML = ''; });
afterEach(() => { widgets.clear(); document.body.innerHTML = ''; });

describe('fillAdpRecruitingForm — flat pass', () => {
  it('fills nothing without a Dojo registry but still sweeps required blanks', async () => {
    const first = mountText('firstName', 'Legal First Name');
    const summary = await fillAdpRecruitingForm({ ...DEFAULT_PROFILE }, document);
    expect(summary.filled).toBe(0);
    expect(summary.flagged).toBe(1);
    expect((first.domNode as HTMLElement).dataset.autofillFlag).toBe('needs-input');
  });

  it('fills text and coded-select fields through the widgets', async () => {
    (window as unknown as { dijit: { registry: DijitRegistry } }).dijit = { registry: registry() };
    const first = mountText('firstName', 'Legal First Name');
    const state = mountSelect('state', 'State/Province', [
      { value: 'NC', label: 'North Carolina' },
      { value: 'CA', label: 'California' },
    ]);
    const relocate = mountSelect('$$willingToRelocate', 'Willing to Relocate', [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' },
    ]);
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, firstName: 'Allen', state: 'NC' },
      jobPreferences: { ...DEFAULT_PROFILE.jobPreferences, willingToRelocate: 'yes' },
    };

    const summary = await fillAdpRecruitingForm(profile, document);

    expect(first.get('value')).toBe('Allen');
    expect(state.get('value')).toBe('NC');
    expect(relocate.get('value')).toBe('true');
    expect(summary.filled).toBe(3);
    delete (window as unknown as { dijit?: unknown }).dijit;
  });

  it('flags a failed-write required Select exactly once', async () => {
    (window as unknown as { dijit: { registry: DijitRegistry } }).dijit = { registry: registry() };
    const state = mountSelect('state', 'State/Province', [
      { value: 'CA', label: 'California' },
      { value: 'TX', label: 'Texas' },
    ]);
    const listbox = document.querySelector<HTMLElement>('.dojositeFld table[role="listbox"]')!;
    // domNode (outer .dijitSelect) is NOT the node the sweep inspects (the inner listbox table).
    expect(state.domNode).not.toBe(listbox);
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, state: 'Nowhereland' },
    };

    const summary = await fillAdpRecruitingForm(profile, document);

    expect(state.get('value')).toBe('');
    // Flag lands on the inner listbox (what sweepRequired dedupes against), not the outer container.
    expect(listbox.dataset.autofillFlag).toBe('needs-input');
    expect((state.domNode as HTMLElement).dataset.autofillFlag).toBeUndefined();
    expect(summary.filled).toBe(0);
    expect(summary.flagged).toBe(1);
    delete (window as unknown as { dijit?: unknown }).dijit;
  });

  it('flags a visible required field with no profile value', async () => {
    (window as unknown as { dijit: { registry: DijitRegistry } }).dijit = { registry: registry() };
    const city = mountText('city', 'City');
    const summary = await fillAdpRecruitingForm({ ...DEFAULT_PROFILE, personal: { ...DEFAULT_PROFILE.personal, city: '' } }, document);
    expect((city.domNode as HTMLElement).dataset.autofillFlag).toBe('needs-input');
    expect(summary.flagged).toBeGreaterThanOrEqual(1);
    delete (window as unknown as { dijit?: unknown }).dijit;
  });

  it('skips a hidden conditional required field — not filled, not flagged', async () => {
    (window as unknown as { dijit: { registry: DijitRegistry } }).dijit = { registry: registry() };
    const city = mountText('city', 'City');
    (city.domNode as HTMLElement).closest<HTMLElement>('.dojositeFld')!.style.display = 'none';
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, city: 'Durham' },
    };
    const summary = await fillAdpRecruitingForm(profile, document);
    expect(city.get('value')).toBe('');
    expect(summary.filled).toBe(0);
    expect(summary.flagged).toBe(0);
    expect((city.domNode as HTMLElement).dataset.autofillFlag).toBeUndefined();
    delete (window as unknown as { dijit?: unknown }).dijit;
  });
});

describe('fillAdpRecruitingForm — Employment History', () => {
  it('fills rendered rows and clicks "Add Employer" for missing ones', async () => {
    (window as unknown as { dijit: { registry: DijitRegistry } }).dijit = { registry: registry() };
    const row1 = mountEmployerRow(1);

    // Model a real dijit/form/Button: `widgetid` on the OUTER node, the click handler bound to
    // the INNER `.dijitButtonNode`. A click on an ancestor never reaches the handler.
    const button = document.createElement('span');
    button.className = 'dijitButton';
    button.setAttribute('widgetid', 'addEmployer_0');
    button.innerHTML =
      '<span class="dijitButtonNode"><span class="dijitButtonContents">' +
      '<span class="dijitButtonText">Add Employer</span></span></span>';
    button.querySelector<HTMLElement>('.dijitButtonNode')!
      .addEventListener('click', () => { mountEmployerRow(2); });
    document.body.append(button);

    const profile: Profile = {
      ...DEFAULT_PROFILE,
      workHistory: [
        { company: 'Acme', title: 'Engineer', location: 'Durham', startDate: '06/2021', endDate: '08/2023', currentlyWorksHere: false, description: 'Built things', supervisorName: 'Dana Lee' },
        { company: 'Globex', title: 'Intern', location: 'Raleigh', startDate: '05/2020', endDate: '08/2020', currentlyWorksHere: false, description: 'Learned things', supervisorName: 'Sam Roe' },
      ],
    };

    const summary = await fillAdpRecruitingForm(profile, document, { addRowIntervalMs: 1, addRowMaxAttempts: 5 });

    expect(row1.name.get('value')).toBe('Acme');
    expect(row1.type.get('value')).toBe('00002000'); // not current -> Previous
    expect(row1.startDate.get('value')).toBeInstanceOf(Date);
    expect(document.querySelector('[name="$$employerName_2_RTiCandidate"]')).not.toBeNull();
    expect(summary.filled).toBeGreaterThanOrEqual(10);
    delete (window as unknown as { dijit?: unknown }).dijit;
  });

  it('leaves End Date blank for a current job but still fills End Position/Title', async () => {
    (window as unknown as { dijit: { registry: DijitRegistry } }).dijit = { registry: registry() };
    const row1 = mountEmployerRow(1);
    const endDate = mountDate('$$employerEndDate_1');
    const endTitle = mountText('$$employerEndTitle_1', 'End Position/Title');
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      workHistory: [
        { company: 'Acme', title: 'Engineer', location: 'Durham', startDate: '06/2021', endDate: '', currentlyWorksHere: true, description: 'x' },
      ],
    };
    await fillAdpRecruitingForm(profile, document, { addRowIntervalMs: 1, addRowMaxAttempts: 2 });
    expect(row1.type.get('value')).toBe('00001000'); // Current
    expect(endDate.get('value')).toBe(''); // untouched
    expect(endTitle.get('value')).toBe('Engineer'); // still required on some tenants
    delete (window as unknown as { dijit?: unknown }).dijit;
  });

  it('counts a failed required employer select once (no double-count with sweepRequired)', async () => {
    (window as unknown as { dijit: { registry: DijitRegistry } }).dijit = { registry: registry() };
    mountText('$$employerName_1', 'Employer');
    const state = mountSelect('$$employerState_1', 'State', [
      { value: 'CA', label: 'California' },
      { value: 'TX', label: 'Texas' },
    ]);
    const listbox = document.querySelector<HTMLElement>(
      '[data-dojosite-fld*="employerState_1"] table[role="listbox"]'
    )!;
    expect(state.domNode).not.toBe(listbox);

    const profile: Profile = {
      ...DEFAULT_PROFILE,
      workHistory: [
        { company: 'Acme', title: 'Engineer', location: 'Durham, Nowhereland, US', startDate: '06/2021', endDate: '08/2023', currentlyWorksHere: false, description: 'x' },
      ],
    };

    const summary = await fillAdpRecruitingForm(profile, document, { addRowIntervalMs: 1, addRowMaxAttempts: 2 });

    expect(state.get('value')).toBe('');
    // Flag lands on the inner listbox once; sweepRequired dedupes against it.
    expect(listbox.dataset.autofillFlag).toBe('needs-input');
    expect((state.domNode as HTMLElement).dataset.autofillFlag).toBeUndefined();
    expect(summary.flagged).toBe(1);
    delete (window as unknown as { dijit?: unknown }).dijit;
  });

  it('does not flag required fields whose write succeeded (text + select + date)', async () => {
    (window as unknown as { dijit: { registry: DijitRegistry } }).dijit = { registry: registry() };
    const row1 = mountEmployerRow(1); // type (select), name (text), startDate (date), ... all required
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      workHistory: [
        {
          company: 'Acme', title: 'Engineer', location: 'Durham', startDate: '06/2021',
          endDate: '08/2023', currentlyWorksHere: false, description: 'Built things',
          supervisorName: 'Dana Lee',
        },
      ],
    };

    const summary = await fillAdpRecruitingForm(profile, document, { addRowIntervalMs: 1, addRowMaxAttempts: 2 });

    expect(row1.name.get('value')).toBe('Acme');
    expect(row1.startDate.get('value')).toBeInstanceOf(Date);
    // The date/select commits are not mirrored into wrapperHasValue's DOM shapes; without
    // recording successful writes the sweep re-counts them as blank required fields.
    expect(summary.flagged).toBe(0);
    for (const control of Array.from(
      document.querySelectorAll<HTMLElement>('input.dijitInputInner, textarea, table[role="listbox"]')
    )) {
      expect(control.dataset.autofillFlag).toBeUndefined();
    }
    delete (window as unknown as { dijit?: unknown }).dijit;
  });
});

describe('fillAdpRecruitingForm — Education', () => {
  function mountEducationRow(row: number): Record<string, DijitWidget> {
    return {
      level: mountSelect(`$$educationDegreeLevel_${row}`, 'Education Level', [
        { value: 'B', label: "&#8203;<span class=label>Bachelor&#x27;s Level Degree&nbsp;</span>" },
        { value: 'M', label: "&#8203;<span class=label>Master&#x27;s Level Degree&nbsp;</span>" },
      ]),
      school: mountText(`$$educationSchoolName_${row}`, 'School/University Name'),
      city: mountText(`$$educationCity_${row}`, 'City'),
      state: mountSelect(`$$educationState_${row}`, 'State/Province', [
        { value: 'NC', label: 'North Carolina' }, { value: 'CA', label: 'California' },
      ]),
      major: mountText(`$$educationMajor_${row}`, 'Major', false),
      graduated: mountSelect(`$$educationGraduated_${row}`, 'Graduated?', [
        { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' },
      ]),
    };
  }

  it('maps a bachelor entry to ADP education fields and derives Graduated from the year', async () => {
    (window as unknown as { dijit: { registry: DijitRegistry } }).dijit = { registry: registry() };
    const row1 = mountEducationRow(1);
    const profile: Profile = {
      ...DEFAULT_PROFILE,
      personal: { ...DEFAULT_PROFILE.personal, city: 'Durham', state: 'NC' },
      education: [
        {
          school: 'Duke University', degree: 'BSE', fieldOfStudy: 'Electrical & Computer Engineering',
          graduationDate: '05/2020', endYear: '2020', location: '',
        },
      ],
    };

    const summary = await fillAdpRecruitingForm(profile, document, { addRowIntervalMs: 1, addRowMaxAttempts: 2 });

    expect(row1.level.get('value')).toBe('B'); // BSE -> Bachelor's Level Degree
    expect(row1.school.get('value')).toBe('Duke University');
    expect(row1.city.get('value')).toBe('Durham'); // falls back to personal.city
    expect(row1.state.get('value')).toBe('NC');
    expect(row1.major.get('value')).toBe('Electrical & Computer Engineering');
    expect(row1.graduated.get('value')).toBe('true'); // 2020 <= now -> Yes
    expect(summary.flagged).toBe(0);
    delete (window as unknown as { dijit?: unknown }).dijit;
  });
});
