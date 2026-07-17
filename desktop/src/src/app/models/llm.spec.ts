import { describe, it, expect } from 'vitest';
import { isAnthropicKind, isTerminalCostSource, type CostSourceKind } from './llm';

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

describe('isAnthropicKind', () => {
  it('is true for anthropic_oauth', () => {
    expect(isAnthropicKind('anthropic_oauth')).toBe(true);
  });

  it('is true for anthropic_api_key', () => {
    expect(isAnthropicKind('anthropic_api_key')).toBe(true);
  });

  it('is false for local', () => {
    expect(isAnthropicKind('local')).toBe(false);
  });

  it('is false for open_router', () => {
    expect(isAnthropicKind('open_router')).toBe(false);
  });
});
