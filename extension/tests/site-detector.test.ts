import { describe, it, expect } from 'vitest';
import { pickAdapter } from '../src/fill-engine/site-detector';
import { Adapter } from '../src/fill-engine/types';

const fakeAdapter: Adapter = {
  id: 'fake',
  matchesHostname: (hostname) => hostname === 'example.com',
  extractFields: () => [],
};

describe('pickAdapter', () => {
  it('returns the matching adapter', () => {
    expect(pickAdapter('example.com', [fakeAdapter]).id).toBe('fake');
  });

  it('falls back to genericAdapter when nothing matches', () => {
    expect(pickAdapter('unknown.com', [fakeAdapter]).id).toBe('generic');
  });
});
