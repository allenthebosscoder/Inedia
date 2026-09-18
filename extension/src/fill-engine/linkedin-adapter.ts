import { extractFields } from './generic-adapter';
import { Adapter } from './types';

const EASY_APPLY_MODAL_SELECTOR = '.jobs-easy-apply-modal';

export const linkedinAdapter: Adapter = {
  id: 'linkedin',
  matchesHostname: (hostname) => /(^|\.)linkedin\.com$/.test(hostname),
  extractFields: (root) => {
    const modal = root.querySelector(EASY_APPLY_MODAL_SELECTOR);
    return extractFields(modal ?? root);
  },
};
