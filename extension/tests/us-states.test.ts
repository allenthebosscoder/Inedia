import { describe, it, expect } from 'vitest';
import {
  US_STATES,
  expandStateAbbreviation,
  abbreviateStateName,
  normalizeStateValue,
} from '../src/fill-engine/us-states';

describe('expandStateAbbreviation', () => {
  it('expands a known abbreviation to its full name', () => {
    expect(expandStateAbbreviation('NC')).toBe('North Carolina');
    expect(expandStateAbbreviation('CA')).toBe('California');
  });

  it('returns null for an unrecognized abbreviation', () => {
    expect(expandStateAbbreviation('ZZ')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(expandStateAbbreviation('nc')).toBe('North Carolina');
  });
});

describe('abbreviateStateName', () => {
  it('abbreviates a lowercase full name', () => {
    expect(abbreviateStateName('north carolina')).toBe('NC');
  });

  it('abbreviates a properly-cased full name', () => {
    expect(abbreviateStateName('North Carolina')).toBe('NC');
  });

  it('returns null for an unrecognized name', () => {
    expect(abbreviateStateName('not a state')).toBeNull();
  });
});

describe('normalizeStateValue', () => {
  it('normalizes a legacy full name to its abbreviation', () => {
    expect(normalizeStateValue('North Carolina')).toBe('NC');
  });

  it('normalizes a lowercase abbreviation to uppercase', () => {
    expect(normalizeStateValue('nc')).toBe('NC');
  });

  it('leaves an already-normalized abbreviation unchanged', () => {
    expect(normalizeStateValue('NC')).toBe('NC');
  });

  it('leaves an empty string unchanged', () => {
    expect(normalizeStateValue('')).toBe('');
  });

  it('passes through an unrecognized value unchanged', () => {
    expect(normalizeStateValue('not a state')).toBe('not a state');
  });
});

describe('US_STATES', () => {
  it('has 51 entries (50 states + DC)', () => {
    expect(US_STATES).toHaveLength(51);
  });

  it('has no duplicate abbreviations', () => {
    const abbreviations = US_STATES.map((s) => s.abbreviation);
    expect(new Set(abbreviations).size).toBe(abbreviations.length);
  });
});
