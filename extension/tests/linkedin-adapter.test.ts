import { describe, it, expect, beforeEach } from 'vitest';
import { linkedinAdapter } from '../src/fill-engine/linkedin-adapter';

describe('linkedinAdapter', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches linkedin.com', () => {
    expect(linkedinAdapter.matchesHostname('www.linkedin.com')).toBe(true);
    expect(linkedinAdapter.matchesHostname('example.com')).toBe(false);
  });

  it('scopes extraction to the Easy Apply modal when present', () => {
    document.body.innerHTML = `
      <input type="text" placeholder="Search" />
      <div class="jobs-easy-apply-modal">
        <input type="text" aria-label="First Name" />
      </div>
    `;
    const fields = linkedinAdapter.extractFields(document);
    expect(fields).toHaveLength(1);
    expect(fields[0].profileKey).toBe('personal.firstName');
  });

  it('falls back to the whole document when no modal is present', () => {
    document.body.innerHTML = `<input type="text" aria-label="Email Address" />`;
    const fields = linkedinAdapter.extractFields(document);
    expect(fields).toHaveLength(1);
  });
});
