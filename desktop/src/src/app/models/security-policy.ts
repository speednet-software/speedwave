/**
 * Frontend mirror of the security-policy DTOs in `desktop/src-tauri/src/types.rs`
 * (backend is SSOT; snake_case matches the wire).
 */

/** Built-in PII category; wire strings match Rust `PiiCategory` serde. */
export type PiiCategory =
  | 'EMAIL'
  | 'PHONE_PL'
  | 'PESEL'
  | 'NIP'
  | 'IBAN'
  | 'CARD'
  | 'API_KEY'
  | 'SENSITIVE_FIELD';

/** Enablement per built-in category; mirror of Rust `PiiCategoryFlags`. */
export type PiiCategoryFlags = Record<PiiCategory, boolean>;

/** A user-defined detection pattern; mirror of Rust `CustomPiiPattern`. */
export interface CustomPiiPattern {
  id: string;
  displayName: string;
  pattern: string;
  caseInsensitive: boolean;
  tokenize: boolean;
  log: boolean;
}

/**
 * A built-in PII policy template's Settings-picker metadata; mirror of Rust
 * `SecurityPolicyTemplateInfo` (`list_security_policy_templates`).
 */
export interface SecurityPolicyTemplateInfo {
  id: string;
  name: string;
  description: string;
  categories: PiiCategoryFlags;
}

/** Mirror of Rust `SecurityPolicyResponse` (`get_security_policy`). */
export interface SecurityPolicyResponse {
  /** A built-in template id, or `"custom"` when the user overrides categories. */
  template: string;
  categories: PiiCategoryFlags;
  custom_patterns: CustomPiiPattern[];
  sensitive_keys_add: string[];
}

/**
 * A custom pattern as entered in the Settings form; the server derives the
 * token id from `display_name` — never send one.
 */
export interface SecurityPolicyCustomPatternInput {
  display_name: string;
  pattern: string;
  case_insensitive: boolean;
}

/**
 * Mirror of Rust `SecurityPolicyUpdate` (`update_security_policy`). `template`
 * selects a built-in id or `"custom"`; the server re-validates every field.
 */
export interface SecurityPolicyUpdate {
  template: string;
  categories: PiiCategoryFlags;
  custom_patterns: SecurityPolicyCustomPatternInput[];
  sensitive_keys_add: string[];
}
