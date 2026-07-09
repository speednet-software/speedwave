/**
 * Tokenizes PII before data reaches the model and resolves tokens back for MCP-to-MCP calls,
 * driven entirely by a pre-compiled CompiledPolicy.
 * @module tokenizer
 */

import crypto from 'crypto';
import { ts } from '@speedwave/mcp-shared';
import { isSensitiveKey } from './patterns.js';
import { PIIType, type CompiledPolicy, type PIITokenEntry } from './types.js';

/**
 * PII context for a single execution
 */
export interface PIIContext {
  /** Map of token strings to their PII entries */
  tokens: Map<string, PIITokenEntry>;
  /** Reverse lookup: "type:value" -> token for O(1) deduplication */
  valueToToken: Map<string, string>;
  /** The compiled policy this context tokenizes/detokenizes against */
  policy: CompiledPolicy;
  /** Maximum number of tokens allowed */
  maxTokens: number;
  /** Time-to-live for tokens in milliseconds */
  ttlMs: number;
  /** When this context was created */
  createdAt: Date;
}

/**
 * Create a new PII context for an execution
 * @param policy - Compiled policy to tokenize/detokenize against
 * @param opts - Per-context overrides for the policy's token-lifecycle defaults
 * @param opts.maxTokens - Overrides `policy.maxTokens` for this context only
 * @param opts.ttlMs - Overrides `policy.ttlMs` for this context only
 * @returns New PII context
 */
export function createPIIContext(
  policy: CompiledPolicy,
  opts?: { maxTokens?: number; ttlMs?: number }
): PIIContext {
  return {
    tokens: new Map(),
    valueToToken: new Map(),
    policy,
    maxTokens: opts?.maxTokens ?? policy.maxTokens,
    ttlMs: opts?.ttlMs ?? policy.ttlMs,
    createdAt: new Date(),
  };
}

/**
 * Generate a token for a PII value
 * @param type - Type of PII to generate token for (a PIIType, or a custom pattern id)
 * @returns Generated token string
 */
function generateToken(type: string): string {
  const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `[${type}:TOKEN_${randomPart}]`;
}

/**
 * Tokenize a sensitive field value
 * @param value - The sensitive value to tokenize
 * @param context - PII context for this execution
 * @returns Token string or original value if limit reached
 */
function tokenizeSensitiveValue(value: string, context: PIIContext): string {
  const cacheKey = `${PIIType.SENSITIVE_FIELD}:${value}`;

  // O(1) lookup via cache
  const existingToken = context.valueToToken.get(cacheKey);
  if (existingToken) {
    const entry = context.tokens.get(existingToken);
    /* c8 ignore next — tokens and valueToToken maps are always in sync */
    if (entry) {
      entry.accessCount++;
      entry.lastAccessed = new Date();
    }
    return existingToken;
  }

  // Create new token if within limit
  if (context.tokens.size >= context.maxTokens) {
    console.warn(`${ts()} PII token limit reached, skipping sensitive field tokenization`);
    return value;
  }

  const token = generateToken(PIIType.SENSITIVE_FIELD);
  context.tokens.set(token, {
    token,
    type: PIIType.SENSITIVE_FIELD,
    value,
    createdAt: new Date(),
    accessCount: 1,
  });
  context.valueToToken.set(cacheKey, token);

  return token;
}

/**
 * Recursively tokenize PII in data by value patterns and key names.
 * @param data - Data to tokenize
 * @param context - PII context for this execution
 * @returns Tokenized data
 */
export function tokenizePII(data: unknown, context: PIIContext): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return tokenizeString(data, context);
  }

  if (Array.isArray(data)) {
    return data.map((item) => tokenizePII(item, context));
  }

  if (typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      // Check if key indicates sensitive field (category-gated: skipped entirely when off)
      if (
        context.policy.sensitiveKeysEnabled &&
        typeof value === 'string' &&
        isSensitiveKey(key, context.policy.sensitiveKeys)
      ) {
        // Tokenize the entire value as SENSITIVE_FIELD
        result[key] = tokenizeSensitiveValue(value, context);
      } else {
        // Recursively tokenize (will detect value-based patterns)
        result[key] = tokenizePII(value, context);
      }
    }
    return result;
  }

  return data;
}

/**
 * Tokenize PII in a string.
 * @param text - String to tokenize
 * @param context - PII context for this execution
 * @returns Tokenized string
 */
