import { afterEach, describe, expect, it, vi } from 'vitest';
import { ts } from './logger.js';

describe('ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a bracketed string', () => {
    const out = ts();
    expect(out.startsWith('[')).toBe(true);
    expect(out.endsWith(']')).toBe(true);
  });

  it('inner part is a parseable ISO timestamp', () => {
    const inner = ts().slice(1, -1);
    const parsed = new Date(inner);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });

  it('emits ISO 8601 with a local offset and millisecond precision', () => {
    const inner = ts().slice(1, -1);
    // `YYYY-MM-DDTHH:mm:ss.sss±HH:MM`, matching Rust SSOT `log_ts::log_timestamp()`.
    expect(inner).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  });

  it('the offset reflects the runtime timezone', () => {
    const inner = ts().slice(1, -1);
    const offset = inner.slice(-6); // `±HH:MM`
    const expectedMin = -new Date().getTimezoneOffset();
    const sign = offset[0] === '-' ? -1 : 1;
    const got = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
    // `+0`/`−0` differ under Object.is; compare via Math.abs + sign.
    expect(Math.abs(got)).toBe(Math.abs(expectedMin));
    if (got !== 0) expect(Math.sign(got)).toBe(Math.sign(expectedMin));
  });

  it.each([
    [-120, '+02:00'], // CEST
    [-330, '+05:30'], // IST
    [240, '-04:00'], // EDT (getTimezoneOffset is minutes *behind* UTC → positive)
    [0, '+00:00'], // UTC renders as +00:00, never `Z`
  ])('renders offset %d → %s', (offsetMin, expected) => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(offsetMin);
    expect(ts().slice(1, -1)).toMatch(new RegExp(`${expected.replace('+', '\\+')}$`));
  });

  it('round-trips: parsing the inner part yields the same instant', () => {
    const inner = ts().slice(1, -1);
    // Re-rendering as UTC and parsing again must point at the same moment.
    expect(new Date(inner).getTime()).toBe(Date.parse(inner));
  });
});
