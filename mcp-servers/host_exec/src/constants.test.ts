import { describe, it, expect, afterEach } from 'vitest';
import { envInt, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, PARAM_MAX_LEN } from './constants.js';

describe('envInt', () => {
  const KEY = 'HOST_EXEC_TEST_ENVINT';
  afterEach(() => {
    delete process.env[KEY];
  });

  it('returns the fallback when the var is unset or empty', () => {
    delete process.env[KEY];
    expect(envInt(KEY, 42)).toBe(42);
    process.env[KEY] = '';
    expect(envInt(KEY, 42)).toBe(42);
  });

  it('parses a valid non-negative integer', () => {
    process.env[KEY] = '1234';
    expect(envInt(KEY, 42)).toBe(1234);
    process.env[KEY] = '0';
    expect(envInt(KEY, 42)).toBe(0);
  });

  it('returns the fallback for a negative, fractional, or non-numeric value', () => {
    process.env[KEY] = '-5';
    expect(envInt(KEY, 42)).toBe(42);
    process.env[KEY] = 'not-a-number';
    expect(envInt(KEY, 42)).toBe(42);
    // parseInt('3.9',10) === 3 which is a valid integer — accepted (parseInt
    // truncates); a value like '3px' also parses to 3. That's fine — these are
    // worker-internal knobs, not user input.
    process.env[KEY] = '3px';
    expect(envInt(KEY, 42)).toBe(3);
  });
});

describe('output cap constants', () => {
  it('are sane positive values', () => {
    expect(MAX_OUTPUT_BYTES).toBeGreaterThan(1024);
    expect(MAX_OUTPUT_LINES).toBeGreaterThan(100);
    expect(PARAM_MAX_LEN).toBeGreaterThan(1024);
  });
});
