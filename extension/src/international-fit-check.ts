import type { InternationalFitCategory, InternationalFitSummary } from './international-fit-types';

const HIGHLIGHT_ATTRIBUTE = 'data-job-autofill-international-fit';
const STYLE_ID = 'job-autofill-international-fit-style';
const WIDGET_HOST_ID = 'job-autofill-control-host';
const MATCH_PATTERN = /\b(?:sponsor(?:s|ed|ing|ship)?|visa(?:s)?|citizen(?:s|ship)?|security\s+clearance|clearance|u\.?\s*s\.?\s*person|itar|export[-\s]control(?:led)?|work\s+authori[sz]ation)\b/gi;

const RESTRICTIVE_PATTERNS = [
  /\b(?:no|not|does\s+not|do\s+not|cannot|can't|unable\s+to|will\s+not|won't)\b.{0,90}\b(?:sponsor|sponsorship|visa)/i,
  /\b(?:sponsor|sponsorship|visa)\b.{0,90}\b(?:not\s+(?:available|provided|offered|eligible)|unavailable|cannot|can't|will\s+not|won't)/i,
  /\b(?:without|require(?:s|d)?\s+no)\b.{0,45}\b(?:current\s+or\s+future\s+)?(?:visa\s+)?sponsorship\b/i,
  /\b(?:must|required\s+to|requires?)\b.{0,70}\b(?:u\.?\s*s\.?\s*)?(?:citizen(?:s|ship)?|security\s+clearance|clearance|u\.?\s*s\.?\s+person)\b/i,
  /\b(?:u\.?\s*s\.?\s*)?(?:citizen(?:s|ship)?|u\.?\s*s\.?\s+person)\b.{0,55}\b(?:required|only|must\s+be\s+(?:held|maintained|obtained))\b/i,
  /(?<!no\s)(?<!no\ssecurity\s)\b(?:security\s+clearance|clearance)\b.{0,55}\b(?:required|must\s+be\s+(?:held|maintained|obtained))\b/i,
  /\b(?:must|only)\b.{0,70}\b(?:authorized|eligible)\b.{0,70}\bwithout\b.{0,35}\bsponsorship\b/i,
];

const SUPPORTIVE_PATTERNS = [
  /\b(?:visa\s+)?sponsorship\b.{0,60}\b(?:is\s+)?(?:available|provided|offered|supported)\b/i,
  /\b(?:will|can|may|do)\s+(?:provide\s+)?(?:visa\s+)?sponsor/i,
  /\bsponsor(?:s|ing)?\b.{0,50}\b(?:qualified|eligible|international|foreign)\b/i,
  /\bopen\s+to\b.{0,40}\binternational\b/i,
  /\b(?:citizen(?:s|ship)?|security\s+clearance|clearance)\b.{0,45}\b(?:is\s+)?not\s+required\b/i,
  /\bno\b.{0,30}\b(?:citizen(?:s|ship)?|security\s+clearance|clearance)\b.{0,25}\b(?:is\s+)?required\b/i,
  /\bno\b.{0,30}\b(?:citizen(?:s|ship)?|security\s+clearance|clearance)\b.{0,25}\brequirement\b/i,
];

function clearInternationalFitHighlights(root: Document = document): number {
  const marks = Array.from(root.querySelectorAll<HTMLElement>(`mark[${HIGHLIGHT_ATTRIBUTE}]`));
  for (const mark of marks) {
    const parent = mark.parentNode;
    mark.replaceWith(root.createTextNode(mark.textContent ?? ''));
    parent?.normalize();
  }
  root.getElementById(STYLE_ID)?.remove();
  return marks.length;
}

function classificationContext(node: Text, matchedText: string): string {
  let element = node.parentElement;
  let best = node.data;
  while (element && element !== document.body) {
    const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > 1600) break;
    if (text.length >= best.length) best = text;
    if (/^(P|LI|DD|DT|TD|TH|BLOCKQUOTE|DIV|SECTION|ARTICLE)$/.test(element.tagName) && text.length > 0) break;
    element = element.parentElement;
  }

  return best;
}

export function classifyInternationalFitText(text: string): InternationalFitCategory {
  if (RESTRICTIVE_PATTERNS.some((pattern) => pattern.test(text))) return 'restrictive';
  if (SUPPORTIVE_PATTERNS.some((pattern) => pattern.test(text))) return 'supportive';
  return 'review';
}

