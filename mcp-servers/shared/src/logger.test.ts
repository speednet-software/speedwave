import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeError, ts } from './logger.js';

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
    expect(inner).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  });

  it('the offset reflects the runtime timezone', () => {
    const inner = ts().slice(1, -1);
    const offset = inner.slice(-6);
    const expectedMin = -new Date().getTimezoneOffset();
    const sign = offset[0] === '-' ? -1 : 1;
    const got = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
    expect(Math.abs(got)).toBe(Math.abs(expectedMin));
    if (got !== 0) expect(Math.sign(got)).toBe(Math.sign(expectedMin));
  });

  it.each([
    [-120, '+02:00'],
    [-330, '+05:30'],
    [240, '-04:00'],
    [0, '+00:00'],
  ])('renders offset %d → %s', (offsetMin, expected) => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(offsetMin);
    expect(ts().slice(1, -1)).toMatch(new RegExp(`${expected.replace('+', '\\+')}$`));
  });

  it('round-trips: parsing the inner part yields the same instant', () => {
    const inner = ts().slice(1, -1);
    expect(new Date(inner).getTime()).toBe(Date.parse(inner));
  });
});

describe('describeError', () => {
  const SENTINEL = 'SENTINEL-997-describe';

  it('never carries the message', () => {
    expect(describeError(new Error(SENTINEL))).not.toContain(SENTINEL);
  });

  it('reports a string code and the error name', () => {
    const error = Object.assign(new TypeError(SENTINEL), { code: 'READ_FAILED' });
    expect(describeError(error)).toBe('code=READ_FAILED name=TypeError');
  });

  it('maps a numeric status to an HTTP code', () => {
    const error = Object.assign(new Error(SENTINEL), { status: 404 });
    expect(describeError(error)).toBe('code=HTTP_404 name=Error');
  });

  it('drops a code or name that is not a plain token', () => {
    const error = Object.assign(new Error('x'), { code: `bad ${SENTINEL}`, name: `n ${SENTINEL}` });
    expect(describeError(error)).toBe('code=UNKNOWN');
  });

  it('never carries a thrown string or object', () => {
    expect(describeError(SENTINEL)).toBe('code=UNKNOWN');
    expect(describeError({ message: SENTINEL })).toBe('code=UNKNOWN');
    expect(describeError(null)).toBe('code=UNKNOWN');
  });
});
