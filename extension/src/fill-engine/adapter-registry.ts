import { Adapter } from './types';
import { greenhouseAdapter } from './greenhouse-adapter';
import { leverAdapter } from './lever-adapter';
import { workdayAdapter } from './workday-adapter';
import { linkedinAdapter } from './linkedin-adapter';
import { smartRecruitersAdapter } from './smartrecruiters-adapter';
import { oracleAdapter } from './oracle-adapter';
import { adpAdapter } from './adp-adapter';
import { adpRecruitingAdapter } from './adp-recruiting-adapter';
import { appleAdapter } from './apple-adapter';

export const ADAPTERS: Adapter[] = [appleAdapter, greenhouseAdapter, leverAdapter, workdayAdapter, linkedinAdapter, smartRecruitersAdapter, oracleAdapter, adpAdapter, adpRecruitingAdapter];
