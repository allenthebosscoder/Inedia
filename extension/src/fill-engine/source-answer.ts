export const COMPANY_WEBSITE_SOURCE = 'Company Website';

function normalizeSource(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isSourceQuestion(label: string): boolean {
  const normalized = normalizeSource(label);
  return (
    /\bhow did you (?:first )?(?:hear|learn|find|discover|see)\b/.test(normalized) ||
    /\bwhere did you (?:first )?(?:hear|learn|find|discover|see)\b/.test(normalized) ||
    /\bhow (?:did you|were you|have you) (?:become aware|hear|learn|find|discover|referred)\b/.test(normalized) ||
    /\b(?:application|applicant|recruitment|candidate|referral) source\b/.test(normalized) ||
    /\bsource (?:of|for) (?:application|applicant|recruitment|referral)\b/.test(normalized) ||
    normalized === 'source'
  );
}

export function findCompanyWebsiteSourceIndex(labels: string[]): number | null {
  const normalized = labels.map(normalizeSource);
  const exactPreference = [
    'company website',
    'company careers website',
    'company career site',
    'company careers site',
    'careers website',
    'career website',
    'corporate website',
    'employer website',
    'employer career site',
    'employer careers site',
    'our website',
    'our careers site',
    'career site',
    'careers site',
    'company career portal',
    'company careers portal',
    'company careers page',
    'careers page',
  ];
  for (const preferred of exactPreference) {
    const index = normalized.indexOf(preferred);
    if (index !== -1) return index;
  }

  const excluded = /\b(?:career builder|career fair|conference|event|job board|linkedin|indeed|glassdoor|monster|dice|recruiter|agency|facebook|google jobs)\b/;
  const descriptive = normalized.findIndex((label) =>
    !excluded.test(label) &&
    (
      /\b(?:company|corporate|employer)\b.*\b(?:website|career(?:s)? (?:site|page|portal))\b/.test(label) ||
      /\b(?:website|career(?:s)? (?:site|page|portal))\b.*\b(?:company|corporate|employer)\b/.test(label) ||
      /\bcareers$/.test(label)
    )
  );
  return descriptive === -1 ? null : descriptive;
}
