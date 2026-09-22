export interface BrowserFrame {
  frameId: number;
  url: string;
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Return only frames that can contain the application form. Injecting into every frame is brittle:
 * advertising, chat, captcha, and sandboxed frames can reject script injection and abort a whole
 * `allFrames` request before the actual ATS form is reached.
 */
export function selectAutofillFrameIds(frames: BrowserFrame[], topHostname: string): number[] {
  return frames
    .filter((frame) => {
      if (frame.frameId === 0) return true;
      const hostname = hostnameOf(frame.url);
      if (!hostname) return false;
      // Same-host application frames, plus known ATS products that render their form in a
      // cross-origin iframe embedded on an employer's branded careers domain (Datadog/Greenhouse,
      // many companies/Lever, Workday, etc.).
      return (
        hostname === topHostname ||
        /(^|\.)(icims\.com|greenhouse\.io|lever\.co|myworkdayjobs\.com|ashbyhq\.com|jobvite\.com|smartrecruiters\.com|recruiting\.adp\.com|workable\.com|bamboohr\.com)$/i.test(hostname)
      );
    })
    .map((frame) => frame.frameId);
}
