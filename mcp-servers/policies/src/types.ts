/**
 * The PII category enum: a wire-string mirror of Rust `PiiCategory` (`pii_policy.rs`),
 * pinned by `pii_category_serde_matches_policy_engine_ts`. Kept even though the rest of
 * the pre-WASM policy shapes are gone — the wasm engine's `Detection.category` and the
 * host-rendered `policy.json` both spell categories with these exact strings.
 * @module types
 */

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
