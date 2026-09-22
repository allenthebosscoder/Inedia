import { beforeEach, describe, expect, it } from 'vitest';
import { adpAdapter } from '../src/fill-engine/adp-adapter';

describe('adpAdapter', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches Workforce Now recruitment hosts only', () => {
    expect(adpAdapter.matchesHostname('workforcenow.adp.com')).toBe(true);
    expect(adpAdapter.matchesHostname('tenant.workforcenow.adp.com')).toBe(true);
    expect(adpAdapter.matchesHostname('example.com')).toBe(false);
  });

  it('leaves MDF text controls to the dedicated filler while retaining native controls', () => {
    document.body.innerHTML = `
      <input id="guestFirstName" aria-label="First Name" aria-required="true">
      <select name="phoneCountry" aria-label="Phone number country"><option>United States</option></select>
    `;

    const fields = adpAdapter.extractFields(document);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ kind: 'select', profileKey: 'personal.phoneCountryCode' });
  });
});
