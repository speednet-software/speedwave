import { describe, it, expect } from 'vitest';
import { isTerminalCostSource, type CostSourceKind } from './llm';

describe('isTerminalCostSource', () => {
  it('treats deferred and the empty sentinel as non-terminal', () => {
    expect(isTerminalCostSource('deferred')).toBe(false);
    expect(isTerminalCostSource('')).toBe(false);
  });

  it('treats every priced/unpriced source as terminal', () => {
    const terminal: CostSourceKind[] = [
      'catalog',
      'subscription',
      'free',
      'actual',
      'unknown',
      'failed',
    ];
    for (const src of terminal) {
      expect(isTerminalCostSource(src)).toBe(true);
    }
  });
});
