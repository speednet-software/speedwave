/**
 * The resolved-policy layer: strict JSON parsing, the compiled-in default, template
 * promotion, and compilation into the CompiledPolicy the tokenizer runs against.
 * @module resolved-policy
 */

import { ts } from '@speedwave/mcp-shared';
import { lintPattern } from './pattern-lint.js';
import { PII_PATTERNS, PII_PATTERN_ORDER, SENSITIVE_KEYS } from './patterns.js';
import { parseCategories, parseCustomPatterns, parseStringArray } from './template-schema.js';
import {
  ALL_PII_TYPES,
  PIIType,
  type CompiledPatternRule,
  type CompiledPolicy,
  type PolicySelection,
  type PolicyTemplate,
  type ResolvedPolicy,
} from './types.js';
import { PII_VALIDATORS } from './validators.js';

const DEFAULT_MAX_TOKENS = 1000;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

const KNOWN_TOP_LEVEL_KEYS = [
  'version',
  'source',
  'categories',
  'customPatterns',
  'sensitiveKeys',
  'limits',
  'forcedCategories',
];

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
 * Validate the `source` field: `{mode:'template', templateId}` or `{mode:'custom', templateId?}`.
 * @param raw - Value to validate
 * @returns The validated selection
 */
function parseSource(raw: unknown): PolicySelection {
  if (!isPlainObject(raw)) {
    fail('resolved policy', 'source must be an object');
  }
  const { mode, templateId } = raw;
  if (mode === 'template') {
    if (typeof templateId !== 'string' || templateId.length === 0) {
      fail('resolved policy', 'source.templateId is required when source.mode is "template"');
    }
    return { mode: 'template', templateId };
  }
  if (mode === 'custom') {
    return typeof templateId === 'string' ? { mode: 'custom', templateId } : { mode: 'custom' };
  }
  fail('resolved policy', `source.mode must be "template" or "custom", got "${String(mode)}"`);
}

/**
 * Validate the `sensitiveKeys` delta object, defaulting omitted sub-arrays to `[]`.
 * @param raw - Value to validate
 * @returns The validated add/remove/forcedAdd arrays
 */
function parseSensitiveKeyDelta(raw: unknown): {
  add: string[];
  remove: string[];
  forcedAdd: string[];
} {
  if (!isPlainObject(raw)) {
    fail('resolved policy', 'sensitiveKeys must be an object');
  }
  return {
    add: parseStringArray(raw.add ?? [], 'resolved policy sensitiveKeys.add'),
    remove: parseStringArray(raw.remove ?? [], 'resolved policy sensitiveKeys.remove'),
    forcedAdd: parseStringArray(raw.forcedAdd ?? [], 'resolved policy sensitiveKeys.forcedAdd'),
  };
}

/**
 * Validate the optional `limits` object, defaulting to today-equivalent values when omitted.
 * @param raw - Value to validate
 * @returns The validated maxTokens/ttlMs
 */
function parseLimits(raw: unknown): { maxTokens: number; ttlMs: number } {
  if (raw === undefined) {
    return { maxTokens: DEFAULT_MAX_TOKENS, ttlMs: DEFAULT_TTL_MS };
  }
  if (!isPlainObject(raw)) {
    fail('resolved policy', 'limits must be an object');
  }
  const maxTokens = raw.maxTokens ?? DEFAULT_MAX_TOKENS;
  const ttlMs = raw.ttlMs ?? DEFAULT_TTL_MS;
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    fail('resolved policy', 'limits.maxTokens must be a positive number');
  }
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    fail('resolved policy', 'limits.ttlMs must be a positive number');
  }
  return { maxTokens, ttlMs };
}

/**
 * Validate the optional `forcedCategories` array, defaulting to `[]` when omitted.
 * @param raw - Value to validate
 * @returns The validated PIIType list
 */
function parseForcedCategories(raw: unknown): PIIType[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    fail('resolved policy', 'forcedCategories must be an array');
  }
  for (const entry of raw) {
    if (!(ALL_PII_TYPES as string[]).includes(entry)) {
      fail('resolved policy', `forcedCategories entry "${String(entry)}" is not a known PIIType`);
    }
  }
  return raw as PIIType[];
}

/**
 * Strictly parse and validate a resolved-policy JSON document (as written to `policy.json`).
 * Unknown top-level fields are ignored and logged; unknown/missing category names hard-error.
 * @param raw - Parsed JSON document
 * @returns The validated resolved policy
 */
export function parseResolvedPolicy(raw: unknown): ResolvedPolicy {
  if (!isPlainObject(raw)) {
    fail('resolved policy', 'must be an object');
  }
  if (raw.version !== 1) {
    fail('resolved policy', `unsupported version "${String(raw.version)}", expected 1`);
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_KEYS.includes(key)) {
      console.warn(`${ts()} resolved policy: ignoring unknown top-level field "${key}"`);
    }
  }

  const source = parseSource(raw.source);
  const categories = parseCategories(raw.categories, 'resolved policy categories');
  const customPatterns = parseCustomPatterns(
    raw.customPatterns ?? [],
    'resolved policy customPatterns'
  );
  const sensitiveKeys = parseSensitiveKeyDelta(raw.sensitiveKeys);
  const limits = parseLimits(raw.limits);
  const forcedCategories = parseForcedCategories(raw.forcedCategories);

  return {
    version: 1,
    source,
    categories,
    customPatterns,
    sensitiveKeys,
    limits,
    forcedCategories,
  };
}

