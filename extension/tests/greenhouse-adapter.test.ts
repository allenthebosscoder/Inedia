import { beforeEach, describe, it, expect } from 'vitest';
import { greenhouseAdapter } from '../src/fill-engine/greenhouse-adapter';
import { fillFields } from '../src/fill-engine/fill-engine';
import { DEFAULT_PROFILE } from '../src/storage/profile-schema';

describe('greenhouseAdapter', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches greenhouse.io subdomains', () => {
    expect(greenhouseAdapter.matchesHostname('boards.greenhouse.io')).toBe(true);
    expect(greenhouseAdapter.matchesHostname('job-boards.greenhouse.io')).toBe(true);
  });

  it('does not match unrelated hosts', () => {
    expect(greenhouseAdapter.matchesHostname('example.com')).toBe(false);
  });

  it('leaves Greenhouse React Selects to the dedicated filler and skips optional preferred name', () => {
    document.body.innerHTML = `
      <label for="first_name">First Name</label><input id="first_name" required>
      <label for="preferred_name">Preferred Name</label><input id="preferred_name">
      <label for="degree--0">Degree</label>
      <input id="degree--0" class="select__input" role="combobox" aria-haspopup="true">
    `;

    const fields = greenhouseAdapter.extractFields(document);

    expect(fields.map((field) => field.element.id)).toEqual(['first_name']);
  });

  it('resolves Greenhouse Attach inputs from the surrounding Resume/CV and Cover Letter headings', () => {
    document.body.innerHTML = `
      <section>
        <h3>Resume/CV</h3>
        <div><label for="resume">Attach</label><input id="resume" type="file"></div>
      </section>
      <section>
        <h3>Cover Letter</h3>
        <div><label for="cover_letter">Attach</label><input id="cover_letter" type="file"></div>
      </section>
    `;

    const fields = greenhouseAdapter.extractFields(document);

    expect(fields).toEqual([
      expect.objectContaining({ element: document.getElementById('resume'), label: expect.stringMatching(/Resume\/CV/) }),
      expect.objectContaining({ element: document.getElementById('cover_letter'), label: 'Attach' }),
    ]);

    const profile = {
      ...DEFAULT_PROFILE,
      resume: {
        name: 'Allen Ryu CV.pdf',
        type: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,SGVsbG8=',
      },
    };
    expect(fillFields(fields, profile)).toEqual({ filled: 1, flagged: 0 });
    expect((document.getElementById('resume') as HTMLInputElement).files?.[0]?.name).toBe('Allen Ryu CV.pdf');
    expect((document.getElementById('cover_letter') as HTMLInputElement).files).toHaveLength(0);
  });
});
