/**
 * Frontend mirror of the security-policy DTOs in `desktop/src-tauri/src/types.rs`
 * (backend is SSOT; snake_case matches the wire).
 */

/** One rule's tokenize/log pair; mirror of Rust `RuleFlags`. */
export interface RuleFlags {
  tokenize: boolean;
  log: boolean;
}

/**
 * Per-rule-id `{tokenize, log}` map. Keys are open PII rule ids sourced from
 * `rules.yaml` (`list_pii_rules`), not a fixed enum — an id absent from the
 * map is off.
 */
export type RuleCategories = Record<string, RuleFlags>;

/** A built-in PII rule from the library; mirror of Rust `PiiRuleInfo` (`list_pii_rules`). */
export interface PiiRuleInfo {
  id: string;
  display_name: string;
}

/** A literal keyword substitution; mirror of Rust `KeywordV3` (camelCase wire). */
export interface KeywordV3 {
  match: string;
  alias: string;
  caseSensitive: boolean;
}

/** A user-defined additive detection rule; mirror of Rust `OwnRuleV3`. */
export interface OwnRule {
  id: string;
  displayName: string;
  patterns: string[];
  validator: string | null;
  caseSensitive: boolean;
  tokenize: boolean;
  log: boolean;
}

/** A resolved rule written to policy.json v3; mirror of Rust `RuleOutput`. */
export interface RuleOutput {
  id: string;
  displayName: string;
  patterns: string[];
  validator?: string;
  caseSensitive: boolean;
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
  categories: RuleCategories;
}

/** A user-defined policy's Settings metadata; mirror of Rust `CustomPolicyDto`. */
export interface CustomPolicyDto {
  id: string;
  name: string;
  categories: RuleCategories;
  rules: OwnRule[];
  keywords: KeywordV3[];
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
  /** Union-resolved rules with at least one flag on; a rule id absent here is fully off. */
  effective_rules: RuleOutput[];
  /** The user's own policy definitions (editable). */
  custom_policies: CustomPolicyDto[];
}

/**
 * A custom detection rule as entered in the Settings form; the server derives
 * the rule id from `display_name`; never send one.
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
  categories: RuleCategories;
  custom_patterns: SecurityPolicyCustomPatternInput[];
  keywords: KeywordV3[];
}

/**
 * Mirror of Rust `SecurityPolicyUpdate`. `policies` and each custom entry's
 * `enabled` carry the user's own selection only, without forced ids.
 */
export interface SecurityPolicyUpdate {
  policies: string[];
  custom_policies: CustomPolicyDtoInput[];
}
