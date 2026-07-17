//! PII policy config model: built-in templates, the resolved `policy.json`
//! contract, and save-time validation (TS counterpart: `mcp-servers/policies`).

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// Maximum number of custom patterns a user may store (save-time gate).
pub const PII_MAX_CUSTOM_PATTERNS: usize = 32;
/// Maximum number of sensitive-key additions a user may store (save-time gate).
pub const PII_MAX_SENSITIVE_KEYS: usize = 64;
/// Minimum length (bytes) of a custom pattern's regex source, mirroring `pattern-lint.ts`'s `MIN_LENGTH`.
pub const PII_PATTERN_MIN_LEN: usize = 3;
/// Maximum length (bytes) of a custom pattern's regex source, mirroring `pattern-lint.ts`'s `MAX_LENGTH`.
pub const PII_PATTERN_MAX_LEN: usize = 256;
/// Maximum stored length (bytes) of a custom pattern's display name.
pub const PII_PATTERN_NAME_MAX_LEN: usize = 64;
/// Maximum stored length (bytes) of a single sensitive-key substring.
const SENSITIVE_KEY_MAX_LEN: usize = 64;
/// Maximum bound of a group-applied counted quantifier (the `){n}`/`){n,}`/`){n,m}`
/// form), mirroring `pattern-lint.ts`'s `MAX_QUANTIFIER_COUNT`. Atom and char-class
/// quantifiers are exempt (linear-time, not a ReDoS risk), as in the TS lint.
const PII_PATTERN_MAX_QUANTIFIER: u32 = 128;

/// A built-in PII category. Serde strings are the exact TS `PIIType` wire
/// values — pinned by `pii_category_serde_matches_policy_engine_ts`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PiiCategory {
    /// Email addresses.
    #[serde(rename = "EMAIL")]
    Email,
    /// Polish phone numbers.
    #[serde(rename = "PHONE_PL")]
    PhonePl,
    /// Polish national identification number.
    #[serde(rename = "PESEL")]
    Pesel,
    /// Polish tax identification number.
    #[serde(rename = "NIP")]
    Nip,
    /// International bank account number.
    #[serde(rename = "IBAN")]
    Iban,
    /// Payment card number.
    #[serde(rename = "CARD")]
    Card,
    /// API key / credential-shaped token.
    #[serde(rename = "API_KEY")]
    ApiKey,
    /// Detected by key name rather than value pattern (password, token, ...).
    #[serde(rename = "SENSITIVE_FIELD")]
    SensitiveField,
}

impl PiiCategory {
    /// Every category, in the contract's declaration order.
    pub const ALL: [PiiCategory; 8] = [
        PiiCategory::Email,
        PiiCategory::PhonePl,
        PiiCategory::Pesel,
        PiiCategory::Nip,
        PiiCategory::Iban,
        PiiCategory::Card,
        PiiCategory::ApiKey,
        PiiCategory::SensitiveField,
    ];

    /// The exact wire string this category (de)serializes to.
    pub fn wire_str(self) -> &'static str {
        match self {
            Self::Email => "EMAIL",
            Self::PhonePl => "PHONE_PL",
            Self::Pesel => "PESEL",
            Self::Nip => "NIP",
            Self::Iban => "IBAN",
            Self::Card => "CARD",
            Self::ApiKey => "API_KEY",
            Self::SensitiveField => "SENSITIVE_FIELD",
        }
    }
}

/// Enablement per built-in PII category. Exhaustive: all 8 fields are
/// required (no `Option`/default) and unknown keys are rejected on parse.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PiiCategoryFlags {
    /// [`PiiCategory::Email`] enablement.
    #[serde(rename = "EMAIL")]
    pub email: bool,
    /// [`PiiCategory::PhonePl`] enablement.
    #[serde(rename = "PHONE_PL")]
    pub phone_pl: bool,
    /// [`PiiCategory::Pesel`] enablement.
    #[serde(rename = "PESEL")]
    pub pesel: bool,
    /// [`PiiCategory::Nip`] enablement.
    #[serde(rename = "NIP")]
    pub nip: bool,
    /// [`PiiCategory::Iban`] enablement.
    #[serde(rename = "IBAN")]
    pub iban: bool,
    /// [`PiiCategory::Card`] enablement.
    #[serde(rename = "CARD")]
    pub card: bool,
    /// [`PiiCategory::ApiKey`] enablement.
    #[serde(rename = "API_KEY")]
    pub api_key: bool,
    /// [`PiiCategory::SensitiveField`] enablement.
    #[serde(rename = "SENSITIVE_FIELD")]
    pub sensitive_field: bool,
}

impl PiiCategoryFlags {
    /// Every category enabled — the compiled-in / "strict" baseline.
    pub const ALL_ON: Self = Self {
        email: true,
        phone_pl: true,
        pesel: true,
        nip: true,
        iban: true,
        card: true,
        api_key: true,
        sensitive_field: true,
    };

    /// Every category disabled — backs the beta-off no-op policy.
    pub const ALL_OFF: Self = Self {
        email: false,
        phone_pl: false,
        pesel: false,
        nip: false,
        iban: false,
        card: false,
        api_key: false,
        sensitive_field: false,
    };

    /// Reads the flag for one category.
    pub fn get(&self, category: PiiCategory) -> bool {
        match category {
            PiiCategory::Email => self.email,
            PiiCategory::PhonePl => self.phone_pl,
            PiiCategory::Pesel => self.pesel,
            PiiCategory::Nip => self.nip,
            PiiCategory::Iban => self.iban,
            PiiCategory::Card => self.card,
            PiiCategory::ApiKey => self.api_key,
            PiiCategory::SensitiveField => self.sensitive_field,
        }
    }

    /// Sets the flag for one category.
    pub fn set(&mut self, category: PiiCategory, value: bool) {
        match category {
            PiiCategory::Email => self.email = value,
            PiiCategory::PhonePl => self.phone_pl = value,
            PiiCategory::Pesel => self.pesel = value,
            PiiCategory::Nip => self.nip = value,
            PiiCategory::Iban => self.iban = value,
            PiiCategory::Card => self.card = value,
            PiiCategory::ApiKey => self.api_key = value,
            PiiCategory::SensitiveField => self.sensitive_field = value,
        }
    }
}

impl Default for PiiCategoryFlags {
    fn default() -> Self {
        Self::ALL_ON
    }
}

/// A user-defined detection pattern, additive to the built-in categories, with its
/// own `{tokenize, log}` pair (forcing lives at the POLICY level, ADR-079 dropped it here).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomPiiPattern {
    /// Uppercase-snake token id; must not collide with a built-in category.
    pub id: String,
    /// Human-readable name shown in UI.
    pub display_name: String,
    /// Regex source, validated by [`validate_value_pattern`] before storage.
    pub pattern: String,
    /// Whether the pattern is matched case-insensitively.
    pub case_insensitive: bool,
    /// Whether hits in this pattern are tokenized (sealed) before leaving the engine.
    pub tokenize: bool,
    /// Whether hits in this pattern are logged (observation mode).
    pub log: bool,
}

/// Sensitive key-name add/remove deltas as shipped by a template or user config.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PiiSensitiveKeyDelta {
    /// Key-name substrings to add to the default sensitive-key list.
    #[serde(default)]
    pub add: Vec<String>,
    /// Key-name substrings to remove from the default sensitive-key list.
    #[serde(default)]
    pub remove: Vec<String>,
}

/// Per-category tokenize/log flag pair from policy.json v2 (mirrors the engine's
/// `speedwave_pii_engine::policy::CategoryFlags`, kept as an independent serde
/// type since writer and reader schemas are validated separately).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PiiCategoryPolicy {
    /// Whether hits in this category are tokenized (sealed) before leaving the engine.
    pub tokenize: bool,
    /// Whether hits in this category are logged (observation mode).
    pub log: bool,
}

impl From<bool> for PiiCategoryPolicy {
    /// A v1-style bool enablement maps to `tokenize: bool, log: false`.
    fn from(tokenize: bool) -> Self {
        Self {
            tokenize,
            log: false,
        }
    }
}

/// A custom pattern as written to `policy.json` v2: same identity/regex fields
/// as [`CustomPiiPattern`], `forced` dropped (host-only), a flag pair added.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedCustomPiiPattern {
    /// Uppercase-snake token id; must not collide with a built-in category.
    pub id: String,
    /// Human-readable name shown in UI.
    pub display_name: String,
    /// Regex source, validated by [`validate_value_pattern`] before storage.
    pub pattern: String,
    /// Whether the pattern is matched case-insensitively.
    pub case_insensitive: bool,
    /// Whether hits are tokenized; always `true` today (every stored pattern is active).
    pub tokenize: bool,
    /// Whether hits are logged; always `false` today (no log-only mode yet).
    pub log: bool,
}

impl From<&CustomPiiPattern> for ResolvedCustomPiiPattern {
    fn from(p: &CustomPiiPattern) -> Self {
        Self {
            id: p.id.clone(),
            display_name: p.display_name.clone(),
            pattern: p.pattern.clone(),
            case_insensitive: p.case_insensitive,
            tokenize: p.tokenize,
            log: p.log,
        }
    }
}

