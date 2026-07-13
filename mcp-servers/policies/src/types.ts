/**
 * Shared types for the policy engine: PII token bookkeeping plus the policy
 * shapes that flow from resolved-policy JSON / template YAML through compilation.
 * @module types
 */

/**
 * PII Token entry
 */
export interface PIITokenEntry {
  /** Token string (e.g., "[EMAIL:TOKEN_A1B2C3]") */
  token: string;
  /** Type of PII: a PIIType value for built-ins, or a custom pattern's id */
  type: string;
  /** Original sensitive value */
  value: string;
  /** When this token was created */
  createdAt: Date;
  /** Number of times this token has been accessed */
  accessCount: number;
  /** Last time this token was accessed */
  lastAccessed?: Date;
}

/**
 * PII Types supported for tokenization
 */
export enum PIIType {
  EMAIL = 'EMAIL',
  PHONE_PL = 'PHONE_PL',
  PESEL = 'PESEL',
  NIP = 'NIP',
  IBAN = 'IBAN',
  CARD = 'CARD',
  API_KEY = 'API_KEY',
  /** Sensitive field detected by key name (password, token, secret, etc.) */
  SENSITIVE_FIELD = 'SENSITIVE_FIELD',
}

/** Every PIIType member, in declaration order — the exhaustive category-key set. */
export const ALL_PII_TYPES: readonly PIIType[] = Object.values(PIIType);

/**
 * A user-defined detection pattern, additive to the built-in PII_PATTERNS.
 */
export interface CustomPatternRule {
  /** Uppercase-snake token id, e.g. "EMPLOYEE_ID" — must not collide with a built-in PIIType */
  id: string;
  /** Human-readable name shown in UI */
  displayName: string;
  /** Regular expression source (validated by pattern-lint before compilation) */
  pattern: string;
  /** Whether the pattern is matched case-insensitively */
  caseInsensitive: boolean;
  /** MDM-forced pattern that the user cannot remove; re-forced by the engine as defense-in-depth */
  forced: boolean;
}

/**
 * Add/remove/forcedAdd deltas applied to the default sensitive-key list.
 */
export interface SensitiveKeyDelta {
  /** Key-name substrings to add to the default sensitive-key list */
  add: string[];
  /** Key-name substrings to remove from the default sensitive-key list */
  remove: string[];
  /** Key-name substrings that always apply, even if also listed in `remove` */
  forcedAdd: string[];
}

/**
 * How a resolved policy was produced — descriptive metadata only, never consulted by the engine.
 */
export type PolicySelection =
  | { mode: 'template'; templateId: string }
  | { mode: 'custom'; templateId?: string };

/**
 * Optional token-lifecycle overrides; omitted fields keep today's defaults.
 */
export interface PolicyLimits {
  /** Maximum number of tokens a single PIIContext may hold */
  maxTokens?: number;
  /** Token time-to-live in milliseconds */
  ttlMs?: number;
}

/**
 * The fully-resolved policy, as written by the host to `policy.json` (camelCase, version 1).
 */
export interface ResolvedPolicy {
  /** Schema version; the engine supports exactly 1 */
  version: 1;
  /** Provenance of this resolved policy */
  source: PolicySelection;
  /** Enablement per built-in PIIType, exhaustive over all 8 members */
  categories: Record<PIIType, boolean>;
  /** Additive custom detection patterns, applied in array order after built-ins */
  customPatterns: CustomPatternRule[];
  /** Sensitive key-name deltas applied to the default list */
  sensitiveKeys: SensitiveKeyDelta;
  /** Optional token-lifecycle overrides */
  limits?: PolicyLimits;
  /** Categories forced on regardless of `categories`; MDM union slot, empty in v1 */
  forcedCategories: PIIType[];
}

/**
 * A named, shippable policy preset loaded from `templates/*.yaml`. The YAML schema is v2
 * (per-category `{tokenize, log}` pairs); `categories` here is mapped down to booleans
 * (`tokenize`) for today's boolean-only resolved-policy pipeline (still v1, see `ResolvedPolicy`).
 */
export interface PolicyTemplate {
  /** YAML schema version; the loader supports exactly 2 */
  version: 2;
  /** Template id, `^[a-z][a-z0-9-]{1,63}$`; "custom" is reserved */
  id: string;
  /** Human-readable template name */
  name: string;
  /** Human-readable template description */
  description: string;
  /** Enablement per built-in PIIType, exhaustive over all 8 members */
  categories: Record<PIIType, boolean>;
  /** Additive custom detection patterns shipped with the template */
  customPatterns: CustomPatternRule[];
  /** Sensitive key-name add/remove deltas shipped with the template */
  sensitiveKeys: { add: string[]; remove: string[] };
}

/**
 * A single compiled detection rule: a ready-to-run global regex plus its token type.
 */
export interface CompiledPatternRule {
  /** PIIType value for a built-in rule, or a custom pattern's id */
  type: string;
  /** Compiled, stateful global regex — callers must reset `lastIndex` before scanning */
  regex: RegExp;
  /** Checksum validator; only built-ins carry one, custom patterns never do */
  validator?: (value: string) => boolean;
}

/**
 * A ResolvedPolicy, compiled once into the exact data tokenizePII/detokenizePII consume.
 */
export interface CompiledPolicy {
  /** Effective enablement per built-in PIIType (categories OR'd with forcedCategories) */
  categories: Record<PIIType, boolean>;
  /** Value-pattern rules in order: built-ins (today's iteration order), then custom (file order) */
  patterns: CompiledPatternRule[];
  /** Whether key-name based SENSITIVE_FIELD detection is enabled */
  sensitiveKeysEnabled: boolean;
  /** Effective sensitive key-name substrings (defaults + add - remove + forcedAdd), lowercased */
  sensitiveKeys: string[];
  /** Maximum number of tokens a PIIContext created from this policy may hold */
  maxTokens: number;
  /** Token time-to-live in milliseconds for a PIIContext created from this policy */
  ttlMs: number;
}
