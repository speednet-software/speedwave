/**
 * Policy-driven PII tokenization engine: a superset of the hub's former inline tokenizer
 * module that behaves bit-identically under the default (all-categories-on) policy.
 * @module speedwave/policy-engine
 */

// Types
export type {
  PIITokenEntry,
  CustomPatternRule,
  SensitiveKeyDelta,
  PolicySelection,
  PolicyLimits,
  ResolvedPolicy,
  PolicyTemplate,
  CompiledPatternRule,
  CompiledPolicy,
} from './types.js';
export { PIIType, ALL_PII_TYPES } from './types.js';

// Built-in patterns and sensitive-key detection
export { PII_PATTERNS, PII_PATTERN_ORDER, SENSITIVE_KEYS, isSensitiveKey } from './patterns.js';

// Checksum validators
export {
  validatePESEL,
  validateNIP,
  validateLuhn,
  validateIBAN,
  PII_VALIDATORS,
} from './validators.js';

// ReDoS pattern lint
export { lintPattern } from './pattern-lint.js';
export type {
  PatternLintErrorCode,
  PatternLintResult,
  PatternLintOk,
  PatternLintFailure,
} from './pattern-lint.js';

// Template schema validation
export {
  parseTemplate,
  parseCategories,
  parseCustomPatterns,
  parseCustomPatternRule,
} from './template-schema.js';

// Template loading
export { loadTemplate, loadAllTemplates, SHIPPED_TEMPLATE_IDS } from './template-loader.js';

// Resolved-policy: parse, default, promote-from-template, compile
export {
  parseResolvedPolicy,
  defaultResolvedPolicy,
  resolvedPolicyFromTemplate,
  compilePolicy,
} from './resolved-policy.js';

// Runtime policy resolution (POLICY_FILE)
export { resolvePolicy } from './resolve.js';

// Tokenizer runtime
export {
  createPIIContext,
  tokenizePII,
  detokenizePII,
  cleanupExpiredTokens,
  getTokenStats,
} from './tokenizer.js';
export type { PIIContext } from './tokenizer.js';
