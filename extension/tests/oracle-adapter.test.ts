import { beforeEach, describe, expect, it } from 'vitest';
import { oracleAdapter } from '../src/fill-engine/oracle-adapter';

describe('oracleAdapter', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches Oracle Recruiting cloud tenants', () => {
    expect(oracleAdapter.matchesHostname('fa-prod.fa.ocs.oraclecloud.com')).toBe(true);
    expect(oracleAdapter.matchesHostname('example.com')).toBe(false);
  });

  it('maps Oracle country-codes-dropdown inputs to phone country code despite the Phone Number label', () => {
    document.body.innerHTML = `
      <label for="country-codes-dropdownphoneNumber">Phone Number</label>
      <input id="country-codes-dropdownphoneNumber" role="combobox" aria-haspopup="grid"
        aria-controls="country-codes-dropdownphoneNumber-listbox" value="+1" />
    `;

    const fields = oracleAdapter.extractFields(document);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ kind: 'combobox', profileKey: 'personal.phoneCountryCode' });
  });
});
