import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateCost,
  setPricingCatalog,
  _resetPricingToSeedForTest,
  _pricingEntryCountForTest,
  _SEED_PRICING_FOR_TEST,
  type PricedAnthropicModel,
} from './pricing';
import { _resetUnknownModelWarnings } from './pricing.testing';
import type { TurnUsage } from '../models/chat';

/**
 * Stand-in for the `list_anthropic_models` payload (the Rust SSOT
 * `AnthropicModelInfo` serialized). Mirrors the ids, contexts, and rates in
 * `defaults.rs::ANTHROPIC_MODELS` so the parity assertion is meaningful — bump
 * this together with the catalog when a model is added.
 */
const CATALOG: PricedAnthropicModel[] = [
  {
    id: 'claude-opus-4-8',
    context_tokens: 1_000_000,
    pricing: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
    pricing_1m: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  },
  {
    id: 'claude-sonnet-4-6',
    context_tokens: 1_000_000,
    pricing: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
    pricing_1m: { input: 6, cachedInput: 0.6, cacheWrite: 7.5, output: 22.5 },
  },
  {
    id: 'claude-haiku-4-5',
    context_tokens: 200_000,
    pricing: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 },
    pricing_1m: null,
  },
  {
    id: 'claude-opus-4-7',
    context_tokens: 1_000_000,
    pricing: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
    pricing_1m: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  },
  {
    id: 'claude-opus-4-6',
    context_tokens: 1_000_000,
    pricing: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
    pricing_1m: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  },
];

/**
 * Counts how many `plugin:log|log` warn-level (level 4) calls the stubbed
 * tauri invoke received. `pluginLogWarn` (used by pricing for unknown-model
 * warnings) forwards to `invoke('plugin:log|log', { message, level: 4 })`, the
 * same pipeline LoggerService uses; we assert on it rather than the raw console.
 * @param invokeSpy - The stubbed `__TAURI_INTERNALS__.invoke` spy.
 */
function logWarnCalls(invokeSpy: ReturnType<typeof vi.fn>): unknown[][] {
  return invokeSpy.mock.calls.filter(
    ([cmd, args]) =>
      cmd === 'plugin:log|log' && (args as { level?: number } | undefined)?.level === 4
  );
}

describe('calculateCost', () => {
  let invokeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetUnknownModelWarnings();
    _resetPricingToSeedForTest();
    invokeSpy = vi.fn().mockResolvedValue(undefined);
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {
      invoke: invokeSpy,
      transformCallback: vi.fn().mockReturnValue(1),
    };
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  });

  it('computes Opus 4.8 cost from input + output tokens (no cache)', () => {
    // 1M in + 1M out @ $5/$25 = $30
    const usage: TurnUsage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    expect(calculateCost('claude-opus-4-8', usage)).toBeCloseTo(30, 6);
  });

  it('computes Opus 4.7 cost from input + output tokens (no cache)', () => {
    // 1M in + 1M out @ $5/$25 = $30
    const usage: TurnUsage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    expect(calculateCost('claude-opus-4-7', usage)).toBeCloseTo(30, 6);
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

  it('prices the [1m] variant at the 1M-context rate for Sonnet', () => {
    // Sonnet's 1M window is a premium ($6/$22.5), distinct from the base rate.
    // 1M in + 1M out @ $6/$22.5 = $28.5
    const usage: TurnUsage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    expect(calculateCost('claude-sonnet-4-6[1m]', usage)).toBeCloseTo(28.5, 6);
  });

  it('prices the [1m] Opus variant at the base rate (1M is standard-priced)', () => {
    const usage: TurnUsage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    expect(calculateCost('claude-opus-4-8[1m]', usage)).toBeCloseTo(30, 6);
  });

  it('resolves a dated snapshot id to its stable alias rate', () => {
    // Saved sessions can carry the dated form; normalize to the alias.
    const usage: TurnUsage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    expect(calculateCost('claude-opus-4-7-20260501', usage)).toBeCloseTo(30, 6);
  });

  it('resolves the short alias Claude Code emits in session metadata', () => {
    // `opus-4.7` → `claude-opus-4-7`.
    const usage: TurnUsage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    expect(calculateCost('opus-4.7', usage)).toBeCloseTo(30, 6);
  });

  it('charges cache-read at cachedInput rate (10% of input)', () => {
    // Opus: 1M cache-read @ $0.5 = $0.5
    // The 1M in the input_tokens count, when >= cache_read, treats the
    // overlap as already-cached (billedInput = max(0, in - cache_read) = 0).
    const usage: TurnUsage = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_tokens: 1_000_000,
      cache_write_tokens: 0,
    };
    expect(calculateCost('claude-opus-4-7', usage)).toBeCloseTo(0.5, 6);
  });

  it('charges cache-write at cacheWrite rate (125% of input)', () => {
    // Opus: 1M cache-write @ $6.25 = $6.25
    const usage: TurnUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 1_000_000,
    };
    expect(calculateCost('claude-opus-4-7', usage)).toBeCloseTo(6.25, 6);
  });

  it('sums all four components for a realistic turn', () => {
    // Opus: input 11_000 (1000 billed after subtracting cache_read) + 10k cache-read +
    //   5k cache-write + 500 output
    //   billedInput = max(0, 11000 - 10000) = 1000
    //   = 1000 * 5 / 1e6 + 10000 * 0.5 / 1e6 + 5000 * 6.25 / 1e6 + 500 * 25 / 1e6
    //   = 0.005 + 0.005 + 0.03125 + 0.0125
    //   = 0.05375
    const usage: TurnUsage = {
      input_tokens: 11_000,
      output_tokens: 500,
      cache_read_tokens: 10_000,
      cache_write_tokens: 5_000,
    };
    expect(calculateCost('claude-opus-4-7', usage)).toBeCloseTo(0.05375, 6);
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
    // billed = max(0, 1000 - 5000) = 0 → only cache_read cost: 5000 * 0.5 / 1e6 = 0.0025
    expect(calculateCost('claude-opus-4-7', usage)).toBeCloseTo(0.0025, 6);
  });

  it('returns null and logs exactly one warning for an unknown model', async () => {
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

    // Let the plugin-log invoke microtask settle before asserting.
    await Promise.resolve();
    await Promise.resolve();

    const warnings = logWarnCalls(invokeSpy);
    expect(warnings).toHaveLength(1);
    expect((warnings[0][1] as { message: string }).message).toContain('claude-ghost-9-99');
  });

  it('logs a fresh warning for a different unknown model', async () => {
    // Reset the dedup cache so prior tests don't suppress the new ids.
    _resetUnknownModelWarnings();
    const usage: TurnUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    calculateCost('unknown-a', usage);
    calculateCost('unknown-b', usage);

    await Promise.resolve();
    await Promise.resolve();

    expect(logWarnCalls(invokeSpy)).toHaveLength(2);
  });

  afterEach(() => {
    _resetUnknownModelWarnings();
    _resetPricingToSeedForTest();
  });
});

