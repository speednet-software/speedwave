/**
 * Validation Helpers Tests
 */

import { describe, it, expect } from 'vitest';
import {
  withValidation,
  requireFields,
  isValidISO8601,
  validateStringFields,
  validateNumberFields,
  validateBooleanFields,
  validateAll,
  validateDateFields,
  asRecord,
  MAX_LENGTHS,
} from './validation.js';
import type { ToolResult } from './validation.js';

describe('validation', () => {
  describe('withValidation', () => {
    it('wraps successful result in MCP format', async () => {
      const handler = async (_params: { name: string }): Promise<ToolResult> => ({
        success: true,
        data: { id: '123' },
      });

      const wrapped = withValidation(handler);
      const result = await wrapped({ name: 'test' });

      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('"id": "123"');
      expect(result.isError).toBeUndefined();
    });

    it('wraps error result in MCP format', async () => {
      const handler = async (_params: Record<string, unknown>): Promise<ToolResult> => ({
        success: false,
        error: { code: 'TEST_ERROR', message: 'Something went wrong' },
      });

      const wrapped = withValidation(handler);
      const result = await wrapped({});

      expect(result.content[0].text).toContain('TEST_ERROR');
      expect(result.isError).toBe(true);
    });

    it('catches thrown errors', async () => {
      const handler = async (): Promise<ToolResult> => {
        throw new Error('Unexpected failure');
      };

      const wrapped = withValidation(handler);
      const result = await wrapped({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('HANDLER_ERROR');
      expect(result.content[0].text).toContain('Unexpected failure');
    });

    it('rejects null params', async () => {
      const handler = async (): Promise<ToolResult> => ({ success: true, data: {} });
      const wrapped = withValidation(handler);

      const result = await wrapped(null as any);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('INVALID_INPUT');
    });

    it('rejects array params', async () => {
      const handler = async (): Promise<ToolResult> => ({ success: true, data: {} });
      const wrapped = withValidation(handler);

      const result = await wrapped([] as any);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('INVALID_INPUT');
    });

    it('handles non-Error thrown values', async () => {
      const handler = async (): Promise<ToolResult> => {
        throw 'string error';
      };

      const wrapped = withValidation(handler);
      const result = await wrapped({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('string error');
    });
  });

  describe('requireFields', () => {
    it('returns valid for present fields', () => {
      const result = requireFields({ name: 'test', id: 'abc' }, ['name', 'id']);
      expect(result.valid).toBe(true);
    });

    it('returns error for missing fields', () => {
      const result = requireFields({ name: 'test' }, ['name', 'id']);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.error?.message).toContain('id');
      }
    });

    it('returns EMPTY_FIELDS error for empty string fields', () => {
      const result = requireFields({ name: '' }, ['name']);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.error?.code).toBe('EMPTY_FIELDS');
        expect(result.error.error?.message).toContain('name');
      }
    });

    it('returns EMPTY_FIELDS error for whitespace-only string fields', () => {
      const result = requireFields({ name: '   ' }, ['name']);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.error?.code).toBe('EMPTY_FIELDS');
      }
    });

    it('distinguishes missing from empty fields', () => {
      const missing = requireFields({}, ['name']);
      expect(missing.valid).toBe(false);
      if (!missing.valid) {
        expect(missing.error.error?.code).toBe('MISSING_FIELDS');
      }

      const empty = requireFields({ name: '' }, ['name']);
      expect(empty.valid).toBe(false);
      if (!empty.valid) {
        expect(empty.error.error?.code).toBe('EMPTY_FIELDS');
      }
    });

    it('returns error for non-string fields', () => {
      const result = requireFields({ name: 123 }, ['name']);
      expect(result.valid).toBe(false);
    });

    it('returns valid for empty required list', () => {
      const result = requireFields({}, []);
      expect(result.valid).toBe(true);
    });

    it('lists all missing fields in error message', () => {
      const result = requireFields({}, ['a', 'b', 'c']);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.error?.message).toContain('a');
        expect(result.error.error?.message).toContain('b');
        expect(result.error.error?.message).toContain('c');
      }
    });
  });

  describe('isValidISO8601', () => {
    it('accepts valid ISO8601 dates', () => {
      expect(isValidISO8601('2026-02-20T10:00:00Z')).toBe(true);
      expect(isValidISO8601('2026-02-20T10:00:00+01:00')).toBe(true);
      expect(isValidISO8601('2026-02-20')).toBe(true);
      expect(isValidISO8601('2026-02-20T10:00:00.000Z')).toBe(true);
    });

    it('rejects invalid dates', () => {
      expect(isValidISO8601('not-a-date')).toBe(false);
      expect(isValidISO8601('')).toBe(false);
      expect(isValidISO8601('abc123')).toBe(false);
    });

    it('rejects non-ISO date formats that Date() would accept', () => {
      expect(isValidISO8601('Feb 20, 2026')).toBe(false);
      expect(isValidISO8601('2026/02/20')).toBe(false);
      expect(isValidISO8601('1708387200000')).toBe(false);
      expect(isValidISO8601('20 Feb 2026')).toBe(false);
    });

    it('rejects out-of-range time components', () => {
      expect(isValidISO8601('2026-02-20T25:00:00Z')).toBe(false);
      expect(isValidISO8601('2026-02-20T10:60:00Z')).toBe(false);
      expect(isValidISO8601('2026-02-20T10:00:60Z')).toBe(false);
      expect(isValidISO8601('2026-02-20T24:00:00Z')).toBe(false);
      expect(isValidISO8601('2026-02-20T99:99:99Z')).toBe(false);
    });

    it('rejects dates with trailing garbage', () => {
      expect(isValidISO8601('2026-02-20T10:00:00Z; DROP TABLE')).toBe(false);
      expect(isValidISO8601('2026-02-20 extra')).toBe(false);
    });

    it('rejects rollover dates (Feb 30 silently becomes Mar 2)', () => {
      expect(isValidISO8601('2026-02-30')).toBe(false);
      expect(isValidISO8601('2026-04-31')).toBe(false);
    });

    it('rejects invalid month (00 and 13)', () => {
      expect(isValidISO8601('2026-00-01')).toBe(false);
      expect(isValidISO8601('2026-13-01')).toBe(false);
    });

    it('rejects invalid day (00 and 32)', () => {
      expect(isValidISO8601('2026-01-00')).toBe(false);
      expect(isValidISO8601('2026-01-32')).toBe(false);
    });

    it('rejects Feb 29 in non-leap years', () => {
      expect(isValidISO8601('2026-02-29')).toBe(false);
      expect(isValidISO8601('2025-02-29')).toBe(false);
    });

    it('accepts Feb 29 in leap years', () => {
      expect(isValidISO8601('2024-02-29')).toBe(true);
      expect(isValidISO8601('2000-02-29')).toBe(true);
    });

    it('rejects non-string values', () => {
      expect(isValidISO8601(123)).toBe(false);
      expect(isValidISO8601(null)).toBe(false);
      expect(isValidISO8601(undefined)).toBe(false);
      expect(isValidISO8601({})).toBe(false);
    });
  });

  describe('validateStringFields', () => {
    it('accepts valid values within limit', () => {
      const result = validateStringFields({ name: 'test' }, [['name', 100, false]]);
      expect(result.valid).toBe(true);
    });

    it('skips undefined (optional fields)', () => {
      const result = validateStringFields({}, [['name', 100, false]]);
      expect(result.valid).toBe(true);
    });

    it('rejects string exceeding max length', () => {
      const result = validateStringFields({ name: 'a'.repeat(101) }, [['name', 100, false]]);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('FIELD_TOO_LONG');
    });

    it('accepts string exactly at max length (boundary)', () => {
      const result = validateStringFields({ name: 'a'.repeat(100) }, [['name', 100, false]]);
      expect(result.valid).toBe(true);
    });

    it('rejects null byte (\\x00)', () => {
      const result = validateStringFields({ name: 'test\x00val' }, [['name', 100, false]]);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('INVALID_CHARACTERS');
    });

    it('rejects bell character (\\x07)', () => {
      const result = validateStringFields({ name: 'test\x07val' }, [['name', 100, false]]);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('INVALID_CHARACTERS');
    });

    it('rejects \\x1f', () => {
      const result = validateStringFields({ name: 'test\x1fval' }, [['name', 100, false]]);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('INVALID_CHARACTERS');
    });

    it('body mode: allows \\n', () => {
      const result = validateStringFields({ body: 'line1\nline2' }, [['body', 1000, true]]);
      expect(result.valid).toBe(true);
    });

    it('body mode: allows \\t', () => {
      const result = validateStringFields({ body: 'col1\tcol2' }, [['body', 1000, true]]);
      expect(result.valid).toBe(true);
    });

    it('body mode: allows \\r', () => {
      const result = validateStringFields({ body: 'line1\r\nline2' }, [['body', 1000, true]]);
      expect(result.valid).toBe(true);
    });

    it('body mode: rejects \\x00', () => {
      const result = validateStringFields({ body: 'test\x00val' }, [['body', 1000, true]]);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('INVALID_CHARACTERS');
    });

    it('body mode: rejects \\x07 (not \\n\\t\\r)', () => {
      const result = validateStringFields({ body: 'test\x07val' }, [['body', 1000, true]]);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('INVALID_CHARACTERS');
    });
  });

  describe('validateNumberFields', () => {
    it('accepts valid value in range', () => {
      const result = validateNumberFields({ limit: 50 }, [['limit', 1, 10000]]);
      expect(result.valid).toBe(true);
    });

    it('skips undefined', () => {
      const result = validateNumberFields({}, [['limit', 1, 10000]]);
      expect(result.valid).toBe(true);
    });

    it('rejects string value', () => {
      const result = validateNumberFields({ limit: '50' }, [['limit', 1, 10000]]);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('INVALID_TYPE');
    });

    it('rejects NaN', () => {
      const result = validateNumberFields({ limit: NaN }, [['limit', 1, 10000]]);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('INVALID_TYPE');
    });

    it('rejects Infinity', () => {
      const result = validateNumberFields({ limit: Infinity }, [['limit', 1, 10000]]);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('INVALID_TYPE');
    });

    it('rejects value below min', () => {
      const result = validateNumberFields({ limit: 0 }, [['limit', 1, 10000]]);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('OUT_OF_RANGE');
    });

    it('rejects value above max', () => {
      const result = validateNumberFields({ limit: 10001 }, [['limit', 1, 10000]]);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('OUT_OF_RANGE');
    });

    it('accepts boundary values (min and max)', () => {
      expect(validateNumberFields({ limit: 1 }, [['limit', 1, 10000]]).valid).toBe(true);
      expect(validateNumberFields({ limit: 10000 }, [['limit', 1, 10000]]).valid).toBe(true);
    });
  });

  describe('validateBooleanFields', () => {
    it('accepts true', () => {
      const result = validateBooleanFields({ flag: true }, ['flag']);
      expect(result.valid).toBe(true);
    });

    it('accepts false', () => {
      const result = validateBooleanFields({ flag: false }, ['flag']);
      expect(result.valid).toBe(true);
    });

    it('skips undefined', () => {
      const result = validateBooleanFields({}, ['flag']);
      expect(result.valid).toBe(true);
    });

    it('rejects string "true"', () => {
      const result = validateBooleanFields({ flag: 'true' }, ['flag']);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('INVALID_TYPE');
    });

    it('rejects 1 and null', () => {
      const r1 = validateBooleanFields({ flag: 1 }, ['flag']);
      expect(r1.valid).toBe(false);
      if (!r1.valid) expect(r1.error.error?.code).toBe('INVALID_TYPE');
      const r2 = validateBooleanFields({ flag: null }, ['flag']);
      expect(r2.valid).toBe(false);
      if (!r2.valid) expect(r2.error.error?.code).toBe('INVALID_TYPE');
    });
  });

  describe('validateAll', () => {
    it('returns valid when no spec keys are provided', () => {
      const result = validateAll({ anything: 'goes' }, {});
      expect(result.valid).toBe(true);
    });

    it('returns valid when all steps pass', () => {
      const result = validateAll(
        { id: 'abc', count: 5, flag: true, name: 'hello' },
        {
          required: ['id'],
          strings: [['name', 100, false]],
          numbers: [['count', 1, 10]],
          booleans: ['flag'],
        }
      );
      expect(result.valid).toBe(true);
    });

    it('fails on missing required field', () => {
      const result = validateAll({}, { required: ['id'] });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('MISSING_FIELDS');
    });

    it('fails on invalid boolean before reaching string check', () => {
      const result = validateAll(
        { id: 'abc', flag: 'yes', name: 'x'.repeat(200) },
        {
          required: ['id'],
          booleans: ['flag'],
          strings: [['name', 100, false]],
        }
      );
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('INVALID_TYPE');
    });

    it('fails on string exceeding max length after booleans pass', () => {
      const result = validateAll(
        { id: 'abc', flag: true, name: 'x'.repeat(200) },
        {
          required: ['id'],
          booleans: ['flag'],
          strings: [['name', 100, false]],
        }
      );
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('FIELD_TOO_LONG');
    });

    it('fails on number out of range after strings pass', () => {
      const result = validateAll(
        { id: 'abc', name: 'ok', count: 999 },
        {
          required: ['id'],
          strings: [['name', 100, false]],
          numbers: [['count', 1, 10]],
        }
      );
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('OUT_OF_RANGE');
    });

    it('skips undefined optional fields in all steps', () => {
      const result = validateAll(
        { id: 'present' },
        {
          required: ['id'],
          booleans: ['optional_bool'],
          strings: [['optional_str', 100, false]],
          numbers: [['optional_num', 1, 10]],
        }
      );
      expect(result.valid).toBe(true);
    });

    it('runs steps in order: required → booleans → strings → numbers', () => {
      // required fails first even though numbers would also fail
      const result = validateAll(
        { count: 999 },
        {
          required: ['id'],
          numbers: [['count', 1, 10]],
        }
      );
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('MISSING_FIELDS');
    });

    it('validates dates when spec.dates is provided', () => {
      const result = validateAll(
        { id: 'abc', start: '2026-02-20T10:00:00Z', end: '2026-02-21T10:00:00Z' },
        {
          required: ['id'],
          dates: ['start', 'end'],
        }
      );
      expect(result.valid).toBe(true);
    });

    it('fails on invalid date field via dates spec', () => {
      const result = validateAll(
        { id: 'abc', start: 'not-a-date' },
        {
          required: ['id'],
          dates: ['start'],
        }
      );
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('INVALID_DATE');
    });

    it('skips undefined date fields in dates spec', () => {
      const result = validateAll(
        { id: 'abc' },
        {
          required: ['id'],
          dates: ['start', 'end'],
        }
      );
      expect(result.valid).toBe(true);
    });

    it('runs dates after numbers: number error reported before date error', () => {
      const result = validateAll(
        { id: 'abc', count: 999, start: 'bad-date' },
        {
          required: ['id'],
          numbers: [['count', 1, 10]],
          dates: ['start'],
        }
      );
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('OUT_OF_RANGE');
    });
  });

  describe('validateDateFields', () => {
    it('returns valid when no fields are provided', () => {
      const result = validateDateFields({}, []);
      expect(result.valid).toBe(true);
    });

    it('returns valid when all date fields are valid ISO8601', () => {
      const result = validateDateFields({ start: '2026-02-20T10:00:00Z', end: '2026-03-01' }, [
        'start',
        'end',
      ]);
      expect(result.valid).toBe(true);
    });

    it('returns valid when date fields are absent (undefined)', () => {
      const result = validateDateFields({}, ['start', 'end']);
      expect(result.valid).toBe(true);
    });

    it('returns valid when date field is null', () => {
      const result = validateDateFields({ start: null }, ['start']);
      expect(result.valid).toBe(true);
    });

    it('fails with INVALID_DATE when value is not an ISO8601 string', () => {
      const result = validateDateFields({ start: 'Feb 20, 2026' }, ['start']);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.error?.code).toBe('INVALID_DATE');
        expect(result.error.error?.message).toContain('start');
      }
    });

    it('fails with INVALID_DATE when value is a number', () => {
      const result = validateDateFields({ start: 1708387200000 }, ['start']);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.code).toBe('INVALID_DATE');
    });

    it('fails with INVALID_DATE for rollover date', () => {
      const result = validateDateFields({ due_date: '2026-02-30' }, ['due_date']);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.error?.code).toBe('INVALID_DATE');
        expect(result.error.error?.message).toContain('due_date');
      }
    });

    it('fails on first invalid field and stops', () => {
      const result = validateDateFields({ start: 'not-a-date', end: '2026-03-01' }, [
        'start',
        'end',
      ]);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error.error?.message).toContain('start');
    });

    it('accepts date-only format (YYYY-MM-DD)', () => {
      const result = validateDateFields({ date: '2026-06-15' }, ['date']);
      expect(result.valid).toBe(true);
    });

    it('accepts datetime with timezone offset', () => {
      const result = validateDateFields({ dt: '2026-06-15T09:30:00+02:00' }, ['dt']);
      expect(result.valid).toBe(true);
    });
  });

  describe('asRecord', () => {
    it('returns the same object cast to Record<string, unknown>', () => {
      const input = { name: 'test', count: 42 };
      const result = asRecord(input);
      expect(result).toBe(input);
      expect(result.name).toBe('test');
      expect(result.count).toBe(42);
    });

    it('handles empty object', () => {
      const result = asRecord({});
      expect(result).toEqual({});
    });
  });
});
