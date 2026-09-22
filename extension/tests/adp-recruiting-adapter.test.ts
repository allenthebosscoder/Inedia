import { describe, expect, it } from 'vitest';
import { adpRecruitingAdapter } from '../src/fill-engine/adp-recruiting-adapter';
import { ADAPTERS } from '../src/fill-engine/adapter-registry';
import { pickAdapter } from '../src/fill-engine/site-detector';

describe('adpRecruitingAdapter', () => {
  it('matches recruiting.adp.com and nothing else ADP', () => {
    expect(adpRecruitingAdapter.matchesHostname('recruiting.adp.com')).toBe(true);
    expect(adpRecruitingAdapter.matchesHostname('workforcenow.adp.com')).toBe(false);
    expect(adpRecruitingAdapter.matchesHostname('example.com')).toBe(false);
  });

  it('extracts no fields (Dojo is driven by the dedicated pass)', () => {
    document.body.innerHTML = '<input name="firstName_RTiCandidate" class="dijitInputInner">';
    expect(adpRecruitingAdapter.extractFields(document)).toEqual([]);
  });

  it('is registered and selected for recruiting.adp.com', () => {
    expect(pickAdapter('recruiting.adp.com', ADAPTERS).id).toBe('adp-recruiting');
  });
});
