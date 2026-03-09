/**
 * Validation Helpers for OS Tool Parameters
 *
 * Shared validation utilities following the Speedwave MCP pattern.
 */

import { ToolsCallResult } from '../../../shared/dist/index.js';

/** Standardized result returned by OS tool handlers. */
export interface ToolResult {
  /** Whether the tool execution succeeded. */
  success: boolean;
  /** Result payload on success. */
  data?: unknown;
  /** Error details on failure. */
  error?: { code: string; message: string };
}

function validateParams(params: unknown): params is Record<string, unknown> {
  return params !== null && typeof params === 'object' && !Array.isArray(params);
}

function formatResult(result: ToolResult): ToolsCallResult {
  if (result.success) {
    return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
  } else {
    return {
      content: [{ type: 'text', text: JSON.stringify(result.error, null, 2) }],
      isError: true,
    };
  }
}

/**
 * Wraps a tool handler with parameter validation and error handling.
 * @param handler - Function that executes the tool logic.
 */
export function withValidation<T>(
  handler: (params: T) => ToolResult | Promise<ToolResult>
): (params: Record<string, unknown>) => Promise<ToolsCallResult> {
  return async (params: Record<string, unknown>) => {
    if (!validateParams(params)) {
      return formatResult({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'Tool parameters must be a non-null object' },
      });
    }
    try {
      const result = await handler(params as T);
      return formatResult(result);
    } catch (error) {
      return formatResult({
        success: false,
        error: {
          code: 'HANDLER_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };
}

/**
 * Validate that required string fields are present and non-empty.
 * @param params - Tool input parameters to validate.
 * @param fields - List of required field names.
 */
export function requireFields(
  params: Record<string, unknown>,
  fields: string[]
): { valid: true } | { valid: false; error: ToolResult } {
  const missing = fields.filter(
    (f) => params[f] === undefined || params[f] === null || typeof params[f] !== 'string'
  );
  if (missing.length > 0) {
    return {
      valid: false,
      error: {
        success: false,
        error: {
          code: 'MISSING_FIELDS',
          message: `Missing required fields: ${missing.join(', ')}`,
        },
      },
    };
  }
  const empty = fields.filter((f) => (params[f] as string).trim() === '');
  if (empty.length > 0) {
    return {
      valid: false,
      error: {
        success: false,
        error: {
          code: 'EMPTY_FIELDS',
          message: `Fields must not be empty: ${empty.join(', ')}`,
        },
      },
    };
  }
  return { valid: true };
}

//=============================================================================
// Input Validation — max length, control chars, types (SEC-012)
//=============================================================================

/** Maximum allowed lengths per field category. */
export const MAX_LENGTHS = { id: 512, short: 1_000, body: 100_000 } as const;

/** Spec for a string field: [name, maxLength, allowNewlines]. */
export type StringFieldSpec = [name: string, maxLength: number, allowNewlines: boolean];

/** Spec for a number field: [name, min, max]. */
export type NumberFieldSpec = [name: string, min: number, max: number];

/** Regex matching control characters \x00-\x1f EXCEPT \t(\x09), \n(\x0a), \r(\x0d). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_BODY = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/** Regex matching ALL control characters \x00-\x1f (strict mode — no newlines allowed). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_STRICT = /[\x00-\x1f\x7f]/;

/**
 * Validate string fields for max length and control characters.
 * Skips fields that are `undefined` (optional not provided).
 * @param params - Tool input parameters to validate.
 * @param specs - Array of string field specs [name, maxLength, allowNewlines].
 */
export function validateStringFields(
  params: Record<string, unknown>,
  specs: StringFieldSpec[]
): { valid: true } | { valid: false; error: ToolResult } {
  for (const [name, maxLength, allowNewlines] of specs) {
    const value = params[name];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      return {
        valid: false,
        error: {
          success: false,
          error: { code: 'INVALID_TYPE', message: `${name} must be a string` },
        },
      };
    }
    if (value.length > maxLength) {
      return {
        valid: false,
        error: {
          success: false,
          error: {
            code: 'FIELD_TOO_LONG',
            message: `${name} exceeds maximum length of ${maxLength}`,
          },
        },
      };
    }
    const re = allowNewlines ? CONTROL_CHARS_BODY : CONTROL_CHARS_STRICT;
    if (re.test(value)) {
      return {
        valid: false,
        error: {
          success: false,
          error: {
            code: 'INVALID_CHARACTERS',
            message: `${name} contains invalid control characters`,
          },
        },
      };
    }
  }
  return { valid: true };
}

/**
 * Validate number fields for type, finiteness, and range.
 * Skips fields that are `undefined` (optional not provided).
 * @param params - Tool input parameters to validate.
 * @param specs - Array of number field specs [name, min, max].
 */
export function validateNumberFields(
  params: Record<string, unknown>,
  specs: NumberFieldSpec[]
): { valid: true } | { valid: false; error: ToolResult } {
  for (const [name, min, max] of specs) {
    const value = params[name];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return {
        valid: false,
        error: {
          success: false,
          error: {
            code: 'INVALID_TYPE',
            message: `${name} must be a finite number between ${min} and ${max}`,
          },
        },
      };
    }
    if (value < min || value > max) {
      return {
        valid: false,
        error: {
          success: false,
          error: {
            code: 'OUT_OF_RANGE',
            message: `${name} must be between ${min} and ${max}`,
          },
        },
      };
    }
  }
  return { valid: true };
}

/**
 * Validate boolean fields for strict `typeof === 'boolean'`.
 * Skips fields that are `undefined` (optional not provided).
 * @param params - Tool input parameters to validate.
 * @param fields - List of boolean field names to check.
 */
export function validateBooleanFields(
  params: Record<string, unknown>,
  fields: string[]
): { valid: true } | { valid: false; error: ToolResult } {
  for (const name of fields) {
    const value = params[name];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      return {
        valid: false,
        error: {
          success: false,
          error: { code: 'INVALID_TYPE', message: `${name} must be a boolean` },
        },
      };
    }
  }
  return { valid: true };
}

/** Spec describing which fields to validate in a single `validateAll` call. */
export interface ValidationSpec {
  required?: string[];
  strings?: StringFieldSpec[];
  numbers?: NumberFieldSpec[];
  booleans?: string[];
  dates?: string[];
}

/**
 * Combine all validation steps in one call.
 * Order: required → booleans → strings → numbers → dates.
 * Returns `{ valid: true }` only when every enabled step passes.
 * Note: `required` validates presence of non-empty string fields only (delegates to `requireFields`).
 * @param params - Tool input parameters to validate.
 * @param spec - Which validations to run and with what configuration.
 */
export function validateAll(
  params: Record<string, unknown>,
  spec: ValidationSpec
): { valid: true } | { valid: false; error: ToolResult } {
  if (spec.required) {
    const r = requireFields(params, spec.required);
    if (!r.valid) return r;
  }
  if (spec.booleans) {
    const b = validateBooleanFields(params, spec.booleans);
    if (!b.valid) return b;
  }
  if (spec.strings) {
    const s = validateStringFields(params, spec.strings);
    if (!s.valid) return s;
  }
  if (spec.numbers) {
    const n = validateNumberFields(params, spec.numbers);
    if (!n.valid) return n;
  }
  if (spec.dates) {
    const d = validateDateFields(params, spec.dates);
    if (!d.valid) return d;
  }
  return { valid: true };
}

/**
 * Cast unknown params to `Record<string, unknown>`.
 * Replaces the verbose `params as unknown as Record<string, unknown>` pattern.
 * @param params - Tool input parameters.
 */
export function asRecord(params: unknown): Record<string, unknown> {
  return params as Record<string, unknown>;
}

/**
 * Validate that optional date fields, when present, are in strict ISO8601 format.
 * Skips fields that are `undefined` or `null`.
 * @param params - Tool input parameters to validate.
 * @param fields - List of field names to check.
 */
export function validateDateFields(
  params: Record<string, unknown>,
  fields: string[]
): { valid: true } | { valid: false; error: ToolResult } {
  for (const field of fields) {
    const value = params[field];
    if (value !== undefined && value !== null) {
      if (typeof value !== 'string' || !isValidISO8601(value)) {
        return {
          valid: false,
          error: {
            success: false,
            error: { code: 'INVALID_DATE', message: `Invalid ${field} date format. Use ISO8601.` },
          },
        };
      }
    }
  }
  return { valid: true };
}

/**
 * Strict ISO8601 regex: YYYY-MM-DD with optional THH:MM:SS(.sss)(Z|±HH:MM).
 * Rejects non-ISO formats that `new Date()` would silently accept
 * (e.g., "Feb 20, 2026", unix timestamps, slash-delimited dates).
 */
const ISO8601_RE =
  /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)?)?$/;

/**
 * Validate ISO8601 date string format.
 * Uses regex pre-check before `new Date()` to reject ambiguous formats.
 * Additionally validates month/day ranges to prevent silent date rollover.
 * @param value - Value to check for valid ISO8601 date format.
 */
export function isValidISO8601(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!ISO8601_RE.test(value)) return false;

  // Validate month/day ranges to prevent silent rollover (e.g., Feb 30 → Mar 2)
  const year = parseInt(value.slice(0, 4), 10);
  const month = parseInt(value.slice(5, 7), 10);
  const day = parseInt(value.slice(8, 10), 10);

  if (month < 1 || month > 12) return false;
  if (day < 1) return false;

  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay = daysInMonth[month - 1] + (month === 2 && isLeap ? 1 : 0);
  if (day > maxDay) return false;

  const date = new Date(value);
  return !isNaN(date.getTime());
}
