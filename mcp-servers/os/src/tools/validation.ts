/** Validation helpers for OS tool parameters, following the Speedwave MCP pattern. */

import {
  withDeclaredParams,
  withResultValidation,
  type Tool,
  type ToolDefinition,
  teachingToolResult,
  type ToolResult,
  type ToolsCallResult,
} from '@speedwave/mcp-shared';

/** Standardized result returned by OS tool handlers (re-export of the shared type). */
export type { ToolResult };

/**
 * Build a `{field: value}` map of the named fields for a multi-field `received`.
 * @param params - Tool input parameters.
 * @param names - Field names to include in the map.
 */
function receivedMapFor(params: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.map((name) => [name, params[name]]));
}

/**
 * Wraps a tool handler with validation + error handling (JSON via the shared Family-A wrapper).
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
  const fieldsError = (
    offending: string[],
    code: string,
    action: string
  ): { valid: false; error: ToolResult } => {
    const names = offending.join(', ');
    return {
      valid: false,
      error: teachingToolResult(
        {
          paramName: names,
          received: offending.length > 1 ? receivedMapFor(params, offending) : params[offending[0]],
          nextStep: `${action} ${names}.`,
        },
        code
      ),
    };
  };
  const missing = fields.filter(
    (f) => params[f] === undefined || params[f] === null || typeof params[f] !== 'string'
  );
  if (missing.length > 0) {
    return fieldsError(missing, 'MISSING_FIELDS', 'Provide a non-empty string for');
  }
  const empty = fields.filter((f) => (params[f] as string).trim() === '');
  if (empty.length > 0) {
    return fieldsError(empty, 'EMPTY_FIELDS', 'Provide a non-empty value for');
  }
  return { valid: true };
}

/** Maximum allowed lengths per field category. */
export const MAX_LENGTHS = { id: 512, short: 1_000, body: 100_000 } as const;

/** Spec for a string field: [name, maxLength, allowNewlines]. */
export type StringFieldSpec = [name: string, maxLength: number, allowNewlines: boolean];

/** Spec for a number field: [name, min, max]. */
export type NumberFieldSpec = [name: string, min: number, max: number];

/** Characters an array item must not contain, with the wording used in the teaching error. */
export interface ForbiddenChars {
  pattern: RegExp;
  describe: string;
}

/** Spec for a string-array field: [name, maxItems, maxItemLength, forbidden?]. */
export type StringArrayFieldSpec = [
  name: string,
  maxItems: number,
  maxItemLength: number,
  forbidden?: ForbiddenChars,
];

/** Regex matching control characters \x00-\x1f EXCEPT \t(\x09), \n(\x0a), \r(\x0d). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_BODY = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/** Regex matching ALL control characters \x00-\x1f (strict mode — no newlines allowed). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_STRICT = /[\x00-\x1f\x7f]/;

const ALARM_VARIANTS = ['at', 'offset_minutes', 'location'];
const ALARM_PROXIMITIES = ['arrive', 'leave'];

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
        error: teachingToolResult(
          { paramName: name, received: value, nextStep: `Pass ${name} as a string.` },
          'INVALID_TYPE'
        ),
      };
    }
    if (value.length > maxLength) {
      return {
        valid: false,
        error: teachingToolResult(
          {
            paramName: name,
            received: `${value.length} characters`,
            nextStep: `Shorten ${name} to at most ${maxLength} characters.`,
          },
          'FIELD_TOO_LONG'
        ),
      };
    }
    const re = allowNewlines ? CONTROL_CHARS_BODY : CONTROL_CHARS_STRICT;
    if (re.test(value)) {
      return {
        valid: false,
        error: teachingToolResult(
          {
            paramName: name,
            received: value,
            nextStep: allowNewlines
              ? `Remove control characters from ${name} (tabs, newlines, and carriage returns are allowed).`
              : `Remove control characters and newlines from ${name}.`,
          },
          'INVALID_CHARACTERS'
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
          {
            paramName: name,
            received: value,
            nextStep: `Pass ${name} as a finite number between ${min} and ${max}.`,
          },
          'INVALID_TYPE'
        ),
      };
    }
    if (value < min || value > max) {
      return {
        valid: false,
        error: teachingToolResult(
          {
            paramName: name,
            received: value,
            nextStep: `Pass ${name} as a number between ${min} and ${max}.`,
          },
          'OUT_OF_RANGE'
        ),
      };
    }
  }
  return { valid: true };
}

/**
 * Validate number fields that must also be whole numbers (e.g. a priority level).
 * @param params - Tool input parameters to validate.
 * @param specs - Array of number field specs [name, min, max].
 */
