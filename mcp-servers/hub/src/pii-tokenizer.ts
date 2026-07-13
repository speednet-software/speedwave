/**
 * Tokenizes PII before data reaches the model and resolves tokens back for MCP-to-MCP calls.
 * @module pii-tokenizer
 */

import { PIIType, PIITokenEntry } from './hub-types.js';
import crypto from 'crypto';
import { ts } from '@speedwave/mcp-shared';

/**
 * PII context for a single execution
 */
export interface PIIContext {
  /** Map of token strings to their PII entries */
  tokens: Map<string, PIITokenEntry>;
  /** Reverse lookup: "type:value" -> token for O(1) deduplication */
  valueToToken: Map<string, string>;
  /** Maximum number of tokens allowed */
  maxTokens: number;
  /** Time-to-live for tokens in milliseconds */
  ttlMs: number;
  /** When this context was created */
  createdAt: Date;
}

/**
 * PII detection patterns (value-based). EMAIL has length limits to prevent ReDoS.
 */
const PII_PATTERNS: Partial<Record<PIIType, RegExp>> = {
  [PIIType.EMAIL]: /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,10}/g,
  [PIIType.PHONE_PL]: /\+?48[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{3}/g,
  [PIIType.PESEL]: /\b\d{11}\b/g,
  [PIIType.NIP]: /\b\d{10}\b/g,
  [PIIType.IBAN]: /[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}([A-Z0-9]?){0,16}/g,
  [PIIType.CARD]: /\b(?:\d{4}[\s-]?){3}\d{4}\b/g,
  [PIIType.API_KEY]:
    /\b(sk-[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9_-]{35}|xoxb-[a-zA-Z0-9-]+|xoxp-[a-zA-Z0-9-]+)\b/g,
  // SENSITIVE_FIELD is detected by key name, not by value pattern
};

/**
 * Sensitive field key names (case-insensitive, partial match via includes).
 */
const SENSITIVE_KEYS = [
  // Authentication & Authorization
  'password',
  'passphrase',
  'token',
  'secret',
  'credential',
  'auth',
  'bearer',
  // API & Keys
  'api_key',
  'apikey',
  'private_key',
  'signing_key',
  'encryption_key',
  // OAuth/Session
  'access_token',
  'refresh_token',
  'client_secret',
  'session',
  'cookie',
  'jwt',
  // MFA/OTP
  'pin',
  'otp',
  '2fa',
  'mfa',
];

/**
 * Validation functions for PII types that have checksums
 */
const PII_VALIDATORS: Partial<Record<PIIType, (value: string) => boolean>> = {
  [PIIType.PESEL]: validatePESEL,
  [PIIType.NIP]: validateNIP,
  [PIIType.CARD]: validateLuhn,
  [PIIType.IBAN]: validateIBAN,
};

/**
 * PESEL checksum validation.
 * @param pesel - PESEL number to validate
 */
function validatePESEL(pesel: string): boolean {
  /* c8 ignore next — PESEL regex /\b\d{11}\b/ always matches exactly 11 digits */
  if (pesel.length !== 11) return false;
  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += parseInt(pesel[i]) * weights[i];
  }
  const checksum = (10 - (sum % 10)) % 10;
  return checksum === parseInt(pesel[10]);
}

/**
 * NIP checksum validation.
 * @param nip - NIP number to validate
 */
function validateNIP(nip: string): boolean {
  /* c8 ignore next — NIP regex /\b\d{10}\b/ always matches exactly 10 digits */
  if (nip.length !== 10) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(nip[i]) * weights[i];
  }
  const checksum = sum % 11;
  return checksum === parseInt(nip[9]);
}

/**
 * Luhn algorithm for credit card validation.
 * @param number - Card number to validate
 */
function validateLuhn(number: string): boolean {
  const digits = number.replace(/\D/g, '');
  /* c8 ignore next — CARD regex constrains to 13–19 digit patterns */
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let isEven = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i]);
    if (isEven) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
}

/**
 * IBAN validation (mod 97 check).
 * @param iban - IBAN to validate
 */
function validateIBAN(iban: string): boolean {
  const cleaned = iban.replace(/\s/g, '').toUpperCase();
  /* c8 ignore next — IBAN regex constrains to 15–34 character patterns */
  if (cleaned.length < 15 || cleaned.length > 34) return false;

  // Move first 4 chars to end
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);

  // Convert letters to numbers (A=10, B=11, etc.)
  let numericString = '';
  for (const char of rearranged) {
    if (char >= 'A' && char <= 'Z') {
      numericString += (char.charCodeAt(0) - 55).toString();
    } else {
      numericString += char;
    }
  }

  // Mod 97 check
  let remainder = 0;
  for (const digit of numericString) {
    remainder = (remainder * 10 + parseInt(digit)) % 97;
  }

  return remainder === 1;
}

/**
 * Create a new PII context for an execution.
 * @param maxTokens - Maximum number of tokens to allow (default: 1000)
 * @param ttlMs - Time-to-live for tokens in milliseconds (default: 30 minutes)
 */
export function createPIIContext(maxTokens = 1000, ttlMs = 30 * 60 * 1000): PIIContext {
  return {
    tokens: new Map(),
    valueToToken: new Map(),
    maxTokens,
    ttlMs,
    createdAt: new Date(),
  };
}

/**
 * Generate a token for a PII value.
 * @param type - Type of PII to generate token for
 */
function generateToken(type: PIIType): string {
  const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `[${type}:TOKEN_${randomPart}]`;
}

/**
 * Matches `author`/`authors` as a complete word segment (excludes `authorization`).
 */
const AUTHOR_SEGMENT = /(^|[^a-z])authors?(?=[^a-z]|$)/g;

/**
 * Check if a key name indicates a sensitive field.
 * @param key - Object key name to check
 */
function isSensitiveKey(key: string): boolean {
  // camelCase → snake_case first, so the segment carve-out sees `co_author`.
  const lowerKey = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(AUTHOR_SEGMENT, '$1');
  return SENSITIVE_KEYS.some((s) => lowerKey.includes(s));
}

/**
 * Tokenize a sensitive field value; returns the original value if the token limit is reached.
 * @param value - The sensitive value to tokenize
 * @param context - PII context for this execution
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
      // Check if key indicates sensitive field
      if (typeof value === 'string' && isSensitiveKey(key)) {
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
 */
function tokenizeString(text: string, context: PIIContext): string {
  let result = text;

  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    const piiType = type as PIIType;
    const validator = PII_VALIDATORS[piiType];

    // Reset pattern lastIndex (required for global regex)
    pattern.lastIndex = 0;

    // Collect unique values to tokenize (avoid processing same value twice)
    const valuesToProcess = new Set<string>();
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[0];

      // Validate if validator exists
      if (validator && !validator(value)) {
        continue;
      }

      valuesToProcess.add(value);
    }

    // Process each unique value
    for (const value of valuesToProcess) {
      const cacheKey = `${piiType}:${value}`;

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

      const token = generateToken(piiType);
      context.tokens.set(token, {
        token,
        type: piiType,
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
 * Detokenize PII in data; resolves tokens back to real values for MCP calls.
 * @param data - Data containing tokens
 * @param context - PII context with token mappings
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
 */
function detokenizeString(text: string, context: PIIContext): string {
  // Match token pattern [TYPE:TOKEN_xxx]
  const tokenPattern = /\[([A-Z_]+):TOKEN_[A-F0-9]+\]/g;

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
 * Clean up expired tokens; removes from both tokens and valueToToken maps.
 * @param context - PII context to clean up
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
 * Get token statistics: total count and breakdown by type.
 * @param context - PII context to get statistics for
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
