/**
 * Built-in PII value patterns and sensitive key-name detection.
 * @module patterns
 */

import { PIIType } from './types.js';

/**
 * PII detection patterns (value-based). EMAIL has length limits to prevent ReDoS.
 */
export const PII_PATTERNS: Partial<Record<PIIType, RegExp>> = {
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
 * Built-in value-pattern types, in today's exact compilation/iteration order.
 */
export const PII_PATTERN_ORDER: PIIType[] = [
  PIIType.EMAIL,
  PIIType.PHONE_PL,
  PIIType.PESEL,
  PIIType.NIP,
  PIIType.IBAN,
  PIIType.CARD,
  PIIType.API_KEY,
];

/**
 * Default sensitive field key names (case-insensitive, partial match via includes).
 */
export const SENSITIVE_KEYS = [
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
 * Matches `author`/`authors` as a complete word segment (excludes `authorization`).
 */
const AUTHOR_SEGMENT = /(^|[^a-z])authors?(?=[^a-z]|$)/g;

/**
 * Check if a key name indicates a sensitive field, against a given effective key list.
 * @param key - Object key name to check
 * @param sensitiveKeys - Effective sensitive key-name substrings (already lowercased)
 * @returns True if the key indicates sensitive data
 */
export function isSensitiveKey(key: string, sensitiveKeys: readonly string[]): boolean {
  // camelCase → snake_case first, so the segment carve-out sees `co_author`.
  const lowerKey = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(AUTHOR_SEGMENT, '$1');
  return sensitiveKeys.some((s) => lowerKey.includes(s));
}
