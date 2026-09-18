import { describe, expect, it } from 'vitest';
import { appleAdapter, extractAppleFields } from '../src/fill-engine/apple-adapter';

describe('appleAdapter', () => {
  it('matches only Apple Jobs', () => {
    expect(appleAdapter.matchesHostname('jobs.apple.com')).toBe(true);
    expect(appleAdapter.matchesHostname('apple.com')).toBe(false);
    expect(appleAdapter.matchesHostname('jobs.example.com')).toBe(false);
  });

  it('leaves personal controls generic but reserves Apple repeatables and supporting files', () => {
    document.body.innerHTML = `
      <label for="profile-firstname">First Name</label><input id="profile-firstname">
      <label for="profile-field-line2">Address Line 2</label><input id="profile-field-line2">
      <label for="profile-preferredname">Preferred Name</label><input id="profile-preferredname" aria-required="false">
      <label for="parsedmodal-jobtitle-0">Job Title</label><input id="parsedmodal-jobtitle-0">
      <label for="apply-skills-typeahead-suggestion-textbox">Skill</label>
      <input id="apply-skills-typeahead-suggestion-textbox">
      <label for="attachfile-resume-supportfile">Add files</label>
      <input id="attachfile-resume-supportfile" type="file">
    `;

    expect(extractAppleFields(document).map((field) => field.element.id)).toEqual(['profile-firstname']);
  });
});
