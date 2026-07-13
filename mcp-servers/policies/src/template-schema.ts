/**
 * Strict schema validation shared by policy templates (YAML) and resolved policies (JSON).
 * @module template-schema
 */

import { ALL_PII_TYPES, type CustomPatternRule, type PolicyTemplate, PIIType } from './types.js';

const TEMPLATE_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const CUSTOM_PATTERN_ID_RE = /^[A-Z][A-Z0-9_]{2,31}$/;

/** Fields from a pre-v1 schema draft; recognized so callers get an actionable error. */
const DEPRECATED_TEMPLATE_FIELDS = ['inherit', 'attachments', 'scope'];
const KNOWN_TEMPLATE_FIELDS = new Set([
  'version',
  'id',
  'name',
  'description',
  'categories',
  'customPatterns',
  'sensitiveKeys',
]);

const BUILTIN_TYPE_IDS: readonly string[] = ALL_PII_TYPES;

/**
 * Throw a schema validation error, prefixed with where it occurred.
 * @param context - Human-readable location of the offending value
 * @param message - What is wrong with it
 */
function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

/**
 * Narrow `v` to a non-null, non-array object.
 * @param v - Value to check
 * @returns True if `v` is a plain object
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate that `raw` is an array of strings.
 * @param raw - Value to validate
 * @param context - Human-readable location for error messages
 * @returns The validated string array
 */
export function parseStringArray(raw: unknown, context: string): string[] {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string')) {
    fail(context, 'must be an array of strings');
  }
  return raw as string[];
}

/**
 * Validate an exhaustive `categories` object: exactly the 8 PIIType keys, all booleans.
 * @param raw - Value to validate
 * @param context - Human-readable location for error messages
 * @returns The validated category-enablement map
 */
export function parseCategories(raw: unknown, context: string): Record<PIIType, boolean> {
  if (!isPlainObject(raw)) {
    fail(context, 'must be an object');
  }
  const seen = new Set(Object.keys(raw));
  const result = {} as Record<PIIType, boolean>;
  for (const type of ALL_PII_TYPES) {
    if (!(type in raw)) {
      fail(context, `missing required key "${type}"`);
    }
    const value = raw[type];
    if (typeof value !== 'boolean') {
      fail(context, `${type} must be a boolean`);
    }
    result[type] = value;
    seen.delete(type);
  }
  if (seen.size > 0) {
    fail(context, `unknown key(s): ${[...seen].sort().join(', ')}`);
  }
  return result;
}

/**
 * Validate one category's `{tokenize, log}` flag pair (template YAML schema v2).
 * @param raw - Value to validate
 * @param context - Human-readable location for error messages
 * @returns Just the `tokenize` flag — the only one today's boolean-only pipeline consumes
 */
function parseCategoryFlagPair(raw: unknown, context: string): boolean {
  if (!isPlainObject(raw)) {
    fail(context, 'must be an object');
  }
  const { tokenize, log, ...rest } = raw;
  if (typeof tokenize !== 'boolean') {
    fail(context, 'tokenize must be a boolean');
  }
  if (typeof log !== 'boolean') {
    fail(context, 'log must be a boolean');
  }
  const unknown = Object.keys(rest);
  if (unknown.length > 0) {
    fail(context, `unknown key(s): ${unknown.sort().join(', ')}`);
  }
  return tokenize;
}

/**
 * Validate an exhaustive template `categories` object of `{tokenize, log}` pairs (schema v2),
 * mapping each category down to its `tokenize` flag.
 * @param raw - Value to validate
 * @param context - Human-readable location for error messages
 * @returns The validated category-enablement map
 */
function parseTemplateCategories(raw: unknown, context: string): Record<PIIType, boolean> {
  if (!isPlainObject(raw)) {
    fail(context, 'must be an object');
  }
  const seen = new Set(Object.keys(raw));
  const result = {} as Record<PIIType, boolean>;
  for (const type of ALL_PII_TYPES) {
    if (!(type in raw)) {
      fail(context, `missing required key "${type}"`);
    }
    result[type] = parseCategoryFlagPair(raw[type], `${context}.${type}`);
    seen.delete(type);
  }
  if (seen.size > 0) {
    fail(context, `unknown key(s): ${[...seen].sort().join(', ')}`);
  }
  return result;
}

/**
 * Validate a single custom pattern rule's shape (not its regex safety — see pattern-lint.ts).
 * @param raw - Value to validate
 * @param context - Human-readable location for error messages
 * @returns The validated rule
 */
