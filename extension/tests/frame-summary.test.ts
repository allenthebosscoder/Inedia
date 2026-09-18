import { describe, expect, it } from 'vitest';
import { aggregateFrameSummaries } from '../src/fill-engine/frame-summary';

describe('aggregateFrameSummaries', () => {
  it('combines top-document and iframe autofill results', () => {
    expect(aggregateFrameSummaries([
      { result: { filled: 0, flagged: 0 } },
      { result: { filled: 4, flagged: 2 } },
      { result: { filled: 1, flagged: 0 } },
    ])).toEqual({ filled: 5, flagged: 2 });
  });

  it('ignores frames that did not return a summary', () => {
    expect(aggregateFrameSummaries([
      {},
      { result: null },
      { result: { filled: 2, flagged: 1 } },
    ])).toEqual({ filled: 2, flagged: 1 });
  });
});
