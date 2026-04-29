import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { calculateCost, PRICING } from './pricing';
import { _resetUnknownModelWarnings } from './pricing.testing';
import type { TurnUsage } from '../models/chat';

describe('calculateCost', () => {
  beforeEach(() => {
    _resetUnknownModelWarnings();
  });

  it('computes Opus 4.7 cost from input + output tokens (no cache)', () => {
    // 1M in + 1M out @ $15/$75 = $90
    const usage: TurnUsage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    expect(calculateCost('claude-opus-4-7', usage)).toBeCloseTo(90, 6);
  });

  it('computes Sonnet 4.6 cost from input + output tokens (no cache)', () => {
    // 1M in + 1M out @ $3/$15 = $18
    const usage: TurnUsage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    expect(calculateCost('claude-sonnet-4-6', usage)).toBeCloseTo(18, 6);
  });

  it('computes Haiku 4.5 cost from input + output tokens (no cache)', () => {
    // 1M in + 1M out @ $1/$5 = $6
    const usage: TurnUsage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    expect(calculateCost('claude-haiku-4-5', usage)).toBeCloseTo(6, 6);
  });

  it('charges cache-read at cachedInput rate (10% of input)', () => {
    // Opus: 1M cache-read @ $1.5 = $1.5
    // The 1M in the input_tokens count, when >= cache_read, treats the
    // overlap as already-cached (billedInput = max(0, in - cache_read) = 0).
    const usage: TurnUsage = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_tokens: 1_000_000,
      cache_write_tokens: 0,
    };
    expect(calculateCost('claude-opus-4-7', usage)).toBeCloseTo(1.5, 6);
  });

  it('charges cache-write at cacheWrite rate (125% of input)', () => {
    // Opus: 1M cache-write @ $18.75 = $18.75
    const usage: TurnUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 1_000_000,
    };
    expect(calculateCost('claude-opus-4-7', usage)).toBeCloseTo(18.75, 6);
  });

  it('sums all four components for a realistic turn', () => {
    // Opus: input 11_000 (1000 billed after subtracting cache_read) + 10k cache-read +
    //   5k cache-write + 500 output
    //   billedInput = max(0, 11000 - 10000) = 1000
    //   = 1000 * 15 / 1e6 + 10000 * 1.5 / 1e6 + 5000 * 18.75 / 1e6 + 500 * 75 / 1e6
    //   = 0.015 + 0.015 + 0.09375 + 0.0375
    //   = 0.16125
    const usage: TurnUsage = {
      input_tokens: 11_000,
      output_tokens: 500,
      cache_read_tokens: 10_000,
      cache_write_tokens: 5_000,
    };
    expect(calculateCost('claude-opus-4-7', usage)).toBeCloseTo(0.16125, 6);
  });

  it('returns 0 for zero-usage input', () => {
    const usage: TurnUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    expect(calculateCost('claude-opus-4-7', usage)).toBe(0);
  });

  it('clamps negative billed input to 0 when cache-read exceeds reported input', () => {
    // Defensive: cache_read > input_tokens should not produce a negative
    // contribution to billedInput.
    const usage: TurnUsage = {
      input_tokens: 1_000,
      output_tokens: 0,
      cache_read_tokens: 5_000,
      cache_write_tokens: 0,
    };
    // billed = max(0, 1000 - 5000) = 0 → only cache_read cost: 5000 * 1.5 / 1e6 = 0.0075
    expect(calculateCost('claude-opus-4-7', usage)).toBeCloseTo(0.0075, 6);
  });

  it('returns null and logs exactly one warning for an unknown model', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const usage: TurnUsage = {
      input_tokens: 100,
      output_tokens: 100,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    // null lets the renderer hide the cost segment instead of showing $0.000.
    expect(calculateCost('claude-ghost-9-99', usage)).toBeNull();
    // Second call with the same unknown id should NOT log again.
    expect(calculateCost('claude-ghost-9-99', usage)).toBeNull();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('claude-ghost-9-99');
    spy.mockRestore();
  });

  it('logs a fresh warning for a different unknown model', () => {
    // Reset the dedup cache so prior tests don't suppress the new ids.
    _resetUnknownModelWarnings();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const usage: TurnUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    calculateCost('unknown-a', usage);
    calculateCost('unknown-b', usage);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('PRICING table is non-empty and well-formed', () => {
    // Each model must have the four required numeric rates — guards against
    // accidental partial entries during manual price updates.
    for (const [model, rate] of Object.entries(PRICING)) {
      expect(typeof rate.input).toBe('number');
      expect(typeof rate.cachedInput).toBe('number');
      expect(typeof rate.cacheWrite).toBe('number');
      expect(typeof rate.output).toBe('number');
      expect(rate.input).toBeGreaterThan(0);
      expect(rate.output).toBeGreaterThan(0);
      // cachedInput should always be cheaper than input (business invariant)
      expect(rate.cachedInput).toBeLessThan(rate.input);
      // cacheWrite should be higher than input (business invariant)
      expect(rate.cacheWrite).toBeGreaterThan(rate.input);
      expect(model).toMatch(/^claude-/);
    }
    expect(Object.keys(PRICING).length).toBeGreaterThan(0);
  });

  afterEach(() => {
    _resetUnknownModelWarnings();
  });
});