export function parseCustomPatternRule(raw: unknown, context: string): CustomPatternRule {
  if (!isPlainObject(raw)) {
    fail(context, 'must be an object');
  }
  const { id, displayName, pattern, caseInsensitive, forced } = raw;
  if (typeof id !== 'string' || !CUSTOM_PATTERN_ID_RE.test(id)) {
    fail(context, `id "${String(id)}" must match ${CUSTOM_PATTERN_ID_RE}`);
  }
  if (BUILTIN_TYPE_IDS.includes(id)) {
    fail(context, `id "${id}" collides with a built-in PIIType`);
  }
  if (typeof displayName !== 'string' || displayName.length === 0) {
    fail(context, `"${id}" displayName must be a non-empty string`);
  }
  if (typeof pattern !== 'string' || pattern.length === 0) {
    fail(context, `"${id}" pattern must be a non-empty string`);
  }
  if (typeof caseInsensitive !== 'boolean') {
    fail(context, `"${id}" caseInsensitive must be a boolean`);
  }
  // `forced` is validated but has no compile-time effect in v1: nothing can strip a present
  // custom pattern, so every one is applied regardless of the flag.
  if (typeof forced !== 'boolean') {
    fail(context, `"${id}" forced must be a boolean`);
  }
  return { id, displayName, pattern, caseInsensitive, forced };
}

/**
 * Validate a `customPatterns` array: well-formed entries, unique ids.
 * @param raw - Value to validate
 * @param context - Human-readable location for error messages
 * @returns The validated rules, in file order
 */
export function parseCustomPatterns(raw: unknown, context: string): CustomPatternRule[] {
  if (!Array.isArray(raw)) {
    fail(context, 'must be an array');
  }
  const rules = raw.map((entry, i) => parseCustomPatternRule(entry, `${context}[${i}]`));
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) {
      fail(context, `id "${rule.id}" is duplicated`);
    }
    ids.add(rule.id);
  }
  return rules;
}

/**
 * Parse and strictly validate a policy template loaded from YAML.
 * @param raw - Parsed YAML document
 * @returns The validated template
 */
export function parseTemplate(raw: unknown): PolicyTemplate {
  if (!isPlainObject(raw)) {
    fail('template', 'must be an object');
  }
  for (const deprecated of DEPRECATED_TEMPLATE_FIELDS) {
    if (deprecated in raw) {
      fail('template', `field "${deprecated}" is not supported in schema version 2`);
    }
  }
  // Reject unknown top-level keys, matching Rust's deny_unknown_fields so the YAML SSOT can't drift TS-only.
  const unknown = Object.keys(raw).filter((k) => !KNOWN_TEMPLATE_FIELDS.has(k));
  if (unknown.length > 0) {
    fail('template', `unknown key(s): ${unknown.sort().join(', ')}`);
  }
  if (raw.version !== 2) {
    fail('template', `unsupported version "${String(raw.version)}", expected 2`);
  }
  const { id, name, description } = raw;
  if (typeof id !== 'string' || !TEMPLATE_ID_RE.test(id)) {
    fail('template', `id "${String(id)}" must match ${TEMPLATE_ID_RE}`);
  }
  if (id === 'custom') {
    fail('template', 'id "custom" is reserved');
  }
  if (typeof name !== 'string' || name.length === 0) {
    fail(`template "${id}"`, 'name must be a non-empty string');
  }
  if (typeof description !== 'string') {
    fail(`template "${id}"`, 'description must be a string');
  }
  const categories = parseTemplateCategories(raw.categories, `template "${id}" categories`);
  const customPatterns = parseCustomPatterns(
    raw.customPatterns ?? [],
    `template "${id}" customPatterns`
  );
  const sensitiveKeysRaw = raw.sensitiveKeys;
  if (!isPlainObject(sensitiveKeysRaw)) {
    fail(`template "${id}"`, 'sensitiveKeys must be an object');
  }
  const add = parseStringArray(sensitiveKeysRaw.add ?? [], `template "${id}" sensitiveKeys.add`);
  const remove = parseStringArray(
    sensitiveKeysRaw.remove ?? [],
    `template "${id}" sensitiveKeys.remove`
  );

  return {
    version: 2,
    id,
    name,
    description,
    categories,
    customPatterns,
    sensitiveKeys: { add, remove },
  };
}
