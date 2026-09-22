import { extractFields } from './generic-adapter';
import { Adapter } from './types';

export const oracleAdapter: Adapter = {
  id: 'oracle',
  matchesHostname: (hostname) => /(^|\.)oraclecloud\.com$/i.test(hostname),
  extractFields,
};