/// Enablement per built-in category as a `{tokenize, log}` pair, exhaustive over
/// all 8 categories (mirrors the policy.json v2 `categories` object). Shared by
/// `PolicyTemplate` and `ResolvedPiiPolicy`, paralleling how [`PiiCategoryFlags`]
/// is shared on the bool-only config side.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PiiCategoryPolicies {
    /// [`PiiCategory::Email`] flags.
    #[serde(rename = "EMAIL")]
    pub email: PiiCategoryPolicy,
    /// [`PiiCategory::PhonePl`] flags.
    #[serde(rename = "PHONE_PL")]
    pub phone_pl: PiiCategoryPolicy,
    /// [`PiiCategory::Pesel`] flags.
    #[serde(rename = "PESEL")]
    pub pesel: PiiCategoryPolicy,
    /// [`PiiCategory::Nip`] flags.
    #[serde(rename = "NIP")]
    pub nip: PiiCategoryPolicy,
    /// [`PiiCategory::Iban`] flags.
    #[serde(rename = "IBAN")]
    pub iban: PiiCategoryPolicy,
    /// [`PiiCategory::Card`] flags.
    #[serde(rename = "CARD")]
    pub card: PiiCategoryPolicy,
    /// [`PiiCategory::ApiKey`] flags.
    #[serde(rename = "API_KEY")]
    pub api_key: PiiCategoryPolicy,
    /// [`PiiCategory::SensitiveField`] flags.
    #[serde(rename = "SENSITIVE_FIELD")]
    pub sensitive_field: PiiCategoryPolicy,
}

impl PiiCategoryPolicies {
    /// Reads the flag pair for one category.
    pub fn get(&self, category: PiiCategory) -> PiiCategoryPolicy {
        match category {
            PiiCategory::Email => self.email,
            PiiCategory::PhonePl => self.phone_pl,
            PiiCategory::Pesel => self.pesel,
            PiiCategory::Nip => self.nip,
            PiiCategory::Iban => self.iban,
            PiiCategory::Card => self.card,
            PiiCategory::ApiKey => self.api_key,
            PiiCategory::SensitiveField => self.sensitive_field,
        }
    }
}

impl From<PiiCategoryFlags> for PiiCategoryPolicies {
    /// Every bool maps to `{tokenize: bool, log: false}` — v2 has no log-only
    /// concept on the config side yet.
    fn from(flags: PiiCategoryFlags) -> Self {
        Self {
            email: flags.email.into(),
            phone_pl: flags.phone_pl.into(),
            pesel: flags.pesel.into(),
            nip: flags.nip.into(),
            iban: flags.iban.into(),
            card: flags.card.into(),
            api_key: flags.api_key.into(),
            sensitive_field: flags.sensitive_field.into(),
        }
    }
}

impl From<PiiCategoryPolicies> for PiiCategoryFlags {
    /// Drops `log`; the only direction today's bool-only UI/config consumers need.
    fn from(policies: PiiCategoryPolicies) -> Self {
        Self {
            email: policies.email.tokenize,
            phone_pl: policies.phone_pl.tokenize,
            pesel: policies.pesel.tokenize,
            nip: policies.nip.tokenize,
            iban: policies.iban.tokenize,
            card: policies.card.tokenize,
            api_key: policies.api_key.tokenize,
            sensitive_field: policies.sensitive_field.tokenize,
        }
    }
}

/// Provenance of a resolved policy.json v2 (mirrors the contract's `source` object).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedPiiPolicySource {
    /// The effective policy id set (user selection ∪ MDM-forced ids).
    pub policies: Vec<String>,
    /// The subset of `policies` forced on by MDM.
    pub forced: Vec<String>,
}

/// A named, shippable policy preset loaded from `templates/*.yaml` (mirrors
/// TS `PolicyTemplate`). Unknown top-level keys are hard rejected.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyTemplate {
    /// Schema version; the engine supports exactly 2.
    pub version: u32,
    /// Template id, `^[a-z][a-z0-9-]{1,63}$`; "custom" is reserved.
    pub id: String,
    /// Human-readable template name.
    pub name: String,
    /// Human-readable template description.
    pub description: String,
    /// Enablement per built-in category, exhaustive.
    pub categories: PiiCategoryPolicies,
    /// Additive custom detection patterns shipped with the template.
    #[serde(default)]
    pub custom_patterns: Vec<CustomPiiPattern>,
    /// Sensitive key-name add/remove deltas shipped with the template.
    #[serde(default)]
    pub sensitive_keys: PiiSensitiveKeyDelta,
}

/// The fully-resolved policy written to `policy.json` v2, consumed by
/// `speedwave_pii_engine::compile_policy_v2`. `Default` is the compiled-in
/// fallback: every category tokenized, nothing logged.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPiiPolicy {
    /// Schema version; the engine supports exactly 2.
    pub version: u8,
    /// Provenance of this resolved policy.
    pub source: ResolvedPiiPolicySource,
    /// Flag pair per built-in category, exhaustive.
    pub categories: PiiCategoryPolicies,
    /// Additive custom detection patterns, in application order.
    pub custom_patterns: Vec<ResolvedCustomPiiPattern>,
    /// Final sensitive key-name list: defaults + add − remove, lowercased,
    /// sorted, deduplicated.
    pub sensitive_keys: Vec<String>,
}

impl Default for ResolvedPiiPolicy {
    fn default() -> Self {
        safe_default_policy()
    }
}

/// Fail-closed fallback (every category tokenized, no patterns): both `Default`
/// and the empty-effective-set resolution, kept panic-free so it can back `Default`.
fn safe_default_policy() -> ResolvedPiiPolicy {
    let sensitive_keys: std::collections::BTreeSet<String> =
        speedwave_pii_engine::default_sensitive_keys()
            .iter()
            .map(|k| k.to_lowercase())
            .collect();
    ResolvedPiiPolicy {
        version: 2,
        source: ResolvedPiiPolicySource::default(),
        categories: PiiCategoryFlags::ALL_ON.into(),
        custom_patterns: Vec::new(),
        sensitive_keys: sensitive_keys.into_iter().collect(),
    }
}

/// The beta-off no-op policy: nothing tokenized or logged, no patterns, no
/// sensitive keys — the proxy and hub engines compile it to zero rules.
pub fn disabled_policy() -> ResolvedPiiPolicy {
    ResolvedPiiPolicy {
        version: 2,
        source: ResolvedPiiPolicySource::default(),
        categories: PiiCategoryFlags::ALL_OFF.into(),
        custom_patterns: Vec::new(),
        sensitive_keys: Vec::new(),
    }
}

/// PII tokenization is beta-gated (ADR-058); MDM-forced policies apply
/// regardless of the toggle — an org policy must never silently vanish.
pub fn pii_feature_enabled(
    beta_enabled: bool,
    managed: Option<&crate::config::ManagedPiiPolicyConfig>,
) -> bool {
    beta_enabled || managed.is_some_and(|m| !m.forced_policies.is_empty())
}

static TEMPLATE_ID_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9-]{1,63}$"));
static CUSTOM_PATTERN_ID_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"^[A-Z][A-Z0-9_]{2,31}$"));

/// Fetches a lazily-compiled id-shape regex, mapping a compile failure to a
/// validation error instead of a panic (no-panic rule outside tests).
fn id_regex(re: &'static LazyLock<Result<Regex, regex::Error>>) -> Result<&'static Regex, String> {
    (**re)
        .as_ref()
        .map_err(|e| format!("internal id pattern failed to compile: {e}"))
}

/// Validates a custom pattern id: shape plus no collision with a built-in category.
pub fn validate_custom_pattern_id(id: &str) -> Result<(), String> {
    if !id_regex(&CUSTOM_PATTERN_ID_RE)?.is_match(id) {
        return Err(format!("id \"{id}\" must match ^[A-Z][A-Z0-9_]{{2,31}}$"));
    }
    if PiiCategory::ALL.iter().any(|c| c.wire_str() == id) {
        return Err(format!("id \"{id}\" collides with a built-in PII category"));
    }
    Ok(())
}

/// Derives a token id from a human-readable display name: uppercases
/// alphanumerics, collapses runs of other characters to a single `_`.
pub fn derive_custom_pattern_id(display_name: &str) -> Result<String, String> {
    let mut id = String::new();
    let mut prev_sep = true;
    for ch in display_name.chars() {
        if ch.is_ascii_alphanumeric() {
            id.push(ch.to_ascii_uppercase());
            prev_sep = false;
        } else if !prev_sep {
            id.push('_');
            prev_sep = true;
        }
    }
    while id.ends_with('_') {
        id.pop();
    }
    validate_custom_pattern_id(&id)?;
    Ok(id)
}

/// Save-time gate, a superset of the TS load lint so a saved pattern never gets silently dropped
/// at load: length in [`PII_PATTERN_MIN_LEN`]..=[`PII_PATTERN_MAX_LEN`] bytes, compiles under `regex`,
/// does not match the empty string, no group-applied counted quantifier over
/// [`PII_PATTERN_MAX_QUANTIFIER`], free of `(a+)+`-nesting.
pub fn validate_value_pattern(pattern: &str) -> Result<(), String> {
    if pattern.len() < PII_PATTERN_MIN_LEN || pattern.len() > PII_PATTERN_MAX_LEN {
        return Err(format!(
            "pattern length {} is outside the allowed {PII_PATTERN_MIN_LEN}..={PII_PATTERN_MAX_LEN} bytes",
            pattern.len()
        ));
    }
    let compiled = Regex::new(pattern).map_err(|e| format!("pattern does not compile: {e}"))?;
    if compiled.is_match("") {
        return Err("pattern must not match the empty string".to_string());
    }
    scan_quantifier_bounds(pattern)?;
    scan_nested_quantifiers(pattern)
}

/// Save-time gate for a sensitive-key substring: non-empty, at most 64 bytes,
/// lowercase, no control characters.
pub fn validate_sensitive_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("sensitive key must not be empty".to_string());
    }
    if key.len() > SENSITIVE_KEY_MAX_LEN {
        return Err(format!(
            "sensitive key exceeds {SENSITIVE_KEY_MAX_LEN} bytes"
        ));
    }
    if key.chars().any(|c| c.is_control()) {
        return Err("sensitive key must not contain control characters".to_string());
    }
    if key.chars().any(|c| c.is_uppercase()) {
        return Err("sensitive key must be lowercase".to_string());
    }
    Ok(())
}

