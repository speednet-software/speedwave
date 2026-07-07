/**
 * Validation Helpers for OS Tool Parameters
 *
 * Shared validation utilities following the Speedwave MCP pattern.
 */

import {
  withResultValidation,
  teachingToolResult as sharedTeachingToolResult,
  type ToolResult,
  type ToolsCallResult,
} from '@speedwave/mcp-shared';

/** Standardized result returned by OS tool handlers (re-export of the shared type). */
export type { ToolResult };

/**
 * Positional sugar over the shared {@link sharedTeachingToolResult} for this
 * file's many call sites.
 * @param code - Machine-readable error code (e.g. `MISSING_FIELDS`).
 * @param paramName - Name of the offending parameter.
 * @param received - The value actually received.
 * @param nextStep - Concrete next step for the caller to take.
 * @param correctValueTool - Name of a tool that provides a correct value, if any.
 */
function teachingToolResult(
  code: string,
  paramName: string,
  received: unknown,
  nextStep: string,
  correctValueTool?: string
): ToolResult {
  return sharedTeachingToolResult({ paramName, received, nextStep, correctValueTool }, code);
}

/**
 * Wraps a tool handler with parameter validation and error handling
 * (pretty-printed JSON output via the shared Family-A wrapper).
 * @param handler - Function that executes the tool logic.
 */
export function withValidation<T>(
  handler: (params: T) => ToolResult | Promise<ToolResult>
): (params: Record<string, unknown>) => Promise<ToolsCallResult> {
  return withResultValidation(handler);
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
    const [first, ...rest] = missing;
    return {
      valid: false,
      error: teachingToolResult(
        'MISSING_FIELDS',
        missing.length > 1 ? `${first} (and ${rest.join(', ')})` : first,
        params[first],
        `Provide a non-empty string for ${missing.join(', ')}.`
      ),
    };
  }
  const empty = fields.filter((f) => (params[f] as string).trim() === '');
  if (empty.length > 0) {
    const [first, ...rest] = empty;
    return {
      valid: false,
      error: teachingToolResult(
        'EMPTY_FIELDS',
        empty.length > 1 ? `${first} (and ${rest.join(', ')})` : first,
        params[first],
        `Provide a non-empty value for ${empty.join(', ')}.`
      ),
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

/** Spec for a string-array field: [name, maxItems, maxItemLength]. */
export type StringArrayFieldSpec = [name: string, maxItems: number, maxItemLength: number];

/** Regex matching control characters \x00-\x1f EXCEPT \t(\x09), \n(\x0a), \r(\x0d). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_BODY = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/** Regex matching ALL control characters \x00-\x1f (strict mode — no newlines allowed). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_STRICT = /[\x00-\x1f\x7f]/;

/**
 * Validate string fields for max length and control characters.
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
        error: teachingToolResult('INVALID_TYPE', name, value, `Pass ${name} as a string.`),
      };
    }
    if (value.length > maxLength) {
      return {
        valid: false,
        error: teachingToolResult(
          'FIELD_TOO_LONG',
          name,
          `${value.length} characters`,
          `Shorten ${name} to at most ${maxLength} characters.`
        ),
      };
    }
    const re = allowNewlines ? CONTROL_CHARS_BODY : CONTROL_CHARS_STRICT;
    if (re.test(value)) {
      return {
        valid: false,
        error: teachingToolResult(
          'INVALID_CHARACTERS',
          name,
          value,
          allowNewlines
            ? `Remove control characters from ${name} (tabs, newlines, and carriage returns are allowed).`
            : `Remove control characters and newlines from ${name}.`
        ),
      };
    }
  }
  return { valid: true };
}

/**
 * Validate number fields for type, finiteness, and range.
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
        error: teachingToolResult(
          'INVALID_TYPE',
          name,
          value,
          `Pass ${name} as a finite number between ${min} and ${max}.`
        ),
      };
    }
    if (value < min || value > max) {
      return {
        valid: false,
        error: teachingToolResult(
          'OUT_OF_RANGE',
          name,
          value,
          `Pass ${name} as a number between ${min} and ${max}.`
        ),
      };
    }
  }
  return { valid: true };
}

/**
 * Validate boolean fields for strict `typeof === 'boolean'`.
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
        error: teachingToolResult(
          'INVALID_TYPE',
          name,
          value,
          `Pass ${name} as a literal boolean (true or false), not a string or number.`
        ),
      };
    }
  }
  return { valid: true };
}

/**
 * Validate string-array fields for type, item count, item length, and control characters.
 * @param params - Tool input parameters to validate.
 * @param specs - Array of string-array field specs [name, maxItems, maxItemLength].
 */
export function validateStringArrayFields(
  params: Record<string, unknown>,
  specs: StringArrayFieldSpec[]
): { valid: true } | { valid: false; error: ToolResult } {
  for (const [name, maxItems, maxItemLength] of specs) {
    const value = params[name];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      return {
        valid: false,
        error: teachingToolResult(
          'INVALID_TYPE',
          name,
          value,
          `Pass ${name} as an array of strings.`
        ),
      };
    }
    if (value.length > maxItems) {
      return {
        valid: false,
        error: teachingToolResult(
          'ARRAY_TOO_LONG',
          name,
          `${value.length} items`,
          `Trim ${name} to at most ${maxItems} items.`
        ),
      };
    }
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const itemName = `${name}[${i}]`;
      if (typeof item !== 'string') {
        return {
          valid: false,
          error: teachingToolResult(
            'INVALID_TYPE',
            itemName,
            item,
            `Pass ${itemName} as a string.`
          ),
        };
      }
      if (item.trim() === '') {
        return {
          valid: false,
          error: teachingToolResult(
            'EMPTY_FIELDS',
            itemName,
            item,
            `Provide a non-empty value for ${itemName}, or remove it from ${name}.`
          ),
        };
      }
      if (item.length > maxItemLength) {
        return {
          valid: false,
          error: teachingToolResult(
            'FIELD_TOO_LONG',
            itemName,
            `${item.length} characters`,
            `Shorten ${itemName} to at most ${maxItemLength} characters.`
          ),
        };
      }
      if (CONTROL_CHARS_STRICT.test(item)) {
        return {
          valid: false,
          error: teachingToolResult(
            'INVALID_CHARACTERS',
            itemName,
            item,
            `Remove control characters and newlines from ${itemName}.`
          ),
        };
      }
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
  stringArrays?: StringArrayFieldSpec[];
}

/**
 * Combine all validation steps in one call.
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
  if (spec.stringArrays) {
    const sa = validateStringArrayFields(params, spec.stringArrays);
    if (!sa.valid) return sa;
  }
  return { valid: true };
}

/**
 * Cast unknown params to `Record<string, unknown>`.
 * @param params - Tool input parameters.
 */
export function asRecord(params: unknown): Record<string, unknown> {
  return params as Record<string, unknown>;
}

/**
 * Validate that optional date fields, when present, are in strict ISO8601 format.
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
          error: teachingToolResult(
            'INVALID_DATE',
            field,
            value,
            `Pass ${field} as an ISO8601 date string, e.g. "2026-06-15" or "2026-06-15T09:30:00Z".`
          ),
        };
      }
    }
  }
  return { valid: true };
}

/** Strict ISO8601 regex: YYYY-MM-DD with optional THH:MM:SS(.sss)(Z|±HH:MM). */
const ISO8601_RE =
  /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)?)?$/;

/**
 * Validate ISO8601 date string format.
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
