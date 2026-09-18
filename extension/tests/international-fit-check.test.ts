import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkInternationalFit,
  classifyInternationalFitText,
  isNonDiscriminationCitizenshipMention,
} from '../src/international-fit-check';

describe('international applicant fit check', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('classifies common restrictive, supportive, and ambiguous wording', () => {
    expect(classifyInternationalFitText('We are unable to offer visa sponsorship.')).toBe('restrictive');
    expect(classifyInternationalFitText('Applicants must be U.S. citizens.')).toBe('restrictive');
    expect(classifyInternationalFitText('Visa sponsorship is available for qualified candidates.')).toBe('supportive');
    expect(classifyInternationalFitText('No security clearance is required.')).toBe('supportive');
    expect(classifyInternationalFitText('This position is subject to ITAR regulations.')).toBe('review');
  });

  it('highlights all relevant terms and scrolls to a restrictive result first', () => {
    document.body.innerHTML = `
      <main>
        <p>Visa sponsorship is available for qualified candidates.</p>
        <p>Candidates must be U.S. citizens and hold a security clearance.</p>
        <p>This role is subject to ITAR and export-control rules.</p>
      </main>
    `;

    const result = checkInternationalFit();

    expect(result).toEqual({ restrictive: 2, supportive: 2, review: 2, total: 6 });
    expect(document.querySelectorAll('mark[data-job-autofill-international-fit="restrictive"]')).toHaveLength(2);
    expect(document.querySelectorAll('mark[data-job-autofill-international-fit="supportive"]')).toHaveLength(2);
    expect(document.querySelectorAll('mark[data-job-autofill-international-fit="review"]')).toHaveLength(2);
    expect(document.querySelector('mark[data-job-autofill-first="true"]')?.getAttribute('data-job-autofill-international-fit')).toBe('restrictive');
  });

  it('clears existing highlights without changing the job description text', () => {
    document.body.innerHTML = '<p>We may sponsor an employment visa.</p>';
    const originalText = document.body.textContent;
    checkInternationalFit();

    const cleared = checkInternationalFit({ clear: true });

    expect(cleared).toEqual({ restrictive: 0, supportive: 0, review: 0, total: 0, cleared: true });
    expect(document.querySelectorAll('mark[data-job-autofill-international-fit]')).toHaveLength(0);
    expect(document.getElementById('job-autofill-international-fit-style')).toBeNull();
    expect(document.body.textContent).toBe(originalText);
  });

  it('does not scan form controls, scripts, or the extension widget', () => {
    document.body.innerHTML = `
      <input value="visa sponsorship">
      <script>const citizen = true;</script>
      <div id="job-autofill-control-host">security clearance</div>
      <p>General engineering role.</p>
    `;

    expect(checkInternationalFit().total).toBe(0);
  });

  it('replaces rather than nesting highlights when run again', () => {
    document.body.innerHTML = '<p>Applicants must be U.S. citizens.</p>';
    checkInternationalFit();
    const second = checkInternationalFit();

    expect(second.total).toBe(1);
    expect(document.querySelectorAll('mark[data-job-autofill-international-fit]')).toHaveLength(1);
    expect(document.querySelector('mark mark')).toBeNull();
  });

  it('ignores citizenship inside equal-opportunity protected-class boilerplate', () => {
    const disclaimer = 'We provide equal employment opportunity regardless of race, color, religion, sex, national origin, age, disability, veteran status, or citizenship.';
    expect(isNonDiscriminationCitizenshipMention('citizenship', disclaimer)).toBe(true);
    document.body.innerHTML = `
      <p>${disclaimer}</p>
      <p>This role does not provide visa sponsorship.</p>
    `;

    const result = checkInternationalFit();

    expect(result).toEqual({ restrictive: 2, supportive: 0, review: 0, total: 2 });
    expect(document.querySelector('mark')?.textContent).toBe('visa');
    expect(document.body.textContent).toContain('citizenship');
    expect(document.querySelectorAll('mark')).toHaveLength(2);
  });

  it('still highlights actual citizenship requirements', () => {
    const requirement = 'Applicants must be U.S. citizens to be considered.';
    expect(isNonDiscriminationCitizenshipMention('citizens', requirement)).toBe(false);
    document.body.innerHTML = `<p>${requirement}</p>`;

    const result = checkInternationalFit();

    expect(result.restrictive).toBe(1);
    expect(document.querySelector('mark')?.textContent).toBe('citizens');
  });
});
