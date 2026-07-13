import { describe, it, expect } from 'vitest';
import { normalizeNumericId, normalizeNumericIdParams } from './numeric-id.js';

describe('normalizeNumericId', () => {
  it('accepts a positive integer number', () => {
    expect(normalizeNumericId(42, 'number')).toEqual({ ok: true, value: 42 });
  });

  it('accepts a plain digit string', () => {
    expect(normalizeNumericId('42', 'number')).toEqual({ ok: true, value: 42 });
  });

  it('trims surrounding whitespace on a string form', () => {
    expect(normalizeNumericId('  42  ', 'number')).toEqual({ ok: true, value: 42 });
  });

  it('strips an allowed prefix and parses the rest', () => {
    expect(normalizeNumericId('#42', 'number', { prefixes: ['#'] })).toEqual({
      ok: true,
      value: 42,
    });
  });

  it('strips the first matching prefix from a multi-prefix option set', () => {
    expect(normalizeNumericId('!7', 'iid', { prefixes: ['#', '!'] })).toEqual({
      ok: true,
      value: 7,
    });
  });

  it('tolerates whitespace between prefix and digits', () => {
    expect(normalizeNumericId('# 42', 'number', { prefixes: ['#'] })).toEqual({
      ok: true,
      value: 42,
    });
  });

  it('rejects a fractional string with paramName and nextStep', () => {
    const r = normalizeNumericId('4.5', 'number');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.paramName).toBe('number');
      expect(r.error.received).toBe('4.5');
      expect(r.error.nextStep).toContain('number');
    }
  });

  it('rejects a negative string', () => {
    expect(normalizeNumericId('-3', 'number').ok).toBe(false);
  });

  it('rejects a hex string', () => {
    expect(normalizeNumericId('0x2A', 'number').ok).toBe(false);
  });

  it('rejects exponent notation', () => {
    expect(normalizeNumericId('1e3', 'number').ok).toBe(false);
  });

  it('rejects a prefixed value when the prefix is not configured', () => {
    expect(normalizeNumericId('#42', 'number').ok).toBe(false);
  });

  it('rejects zero (number and string)', () => {
    expect(normalizeNumericId(0, 'number').ok).toBe(false);
    expect(normalizeNumericId('0', 'number').ok).toBe(false);
  });

  it('rejects a negative or fractional number', () => {
    expect(normalizeNumericId(-3, 'number').ok).toBe(false);
    expect(normalizeNumericId(4.5, 'number').ok).toBe(false);
  });

  it('rejects a non-finite number', () => {
    expect(normalizeNumericId(NaN, 'number').ok).toBe(false);
    expect(normalizeNumericId(Infinity, 'number').ok).toBe(false);
  });

  it('rejects an empty or whitespace-only string', () => {
    expect(normalizeNumericId('', 'number').ok).toBe(false);
    expect(normalizeNumericId('   ', 'number').ok).toBe(false);
  });

  it('rejects a bare prefix with no digits', () => {
    expect(normalizeNumericId('#', 'number', { prefixes: ['#'] }).ok).toBe(false);
  });

  it('rejects non-number, non-string values', () => {
    expect(normalizeNumericId(null, 'number').ok).toBe(false);
    expect(normalizeNumericId(undefined, 'number').ok).toBe(false);
    expect(normalizeNumericId({ id: 1 }, 'number').ok).toBe(false);
  });

  it('mentions allowed prefixes in the teaching nextStep', () => {
    const r = normalizeNumericId('bad', 'iid', { prefixes: ['#', '!'] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.nextStep).toContain("'#'");
      expect(r.error.nextStep).toContain("'!'");
    }
  });
});

describe('normalizeNumericIdParams', () => {
  it('coerces present numeric-id params to numbers', () => {
    const r = normalizeNumericIdParams({ number: '42', run_id: 7 }, ['number', 'run_id']);
    expect(r).toEqual({ ok: true, value: { number: 42, run_id: 7 } });
  });

  it('leaves the input object untouched (returns a copy)', () => {
    const input = { number: '42' };
    normalizeNumericIdParams(input, ['number']);
    expect(input.number).toBe('42');
  });

  it('skips params that are absent', () => {
    const r = normalizeNumericIdParams({ number: '5' }, ['number', 'run_id', 'artifact_id']);
    expect(r).toEqual({ ok: true, value: { number: 5 } });
  });

  it('skips a param explicitly set to undefined', () => {
    const r = normalizeNumericIdParams({ number: undefined, run_id: '3' }, ['number', 'run_id']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('number' in r.value).toBe(true);
      expect(r.value.number).toBeUndefined();
      expect(r.value.run_id).toBe(3);
    }
  });

  it('returns the first teaching error and stops', () => {
    const r = normalizeNumericIdParams({ number: '4.5', run_id: '2' }, ['number', 'run_id']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.paramName).toBe('number');
  });

  it('applies prefixes to every named param', () => {
    const r = normalizeNumericIdParams({ number: '#9' }, ['number'], { prefixes: ['#'] });
    expect(r).toEqual({ ok: true, value: { number: 9 } });
  });

  it('rejects a present null value', () => {
    const r = normalizeNumericIdParams({ number: null }, ['number']);
    expect(r.ok).toBe(false);
  });
});
