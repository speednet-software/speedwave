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

/** One category's tokenize/log pair; mirror of Rust `PiiCategoryPolicy`. */
export interface CategoryFlagPair {
  tokenize: boolean;
  log: boolean;
}

/** Flag pair per built-in category; mirror of Rust `PiiCategoryPolicies`. */
export type PiiCategoryPolicies = Record<PiiCategory, CategoryFlagPair>;

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
  categories: PiiCategoryPolicies;
}

/** A user-defined policy's Settings metadata; mirror of Rust `CustomPolicyDto`. */
export interface CustomPolicyDto {
  id: string;
  name: string;
  categories: PiiCategoryPolicies;
  custom_patterns: CustomPiiPattern[];
  sensitive_keys_add: string[];
}

/**
 * Mirror of Rust `SecurityPolicyResponse` (`get_security_policy`): the resolved
 * multi-policy union for the active project.
 */
export interface SecurityPolicyResponse {
  /** Effective enabled policy ids (user selection union MDM-forced), presentation order. */
  enabled_policies: string[];
  /** Subset of `enabled_policies` forced by MDM, locked (checked, disabled) in the UI. */
  forced_policies: string[];
  /** Union-resolved flag pair per category; read-only preview. */
  effective_categories: PiiCategoryPolicies;
  /** The user's own policy definitions (editable). */
  custom_policies: CustomPolicyDto[];
}

/**
 * A custom pattern as entered in the Settings form; the server derives the
 * token id from `display_name`; never send one.
 */
export interface SecurityPolicyCustomPatternInput {
  display_name: string;
  pattern: string;
  case_insensitive: boolean;
}

/**
 * A user-defined policy as entered in the Settings form; the server derives
 * the policy id from `name`; never send one. Mirror of Rust `CustomPolicyDtoInput`.
 */
export interface CustomPolicyDtoInput {
  name: string;
  /** This policy's own checklist state (custom ids aren't known before the server derive). */
  enabled: boolean;
  categories: PiiCategoryPolicies;
  custom_patterns: SecurityPolicyCustomPatternInput[];
  sensitive_keys_add: string[];
}

/**
 * Mirror of Rust `SecurityPolicyUpdate`. `policies` and each custom entry's
 * `enabled` carry the user's own selection only, without forced ids.
 */
export interface SecurityPolicyUpdate {
  policies: string[];
  custom_policies: CustomPolicyDtoInput[];
}