/**
 * The compiled-in fallback: every category on, no overrides, today-equivalent limits.
 * Deep-equal-pinned against the "strict" template on both sides of the contract.
 * @returns The default resolved policy
 */
export function defaultResolvedPolicy(): ResolvedPolicy {
  const categories = {} as Record<PIIType, boolean>;
  for (const type of ALL_PII_TYPES) {
    categories[type] = true;
  }
  return {
    version: 1,
    source: { mode: 'template', templateId: 'strict' },
    categories,
    customPatterns: [],
    sensitiveKeys: { add: [], remove: [], forcedAdd: [] },
    limits: { maxTokens: DEFAULT_MAX_TOKENS, ttlMs: DEFAULT_TTL_MS },
    forcedCategories: [],
  };
}

/**
 * Promote a loaded PolicyTemplate into a full ResolvedPolicy (filling in the fields a
 * template does not carry: `forcedAdd`, `limits`, `forcedCategories`).
 * @param template - The template to resolve
 * @returns The resolved policy
 */
export function resolvedPolicyFromTemplate(template: PolicyTemplate): ResolvedPolicy {
  return {
    version: 1,
    source: { mode: 'template', templateId: template.id },
    categories: template.categories,
    customPatterns: template.customPatterns,
    sensitiveKeys: {
      add: template.sensitiveKeys.add,
      remove: template.sensitiveKeys.remove,
      forcedAdd: [],
    },
    limits: { maxTokens: DEFAULT_MAX_TOKENS, ttlMs: DEFAULT_TTL_MS },
    forcedCategories: [],
  };
}

/**
 * Effective enablement of a category: its own flag, OR'd with the MDM forced-on union slot.
 * @param policy - Resolved policy to read
 * @param type - Category to check
 * @returns True if the category is effectively enabled
 */
function isCategoryEnabled(policy: ResolvedPolicy, type: PIIType): boolean {
  return policy.categories[type] || policy.forcedCategories.includes(type);
}

/**
 * Effective sensitive key-name list: defaults + add, minus remove, then forcedAdd re-applied
 * so an MDM-forced key survives a remove (defense-in-depth).
 * @param policy - Resolved policy to read
 * @returns Lowercased, deduplicated effective key-name substrings
 */
function compileSensitiveKeys(policy: ResolvedPolicy): string[] {
  const keys = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));
  for (const k of policy.sensitiveKeys.add) keys.add(k.toLowerCase());
  for (const k of policy.sensitiveKeys.remove) keys.delete(k.toLowerCase());
  for (const k of policy.sensitiveKeys.forcedAdd) keys.add(k.toLowerCase());
  return [...keys];
}

/**
 * Compile a ResolvedPolicy: enabled built-ins in today's exact order, then custom patterns
 * in file order. A custom pattern failing lint is skipped with an error log, never a throw.
 * @param policy - Resolved policy to compile
 * @returns The compiled policy
 */
export function compilePolicy(policy: ResolvedPolicy): CompiledPolicy {
  const categories = {} as Record<PIIType, boolean>;
  for (const type of ALL_PII_TYPES) {
    categories[type] = isCategoryEnabled(policy, type);
  }

  const patterns: CompiledPatternRule[] = [];
  for (const type of PII_PATTERN_ORDER) {
    if (!categories[type]) continue;
    const source = PII_PATTERNS[type];
    /* c8 ignore next — PII_PATTERN_ORDER is exactly the set of keys with a PII_PATTERNS entry */
    if (!source) continue;
    patterns.push({
      type,
      regex: new RegExp(source.source, source.flags),
      validator: PII_VALIDATORS[type],
    });
  }

  for (const custom of policy.customPatterns) {
    const lint = lintPattern(custom.pattern, custom.caseInsensitive);
    if (!lint.ok) {
      console.error(
        `${ts()} custom pattern "${custom.id}" failed lint (${lint.code}): ${lint.message} — skipped`
      );
      continue;
    }
    patterns.push({
      type: custom.id,
      regex: new RegExp(custom.pattern, custom.caseInsensitive ? 'gi' : 'g'),
    });
  }

  const limits = policy.limits ?? { maxTokens: DEFAULT_MAX_TOKENS, ttlMs: DEFAULT_TTL_MS };

  return {
    categories,
    patterns,
    sensitiveKeysEnabled: categories[PIIType.SENSITIVE_FIELD],
    sensitiveKeys: compileSensitiveKeys(policy),
    maxTokens: limits.maxTokens ?? DEFAULT_MAX_TOKENS,
    ttlMs: limits.ttlMs ?? DEFAULT_TTL_MS,
  };
}
