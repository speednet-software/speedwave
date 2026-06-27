import { describe, it, expect } from 'vitest';
import { formatTokens, formatUsd } from './format-number';

describe('formatTokens', () => {
  it('adds en-US thousands separators (happy path)', () => {
    expect(formatTokens(1234567)).toBe('1,234,567');
    expect(formatTokens(999)).toBe('999');
  });

  it('handles the zero edge', () => {
    expect(formatTokens(0)).toBe('0');
  });
});

describe('formatUsd', () => {
  it('defaults to 4 decimals', () => {
    expect(formatUsd(0.0185)).toBe('$0.0185');
    expect(formatUsd(0)).toBe('$0.0000');
  });

  it('honours an explicit precision', () => {
    expect(formatUsd(0.018, 3)).toBe('$0.018');
    expect(formatUsd(1.5, 2)).toBe('$1.50');
  });

  it('rounds to the requested precision', () => {
    expect(formatUsd(0.12345, 3)).toBe('$0.123');
  });
});
