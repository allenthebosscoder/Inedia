import { describe, it, expect } from 'vitest';
import { workdayAdapter } from '../src/fill-engine/workday-adapter';

describe('workdayAdapter.matchesHostname', () => {
  it('matches myworkdayjobs.com tenant subdomains', () => {
    expect(workdayAdapter.matchesHostname('acme.wd1.myworkdayjobs.com')).toBe(true);
  });

  it('matches myworkdaysite.com Candidate Experience tenants', () => {
    expect(workdayAdapter.matchesHostname('wd5.myworkdaysite.com')).toBe(true);
  });

  it('does not match unrelated hosts', () => {
    expect(workdayAdapter.matchesHostname('example.com')).toBe(false);
  });
});
