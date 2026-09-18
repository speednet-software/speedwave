import { describe, it, expect } from 'vitest';
import { parseResetTime, planLimitsFrom } from './plan-limits';
import type { ClaudePlanUsage, ClaudeRateLimits } from './claude-control';

const NOW = Date.parse('2026-09-18T10:00:00Z');

function limits(overrides: Partial<ClaudeRateLimits> = {}): ClaudeRateLimits {
  return {
    five_hour: { utilization: 15, resets_at: '2026-09-18T12:40:00.744446+00:00' },
    seven_day: { utilization: 70, resets_at: '2026-09-22T21:00:00.744471+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: null,
    model_scoped: [
      { display_name: 'Fable', utilization: 67, resets_at: '2026-09-22T21:00:00.744723+00:00' },
    ],
    extra_usage: {
      is_enabled: false,
      monthly_limit: null,
      used_credits: null,
      utilization: null,
      currency: null,
    },
    ...overrides,
  };
}

function usage(overrides: Partial<ClaudePlanUsage> = {}): ClaudePlanUsage {
  return {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: limits(),
    ...overrides,
  };
}

describe('parseResetTime', () => {
  it('reads the microsecond timestamps the usage endpoint sends', () => {
    expect(parseResetTime('2026-09-18T12:40:00.744446+00:00')).toBe(
      Date.parse('2026-09-18T12:40:00.744Z')
    );
  });

  it('reads a timestamp without fractional seconds', () => {
    expect(parseResetTime('2026-09-22T21:00:00+00:00')).toBe(Date.parse('2026-09-22T21:00:00Z'));
  });

  it('returns null for a missing or unreadable value', () => {
    expect(parseResetTime(null)).toBeNull();
    expect(parseResetTime('')).toBeNull();
    expect(parseResetTime('soon')).toBeNull();
  });
});

describe('planLimitsFrom', () => {
  it('reports the captured Max account windows in display order', () => {
    const result = planLimitsFrom(usage(), NOW);

    expect(result?.subscription_type).toBe('max');
    expect(result?.windows.map((w) => [w.key, w.model, w.utilization])).toEqual([
      ['five_hour', null, 15],
      ['seven_day', null, 70],
      ['model_scoped', 'Fable', 67],
    ]);
    expect(result?.windows[0].resets_at).toBe(Date.parse('2026-09-18T12:40:00.744Z'));
    expect(result?.extra_usage).toBeNull();
  });

  it('is absent when the request failed', () => {
    expect(planLimitsFrom(null, NOW)).toBeNull();
  });

  it('is absent for an API-key session: no plan limits apply', () => {
    expect(
      planLimitsFrom(
        usage({ subscription_type: null, rate_limits_available: false, rate_limits: null }),
        NOW
      )
    ).toBeNull();
  });

  it('is absent when limits are flagged unavailable even if a payload came along', () => {
    expect(planLimitsFrom(usage({ rate_limits_available: false }), NOW)).toBeNull();
  });

  it('drops a window whose reset time has passed', () => {
    const afterFiveHourReset = Date.parse('2026-09-18T13:00:00Z');

    const result = planLimitsFrom(usage(), afterFiveHourReset);

    expect(result?.windows.map((w) => w.key)).toEqual(['seven_day', 'model_scoped']);
  });

  it('drops a window at the very instant it resets', () => {
    const atReset = Date.parse('2026-09-18T12:40:00.744Z');

    expect(planLimitsFrom(usage(), atReset)?.windows.map((w) => w.key)).not.toContain('five_hour');
  });

  it('never reports a window without a utilization', () => {
    const result = planLimitsFrom(
      usage({
        rate_limits: limits({
          five_hour: { utilization: null, resets_at: '2026-09-18T12:40:00+00:00' },
          model_scoped: [{ display_name: 'Opus', utilization: null, resets_at: null }],
        }),
      }),
      NOW
    );

    expect(result?.windows.map((w) => w.key)).toEqual(['seven_day']);
  });

  it('keeps a window whose reset time is missing or unreadable, without a reset time', () => {
    const result = planLimitsFrom(
      usage({
        rate_limits: limits({
          five_hour: { utilization: 40, resets_at: null },
          seven_day: { utilization: 5, resets_at: 'not a date' },
          model_scoped: [],
        }),
      }),
      NOW
    );

    expect(result?.windows).toEqual([
      { key: 'five_hour', model: null, utilization: 40, resets_at: null },
      { key: 'seven_day', model: null, utilization: 5, resets_at: null },
    ]);
  });

  it('reports a zero utilization: zero is data, not absence', () => {
    const result = planLimitsFrom(
      usage({
        rate_limits: limits({ five_hour: { utilization: 0, resets_at: null }, model_scoped: [] }),
      }),
      NOW
    );

    expect(result?.windows[0]).toMatchObject({ key: 'five_hour', utilization: 0 });
  });

  it('reports the per-model weekly windows Claude Code still types', () => {
    const result = planLimitsFrom(
      usage({
        rate_limits: limits({
          seven_day_opus: { utilization: 12, resets_at: null },
          seven_day_sonnet: { utilization: 3, resets_at: null },
        }),
      }),
      NOW
    );

    expect(result?.windows.map((w) => w.key)).toEqual([
      'five_hour',
      'seven_day',
      'seven_day_opus',
      'seven_day_sonnet',
      'model_scoped',
    ]);
  });

  it('carries extra usage only when it is enabled', () => {
    const enabled = {
      is_enabled: true,
      monthly_limit: 5000,
      used_credits: 1250,
      utilization: 25,
      currency: 'USD',
    };

    expect(
      planLimitsFrom(usage({ rate_limits: limits({ extra_usage: enabled }) }), NOW)
    ).toMatchObject({ extra_usage: enabled });
  });

  it('is absent when every window has expired and extra usage is off', () => {
    const nextMonth = Date.parse('2026-10-18T00:00:00Z');

    expect(planLimitsFrom(usage(), nextMonth)).toBeNull();
  });

  it('still reports enabled extra usage when every window has expired', () => {
    const nextMonth = Date.parse('2026-10-18T00:00:00Z');
    const enabled = {
      is_enabled: true,
      monthly_limit: null,
      used_credits: null,
      utilization: null,
      currency: null,
    };

    const result = planLimitsFrom(
      usage({ rate_limits: limits({ extra_usage: enabled }) }),
      nextMonth
    );

    expect(result).toEqual({ subscription_type: 'max', windows: [], extra_usage: enabled });
  });
});