/// Validates a policy id: shape plus no collision with a built-in template id.
/// Shared by save-time validation and resolve-time defense-in-depth.
fn validate_policy_id_against_templates(
    id: &str,
    templates: &[PolicyTemplate],
) -> Result<(), String> {
    if !id_regex(&TEMPLATE_ID_RE)?.is_match(id) {
        return Err(format!(
            "policy id \"{id}\" must match ^[a-z][a-z0-9-]{{1,63}}$"
        ));
    }
    if templates.iter().any(|t| t.id == id) {
        return Err(format!(
            "policy id \"{id}\" collides with a built-in template id"
        ));
    }
    Ok(())
}

/// Save-time gate for one policy definition's own contents: per-pattern and
/// per-key validation plus the list-size caps.
fn validate_policy_definition_contents(
    def: &crate::config::PiiPolicyDefinition,
) -> Result<(), String> {
    if def.name.trim().is_empty() {
        return Err(format!("policy \"{}\": name must not be empty", def.id));
    }
    if def.custom_patterns.len() > PII_MAX_CUSTOM_PATTERNS {
        return Err(format!(
            "policy \"{}\": at most {PII_MAX_CUSTOM_PATTERNS} custom patterns are allowed",
            def.id
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for p in &def.custom_patterns {
        if p.display_name.trim().is_empty() {
            return Err(format!(
                "policy \"{}\" pattern \"{}\": display name must not be empty",
                def.id, p.id
            ));
        }
        if p.display_name.len() > PII_PATTERN_NAME_MAX_LEN {
            return Err(format!(
                "policy \"{}\" pattern \"{}\": display name exceeds {PII_PATTERN_NAME_MAX_LEN} bytes",
                def.id, p.id
            ));
        }
        validate_custom_pattern_id(&p.id)?;
        if !seen.insert(p.id.clone()) {
            return Err(format!(
                "policy \"{}\": duplicate custom pattern id \"{}\"",
                def.id, p.id
            ));
        }
        validate_value_pattern(&p.pattern)?;
    }
    if def.sensitive_keys.add.len() > PII_MAX_SENSITIVE_KEYS {
        return Err(format!(
            "policy \"{}\": at most {PII_MAX_SENSITIVE_KEYS} sensitive keys are allowed",
            def.id
        ));
    }
    for key in def
        .sensitive_keys
        .add
        .iter()
        .chain(def.sensitive_keys.remove.iter())
    {
        validate_sensitive_key(key)?;
    }
    Ok(())
}

/// Save-time gate for a full user PII policy selection: per-definition
/// validation, id collisions/duplicates, and unknown ids in `policies`.
pub fn validate_user_policy_config(cfg: &crate::config::PiiPolicyUserConfig) -> Result<(), String> {
    let templates = builtin_templates().map_err(|e| e.to_string())?;

    let mut seen_ids = std::collections::HashSet::new();
    for def in &cfg.custom_policies {
        validate_policy_id_against_templates(&def.id, templates)?;
        if !seen_ids.insert(def.id.clone()) {
            return Err(format!("duplicate custom policy id \"{}\"", def.id));
        }
        validate_policy_definition_contents(def)?;
    }

    let known_ids: std::collections::HashSet<&str> = templates
        .iter()
        .map(|t| t.id.as_str())
        .chain(cfg.custom_policies.iter().map(|d| d.id.as_str()))
        .collect();
    for id in &cfg.policies {
        if !known_ids.contains(id.as_str()) {
            return Err(format!("policy list references unknown id \"{id}\""));
        }
    }
    Ok(())
}

/// A quantifier at `b[i]`: `(length consumed, is open-ended)`. A `{` whose
/// body doesn't start with a digit is left as a literal (not a real quantifier).
fn quantifier_at(b: &[u8], i: usize) -> Option<(usize, bool)> {
    match b.get(i) {
        Some(b'*') | Some(b'+') => {
            let mut len = 1;
            if b.get(i + 1) == Some(&b'?') {
                len += 1;
            }
            Some((len, true))
        }
        Some(b'{') => {
            if !matches!(b.get(i + 1), Some(c) if c.is_ascii_digit()) {
                return None;
            }
            let mut j = i + 1;
            while j < b.len() && b[j] != b'}' {
                j += 1;
            }
            if j >= b.len() {
                return None;
            }
            let body = std::str::from_utf8(&b[i + 1..j]).ok()?;
            let open_ended = body
                .split_once(',')
                .map(|(_, upper)| upper.is_empty())
                .unwrap_or(false);
            let mut len = j - i + 1;
            if b.get(j + 1) == Some(&b'?') {
                len += 1;
            }
            Some((len, open_ended))
        }
        _ => None,
    }
}

/// Records an open-ended quantifier against the innermost open group (or
/// drops it if we are at the top level — nothing can wrap the top level).
fn mark_unbounded(stack: &mut [bool]) {
    if let Some(last) = stack.last_mut() {
        *last = true;
    }
}

/// Parses a `{...}` body (`n`, `n,`, or `n,m`) into `(lower, upper)`; `upper` is
/// `None` for the open-ended `n,` form. `None` overall if either number doesn't parse.
fn parse_counted_bounds(body: &str) -> Option<(u32, Option<u32>)> {
    match body.split_once(',') {
        None => {
            let n = body.parse().ok()?;
            Some((n, Some(n)))
        }
        Some((lower, "")) => Some((lower.parse().ok()?, None)),
        Some((lower, upper)) => Some((lower.parse().ok()?, Some(upper.parse().ok()?))),
    }
}

/// If a counted quantifier (`{n}`/`{n,}`/`{n,m}`) starts at `b[i]`, returns its
/// inner body (between the braces) and the byte length it spans; `None` otherwise.
fn counted_quantifier_at(b: &[u8], i: usize) -> Option<(&str, usize)> {
    if b.get(i) != Some(&b'{') || !matches!(b.get(i + 1), Some(c) if c.is_ascii_digit()) {
        return None;
    }
    let mut j = i + 1;
    while j < b.len() && b[j] != b'}' {
        j += 1;
    }
    if j >= b.len() {
        return None;
    }
    let body = std::str::from_utf8(&b[i + 1..j]).ok()?;
    Some((body, j + 1 - i))
}

/// Save-time cap mirroring `pattern-lint.ts`'s `MAX_QUANTIFIER_COUNT`: a counted
/// quantifier applied to a GROUP (the `){n}`/`){n,}`/`){n,m}` form) may not exceed
/// [`PII_PATTERN_MAX_QUANTIFIER`]. Atom and char-class quantifiers are exempt (linear-time,
/// not a ReDoS risk). Escape/char-class handling mirrors `scan_nested_quantifiers`.
fn scan_quantifier_bounds(pattern: &str) -> Result<(), String> {
    let b = pattern.as_bytes();
    let mut i = 0usize;

    while i < b.len() {
        match b[i] {
            b'\\' => {
                i += if i + 1 < b.len() { 2 } else { 1 };
            }
            b'[' => {
                i += 1;
                if b.get(i) == Some(&b'^') {
                    i += 1;
                }
                if b.get(i) == Some(&b']') {
                    i += 1;
                }
                while i < b.len() && b[i] != b']' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            b')' => {
                i += 1;
                if let Some((body, qlen)) = counted_quantifier_at(b, i) {
                    if let Some((lower, upper)) = parse_counted_bounds(body) {
                        if lower > PII_PATTERN_MAX_QUANTIFIER
                            || upper.is_some_and(|u| u > PII_PATTERN_MAX_QUANTIFIER)
                        {
                            return Err(format!(
                                "group quantifier \"{{{body}}}\" in pattern \"{pattern}\" exceeds the maximum of {PII_PATTERN_MAX_QUANTIFIER} repetitions"
                            ));
                        }
                    }
                    i += qlen;
                }
            }
            _ => {
                i += 1;
            }
        }
    }
    Ok(())
}

/// Scans a compiled-valid pattern for the `(a+)+`-class: a quantified group
/// whose body already contains another open-ended quantifier, incl. `((a+)b)+`.
fn scan_nested_quantifiers(pattern: &str) -> Result<(), String> {
    let b = pattern.as_bytes();
    let mut i = 0usize;
    let mut stack: Vec<bool> = Vec::new();

    while i < b.len() {
        match b[i] {
            b'\\' => {
                i += if i + 1 < b.len() { 2 } else { 1 };
                if let Some((qlen, open_ended)) = quantifier_at(b, i) {
                    if open_ended {
                        mark_unbounded(&mut stack);
                    }
                    i += qlen;
                }
            }
            b'[' => {
                i += 1;
                if b.get(i) == Some(&b'^') {
                    i += 1;
                }
                if b.get(i) == Some(&b']') {
                    i += 1;
                }
                while i < b.len() && b[i] != b']' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
                if let Some((qlen, open_ended)) = quantifier_at(b, i) {
                    if open_ended {
                        mark_unbounded(&mut stack);
                    }
                    i += qlen;
                }
            }
            b'(' => {
                i += 1;
                if b.get(i) == Some(&b'?') {
                    i += 1;
                    if b.get(i) == Some(&b':') {
                        i += 1;
                    } else if b.get(i) == Some(&b'P') && b.get(i + 1) == Some(&b'<') {
                        i += 2;
                        while i < b.len() && b[i] != b'>' {
                            i += 1;
                        }
                        i += 1;
                    }
                }
                stack.push(false);
            }
            b')' => {
                let frame_unbounded = stack.pop().unwrap_or(false);
                i += 1;
                let trailing = quantifier_at(b, i);
                let trailing_open = trailing.map(|(_, oe)| oe).unwrap_or(false);
                if trailing_open && frame_unbounded {
                    return Err(
                        "nests an open-ended repeat inside another open-ended repeat".to_string(),
                    );
                }
                if let Some((qlen, _)) = trailing {
                    i += qlen;
                }
                if frame_unbounded || trailing_open {
                    mark_unbounded(&mut stack);
                }
            }
            _ => {
                i += 1;
                if let Some((qlen, open_ended)) = quantifier_at(b, i) {
                    if open_ended {
                        mark_unbounded(&mut stack);
                    }
                    i += qlen;
                }
            }
        }
    }
    Ok(())
}

fn validate_template(t: &PolicyTemplate) -> Result<(), String> {
    if t.version != 2 {
        return Err(format!("unsupported version {}, expected 2", t.version));
    }
    if t.id == "custom" {
        return Err("template id \"custom\" is reserved".to_string());
    }
    if !id_regex(&TEMPLATE_ID_RE)?.is_match(&t.id) {
        return Err(format!(
            "template id \"{}\" must match ^[a-z][a-z0-9-]{{1,63}}$",
            t.id
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for p in &t.custom_patterns {
        validate_custom_pattern_id(&p.id)?;
        if !seen.insert(p.id.clone()) {
            return Err(format!("duplicate custom pattern id \"{}\"", p.id));
        }
        validate_value_pattern(&p.pattern)?;
    }
    Ok(())
}

fn load_builtin_templates() -> anyhow::Result<Vec<PolicyTemplate>> {
    const RAW: [(&str, &str); 3] = [
        (
            "strict",
            include_str!("../../../mcp-servers/policies/templates/strict.yaml"),
        ),
        (
            "gdpr-art32",
            include_str!("../../../mcp-servers/policies/templates/gdpr-art32.yaml"),
        ),
        (
            "eu-ai-act-art5",
            include_str!("../../../mcp-servers/policies/templates/eu-ai-act-art5.yaml"),
        ),
    ];
    let mut templates = Vec::with_capacity(RAW.len());
    for (expected_id, raw) in RAW {
        let template: PolicyTemplate = serde_yaml_ng::from_str(raw).map_err(|e| {
            anyhow::anyhow!("builtin PII template \"{expected_id}\" failed to parse: {e}")
        })?;
        if template.id != expected_id {
            anyhow::bail!(
                "builtin PII template file mismatch: expected id \"{expected_id}\", got \"{}\"",
                template.id
            );
        }
        validate_template(&template)
            .map_err(|e| anyhow::anyhow!("builtin PII template \"{expected_id}\" invalid: {e}"))?;
        templates.push(template);
    }
    Ok(templates)
}

static TEMPLATES: LazyLock<anyhow::Result<Vec<PolicyTemplate>>> =
    LazyLock::new(load_builtin_templates);

/// Every shipped PII policy template, parsed once from the embedded YAMLs.
pub fn builtin_templates() -> anyhow::Result<&'static [PolicyTemplate]> {
    match &*TEMPLATES {
        Ok(v) => Ok(v),
        Err(e) => Err(anyhow::anyhow!("{e}")),
    }
}

/// A resolved policy-set member, borrowed from either a builtin template or a
/// user policy definition — symmetric inputs to the union.
struct PolicyMember<'a> {
    id: &'a str,
    categories: PiiCategoryPolicies,
    custom_patterns: &'a [CustomPiiPattern],
    sensitive_keys: &'a PiiSensitiveKeyDelta,
}

/// Field-by-field OR of two category flag-pair sets (union semantics: a
/// category is on/logged if ANY policy in the effective set turns it on).
fn or_category_policies(a: PiiCategoryPolicies, b: PiiCategoryPolicies) -> PiiCategoryPolicies {
    fn or(x: PiiCategoryPolicy, y: PiiCategoryPolicy) -> PiiCategoryPolicy {
        PiiCategoryPolicy {
            tokenize: x.tokenize || y.tokenize,
            log: x.log || y.log,
        }
    }
    PiiCategoryPolicies {
        email: or(a.email, b.email),
        phone_pl: or(a.phone_pl, b.phone_pl),
        pesel: or(a.pesel, b.pesel),
        nip: or(a.nip, b.nip),
        iban: or(a.iban, b.iban),
        card: or(a.card, b.card),
        api_key: or(a.api_key, b.api_key),
        sensitive_field: or(a.sensitive_field, b.sensitive_field),
    }
}

/// Resolves `user.policies ∪ managed.forced_policies` into a policy.json v2 document.
/// Fail-closed: any ambiguity or unresolvable id is an `Err`, never a silent degrade.
pub fn resolve_pii_policy(
    user: Option<&crate::config::PiiPolicyUserConfig>,
    managed: Option<&crate::config::ManagedPiiPolicyConfig>,
) -> Result<ResolvedPiiPolicy, String> {
    let templates = builtin_templates().map_err(|e| e.to_string())?;
    let custom_policies: &[crate::config::PiiPolicyDefinition] =
        user.map(|u| u.custom_policies.as_slice()).unwrap_or(&[]);

    // Effective set: user policies in order, then MDM-forced ids not already
    // present (dedup on first occurrence) — MDM ids are additive, not overriding.
    let mut effective: Vec<String> = Vec::new();
    for id in user.map(|u| u.policies.as_slice()).unwrap_or(&[]) {
        if !effective.contains(id) {
            effective.push(id.clone());
        }
    }
    let mut forced: Vec<String> = Vec::new();
    for id in managed.map(|m| m.forced_policies.as_slice()).unwrap_or(&[]) {
        if !effective.contains(id) {
            effective.push(id.clone());
        }
        if !forced.contains(id) {
            forced.push(id.clone());
        }
    }

    if effective.is_empty() {
        return Ok(safe_default_policy());
    }

    // custom_policies internal integrity: no id collides with a builtin, no duplicates.
    let mut seen_custom_ids = std::collections::HashSet::new();
    for def in custom_policies {
        if templates.iter().any(|t| t.id == def.id) {
            return Err(format!(
                "custom policy id \"{}\" collides with a built-in template id",
                def.id
            ));
        }
        if !seen_custom_ids.insert(def.id.as_str()) {
            return Err(format!("duplicate custom policy id \"{}\"", def.id));
        }
    }

    let mut members: Vec<PolicyMember> = Vec::with_capacity(effective.len());
    for id in &effective {
        if let Some(t) = templates.iter().find(|t| &t.id == id) {
            members.push(PolicyMember {
                id: &t.id,
                categories: t.categories,
                custom_patterns: &t.custom_patterns,
                sensitive_keys: &t.sensitive_keys,
            });
        } else if let Some(d) = custom_policies.iter().find(|d| &d.id == id) {
            members.push(PolicyMember {
                id: &d.id,
                categories: d.categories,
                custom_patterns: &d.custom_patterns,
                sensitive_keys: &d.sensitive_keys,
            });
        } else {
            return Err(format!("unknown PII policy id \"{id}\""));
        }
    }

    // Categories: OR each flag pair across every member of the set.
    let mut categories = members[0].categories;
    for m in &members[1..] {
        categories = or_category_policies(categories, m.categories);
    }

    // Custom patterns: union by id, first-seen order (linear scan, counts are
    // small); a shared id must match (pattern, caseInsensitive) or it's Err.
    let mut custom_patterns: Vec<ResolvedCustomPiiPattern> = Vec::new();
    for m in &members {
        for p in m.custom_patterns {
            validate_value_pattern(&p.pattern)
                .map_err(|e| format!("policy \"{}\" custom pattern \"{}\": {e}", m.id, p.id))?;
            match custom_patterns
                .iter_mut()
                .find(|existing| existing.id == p.id)
            {
                None => custom_patterns.push(ResolvedCustomPiiPattern::from(p)),
                Some(existing) => {
                    if existing.pattern != p.pattern
                        || existing.case_insensitive != p.case_insensitive
                    {
                        return Err(format!(
                            "custom pattern id \"{}\" is defined with a different pattern or \
                             caseInsensitive flag across policies in the effective set",
                            p.id
                        ));
                    }
                    existing.tokenize = existing.tokenize || p.tokenize;
                    existing.log = existing.log || p.log;
                }
            }
        }
    }

    // Sensitive keys: add is a union; remove applies only where EVERY member
    // removes the key (intersection), so the union never narrows protection.
    let mut add: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut remove_intersection: Option<std::collections::BTreeSet<String>> = None;
    for m in &members {
        for key in &m.sensitive_keys.add {
            add.insert(key.to_lowercase());
        }
        let this_remove: std::collections::BTreeSet<String> = m
            .sensitive_keys
            .remove
            .iter()
            .map(|k| k.to_lowercase())
            .collect();
        remove_intersection = Some(match remove_intersection {
            None => this_remove,
            Some(prev) => prev.intersection(&this_remove).cloned().collect(),
        });
    }
    let remove_effective = remove_intersection.unwrap_or_default();
    let mut sensitive_keys: std::collections::BTreeSet<String> =
        speedwave_pii_engine::default_sensitive_keys()
            .iter()
            .map(|k| k.to_lowercase())
            .collect();
    sensitive_keys.extend(add);
    for key in &remove_effective {
        sensitive_keys.remove(key);
    }

    Ok(ResolvedPiiPolicy {
        version: 2,
        source: ResolvedPiiPolicySource {
            policies: effective,
            forced,
        },
        categories,
        custom_patterns,
        sensitive_keys: sensitive_keys.into_iter().collect(),
    })
}

/// True when MDM is implicated in a `resolve_pii_policy` failure: present AND
/// the same user config resolves cleanly without it (mirrors telemetry's helper).
fn pii_policy_error_implicates_mdm(
    user: Option<&crate::config::PiiPolicyUserConfig>,
    managed: Option<&crate::config::ManagedPiiPolicyConfig>,
) -> bool {
    managed.is_some() && resolve_pii_policy(user, None).is_ok()
}

/// Global boot gate for the active project's PII policy (mirrors
/// `check_telemetry_policy_at_boot`): any config error hard-stops at startup.
pub fn check_pii_policy_at_boot() -> Result<(), String> {
    let user_config = crate::config::load_user_config().unwrap_or_default();
    let policy = user_config
        .active_project_entry()
        .and_then(|p| p.policy.as_ref());
    let managed = crate::managed_config::load_managed_config()
        .map_err(|e| e.to_string())?
        .and_then(|m| m.pii_policy);

    // Beta-gated: an inactive feature must not block boot on a stale user config.
    if !pii_feature_enabled(user_config.beta_enabled(), managed.as_ref()) {
        return Ok(());
    }

    if let Err(e) = resolve_pii_policy(policy, managed.as_ref()) {
        if pii_policy_error_implicates_mdm(policy, managed.as_ref()) {
            return Err(e);
        }
        return Err(format!(
            "invalid local PII policy configuration (no organization policy involved): {e}"
        ));
    }
    Ok(())
}

/// `<data_dir>/policies/<project>/`. Caller validates `project` as a safe component.
pub fn policy_config_dir_in(data_dir: &Path, project: &str) -> PathBuf {
    data_dir.join("policies").join(project)
}

/// The policy.json path inside the per-project policy dir.
pub fn policy_config_path_in(data_dir: &Path, project: &str) -> PathBuf {
    policy_config_dir_in(data_dir, project).join("policy.json")
}

/// Writes the resolved PII policy as `policy.json`, mounted `:ro` into mcp-hub.
/// Dir owner-only (0o700 / DACL), file 0o600 via fs_perms atomic write (mirrors
/// `claude_managed.rs::write_managed_settings`).
pub fn write_policy_config_in(
    data_dir: &Path,
    project: &str,
    policy: &ResolvedPiiPolicy,
) -> anyhow::Result<()> {
    let dir = policy_config_dir_in(data_dir, project);
    crate::fs_perms::ensure_owner_only_dir(&dir)?;
    let content = serde_json::to_string_pretty(policy)?;
    crate::fs_perms::write_restricted_file_atomic(
        &policy_config_path_in(data_dir, project),
        &content,
    )
}

/// sha256 of the rendered `policy.json`; digest change forces mcp-hub recreate
/// (mirrors `compose/proxy.rs::proxy_state_digest_in`).
pub(crate) fn policy_state_digest_in(data_dir: &Path, project: &str) -> String {
    use sha2::{Digest, Sha256};
    let content = std::fs::read(policy_config_path_in(data_dir, project)).unwrap_or_default();
    crate::bundle::bytes_to_hex(&Sha256::digest(content))
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;
    use crate::config::{ManagedPiiPolicyConfig, PiiPolicyUserConfig};

    // ---- PiiCategoryFlags -----------------------------------------------

    #[test]
    fn category_flags_get_set_roundtrip_every_category() {
        let mut flags = PiiCategoryFlags::ALL_ON;
        for cat in PiiCategory::ALL {
            assert!(flags.get(cat));
            flags.set(cat, false);
            assert!(!flags.get(cat));
        }
    }

    #[test]
    fn category_flags_default_is_all_on() {
        assert_eq!(PiiCategoryFlags::default(), PiiCategoryFlags::ALL_ON);
    }

    // ---- builtin templates -----------------------------------------------

    #[test]
    fn builtin_templates_parse_and_have_unique_non_custom_ids() {
        let templates = builtin_templates().unwrap();
        assert_eq!(templates.len(), 3);
        let mut ids = std::collections::HashSet::new();
        for t in templates {
            assert_ne!(t.id, "custom");
            assert!(ids.insert(t.id.clone()), "duplicate template id {}", t.id);
            for p in &t.custom_patterns {
                validate_value_pattern(&p.pattern).unwrap();
            }
        }
    }

    #[test]
    fn strict_template_matches_compiled_default() {
        let templates = builtin_templates().unwrap();
        let strict = templates.iter().find(|t| t.id == "strict").unwrap();
        let all_on: PiiCategoryPolicies = PiiCategoryFlags::ALL_ON.into();
        assert_eq!(strict.categories, all_on);
        assert_eq!(resolve_pii_policy(None, None).unwrap().categories, all_on);
        assert_eq!(ResolvedPiiPolicy::default().categories, all_on);
    }

    #[test]
    fn gdpr_and_ai_act_templates_have_expected_category_overrides() {
        let templates = builtin_templates().unwrap();
        let gdpr = templates.iter().find(|t| t.id == "gdpr-art32").unwrap();
        assert!(!gdpr.categories.api_key.tokenize);
        assert!(gdpr.categories.nip.tokenize);

        let ai_act = templates.iter().find(|t| t.id == "eu-ai-act-art5").unwrap();
        assert!(!ai_act.categories.nip.tokenize);
        assert!(!ai_act.categories.api_key.tokenize);
        assert!(ai_act.categories.email.tokenize);
    }

    #[test]
    fn policy_template_rejects_unknown_top_level_field() {
        let yaml = r#"
version: 2
id: strict
name: "x"
description: "x"
categories: { EMAIL: {tokenize: true, log: false}, PHONE_PL: {tokenize: true, log: false}, PESEL: {tokenize: true, log: false}, NIP: {tokenize: true, log: false}, IBAN: {tokenize: true, log: false}, CARD: {tokenize: true, log: false}, API_KEY: {tokenize: true, log: false}, SENSITIVE_FIELD: {tokenize: true, log: false} }
customPatterns: []
sensitiveKeys: { add: [], remove: [] }
inherit: something
"#;
        let result: Result<PolicyTemplate, _> = serde_yaml_ng::from_str(yaml);
        assert!(result.is_err());
    }

    #[test]
    fn policy_template_rejects_missing_category_key() {
        let yaml = r#"
version: 2
id: strict
name: "x"
description: "x"
categories: { EMAIL: {tokenize: true, log: false}, PHONE_PL: {tokenize: true, log: false}, PESEL: {tokenize: true, log: false}, NIP: {tokenize: true, log: false}, IBAN: {tokenize: true, log: false}, CARD: {tokenize: true, log: false}, API_KEY: {tokenize: true, log: false} }
customPatterns: []
sensitiveKeys: { add: [], remove: [] }
"#;
        let result: Result<PolicyTemplate, _> = serde_yaml_ng::from_str(yaml);
        assert!(result.is_err());
    }

    #[test]
    fn policy_template_rejects_unknown_category_key() {
        let yaml = r#"
version: 2
id: strict
name: "x"
description: "x"
categories: { EMAIL: {tokenize: true, log: false}, PHONE_PL: {tokenize: true, log: false}, PESEL: {tokenize: true, log: false}, NIP: {tokenize: true, log: false}, IBAN: {tokenize: true, log: false}, CARD: {tokenize: true, log: false}, API_KEY: {tokenize: true, log: false}, SENSITIVE_FIELD: {tokenize: true, log: false}, BOGUS: {tokenize: true, log: false} }
customPatterns: []
sensitiveKeys: { add: [], remove: [] }
"#;
        let result: Result<PolicyTemplate, _> = serde_yaml_ng::from_str(yaml);
        assert!(result.is_err());
    }

    #[test]
    fn policy_template_rejects_unsupported_version() {
        let yaml = r#"
version: 1
id: strict
name: "x"
description: "x"
categories: { EMAIL: {tokenize: true, log: false}, PHONE_PL: {tokenize: true, log: false}, PESEL: {tokenize: true, log: false}, NIP: {tokenize: true, log: false}, IBAN: {tokenize: true, log: false}, CARD: {tokenize: true, log: false}, API_KEY: {tokenize: true, log: false}, SENSITIVE_FIELD: {tokenize: true, log: false} }
customPatterns: []
sensitiveKeys: { add: [], remove: [] }
"#;
        let template: PolicyTemplate = serde_yaml_ng::from_str(yaml).unwrap();
        assert!(validate_template(&template).is_err());
    }

    #[test]
    fn policy_template_rejects_unknown_category_flag_pair_key() {
        let yaml = r#"
version: 2
id: strict
name: "x"
description: "x"
categories: { EMAIL: {tokenize: true, log: false, bogus: true}, PHONE_PL: {tokenize: true, log: false}, PESEL: {tokenize: true, log: false}, NIP: {tokenize: true, log: false}, IBAN: {tokenize: true, log: false}, CARD: {tokenize: true, log: false}, API_KEY: {tokenize: true, log: false}, SENSITIVE_FIELD: {tokenize: true, log: false} }
customPatterns: []
sensitiveKeys: { add: [], remove: [] }
"#;
        let result: Result<PolicyTemplate, _> = serde_yaml_ng::from_str(yaml);
        assert!(result.is_err());
    }

    // ---- resolve_pii_policy semantics ------------------------------------

    fn custom_pattern(id: &str, pattern: &str, tokenize: bool, log: bool) -> CustomPiiPattern {
        CustomPiiPattern {
            id: id.to_string(),
            display_name: id.to_string(),
            pattern: pattern.to_string(),
            case_insensitive: false,
            tokenize,
            log,
        }
    }

    fn custom_policy(
        id: &str,
        categories: PiiCategoryPolicies,
        custom_patterns: Vec<CustomPiiPattern>,
        sensitive_keys: PiiSensitiveKeyDelta,
    ) -> crate::config::PiiPolicyDefinition {
        crate::config::PiiPolicyDefinition {
            id: id.to_string(),
            name: id.to_string(),
            categories,
            custom_patterns,
            sensitive_keys,
        }
    }

    #[test]
    fn resolve_with_no_user_and_no_managed_is_safe_default() {
        // Point 3: empty effective set => safe default (all-on, no patterns).
        let resolved = resolve_pii_policy(None, None).unwrap();
        assert_eq!(resolved.categories, PiiCategoryFlags::ALL_ON.into());
        assert_eq!(
            resolved.source,
            ResolvedPiiPolicySource {
                policies: Vec::new(),
                forced: Vec::new(),
            }
        );
        assert!(resolved.custom_patterns.is_empty());
    }

    #[test]
    fn disabled_policy_compiles_to_engine_noop() {
        let policy = disabled_policy();
        assert_eq!(policy.categories, PiiCategoryFlags::ALL_OFF.into());
        assert!(policy.custom_patterns.is_empty());
        assert!(policy.sensitive_keys.is_empty());
        let compiled =
            speedwave_pii_engine::compile_policy_v2(&serde_json::to_string(&policy).unwrap())
                .expect("the beta-off policy must be a valid v2 document");
        assert!(compiled.rules().is_empty(), "no value-pattern rules");
        assert!(compiled.sensitive_keys().is_empty(), "no key-name rules");
    }

    #[test]
    fn pii_feature_enabled_gates_on_beta_or_mdm_forced() {
        use crate::config::ManagedPiiPolicyConfig;
        let forced = ManagedPiiPolicyConfig {
            forced_policies: vec!["gdpr-art32".to_string()],
        };
        let empty = ManagedPiiPolicyConfig::default();
        assert!(pii_feature_enabled(true, None));
        assert!(pii_feature_enabled(true, Some(&forced)));
        assert!(
            pii_feature_enabled(false, Some(&forced)),
            "MDM-forced policies must apply with beta off"
        );
        assert!(!pii_feature_enabled(false, None));
        assert!(
            !pii_feature_enabled(false, Some(&empty)),
            "a managed file forcing nothing must not enable the feature"
        );
    }

    #[test]
    fn resolve_with_known_template_id_uses_its_categories() {
        let user = PiiPolicyUserConfig {
            policies: vec!["gdpr-art32".to_string()],
            ..Default::default()
        };
        let resolved = resolve_pii_policy(Some(&user), None).unwrap();
        assert!(!resolved.categories.api_key.tokenize);
        assert_eq!(
            resolved.source,
            ResolvedPiiPolicySource {
                policies: vec!["gdpr-art32".to_string()],
                forced: Vec::new(),
            }
        );
    }

    #[test]
    fn resolve_with_unknown_user_policy_id_errs_naming_it() {
        // Point 2: unknown id (user or MDM) is an Err naming the id.
        let user = PiiPolicyUserConfig {
            policies: vec!["totally-bogus-template".to_string()],
            ..Default::default()
        };
        let err = resolve_pii_policy(Some(&user), None).unwrap_err();
        assert!(err.contains("totally-bogus-template"));
    }

    #[test]
    fn resolve_with_unknown_managed_forced_id_errs_naming_it() {
        let managed = ManagedPiiPolicyConfig {
            forced_policies: vec!["not-a-real-policy".to_string()],
        };
        let err = resolve_pii_policy(None, Some(&managed)).unwrap_err();
        assert!(err.contains("not-a-real-policy"));
    }

    #[test]
    fn resolve_custom_policy_colliding_with_builtin_id_errs() {
        let user = PiiPolicyUserConfig {
            policies: vec!["strict".to_string()],
            custom_policies: vec![custom_policy(
                "strict",
                PiiCategoryFlags::ALL_ON.into(),
                Vec::new(),
                PiiSensitiveKeyDelta::default(),
            )],
        };
        assert!(resolve_pii_policy(Some(&user), None).is_err());
    }

    #[test]
    fn resolve_duplicate_custom_policy_ids_errs() {
        let def = custom_policy(
            "acme",
            PiiCategoryFlags::ALL_ON.into(),
            Vec::new(),
            PiiSensitiveKeyDelta::default(),
        );
        let user = PiiPolicyUserConfig {
            policies: vec!["acme".to_string()],
            custom_policies: vec![def.clone(), def],
        };
        assert!(resolve_pii_policy(Some(&user), None).is_err());
    }

    #[test]
    fn resolve_effective_set_is_user_policies_then_unseen_forced_ids() {
        // Point 1: user order first, then unseen forced ids; `source.forced`
        // names every MDM-forced id even if the user also picked it themselves.
        let user = PiiPolicyUserConfig {
            policies: vec!["gdpr-art32".to_string()],
            ..Default::default()
        };
        let managed = ManagedPiiPolicyConfig {
            forced_policies: vec!["gdpr-art32".to_string(), "eu-ai-act-art5".to_string()],
        };
        let resolved = resolve_pii_policy(Some(&user), Some(&managed)).unwrap();
        assert_eq!(
            resolved.source,
            ResolvedPiiPolicySource {
                policies: vec!["gdpr-art32".to_string(), "eu-ai-act-art5".to_string()],
                forced: vec!["gdpr-art32".to_string(), "eu-ai-act-art5".to_string()],
            }
        );
    }

    #[test]
    fn resolve_categories_are_ored_per_flag_across_the_effective_set() {
        // Point 4: gdpr-art32 has nip ON (eu-ai-act-art5 off) — OR keeps it on.
        // Both have api_key off, so it stays off (not "any policy defaults on").
        let user = PiiPolicyUserConfig {
            policies: vec!["gdpr-art32".to_string(), "eu-ai-act-art5".to_string()],
            ..Default::default()
        };
        let resolved = resolve_pii_policy(Some(&user), None).unwrap();
        assert!(resolved.categories.nip.tokenize, "on in gdpr-art32");
        assert!(
            !resolved.categories.api_key.tokenize,
            "off in both — OR must not invent a true"
        );
        assert!(resolved.categories.email.tokenize, "on in both");
    }

    #[test]
    fn resolve_custom_patterns_with_same_id_and_pattern_merge_flags_with_or() {
        // Point 5: identical (pattern, caseInsensitive) across policies -> one
        // merged entry with OR'd tokenize/log.
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string(), "b".to_string()],
            custom_policies: vec![
                custom_policy(
                    "a",
                    PiiCategoryFlags::ALL_ON.into(),
                    vec![custom_pattern("EMPLOYEE_ID", r"\d{3}", true, false)],
                    PiiSensitiveKeyDelta::default(),
                ),
                custom_policy(
                    "b",
                    PiiCategoryFlags::ALL_ON.into(),
                    vec![custom_pattern("EMPLOYEE_ID", r"\d{3}", false, true)],
                    PiiSensitiveKeyDelta::default(),
                ),
            ],
        };
        let resolved = resolve_pii_policy(Some(&user), None).unwrap();
        assert_eq!(resolved.custom_patterns.len(), 1);
        assert!(resolved.custom_patterns[0].tokenize);
        assert!(resolved.custom_patterns[0].log);
    }

    #[test]
    fn resolve_custom_patterns_with_same_id_but_different_pattern_errs() {
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string(), "b".to_string()],
            custom_policies: vec![
                custom_policy(
                    "a",
                    PiiCategoryFlags::ALL_ON.into(),
                    vec![custom_pattern("EMPLOYEE_ID", r"\d{3}", true, false)],
                    PiiSensitiveKeyDelta::default(),
                ),
                custom_policy(
                    "b",
                    PiiCategoryFlags::ALL_ON.into(),
                    vec![custom_pattern("EMPLOYEE_ID", r"\d{4}", true, false)],
                    PiiSensitiveKeyDelta::default(),
                ),
            ],
        };
        let err = resolve_pii_policy(Some(&user), None).unwrap_err();
        assert!(err.contains("EMPLOYEE_ID"));
    }

    #[test]
    fn resolve_errs_on_an_unusable_stored_custom_pattern() {
        // Fail-closed: a stored pattern that no longer validates is an Err, not
        // a silent drop (unlike the pre-F2.2 infallible resolve).
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string()],
            custom_policies: vec![custom_policy(
                "a",
                PiiCategoryFlags::ALL_ON.into(),
                vec![custom_pattern("BAD", "(a+)+", true, false)],
                PiiSensitiveKeyDelta::default(),
            )],
        };
        assert!(resolve_pii_policy(Some(&user), None).is_err());
    }

    #[test]
    fn resolve_sensitive_keys_add_is_a_union_remove_only_when_every_policy_agrees() {
        // Point 6: "cookie" removed by only one of two policies must survive;
        // "token" removed by both must be gone.
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string(), "b".to_string()],
            custom_policies: vec![
                custom_policy(
                    "a",
                    PiiCategoryFlags::ALL_ON.into(),
                    Vec::new(),
                    PiiSensitiveKeyDelta {
                        add: vec!["Salary".to_string()],
                        remove: vec!["cookie".to_string(), "token".to_string()],
                    },
                ),
                custom_policy(
                    "b",
                    PiiCategoryFlags::ALL_ON.into(),
                    Vec::new(),
                    PiiSensitiveKeyDelta {
                        add: Vec::new(),
                        remove: vec!["token".to_string()],
                    },
                ),
            ],
        };
        let resolved = resolve_pii_policy(Some(&user), None).unwrap();
        assert!(resolved.sensitive_keys.contains(&"salary".to_string()));
        assert!(
            resolved.sensitive_keys.contains(&"cookie".to_string()),
            "only one policy removes cookie — union must not narrow protection"
        );
        assert!(
            !resolved.sensitive_keys.contains(&"token".to_string()),
            "both policies remove token — intersection removes it"
        );
    }

    // ---- serde round-trips -------------------------------------------------

    #[test]
    fn resolved_pii_policy_json_round_trips_and_uses_camel_case() {
        let user = PiiPolicyUserConfig {
            policies: vec!["gdpr-art32".to_string(), "custom".to_string()],
            custom_policies: vec![custom_policy(
                "custom",
                PiiCategoryFlags::ALL_ON.into(),
                vec![custom_pattern(
                    "EMPLOYEE_ID",
                    r"\bEMP-\d{4,8}\b",
                    true,
                    false,
                )],
                PiiSensitiveKeyDelta {
                    add: vec!["salary".to_string()],
                    remove: Vec::new(),
                },
            )],
        };
        let resolved = resolve_pii_policy(Some(&user), None).unwrap();

        let value = serde_json::to_value(&resolved).unwrap();
        assert_eq!(value["version"], 2);
        assert!(value.get("customPatterns").is_some());
        assert!(value.get("sensitiveKeys").is_some());
        assert!(value.get("limits").is_none());
        assert!(value.get("forcedCategories").is_none());
        assert_eq!(value["categories"]["EMAIL"]["tokenize"], true);
        assert_eq!(value["categories"]["EMAIL"]["log"], false);
        assert_eq!(value["customPatterns"][0]["displayName"], "EMPLOYEE_ID");
        assert_eq!(value["customPatterns"][0]["caseInsensitive"], false);
        assert_eq!(value["customPatterns"][0]["tokenize"], true);
        assert_eq!(value["customPatterns"][0]["log"], false);
        assert!(value["sensitiveKeys"]
            .as_array()
            .unwrap()
            .contains(&serde_json::Value::String("salary".to_string())));
        // Literal wire values, so a symmetric casing bug can't hide behind the round-trip.
        assert_eq!(
            value["source"]["policies"],
            serde_json::json!(["gdpr-art32", "custom"])
        );
        assert_eq!(value["source"]["forced"], serde_json::json!([]));

        let default_value = serde_json::to_value(resolve_pii_policy(None, None).unwrap()).unwrap();
        assert_eq!(default_value["source"]["policies"], serde_json::json!([]));

        let round_tripped: ResolvedPiiPolicy = serde_json::from_value(value).unwrap();
        assert_eq!(round_tripped, resolved);
    }

    // ---- validate_value_pattern -------------------------------------------

    #[test]
    fn validate_value_pattern_accepts_a_realistic_pattern() {
        assert!(validate_value_pattern(r"\bEMP-\d{4,8}\b").is_ok());
    }

    #[test]
    fn validate_value_pattern_rejects_empty() {
        assert!(validate_value_pattern("").is_err());
    }

    #[test]
    fn validate_value_pattern_rejects_under_min_length() {
        assert!(validate_value_pattern("ab").is_err());
        assert!(validate_value_pattern(&"a".repeat(PII_PATTERN_MIN_LEN - 1)).is_err());
    }

    #[test]
    fn validate_value_pattern_rejects_over_max_length() {
        let huge = "a".repeat(PII_PATTERN_MAX_LEN + 1);
        let err = validate_value_pattern(&huge).unwrap_err();
        assert!(err.contains(&PII_PATTERN_MAX_LEN.to_string()));
    }

    #[test]
    fn validate_value_pattern_rejects_empty_string_match() {
        // `\d*` compiles and is bounded, but matches "" and would spin the tokenizer loop.
        let err = validate_value_pattern(r"\d*").unwrap_err();
        assert!(err.contains("empty string"));
        assert!(validate_value_pattern("a*b*").is_err());
    }

    #[test]
    fn validate_value_pattern_rejects_uncompilable_syntax() {
        assert!(validate_value_pattern("(").is_err());
    }

    #[test]
    fn validate_value_pattern_rejects_backreferences_and_lookaround() {
        // Rejected by the `regex` crate at compile time (no backtracking engine).
        assert!(validate_value_pattern(r"(a)\1").is_err());
        assert!(validate_value_pattern("(?=a)b").is_err());
    }

    #[test]
    fn validate_value_pattern_rejects_simple_nested_quantifier() {
        assert!(validate_value_pattern("(a+)+").is_err());
        assert!(validate_value_pattern("(a*)*").is_err());
        assert!(validate_value_pattern("(a{2,})+").is_err());
    }

    #[test]
    fn validate_value_pattern_rejects_nested_group_form() {
        // The TS regex heuristic misses this; the Rust scan is authoritative.
        assert!(validate_value_pattern("((a+)b)+").is_err());
    }

    #[test]
    fn validate_value_pattern_accepts_single_level_group_repeat() {
        assert!(validate_value_pattern("(ab)+").is_ok());
        assert!(validate_value_pattern("(a+)").is_ok());
        assert!(validate_value_pattern("a+b+").is_ok());
        assert!(validate_value_pattern("(?:abc)+").is_ok());
    }

    #[test]
    fn validate_value_pattern_accepts_group_quantifier_bound_at_the_cap() {
        assert!(validate_value_pattern("(ab){1,128}").is_ok());
        assert!(validate_value_pattern("(ab){128}").is_ok());
    }

    #[test]
    fn validate_value_pattern_rejects_group_quantifier_bound_over_the_cap() {
        let err = validate_value_pattern("(ab){129}").unwrap_err();
        assert!(err.contains("128"));
        assert!(validate_value_pattern("(?:x){200,300}").is_err());
        assert!(validate_value_pattern("(a|b){0,129}").is_err());
    }

    #[test]
    fn validate_value_pattern_exempts_atom_and_char_class_quantifiers_from_the_cap() {
        // Atom/char-class counted quantifiers are linear-time; TS exempts them and so must we,
        // or safe user patterns (and the built-in EMAIL `{1,255}`) would be wrongly rejected.
        assert!(validate_value_pattern("a{129}").is_ok());
        assert!(validate_value_pattern("[a-z]{1,255}").is_ok());
        assert!(validate_value_pattern(r"\d{200}").is_ok());
    }

    #[test]
    fn validate_value_pattern_ignores_braces_in_char_class_or_escaped() {
        // A `{` inside `[...]` or preceded by `\` is a literal, never a quantifier.
        assert!(validate_value_pattern(r"[a{300}]bbb").is_ok());
        assert!(validate_value_pattern(r"a\{300,999\}bbb").is_ok());
    }

    #[test]
    fn builtin_templates_have_no_pattern_exceeding_the_quantifier_cap() {
        for template in builtin_templates().unwrap() {
            for p in &template.custom_patterns {
                assert!(validate_value_pattern(&p.pattern).is_ok());
            }
        }
    }

    // ---- validate_sensitive_key --------------------------------------------

    #[test]
    fn validate_sensitive_key_accepts_lowercase_ascii_and_unicode() {
        assert!(validate_sensitive_key("salary").is_ok());
        assert!(validate_sensitive_key("хэш").is_ok());
    }

    #[test]
    fn validate_sensitive_key_rejects_empty() {
        assert!(validate_sensitive_key("").is_err());
    }

    #[test]
    fn validate_sensitive_key_rejects_over_64_bytes() {
        assert!(validate_sensitive_key(&"a".repeat(65)).is_err());
    }

    #[test]
    fn validate_sensitive_key_rejects_uppercase_ascii_and_unicode() {
        assert!(validate_sensitive_key("Salary").is_err());
        assert!(validate_sensitive_key("ХЭШ").is_err());
    }

    #[test]
    fn validate_sensitive_key_rejects_control_characters() {
        assert!(validate_sensitive_key("sal\u{0007}ary").is_err());
    }

    // ---- id derivation ------------------------------------------------------

    #[test]
    fn derive_custom_pattern_id_matches_contract_example() {
        assert_eq!(
            derive_custom_pattern_id("Employee ID").unwrap(),
            "EMPLOYEE_ID"
        );
    }

    #[test]
    fn derive_custom_pattern_id_rejects_collision_with_builtin_category() {
        assert!(derive_custom_pattern_id("Email").is_err());
    }

    #[test]
    fn derive_custom_pattern_id_rejects_too_short() {
        assert!(derive_custom_pattern_id("XY").is_err());
    }

    #[test]
    fn derive_custom_pattern_id_rejects_all_non_alphanumeric_name() {
        assert!(derive_custom_pattern_id("!!!").is_err());
    }

    // ---- validate_user_policy_config ---------------------------------------

    #[test]
    fn validate_user_policy_config_rejects_too_many_custom_patterns() {
        let patterns: Vec<CustomPiiPattern> = (0..PII_MAX_CUSTOM_PATTERNS + 1)
            .map(|i| custom_pattern(&format!("PAT_{i}"), r"\d{3}", true, false))
            .collect();
        let cfg = PiiPolicyUserConfig {
            policies: vec!["custom".to_string()],
            custom_policies: vec![custom_policy(
                "custom",
                PiiCategoryFlags::ALL_ON.into(),
                patterns,
                PiiSensitiveKeyDelta::default(),
            )],
        };
        assert!(validate_user_policy_config(&cfg).is_err());
    }

    #[test]
    fn validate_user_policy_config_rejects_duplicate_pattern_ids() {
        let cfg = PiiPolicyUserConfig {
            policies: vec!["custom".to_string()],
            custom_policies: vec![custom_policy(
                "custom",
                PiiCategoryFlags::ALL_ON.into(),
                vec![
                    custom_pattern("DUP", r"\d{3}", true, false),
                    custom_pattern("DUP", r"\d{4}", true, false),
                ],
                PiiSensitiveKeyDelta::default(),
            )],
        };
        assert!(validate_user_policy_config(&cfg).is_err());
    }

    #[test]
    fn validate_user_policy_config_rejects_over_length_display_name() {
        let mut pattern = custom_pattern("EMPLOYEE_ID", r"\d{3}", true, false);
        pattern.display_name = "a".repeat(PII_PATTERN_NAME_MAX_LEN + 1);
        let cfg = PiiPolicyUserConfig {
            policies: vec!["custom".to_string()],
            custom_policies: vec![custom_policy(
                "custom",
                PiiCategoryFlags::ALL_ON.into(),
                vec![pattern],
                PiiSensitiveKeyDelta::default(),
            )],
        };
        let err = validate_user_policy_config(&cfg).unwrap_err();
        assert!(err.contains("display name exceeds"));
    }

    #[test]
    fn validate_user_policy_config_accepts_max_length_display_name() {
        let mut pattern = custom_pattern("EMPLOYEE_ID", r"\d{3}", true, false);
        pattern.display_name = "a".repeat(PII_PATTERN_NAME_MAX_LEN);
        let cfg = PiiPolicyUserConfig {
            policies: vec!["custom".to_string()],
            custom_policies: vec![custom_policy(
                "custom",
                PiiCategoryFlags::ALL_ON.into(),
                vec![pattern],
                PiiSensitiveKeyDelta::default(),
            )],
        };
        assert!(validate_user_policy_config(&cfg).is_ok());
    }

    #[test]
    fn validate_user_policy_config_rejects_too_many_sensitive_keys() {
        let cfg = PiiPolicyUserConfig {
            policies: vec!["custom".to_string()],
            custom_policies: vec![custom_policy(
                "custom",
                PiiCategoryFlags::ALL_ON.into(),
                Vec::new(),
                PiiSensitiveKeyDelta {
                    add: (0..PII_MAX_SENSITIVE_KEYS + 1)
                        .map(|i| format!("k{i}"))
                        .collect(),
                    remove: vec![],
                },
            )],
        };
        assert!(validate_user_policy_config(&cfg).is_err());
    }

    #[test]
    fn validate_user_policy_config_accepts_well_formed_config() {
        let cfg = PiiPolicyUserConfig {
            policies: vec!["strict".to_string(), "custom".to_string()],
            custom_policies: vec![custom_policy(
                "custom",
                PiiCategoryFlags::ALL_ON.into(),
                vec![custom_pattern(
                    "EMPLOYEE_ID",
                    r"\bEMP-\d{4,8}\b",
                    true,
                    false,
                )],
                PiiSensitiveKeyDelta {
                    add: vec!["salary".to_string()],
                    remove: vec![],
                },
            )],
        };
        assert!(validate_user_policy_config(&cfg).is_ok());
    }

    #[test]
    fn validate_user_policy_config_rejects_policy_referencing_unknown_id() {
        let cfg = PiiPolicyUserConfig {
            policies: vec!["totally-bogus".to_string()],
            custom_policies: Vec::new(),
        };
        let err = validate_user_policy_config(&cfg).unwrap_err();
        assert!(err.contains("totally-bogus"));
    }

    #[test]
    fn validate_user_policy_config_rejects_custom_policy_id_colliding_with_builtin() {
        let cfg = PiiPolicyUserConfig {
            policies: vec!["strict".to_string()],
            custom_policies: vec![custom_policy(
                "strict",
                PiiCategoryFlags::ALL_ON.into(),
                Vec::new(),
                PiiSensitiveKeyDelta::default(),
            )],
        };
        assert!(validate_user_policy_config(&cfg).is_err());
    }

    #[test]
    fn validate_user_policy_config_rejects_duplicate_custom_policy_ids() {
        let def = custom_policy(
            "acme",
            PiiCategoryFlags::ALL_ON.into(),
            Vec::new(),
            PiiSensitiveKeyDelta::default(),
        );
        let cfg = PiiPolicyUserConfig {
            policies: vec!["acme".to_string()],
            custom_policies: vec![def.clone(), def],
        };
        assert!(validate_user_policy_config(&cfg).is_err());
    }

    // ---- cross-read SSOT: Rust serde strings vs TS PIIType enum ------------

    #[test]
    fn pii_category_serde_matches_policy_engine_ts() {
        let mut rust: Vec<String> = PiiCategory::ALL
            .iter()
            .map(|c| c.wire_str().to_string())
            .collect();
        rust.sort();

        let src = include_str!("../../../mcp-servers/policies/src/types.ts");
        let enum_re = Regex::new(r"enum\s+PIIType\s*\{([^}]*)\}").unwrap();
        let block = &enum_re
            .captures(src)
            .expect("types.ts must declare `enum PIIType`")[1];
        let value_re = Regex::new(r#"=\s*'([A-Z_]+)'"#).unwrap();
        let mut ts: Vec<String> = value_re
            .captures_iter(block)
            .map(|m| m[1].to_string())
            .collect();
        ts.sort();

        assert_eq!(
            rust, ts,
            "Rust PiiCategory serde strings must match TS PIIType enum values"
        );
    }

    // ---- write_policy_config_in / policy_state_digest_in -------------------

    #[test]
    fn policy_dir_and_path_layout() {
        assert_eq!(
            policy_config_dir_in(Path::new("/data"), "proj"),
            Path::new("/data/policies/proj")
        );
        assert_eq!(
            policy_config_path_in(Path::new("/data"), "proj"),
            Path::new("/data/policies/proj/policy.json")
        );
    }

    /// Snapshot: written JSON matches the pinned v2 contract shape, incl. the
    /// literal `source.policies` value and per-category flag pairs.
    #[test]
    fn write_policy_config_matches_pinned_contract_shape() {
        let tmp = tempfile::tempdir().unwrap();
        // Matches gdpr-art32's own api_key=false so the union preserves the
        // exclusion (a plain ALL_ON "custom" policy would OR it back on).
        let mut api_key_off = PiiCategoryFlags::ALL_ON;
        api_key_off.set(PiiCategory::ApiKey, false);
        let mut pattern = custom_pattern("EMPLOYEE_ID", r"\bEMP-\d{4,8}\b", true, false);
        pattern.display_name = "Employee ID".to_string();
        let user = PiiPolicyUserConfig {
            policies: vec!["gdpr-art32".to_string(), "custom".to_string()],
            custom_policies: vec![custom_policy(
                "custom",
                api_key_off.into(),
                vec![pattern],
                PiiSensitiveKeyDelta {
                    add: vec!["salary".to_string()],
                    remove: vec![],
                },
            )],
        };
        let policy = resolve_pii_policy(Some(&user), None).unwrap();
        write_policy_config_in(tmp.path(), "proj", &policy).unwrap();

        let path = policy_config_path_in(tmp.path(), "proj");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["version"], 2);
        assert_eq!(
            v["source"]["policies"],
            serde_json::json!(["gdpr-art32", "custom"])
        );
        assert_eq!(v["source"]["forced"], serde_json::json!([]));
        assert_eq!(v["categories"]["EMAIL"]["tokenize"], true);
        assert!(!v["categories"]["API_KEY"]["tokenize"].as_bool().unwrap());
        assert_eq!(v["customPatterns"][0]["id"], "EMPLOYEE_ID");
        assert_eq!(v["customPatterns"][0]["displayName"], "Employee ID");
        assert_eq!(v["customPatterns"][0]["tokenize"], true);
        assert!(v["sensitiveKeys"]
            .as_array()
            .unwrap()
            .contains(&serde_json::Value::String("salary".to_string())));
        assert!(v.get("limits").is_none());
        assert!(v.get("forcedCategories").is_none());
    }

    #[test]
    fn write_policy_config_is_owner_only() {
        let tmp = tempfile::tempdir().unwrap();
        write_policy_config_in(tmp.path(), "proj", &ResolvedPiiPolicy::default()).unwrap();
        let path = policy_config_path_in(tmp.path(), "proj");
        assert!(path.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "policy.json must be owner-only");
            let dir_mode = std::fs::metadata(policy_config_dir_in(tmp.path(), "proj"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(dir_mode, 0o700, "policy dir must be owner-only");
        }
    }

    #[test]
    fn policy_state_digest_changes_with_content_and_is_stable_otherwise() {
        let tmp = tempfile::tempdir().unwrap();
        write_policy_config_in(tmp.path(), "proj", &ResolvedPiiPolicy::default()).unwrap();
        let d1 = policy_state_digest_in(tmp.path(), "proj");
        assert_eq!(d1.len(), 64);
        assert!(d1.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(d1, policy_state_digest_in(tmp.path(), "proj"));

        let mut other = ResolvedPiiPolicy::default();
        other.categories.email.tokenize = false;
        write_policy_config_in(tmp.path(), "proj", &other).unwrap();
        let d2 = policy_state_digest_in(tmp.path(), "proj");
        assert_ne!(d1, d2, "changed policy content must change the digest");
    }

    #[test]
    fn policy_state_digest_handles_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let d = policy_state_digest_in(tmp.path(), "proj");
        assert_eq!(d.len(), 64);
        assert_eq!(d, policy_state_digest_in(tmp.path(), "proj"));
    }
}