export function isNonDiscriminationCitizenshipMention(matchedText: string, context: string): boolean {
  if (!/^citizen(?:s|ship)?$/i.test(matchedText.trim())) return false;
  const normalized = context.replace(/\s+/g, ' ').toLocaleLowerCase();
  const isEqualOpportunityLanguage = /\b(?:without regard to|regardless of|equal (?:employment )?opportunit(?:y|ies)|non[- ]discrimination|discriminat(?:e|es|ion)|protected by (?:applicable )?law)\b/i.test(normalized);
  if (!isEqualOpportunityLanguage) return false;

  // Citizenship in these boilerplate lists describes protected characteristics, not a hiring
  // restriction. Requiring at least two neighboring protected classes avoids hiding a real
  // citizenship requirement merely because an unrelated EEO sentence shares a large container.
  const protectedClasses = normalized.match(/\b(?:race|color|religion|sex|gender|national origin|ancestry|age|disability|veteran status|marital status|sexual orientation)\b/g) ?? [];
  return new Set(protectedClasses).size >= 2;
}

function shouldScanText(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent || !node.data.trim() || !MATCH_PATTERN.test(node.data)) return false;
  MATCH_PATTERN.lastIndex = 0;
  if (parent.closest(`#${WIDGET_HOST_ID}, mark[${HIGHLIGHT_ATTRIBUTE}], script, style, noscript, textarea, input, select, option`)) return false;
  const style = getComputedStyle(parent);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function addHighlightStyles(root: Document): void {
  const style = root.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    mark[${HIGHLIGHT_ATTRIBUTE}]{border-radius:3px;padding:1px 2px;font:inherit;color:inherit}
    mark[${HIGHLIGHT_ATTRIBUTE}="restrictive"]{background:#ffb8b8;color:#680000;box-shadow:0 0 0 1px #d1242f}
    mark[${HIGHLIGHT_ATTRIBUTE}="supportive"]{background:#b9efc5;color:#083d18;box-shadow:0 0 0 1px #1a7f37}
    mark[${HIGHLIGHT_ATTRIBUTE}="review"]{background:#ffe68a;color:#4d3900;box-shadow:0 0 0 1px #bf8700}
    mark[${HIGHLIGHT_ATTRIBUTE}][data-job-autofill-first="true"]{outline:3px solid #0969da;outline-offset:2px}
  `;
  (root.head ?? root.documentElement).appendChild(style);
}

export function checkInternationalFit(options: { clear?: boolean } = {}): InternationalFitSummary {
  const removed = clearInternationalFitHighlights();
  if (options.clear) {
    return { restrictive: 0, supportive: 0, review: 0, total: 0, cleared: removed > 0 };
  }

  const summary: InternationalFitSummary = { restrictive: 0, supportive: 0, review: 0, total: 0 };
  if (!document.body) return summary;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => shouldScanText(node as Text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const nodes: Text[] = [];
  while (walker.nextNode() && nodes.length < 1000) nodes.push(walker.currentNode as Text);
  if (!nodes.length) return summary;

  addHighlightStyles(document);
  const firstByCategory: Partial<Record<InternationalFitCategory, HTMLElement>> = {};
  for (const node of nodes) {
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    MATCH_PATTERN.lastIndex = 0;
    for (const match of node.data.matchAll(MATCH_PATTERN)) {
      if (typeof match.index !== 'number') continue;
      fragment.append(document.createTextNode(node.data.slice(cursor, match.index)));
      const context = classificationContext(node, match[0]);
      if (isNonDiscriminationCitizenshipMention(match[0], context)) {
        fragment.append(document.createTextNode(match[0]));
        cursor = match.index + match[0].length;
        continue;
      }
      const category = classifyInternationalFitText(context);
      const mark = document.createElement('mark');
      mark.setAttribute(HIGHLIGHT_ATTRIBUTE, category);
      mark.title = category === 'restrictive'
        ? 'Likely restriction for international applicants'
        : category === 'supportive'
          ? 'Potentially supportive of international applicants'
          : 'Review this wording for international eligibility';
      mark.textContent = match[0];
      fragment.append(mark);
      firstByCategory[category] ??= mark;
      summary[category] += 1;
      summary.total += 1;
      cursor = match.index + match[0].length;
    }
    fragment.append(document.createTextNode(node.data.slice(cursor)));
    node.replaceWith(fragment);
  }

  const first = firstByCategory.restrictive ?? firstByCategory.supportive ?? firstByCategory.review;
  if (first) {
    first.dataset.jobAutofillFirst = 'true';
    first.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  } else {
    document.getElementById(STYLE_ID)?.remove();
  }
  return summary;
}

declare global {
  interface Window {
    __jobAutofillCheckInternationalFit?: (options?: { clear?: boolean }) => InternationalFitSummary;
  }
}

window.__jobAutofillCheckInternationalFit = checkInternationalFit;
