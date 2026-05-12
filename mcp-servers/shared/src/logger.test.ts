import { describe, it, expect } from 'vitest';
import { ts } from './logger.js';

describe('ts', () => {
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

  it('emits the UTC `Z` form with millisecond precision', () => {
    const inner = ts().slice(1, -1);
    // `Date.prototype.toISOString()` is always `YYYY-MM-DDTHH:mm:ss.sssZ`.
    expect(inner).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('round-trips: parsing the inner part yields the same ISO string', () => {
    const inner = ts().slice(1, -1);
    expect(new Date(inner).toISOString()).toBe(inner);
  });
});