function tokenizeString(text: string, context: PIIContext): string {
  let result = text;

  for (const rule of context.policy.patterns) {
    const { type, regex, validator } = rule;

    // Reset pattern lastIndex (required for global regex)
    regex.lastIndex = 0;

    // Collect unique values to tokenize (avoid processing same value twice)
    const valuesToProcess = new Set<string>();
    let match;
    while ((match = regex.exec(text)) !== null) {
      const value = match[0];

      if (value.length === 0) {
        // Backstop: a zero-length match must not spin regex.exec forever at the same lastIndex.
        regex.lastIndex++;
        continue;
      }

      // Validate if validator exists
      if (validator && !validator(value)) {
        continue;
      }

      valuesToProcess.add(value);
    }

    // Process each unique value
    for (const value of valuesToProcess) {
      const cacheKey = `${type}:${value}`;

      // O(1) lookup via cache
      const existingToken = context.valueToToken.get(cacheKey);
      if (existingToken) {
        const entry = context.tokens.get(existingToken);
        /* c8 ignore next — tokens and valueToToken maps are always in sync */
        if (entry) {
          entry.accessCount++;
          entry.lastAccessed = new Date();
        }
        // Replace ALL occurrences
        result = result.replaceAll(value, existingToken);
        continue;
      }

      // Create new token if within limit
      if (context.tokens.size >= context.maxTokens) {
        console.warn(`${ts()} PII token limit reached, skipping tokenization`);
        continue;
      }

      const token = generateToken(type);
      context.tokens.set(token, {
        token,
        type,
        value,
        createdAt: new Date(),
        accessCount: 1,
      });
      context.valueToToken.set(cacheKey, token);

      // Replace ALL occurrences
      result = result.replaceAll(value, token);
    }
  }

  return result;
}

/**
 * Detokenize PII in data
 * Resolves tokens back to real values for MCP calls
 * @param data - Data containing tokens
 * @param context - PII context with token mappings
 * @returns Detokenized data
 */
export function detokenizePII(data: unknown, context: PIIContext): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return detokenizeString(data, context);
  }

  if (Array.isArray(data)) {
    return data.map((item) => detokenizePII(item, context));
  }

  if (typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = detokenizePII(value, context);
    }
    return result;
  }

  return data;
}

/**
 * Detokenize PII in a string using reverse-order replacement.
 * @param text - String containing tokens
 * @param context - PII context with token mappings
 * @returns Detokenized string
 */
function detokenizeString(text: string, context: PIIContext): string {
  // Match token pattern [TYPE:TOKEN_xxx] — widened over the built-in-only [A-Z_]+ so a custom
  // pattern id containing digits (e.g. "EMP2_ID") is recognized too.
  const tokenPattern = /\[([A-Z][A-Z0-9_]*):TOKEN_[A-F0-9]+\]/g;

  // Collect all replacements with their positions
  const replacements: Array<{ token: string; value: string; index: number }> = [];

  let match;
  while ((match = tokenPattern.exec(text)) !== null) {
    const token = match[0];
    const entry = context.tokens.get(token);

    if (entry) {
      replacements.push({
        token,
        value: entry.value,
        index: match.index,
      });
      entry.accessCount++;
      entry.lastAccessed = new Date();
    }
  }

  // Replace from end to start to preserve indices
  let result = text;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { token, value, index } = replacements[i];
    result = result.substring(0, index) + value + result.substring(index + token.length);
  }

  return result;
}

/**
 * Clean up expired tokens
 * Removes from both tokens and valueToToken maps
 * @param context - PII context to clean up
 * @returns Number of tokens removed
 */
export function cleanupExpiredTokens(context: PIIContext): number {
  const now = Date.now();
  let removed = 0;

  for (const [token, entry] of context.tokens) {
    const age = now - entry.createdAt.getTime();
    if (age > context.ttlMs) {
      context.tokens.delete(token);
      // Also remove from reverse lookup
      const cacheKey = `${entry.type}:${entry.value}`;
      context.valueToToken.delete(cacheKey);
      removed++;
    }
  }

  return removed;
}

/**
 * Get token statistics
 * @param context - PII context to get statistics for
 * @returns Token statistics including total count and breakdown by type
 */
export function getTokenStats(context: PIIContext): {
  total: number;
  byType: Record<string, number>;
} {
  const byType: Record<string, number> = {};

  for (const entry of context.tokens.values()) {
    byType[entry.type] = (byType[entry.type] || 0) + 1;
  }

  return {
    total: context.tokens.size,
    byType,
  };
}
