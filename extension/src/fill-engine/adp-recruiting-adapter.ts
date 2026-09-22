import { Adapter } from './types';

// recruiting.adp.com ("Recruiting Management / SRCCAR") is a Dojo/Dijit app. Its widgets keep
// their state in the Dijit registry, so a plain input.value write is reverted. adp-recruiting-fill
// drives them through the Dijit API instead; returning no fields here keeps the generic engine out.
export const adpRecruitingAdapter: Adapter = {
  id: 'adp-recruiting',
  matchesHostname: (hostname) => /(^|\.)recruiting\.adp\.com$/i.test(hostname),
  extractFields: () => [],
};