describe('setPricingCatalog (Rust SSOT override)', () => {
  afterEach(() => {
    _resetPricingToSeedForTest();
  });

  it('replaces the seed with the backend catalog rates', () => {
    setPricingCatalog([
      {
        id: 'claude-opus-4-8',
        context_tokens: 1_000_000,
        // Deliberately different from the seed to prove the override takes effect.
        pricing: { input: 7, cachedInput: 0.7, cacheWrite: 8.75, output: 35 },
        pricing_1m: { input: 7, cachedInput: 0.7, cacheWrite: 8.75, output: 35 },
      },
    ]);
    const usage: TurnUsage = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    expect(calculateCost('claude-opus-4-8', usage)).toBeCloseTo(7, 6);
  });

  it('clears stale ids when reseeded with a smaller catalog', () => {
    setPricingCatalog([CATALOG[2]]); // haiku only, no [1m]
    expect(_pricingEntryCountForTest()).toBe(1);
  });

  it('skips entries with a missing/malformed pricing block', () => {
    setPricingCatalog([
      { id: 'bad', context_tokens: 1_000_000 } as unknown as PricedAnthropicModel,
      CATALOG[2],
    ]);
    // Only the well-formed haiku entry survives.
    expect(_pricingEntryCountForTest()).toBe(1);
  });

  it('parity: the bootstrap seed prices every catalog id (and [1m] for 1M families)', () => {
    // Guards drift: a model bump in defaults.rs (mirrored into CATALOG) must
    // have a matching seed entry so the pre-load cost meter never shows a
    // price-less turn. The Rust side enforces pricing completeness; this side
    // enforces the seed covers the catalog.
    for (const m of CATALOG) {
      expect(_SEED_PRICING_FOR_TEST[m.id]).toBeDefined();
      if (m.context_tokens >= 1_000_000) {
        expect(_SEED_PRICING_FOR_TEST[`${m.id}[1m]`]).toBeDefined();
      } else {
        expect(m.pricing_1m == null).toBe(true);
        expect(_SEED_PRICING_FOR_TEST[`${m.id}[1m]`]).toBeUndefined();
      }
    }
  });

  it('parity: seed rates match the catalog rates for every id', () => {
    // Catch a value drift between the TS bootstrap seed and the Rust SSOT
    // numbers (mirrored into CATALOG).
    for (const m of CATALOG) {
      expect(_SEED_PRICING_FOR_TEST[m.id]).toEqual(m.pricing);
      if (m.context_tokens >= 1_000_000 && m.pricing_1m) {
        expect(_SEED_PRICING_FOR_TEST[`${m.id}[1m]`]).toEqual(m.pricing_1m);
      }
    }
  });

  it('seed entries are well-formed (cache-read < input < cache-write)', () => {
    // Business invariants mirrored from the Rust SSOT test
    // (`defaults.rs::every_model_has_well_formed_pricing`).
    for (const rate of Object.values(_SEED_PRICING_FOR_TEST)) {
      expect(rate.input).toBeGreaterThan(0);
      expect(rate.output).toBeGreaterThan(0);
      expect(rate.cachedInput).toBeLessThan(rate.input);
      expect(rate.cacheWrite).toBeGreaterThan(rate.input);
    }
  });
});
