import { extractFields } from './generic-adapter';
import { Adapter } from './types';

export const workdayAdapter: Adapter = {
  id: 'workday',
  // Workday serves the same Candidate Experience application from both hostname families.
  // `myworkdaysite.com` tenants otherwise fall through to the generic adapter and lose every
  // Workday-specific repeatable, composite-date, controlled-text, and questionnaire path.
  matchesHostname: (hostname) => /\.(?:myworkdayjobs|myworkdaysite)\.com$/i.test(hostname),
  extractFields,
};
