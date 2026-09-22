import { FillSummary } from './types';

export function aggregateFrameSummaries(
  results: Array<{ result?: FillSummary | null }>
): FillSummary {
  return results.reduce<FillSummary>((total, entry) => ({
    filled: total.filled + (entry.result?.filled ?? 0),
    flagged: total.flagged + (entry.result?.flagged ?? 0),
  }), { filled: 0, flagged: 0 });
}
