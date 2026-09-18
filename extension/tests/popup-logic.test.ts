import { describe, it, expect } from 'vitest';
import { formatSummary, detectAdapterId } from '../src/popup/popup-logic';

describe('formatSummary', () => {
  it('pluralizes filled/flagged counts correctly', () => {
    expect(formatSummary({ filled: 1, flagged: 0 })).toBe('Filled 1 field, 0 need your input.');
    expect(formatSummary({ filled: 14, flagged: 3 })).toBe('Filled 14 fields, 3 need your input.');
    expect(formatSummary({ filled: 5, flagged: 1 })).toBe('Filled 5 fields, 1 needs your input.');
  });

  it("reports unsupported site instead of implying success when nothing was recognized", () => {
    expect(formatSummary({ filled: 0, flagged: 0 })).toBe("0 fields recognized, this site isn't supported yet.");
  });

  it('lists flagged skill names so the applicant can add them manually', () => {
    expect(formatSummary({ filled: 4, flagged: 1, flaggedSkills: ['PCB Design'] })).toBe(
      'Filled 4 fields, 1 needs your input. Skill not found in the catalogue: PCB Design.'
    );
  });

  it('pluralizes "Skills" when more than one is flagged', () => {
    expect(
      formatSummary({ filled: 4, flagged: 2, flaggedSkills: ['PCB Design', 'DC-DC Converter Design'] })
    ).toBe('Filled 4 fields, 2 need your input. Skills not found in the catalogue: PCB Design, DC-DC Converter Design.');
  });

  it('omits the skills sentence when flaggedSkills is absent or empty', () => {
    expect(formatSummary({ filled: 4, flagged: 1 })).toBe('Filled 4 fields, 1 needs your input.');
    expect(formatSummary({ filled: 4, flagged: 1, flaggedSkills: [] })).toBe('Filled 4 fields, 1 needs your input.');
  });
});

describe('detectAdapterId', () => {
  it('identifies Greenhouse by hostname', () => {
    expect(detectAdapterId('boards.greenhouse.io')).toBe('greenhouse');
  });

  it('falls back to generic for unknown hosts', () => {
    expect(detectAdapterId('example.com')).toBe('generic');
  });
});
