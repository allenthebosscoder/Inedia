import { extractFields } from './generic-adapter';
import { Adapter } from './types';

export const leverAdapter: Adapter = {
  id: 'lever',
  matchesHostname: (hostname) => /(^|\.)lever\.co$/.test(hostname),
  extractFields,
};
