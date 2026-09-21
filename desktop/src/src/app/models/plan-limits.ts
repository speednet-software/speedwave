import type { ClaudeExtraUsage, ClaudePlanUsage } from './claude-control';

/** Which plan window a row stands for; `model_scoped` rows carry the model name. */
export type PlanLimitWindowKey =
  'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'model_scoped';

/** One reportable plan usage window: a known utilization (0-100) and a reset time still ahead. */
export interface PlanLimitWindow {
  key: PlanLimitWindowKey;
  model: string | null;
  utilization: number;
  resets_at: number | null;
}

/** The plan usage limits worth showing; absent (`null`) whenever Claude Code reports none. */
export interface PlanLimits {
  subscription_type: string | null;
  windows: PlanLimitWindow[];
  extra_usage: ClaudeExtraUsage | null;
}

/**
 * Epoch milliseconds of an ISO 8601 reset time, or `null` when it cannot be read. Fractional
 * seconds are cut to milliseconds first: the usage endpoint sends microseconds.
 * @param iso - `resets_at` as Claude Code reports it.
 */
export function parseResetTime(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(ms) ? null : ms;
}

const UI_LOCALE = 'en-US';
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * Row label of a plan window: `5-hour limit`, `Weekly · all models`, `Weekly · <model>`.
 * @param window - Window as `planLimitsFrom` reports it.
 */
export function planWindowLabel(window: PlanLimitWindow): string {
  switch (window.key) {
    case 'five_hour':
      return '5-hour limit';
    case 'seven_day':
      return 'Weekly · all models';
    case 'seven_day_opus':
      return 'Weekly · Opus';
    case 'seven_day_sonnet':
      return 'Weekly · Sonnet';
    case 'model_scoped':
      return `Weekly · ${window.model ?? 'model'}`;
  }
}

/**
 * Reset time for a plan window: relative under 24 hours (`Resets in 4 hr 7 min`), weekday plus
 * local time otherwise (`Resets Tue 11:00 PM`); empty when unknown or already past.
 * @param resetsAtMs - Reset time in epoch milliseconds, or `null` when Claude Code sent none.
 * @param nowMs - Current time in epoch milliseconds.
 * @param viewer - Locale and IANA zone of the weekday form.
 * @param viewer.locale - BCP 47 locale; the app's `en-US` when omitted.
 * @param viewer.timeZone - IANA time zone; the viewer's own when omitted.
 */
export function formatResetTime(
  resetsAtMs: number | null,
  nowMs: number,
  viewer: { locale?: string; timeZone?: string } = {}
): string {
  if (resetsAtMs === null || resetsAtMs <= nowMs) return '';
  const remaining = resetsAtMs - nowMs;
  if (remaining < 24 * HOUR_MS) {
    const hours = Math.floor(remaining / HOUR_MS);
    const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS);
    if (hours === 0 && minutes === 0) return 'Resets in under a minute';
    const parts = [hours > 0 ? `${hours} hr` : '', minutes > 0 ? `${minutes} min` : ''];
    return `Resets in ${parts.filter(Boolean).join(' ')}`;
  }
  const when = new Intl.DateTimeFormat(viewer.locale ?? UI_LOCALE, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: viewer.timeZone,
  }).format(new Date(resetsAtMs));
  return `Resets ${when}`;
}

function windowOf(
  key: PlanLimitWindowKey,
  model: string | null,
  source: { utilization: number | null; resets_at: string | null } | null,
  nowMs: number
): PlanLimitWindow | null {
  const utilization = source?.utilization ?? null;
  if (!source || utilization === null || !Number.isFinite(utilization)) return null;
  const resets_at = parseResetTime(source.resets_at);
  if (resets_at !== null && resets_at <= nowMs) return null;
  return { key, model, utilization, resets_at };
}

/**
 * Reduces a `get_usage` answer to the windows worth showing at `nowMs`: a window without a
 * utilization, or whose reset time has passed, is dropped; nothing left means no limits.
 * @param usage - Typed `get_usage` response, or `null` when the request failed.
 * @param nowMs - Current time in epoch milliseconds.
 */
export function planLimitsFrom(usage: ClaudePlanUsage | null, nowMs: number): PlanLimits | null {
  const limits = usage?.rate_limits_available ? usage.rate_limits : null;
  if (!usage || !limits) return null;

  const windows = [
    windowOf('five_hour', null, limits.five_hour, nowMs),
    windowOf('seven_day', null, limits.seven_day, nowMs),
    windowOf('seven_day_opus', null, limits.seven_day_opus, nowMs),
    windowOf('seven_day_sonnet', null, limits.seven_day_sonnet, nowMs),
    ...limits.model_scoped.map((w) => windowOf('model_scoped', w.display_name, w, nowMs)),
  ].filter((w): w is PlanLimitWindow => w !== null);

  const extra_usage = limits.extra_usage?.is_enabled ? limits.extra_usage : null;
  if (windows.length === 0 && !extra_usage) return null;
  return { subscription_type: usage.subscription_type, windows, extra_usage };
}
