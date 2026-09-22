import { extractFields } from './generic-adapter';
import { Adapter } from './types';

function extractAdpFields(root: ParentNode = document) {
  // ADP MDF text controls need a focus/render/input/render/blur sequence and are handled by
  // adp-fill. Keep native selects, radios, checkboxes, and files in the shared engine.
  return extractFields(root).filter((field) => field.kind !== 'text' && field.kind !== 'textarea');
}

export const adpAdapter: Adapter = {
  id: 'adp',
  matchesHostname: (hostname) => /(^|\.)workforcenow\.adp\.com$/i.test(hostname),
  extractFields: extractAdpFields,
};
