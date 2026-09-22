import { extractFields } from './generic-adapter';
import { Adapter } from './types';

export const APPLE_DEDICATED_SELECTOR = [
  '[id^="parsedmodal-"]',
  '#profile-field-line2',
  '#profile-preferredname',
  '#apply-skills-typeahead-suggestion-textbox',
  '#attachfile-resume-supportfile',
].join(',');

export function extractAppleFields(root: ParentNode = document) {
  return extractFields(root).filter((field) => !field.element.matches(APPLE_DEDICATED_SELECTOR));
}

export const appleAdapter: Adapter = {
  id: 'apple',
  matchesHostname: (hostname) => hostname === 'jobs.apple.com',
  extractFields: extractAppleFields,
};
