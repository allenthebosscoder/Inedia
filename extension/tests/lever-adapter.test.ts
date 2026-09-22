import { describe, it, expect } from 'vitest';
import { leverAdapter } from '../src/fill-engine/lever-adapter';

describe('leverAdapter.matchesHostname', () => {
  it('matches lever.co subdomains', () => {
    expect(leverAdapter.matchesHostname('jobs.lever.co')).toBe(true);
  });

  it('does not match unrelated hosts', () => {
    expect(leverAdapter.matchesHostname('example.com')).toBe(false);
  });
});
