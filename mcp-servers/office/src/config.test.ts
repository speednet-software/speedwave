/**
 * Tests for the config module's `parsePositiveInt` env-var parsing.
 * @module mcp-office/config.test
 */

import { describe, it, expect } from 'vitest';
import { parsePositiveInt } from './config.js';

describe('parsePositiveInt', () => {
  it('returns the fallback when the value is undefined', () => {
    expect(parsePositiveInt(undefined, 99)).toBe(99);
  });
  it('parses a valid positive integer', () => {
    expect(parsePositiveInt('42', 1)).toBe(42);
  });
  it('returns the fallback for zero, negatives, and non-numeric strings', () => {
    expect(parsePositiveInt('0', 7)).toBe(7);
    expect(parsePositiveInt('-3', 7)).toBe(7);
    expect(parsePositiveInt('abc', 7)).toBe(7);
    expect(parsePositiveInt('', 7)).toBe(7);
  });
});
