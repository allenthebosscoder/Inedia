import { extractFields } from './generic-adapter';
import { GREENHOUSE_REACT_SELECT_SELECTOR } from './greenhouse-fill';
import { Adapter } from './types';

function extractGreenhouseFields(root: ParentNode = document) {
  return extractFields(root).filter((field) =>
    !field.element.matches(GREENHOUSE_REACT_SELECT_SELECTOR) &&
    field.element.id !== 'preferred_name'
  );
}

export const greenhouseAdapter: Adapter = {
  id: 'greenhouse',
  matchesHostname: (hostname) => /(^|\.)greenhouse\.io$/.test(hostname),
  extractFields: extractGreenhouseFields,
};
