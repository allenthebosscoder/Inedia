import { pickAdapter } from '../fill-engine/site-detector';
import { ADAPTERS } from '../fill-engine/adapter-registry';
import { FillSummary } from '../fill-engine/types';

export function formatSummary(summary: FillSummary): string {
  if (summary.filled === 0 && summary.flagged === 0) {
    return "0 fields recognized, this site isn't supported yet.";
  }
  const fieldWord = summary.filled === 1 ? 'field' : 'fields';
  const needWord = summary.flagged === 1 ? 'needs' : 'need';
  const base = `Filled ${summary.filled} ${fieldWord}, ${summary.flagged} ${needWord} your input.`;
  // Surfaced directly rather than making the applicant open the diagnostic panel to find out —
  // these are genuine catalogue gaps (no matching entry exists on this tenant), not something a
  // retry would fix, so naming them is more useful than just the flagged count.
  if (!summary.flaggedSkills?.length) return base;
  const skillWord = summary.flaggedSkills.length === 1 ? 'Skill' : 'Skills';
  return `${base} ${skillWord} not found in the catalogue: ${summary.flaggedSkills.join(', ')}.`;
}

export function detectAdapterId(hostname: string): string {
  return pickAdapter(hostname, ADAPTERS).id;
}
