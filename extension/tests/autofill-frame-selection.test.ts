import { describe, expect, it } from 'vitest';
import { selectAutofillFrameIds } from '../src/autofill-frame-selection';

describe('selectAutofillFrameIds', () => {
  it('keeps the top document and the iCIMS form while excluding unrelated embeds', () => {
    expect(selectAutofillFrameIds([
      { frameId: 0, url: 'https://careers.example.com/job/42' },
      { frameId: 1, url: 'https://tenant.icims.com/jobs/42/candidate?in_iframe=1' },
      { frameId: 2, url: 'https://assets.textrecruit.com/chat' },
      { frameId: 3, url: 'about:blank' },
      { frameId: 4, url: 'https://ads.example.net/pixel' },
    ], 'careers.example.com')).toEqual([0, 1]);
  });

  it('keeps a cross-origin recruiting.adp.com form iframe on a branded careers domain', () => {
    expect(selectAutofillFrameIds([
      { frameId: 0, url: 'https://careers.holdenindustries.com/jobs' },
      { frameId: 1, url: 'https://recruiting.adp.com/srccar/public/nghome.guid?ncsp=holdenincjobs' },
      { frameId: 2, url: 'https://ads.example.net/pixel' },
    ], 'careers.holdenindustries.com')).toEqual([0, 1]);
  });

  it('keeps a cross-origin Greenhouse job-board iframe embedded on a company careers domain', () => {
    expect(selectAutofillFrameIds([
      { frameId: 0, url: 'https://careers.datadoghq.com/detail/123/' },
      { frameId: 1, url: 'https://job-boards.greenhouse.io/embed/job_app?token=456&for=datadog' },
      { frameId: 2, url: 'https://www.googletagmanager.com/ns.html' },
    ], 'careers.datadoghq.com')).toEqual([0, 1]);
  });

  it('keeps same-host nested application frames', () => {
    expect(selectAutofillFrameIds([
      { frameId: 0, url: 'https://jobs.example.com/apply' },
      { frameId: 9, url: 'https://jobs.example.com/application/form' },
    ], 'jobs.example.com')).toEqual([0, 9]);
  });

  it('keeps the top frame even when its URL is temporarily unavailable', () => {
    expect(selectAutofillFrameIds([
      { frameId: 0, url: '' },
      { frameId: 2, url: 'https://tracking.example.net/pixel' },
    ], 'jobs.example.com')).toEqual([0]);
  });
});