export function validateIntegerFields(
  params: Record<string, unknown>,
  specs: NumberFieldSpec[]
): { valid: true } | { valid: false; error: ToolResult } {
  const numeric = validateNumberFields(params, specs);
  if (!numeric.valid) return numeric;
  for (const [name, min, max] of specs) {
    const value = params[name];
    if (value === undefined || Number.isInteger(value)) continue;
    return {
      valid: false,
      error: teachingToolResult(
        {
          paramName: name,
          received: value,
          nextStep: `Pass ${name} as a whole number between ${min} and ${max}.`,
        },
        'INVALID_TYPE'
      ),
    };
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
          {
            paramName: name,
            received: value,
            nextStep: `Pass ${name} as a literal boolean (true or false), not a string or number.`,
          },
          'INVALID_TYPE'
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
  for (const [name, maxItems, maxItemLength, forbidden] of specs) {
    const value = params[name];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      return {
        valid: false,
        error: teachingToolResult(
          { paramName: name, received: value, nextStep: `Pass ${name} as an array of strings.` },
          'INVALID_TYPE'
        ),
      };
    }
    if (value.length > maxItems) {
      return {
        valid: false,
        error: teachingToolResult(
          {
            paramName: name,
            received: `${value.length} items`,
            nextStep: `Trim ${name} to at most ${maxItems} items.`,
          },
          'ARRAY_TOO_LONG'
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
            { paramName: itemName, received: item, nextStep: `Pass ${itemName} as a string.` },
            'INVALID_TYPE'
          ),
        };
      }
      if (item.trim() === '') {
        return {
          valid: false,
          error: teachingToolResult(
            {
              paramName: itemName,
              received: item,
              nextStep: `Provide a non-empty value for ${itemName}, or remove it from ${name}.`,
            },
            'EMPTY_FIELDS'
          ),
        };
      }
      if (item.length > maxItemLength) {
        return {
          valid: false,
          error: teachingToolResult(
            {
              paramName: itemName,
              received: `${item.length} characters`,
              nextStep: `Shorten ${itemName} to at most ${maxItemLength} characters.`,
            },
            'FIELD_TOO_LONG'
          ),
        };
      }
      if (CONTROL_CHARS_STRICT.test(item)) {
        return {
          valid: false,
          error: teachingToolResult(
            {
              paramName: itemName,
              received: item,
              nextStep: `Remove control characters and newlines from ${itemName}.`,
            },
            'INVALID_CHARACTERS'
          ),
        };
      }
      if (forbidden?.pattern.test(item)) {
        return {
          valid: false,
          error: teachingToolResult(
            {
              paramName: itemName,
              received: item,
              nextStep: `Remove ${forbidden.describe} from ${itemName}.`,
            },
            'INVALID_CHARACTERS'
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
  integers?: NumberFieldSpec[];
  booleans?: string[];
  dates?: string[];
  /** Date and alarm fields that accept an explicit null (a PATCH "clear this field"); every other null is rejected. */
  nullable?: string[];
  stringArrays?: StringArrayFieldSpec[];
  /** Reminder alarm arrays; names also listed in `nullable` accept an explicit null (remove all alarms). */
  alarms?: string[];
}

/**
 * Combine all validation steps in one call, per `spec`.
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
  if (spec.integers) {
    const i = validateIntegerFields(params, spec.integers);
    if (!i.valid) return i;
  }
  if (spec.dates) {
    const d = validateDateFields(params, spec.dates, spec.nullable);
    if (!d.valid) return d;
  }
  if (spec.stringArrays) {
    const sa = validateStringArrayFields(params, spec.stringArrays);
    if (!sa.valid) return sa;
  }
  if (spec.alarms) {
    const a = validateAlarmFields(params, spec.alarms, spec.nullable);
    if (!a.valid) return a;
  }
  return { valid: true };
}

/**
 * Pairs a tool with its validated handler, rejecting any argument its inputSchema does not declare.
 * @param tool - Tool definition.
 * @param handler - Handler returning a ToolResult.
 */
export function guardedTool<T>(
  tool: Tool,
  handler: (params: T) => ToolResult | Promise<ToolResult>
): ToolDefinition {
  return { tool, handler: withDeclaredParams(tool, withValidation(handler)) };
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
 * @param nullable - Fields for which an explicit null is accepted (a PATCH "clear this field").
 */
export function validateDateFields(
  params: Record<string, unknown>,
  fields: string[],
  nullable: string[] = []
): { valid: true } | { valid: false; error: ToolResult } {
  for (const field of fields) {
    const value = params[field];
    if (value === null && !nullable.includes(field)) {
      return {
        valid: false,
        error: teachingToolResult(
          {
            paramName: field,
            received: value,
            nextStep: `Pass ${field} as an ISO8601 date string, or omit it; null is not accepted here.`,
          },
          'INVALID_TYPE'
        ),
      };
    }
    if (value !== undefined && value !== null) {
      if (typeof value !== 'string' || !isValidISO8601(value)) {
        return {
          valid: false,
          error: teachingToolResult(
            {
              paramName: field,
              received: value,
              nextStep: `Pass ${field} as an ISO8601 date string, e.g. "2026-06-15" or "2026-06-15T09:30:00".`,
            },
            'INVALID_DATE'
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

const MAX_ALARM_OFFSET_MINUTES = 525600;

function validateAlarmFields(
  params: Record<string, unknown>,
  fields: string[],
  nullable: string[] = []
): { valid: true } | { valid: false; error: ToolResult } {
  for (const field of fields) {
    const value = params[field];
    if (value === undefined) continue;
    if (value === null) {
      if (nullable.includes(field)) continue;
      return alarmError(
        field,
        value,
        `Pass ${field} as an array of alarms, or omit it; null is not accepted here.`,
        'INVALID_TYPE'
      );
    }
    if (!Array.isArray(value)) {
      return alarmError(field, value, `Pass ${field} as an array of alarms.`, 'INVALID_TYPE');
    }
    for (let i = 0; i < value.length; i++) {
      const alarm = validateAlarm(value[i], `${field}[${i}]`);
      if (!alarm.valid) return alarm;
    }
  }
  return { valid: true };
}

function validateAlarm(
  value: unknown,
  name: string
): { valid: true } | { valid: false; error: ToolResult } {
  const alarm = asObject(value);
  if (!alarm) {
    return alarmError(name, value, `Pass ${name} as an object.`, 'INVALID_TYPE');
  }
  const present = ALARM_VARIANTS.filter((variant) => alarm[variant] !== undefined);
  if (present.length !== 1) {
    return alarmError(
      name,
      present.length === 0 ? 'no variant' : present.join(' and '),
      `Pass exactly one of ${ALARM_VARIANTS.join(', ')} in ${name}.`,
      'INVALID_PARAM'
    );
  }
  if (alarm.at !== undefined) {
    return isValidISO8601(alarm.at)
      ? { valid: true }
      : alarmError(
          `${name}.at`,
          alarm.at,
          `Pass ${name}.at as an ISO8601 date string, e.g. "2026-06-15T08:30:00".`,
          'INVALID_DATE'
        );
  }
  if (alarm.offset_minutes !== undefined) {
    return Number.isSafeInteger(alarm.offset_minutes) &&
      Math.abs(alarm.offset_minutes as number) <= MAX_ALARM_OFFSET_MINUTES
      ? { valid: true }
      : alarmError(
          `${name}.offset_minutes`,
          alarm.offset_minutes,
          `Pass ${name}.offset_minutes as a whole number of minutes between -${MAX_ALARM_OFFSET_MINUTES} and ${MAX_ALARM_OFFSET_MINUTES} (one year); negative is before the due date.`,
          'INVALID_TYPE'
        );
  }
  return validateAlarmLocation(alarm.location, `${name}.location`);
}

function validateAlarmLocation(
  value: unknown,
  name: string
): { valid: true } | { valid: false; error: ToolResult } {
  const location = asObject(value);
  if (!location) {
    return alarmError(name, value, `Pass ${name} as an object.`, 'INVALID_TYPE');
  }
  if (
    typeof location.name !== 'string' ||
    location.name.trim() === '' ||
    location.name.length > MAX_LENGTHS.short
  ) {
    return alarmError(
      `${name}.name`,
      location.name,
      `Pass ${name}.name as a non-empty place name of at most ${MAX_LENGTHS.short} characters.`,
      'INVALID_TYPE'
    );
  }
  const ranges: [key: string, min: number, max: number, required: boolean, bounds: string][] = [
    ['latitude', -90, 90, true, 'between -90 and 90'],
    ['longitude', -180, 180, true, 'between -180 and 180'],
    ['radius_m', 0, Infinity, false, 'of at least 0 (metres)'],
  ];
  for (const [key, min, max, required, bounds] of ranges) {
    const number = location[key];
    if (number === undefined && !required) continue;
    if (typeof number !== 'number' || !Number.isFinite(number)) {
      return alarmError(
        `${name}.${key}`,
        number,
        `Pass ${name}.${key} as a finite number ${bounds}.`,
        'INVALID_TYPE'
      );
    }
    if (number < min || number > max) {
      return alarmError(
        `${name}.${key}`,
        number,
        `Pass ${name}.${key} as a number ${bounds}.`,
        'OUT_OF_RANGE'
      );
    }
  }
  if (typeof location.on !== 'string' || !ALARM_PROXIMITIES.includes(location.on)) {
    return alarmError(
      `${name}.on`,
      location.on,
      `Pass ${name}.on as "arrive" or "leave".`,
      'INVALID_PARAM'
    );
  }
  return { valid: true };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function alarmError(
  name: string,
  received: unknown,
  nextStep: string,
  code: string
): { valid: false; error: ToolResult } {
  return { valid: false, error: teachingToolResult({ paramName: name, received, nextStep }, code) };
}
