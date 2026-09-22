import { describe, expect, it } from 'vitest';
import { findCompanyWebsiteSourceIndex, isSourceQuestion } from '../src/fill-engine/source-answer';

describe('source answer policy', () => {
  it('recognizes common source-question wording', () => {
    expect(isSourceQuestion('How did you hear about this job?')).toBe(true);
    expect(isSourceQuestion('Where did you first learn about this position?')).toBe(true);
    expect(isSourceQuestion('How did you become aware of this opening?')).toBe(true);
    expect(isSourceQuestion('Applicant Source')).toBe(true);
    expect(isSourceQuestion('Source')).toBe(true);
    expect(isSourceQuestion('What is your LinkedIn URL?')).toBe(false);
  });

  it('prefers Company Website over unrelated earlier options', () => {
    expect(findCompanyWebsiteSourceIndex(['Career Fair', 'LinkedIn', 'Company Website'])).toBe(2);
  });

  it('accepts a named company careers site as an equivalent', () => {
    expect(findCompanyWebsiteSourceIndex(['ADA', 'Starkey Careers', 'Indeed'])).toBe(1);
    expect(findCompanyWebsiteSourceIndex(['Referral', 'Company Career Portal'])).toBe(1);
  });

  it('does not treat job boards or events as a company website', () => {
    expect(findCompanyWebsiteSourceIndex(['CareerBuilder', 'Career Fair', 'LinkedIn'])).toBeNull();
  });
});
