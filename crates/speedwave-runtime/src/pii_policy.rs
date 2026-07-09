//! PII policy config model: built-in templates, the resolved `policy.json`
//! contract, and save-time validation (TS counterpart: `mcp-servers/policies`).

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// Builtin template id used when no template is requested.
pub const DEFAULT_TEMPLATE_ID: &str = "strict";

/// Maximum number of custom patterns a user may store (save-time gate).
pub const PII_MAX_CUSTOM_PATTERNS: usize = 32;
/// Maximum number of sensitive-key additions a user may store (save-time gate).
pub const PII_MAX_SENSITIVE_KEYS: usize = 64;
/// Maximum stored length (bytes) of a custom pattern's regex source.
pub const PII_PATTERN_MAX_LEN: usize = 512;
/// Maximum stored length (bytes) of a custom pattern's display name.
pub const PII_PATTERN_NAME_MAX_LEN: usize = 64;
/// Maximum stored length (bytes) of a single sensitive-key substring.
const SENSITIVE_KEY_MAX_LEN: usize = 64;
/// Maximum bound of a group-applied counted quantifier (the `){n}`/`){n,}`/`){n,m}`
/// form), mirroring `pattern-lint.ts`'s `MAX_QUANTIFIER_COUNT`. Atom and char-class
/// quantifiers are exempt (linear-time, not a ReDoS risk), as in the TS lint.
const PII_PATTERN_MAX_QUANTIFIER: u32 = 128;

const DEFAULT_MAX_TOKENS: u32 = 1000;
const DEFAULT_TTL_MS: u64 = 30 * 60 * 1000;

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

/// A user-defined detection pattern, additive to the built-in categories.
/// Shared by `PolicyTemplate` and `ResolvedPiiPolicy` (mirrors TS `CustomPatternRule`).
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
    /// MDM-forced pattern the user cannot remove; re-forced by the engine.
    #[serde(default)]
    pub forced: bool,
}

/// Sensitive key-name add/remove deltas as shipped by a template (2 fields;
/// `forcedAdd` is MDM-only and lives on [`ResolvedSensitiveKeyDelta`]).
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

/// Sensitive key-name add/remove/forcedAdd deltas as written to `policy.json`
/// (mirrors TS `SensitiveKeyDelta`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSensitiveKeyDelta {
    /// Key-name substrings to add to the default sensitive-key list.
    pub add: Vec<String>,
    /// Key-name substrings to remove from the default sensitive-key list.
    pub remove: Vec<String>,
    /// Key-name substrings that always apply, even if also listed in `remove`.
    pub forced_add: Vec<String>,
}

/// Optional token-lifecycle overrides; omitted fields keep today's defaults.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PiiPolicyLimits {
    /// Maximum number of tokens a single `PIIContext` may hold.
    pub max_tokens: u32,
    /// Token time-to-live in milliseconds.
    pub ttl_ms: u64,
}

impl Default for PiiPolicyLimits {
    fn default() -> Self {
        Self {
            max_tokens: DEFAULT_MAX_TOKENS,
            ttl_ms: DEFAULT_TTL_MS,
        }
    }
}

/// How a resolved policy was produced (mirrors TS `PolicySelection`).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum PiiPolicySource {
    /// Resolved purely from a named built-in template.
    Template {
        /// The template's id.
        template_id: String,
    },
    /// Resolved with user overrides layered on top of an optional starting template.
    Custom {
        /// The starting template's id, if any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        template_id: Option<String>,
    },
}

/// A named, shippable policy preset loaded from `templates/*.yaml` (mirrors
/// TS `PolicyTemplate`). Unknown top-level keys are hard rejected.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyTemplate {
    /// Schema version; the engine supports exactly 1.
    pub version: u32,
    /// Template id, `^[a-z][a-z0-9-]{1,63}$`; "custom" is reserved.
    pub id: String,
    /// Human-readable template name.
    pub name: String,
    /// Human-readable template description.
    pub description: String,
    /// Enablement per built-in category, exhaustive.
    pub categories: PiiCategoryFlags,
    /// Additive custom detection patterns shipped with the template.
    #[serde(default)]
    pub custom_patterns: Vec<CustomPiiPattern>,
    /// Sensitive key-name add/remove deltas shipped with the template.
    #[serde(default)]
    pub sensitive_keys: PiiSensitiveKeyDelta,
}

/// The fully-resolved policy written to `policy.json` (mirrors TS
/// `ResolvedPolicy`). `Default` is the compiled-in fallback: every category on.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPiiPolicy {
    /// Schema version; the engine supports exactly 1.
    pub version: u8,
    /// Provenance of this resolved policy.
    pub source: PiiPolicySource,
    /// Enablement per built-in category, exhaustive.
    pub categories: PiiCategoryFlags,
    /// Additive custom detection patterns, in application order.
    pub custom_patterns: Vec<CustomPiiPattern>,
    /// Sensitive key-name deltas applied to the default list.
    pub sensitive_keys: ResolvedSensitiveKeyDelta,
    /// Optional token-lifecycle overrides.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<PiiPolicyLimits>,
    /// Categories forced on regardless of `categories`; MDM union slot, empty in v1.
    pub forced_categories: Vec<PiiCategory>,
}

impl Default for ResolvedPiiPolicy {
    fn default() -> Self {
        resolve_pii_policy(None, None)
    }
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

/// Save-time gate: non-empty, at most [`PII_PATTERN_MAX_LEN`] bytes, compiles under `regex`, no
/// group-applied counted quantifier over [`PII_PATTERN_MAX_QUANTIFIER`], free of `(a+)+`-nesting.
pub fn validate_value_pattern(pattern: &str) -> Result<(), String> {
    if pattern.is_empty() {
        return Err("pattern must not be empty".to_string());
    }
    if pattern.len() > PII_PATTERN_MAX_LEN {
        return Err(format!("pattern exceeds {PII_PATTERN_MAX_LEN} bytes"));
    }
    Regex::new(pattern).map_err(|e| format!("pattern does not compile: {e}"))?;
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

/// Save-time gate for a full user PII policy selection: list-size caps plus
/// per-item validation. Call before persisting a [`crate::config::PiiPolicyUserConfig`].
pub fn validate_user_policy_config(cfg: &crate::config::PiiPolicyUserConfig) -> Result<(), String> {
    if let Some(patterns) = &cfg.custom_patterns {
        if patterns.len() > PII_MAX_CUSTOM_PATTERNS {
            return Err(format!(
                "at most {PII_MAX_CUSTOM_PATTERNS} custom patterns are allowed"
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for p in patterns {
            if p.display_name.trim().is_empty() {
                return Err(format!(
                    "pattern \"{}\" display name must not be empty",
                    p.id
                ));
            }
            if p.display_name.len() > PII_PATTERN_NAME_MAX_LEN {
                return Err(format!(
                    "pattern \"{}\" display name exceeds {PII_PATTERN_NAME_MAX_LEN} bytes",
                    p.id
                ));
            }
            validate_custom_pattern_id(&p.id)?;
            if !seen.insert(p.id.clone()) {
                return Err(format!("duplicate custom pattern id \"{}\"", p.id));
            }
            validate_value_pattern(&p.pattern)?;
        }
    }
    if let Some(delta) = &cfg.sensitive_keys {
        if delta.add.len() > PII_MAX_SENSITIVE_KEYS {
            return Err(format!(
                "at most {PII_MAX_SENSITIVE_KEYS} sensitive keys are allowed"
            ));
        }
        for key in delta.add.iter().chain(delta.remove.iter()) {
            validate_sensitive_key(key)?;
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
    if t.version != 1 {
        return Err(format!("unsupported version {}, expected 1", t.version));
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

/// Merges the user's PII policy with the (v1: always-empty) MDM slot.
/// Infallible: degrades toward MORE filtering only (all-on / dropped).
pub fn resolve_pii_policy(
    user: Option<&crate::config::PiiPolicyUserConfig>,
    managed: Option<&crate::config::ManagedPiiPolicyConfig>,
) -> ResolvedPiiPolicy {
    let requested_template_id = user
        .and_then(|u| u.template_id.clone())
        .unwrap_or_else(|| DEFAULT_TEMPLATE_ID.to_string());

    let template = match builtin_templates() {
        Ok(templates) => {
            let found = templates.iter().find(|t| t.id == requested_template_id);
            if found.is_none() {
                log::warn!(
                    "PII policy: unknown template id \"{requested_template_id}\"; \
                     falling back to all categories on"
                );
            }
            found
        }
        Err(e) => {
            log::warn!("PII policy templates unavailable ({e}); falling back to all categories on");
            None
        }
    };

    let is_custom = user.is_some_and(|u| {
        u.categories.is_some() || u.custom_patterns.is_some() || u.sensitive_keys.is_some()
    });

    let categories = user
        .and_then(|u| u.categories)
        .or_else(|| template.map(|t| t.categories))
        .unwrap_or_default();

    let mut custom_patterns: Vec<CustomPiiPattern> = template
        .map(|t| t.custom_patterns.clone())
        .unwrap_or_default();
    if let Some(extra) = user.and_then(|u| u.custom_patterns.clone()) {
        custom_patterns.extend(extra);
    }
    custom_patterns.retain(|p| match validate_value_pattern(&p.pattern) {
        Ok(()) => true,
        Err(e) => {
            log::warn!(
                "PII policy: dropping unusable stored custom pattern \"{}\": {e}",
                p.id
            );
            false
        }
    });

    let template_keys = template
        .map(|t| t.sensitive_keys.clone())
        .unwrap_or_default();
    let mut add = template_keys.add;
    let mut remove = template_keys.remove;
    if let Some(delta) = user.and_then(|u| u.sensitive_keys.as_ref()) {
        add.extend(delta.add.iter().cloned());
        remove.extend(delta.remove.iter().cloned());
    }

    let forced_categories = managed
        .and_then(|m| m.forced_categories.clone())
        .unwrap_or_default();

    let limits = user.and_then(|u| u.limits).unwrap_or_default();

    let source = if is_custom {
        PiiPolicySource::Custom {
            template_id: user.and_then(|u| u.template_id.clone()),
        }
    } else {
        PiiPolicySource::Template {
            template_id: template
                .map(|t| t.id.clone())
                .unwrap_or_else(|| requested_template_id.clone()),
        }
    };

    ResolvedPiiPolicy {
        version: 1,
        source,
        categories,
        custom_patterns,
        sensitive_keys: ResolvedSensitiveKeyDelta {
            add,
            remove,
            forced_add: Vec::new(),
        },
        limits: Some(limits),
        forced_categories,
    }
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
#[allow(clippy::unwrap_used, clippy::expect_used)]
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
        assert_eq!(strict.categories, PiiCategoryFlags::ALL_ON);
        assert_eq!(
            resolve_pii_policy(None, None).categories,
            PiiCategoryFlags::ALL_ON
        );
        assert_eq!(
            ResolvedPiiPolicy::default().categories,
            PiiCategoryFlags::ALL_ON
        );
    }

    #[test]
    fn gdpr_and_ai_act_templates_have_expected_category_overrides() {
        let templates = builtin_templates().unwrap();
        let gdpr = templates.iter().find(|t| t.id == "gdpr-art32").unwrap();
        assert!(!gdpr.categories.api_key);
        assert!(gdpr.categories.nip);

        let ai_act = templates.iter().find(|t| t.id == "eu-ai-act-art5").unwrap();
        assert!(!ai_act.categories.nip);
        assert!(!ai_act.categories.api_key);
        assert!(ai_act.categories.email);
    }

    #[test]
    fn policy_template_rejects_unknown_top_level_field() {
        let yaml = r#"
version: 1
id: strict
name: "x"
description: "x"
categories: { EMAIL: true, PHONE_PL: true, PESEL: true, NIP: true, IBAN: true, CARD: true, API_KEY: true, SENSITIVE_FIELD: true }
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
version: 1
id: strict
name: "x"
description: "x"
categories: { EMAIL: true, PHONE_PL: true, PESEL: true, NIP: true, IBAN: true, CARD: true, API_KEY: true }
customPatterns: []
sensitiveKeys: { add: [], remove: [] }
"#;
        let result: Result<PolicyTemplate, _> = serde_yaml_ng::from_str(yaml);
        assert!(result.is_err());
    }

    #[test]
    fn policy_template_rejects_unknown_category_key() {
        let yaml = r#"
version: 1
id: strict
name: "x"
description: "x"
categories: { EMAIL: true, PHONE_PL: true, PESEL: true, NIP: true, IBAN: true, CARD: true, API_KEY: true, SENSITIVE_FIELD: true, BOGUS: true }
customPatterns: []
sensitiveKeys: { add: [], remove: [] }
"#;
        let result: Result<PolicyTemplate, _> = serde_yaml_ng::from_str(yaml);
        assert!(result.is_err());
    }

    // ---- resolve_pii_policy semantics ------------------------------------

    #[test]
    fn resolve_with_no_user_and_no_managed_defaults_to_strict_all_on() {
        let resolved = resolve_pii_policy(None, None);
        assert_eq!(resolved.categories, PiiCategoryFlags::ALL_ON);
        assert_eq!(
            resolved.source,
            PiiPolicySource::Template {
                template_id: "strict".to_string()
            }
        );
        assert!(resolved.forced_categories.is_empty());
        assert!(resolved.custom_patterns.is_empty());
    }

    #[test]
    fn resolve_with_known_template_id_uses_its_categories() {
        let user = PiiPolicyUserConfig {
            template_id: Some("gdpr-art32".to_string()),
            ..Default::default()
        };
        let resolved = resolve_pii_policy(Some(&user), None);
        assert!(!resolved.categories.api_key);
        assert_eq!(
            resolved.source,
            PiiPolicySource::Template {
                template_id: "gdpr-art32".to_string()
            }
        );
    }

    #[test]
    fn resolve_with_unknown_template_id_degrades_to_all_on() {
        let user = PiiPolicyUserConfig {
            template_id: Some("totally-bogus-template".to_string()),
            ..Default::default()
        };
        let resolved = resolve_pii_policy(Some(&user), None);
        assert_eq!(resolved.categories, PiiCategoryFlags::ALL_ON);
        assert_eq!(
            resolved.source,
            PiiPolicySource::Template {
                template_id: "totally-bogus-template".to_string()
            }
        );
    }

    #[test]
    fn resolve_with_category_override_switches_to_custom_mode() {
        let mut categories = PiiCategoryFlags::ALL_ON;
        categories.set(PiiCategory::Email, false);
        let user = PiiPolicyUserConfig {
            categories: Some(categories),
            ..Default::default()
        };
        let resolved = resolve_pii_policy(Some(&user), None);
        assert_eq!(resolved.categories, categories);
        assert_eq!(
            resolved.source,
            PiiPolicySource::Custom { template_id: None }
        );
    }

    #[test]
    fn resolve_with_template_and_extra_custom_pattern_records_provenance() {
        let user = PiiPolicyUserConfig {
            template_id: Some("gdpr-art32".to_string()),
            custom_patterns: Some(vec![CustomPiiPattern {
                id: "EMPLOYEE_ID".to_string(),
                display_name: "Employee ID".to_string(),
                pattern: r"\bEMP-\d{4,8}\b".to_string(),
                case_insensitive: false,
                forced: false,
            }]),
            ..Default::default()
        };
        let resolved = resolve_pii_policy(Some(&user), None);
        assert_eq!(
            resolved.source,
            PiiPolicySource::Custom {
                template_id: Some("gdpr-art32".to_string())
            }
        );
        assert_eq!(resolved.custom_patterns.len(), 1);
        assert!(
            !resolved.categories.api_key,
            "gdpr-art32 baseline preserved"
        );
    }

    #[test]
    fn resolve_drops_invalid_stored_custom_pattern_and_keeps_the_rest() {
        let user = PiiPolicyUserConfig {
            custom_patterns: Some(vec![
                CustomPiiPattern {
                    id: "GOOD".to_string(),
                    display_name: "Good".to_string(),
                    pattern: r"\d{3}".to_string(),
                    case_insensitive: false,
                    forced: false,
                },
                CustomPiiPattern {
                    id: "BAD".to_string(),
                    display_name: "Bad".to_string(),
                    pattern: "(a+)+".to_string(),
                    case_insensitive: false,
                    forced: false,
                },
            ]),
            ..Default::default()
        };
        let resolved = resolve_pii_policy(Some(&user), None);
        assert_eq!(resolved.custom_patterns.len(), 1);
        assert_eq!(resolved.custom_patterns[0].id, "GOOD");
    }

    #[test]
    fn resolve_applies_sensitive_key_delta_on_top_of_template() {
        let user = PiiPolicyUserConfig {
            sensitive_keys: Some(PiiSensitiveKeyDelta {
                add: vec!["salary".to_string()],
                remove: vec![],
            }),
            ..Default::default()
        };
        let resolved = resolve_pii_policy(Some(&user), None);
        assert!(resolved.sensitive_keys.add.contains(&"salary".to_string()));
        assert!(resolved.sensitive_keys.forced_add.is_empty());
    }

    #[test]
    fn resolve_carries_mdm_forced_categories_unmerged() {
        let managed = ManagedPiiPolicyConfig {
            forced_categories: Some(vec![PiiCategory::ApiKey]),
        };
        let mut categories = PiiCategoryFlags::ALL_ON;
        categories.set(PiiCategory::ApiKey, false);
        let user = PiiPolicyUserConfig {
            categories: Some(categories),
            ..Default::default()
        };
        let resolved = resolve_pii_policy(Some(&user), Some(&managed));
        assert!(
            !resolved.categories.api_key,
            "forced_categories is a separate slot, not OR'd in here"
        );
        assert_eq!(resolved.forced_categories, vec![PiiCategory::ApiKey]);
    }

    #[test]
    fn resolve_applies_user_limits_override() {
        let user = PiiPolicyUserConfig {
            limits: Some(PiiPolicyLimits {
                max_tokens: 50,
                ttl_ms: 60_000,
            }),
            ..Default::default()
        };
        let resolved = resolve_pii_policy(Some(&user), None);
        assert_eq!(
            resolved.limits,
            Some(PiiPolicyLimits {
                max_tokens: 50,
                ttl_ms: 60_000
            })
        );
    }

    // ---- serde round-trips -------------------------------------------------

    #[test]
    fn resolved_pii_policy_json_round_trips_and_uses_camel_case() {
        let resolved = resolve_pii_policy(
            Some(&PiiPolicyUserConfig {
                template_id: Some("gdpr-art32".to_string()),
                custom_patterns: Some(vec![CustomPiiPattern {
                    id: "EMPLOYEE_ID".to_string(),
                    display_name: "Employee ID".to_string(),
                    pattern: r"\bEMP-\d{4,8}\b".to_string(),
                    case_insensitive: false,
                    forced: false,
                }]),
                sensitive_keys: Some(PiiSensitiveKeyDelta {
                    add: vec!["salary".to_string()],
                    remove: vec![],
                }),
                ..Default::default()
            }),
            None,
        );

        let value = serde_json::to_value(&resolved).unwrap();
        assert_eq!(value["version"], 1);
        assert!(value.get("customPatterns").is_some());
        assert!(value.get("sensitiveKeys").is_some());
        assert!(value.get("forcedCategories").is_some());
        assert_eq!(value["categories"]["EMAIL"], true);
        assert_eq!(value["customPatterns"][0]["displayName"], "Employee ID");
        assert_eq!(value["customPatterns"][0]["caseInsensitive"], false);
        assert_eq!(value["sensitiveKeys"]["forcedAdd"], serde_json::json!([]));
        // Literal wire values, so a symmetric casing bug can't hide behind the round-trip.
        assert_eq!(value["source"]["mode"], "custom");
        assert_eq!(value["source"]["templateId"], "gdpr-art32");

        let default_value = serde_json::to_value(resolve_pii_policy(None, None)).unwrap();
        assert_eq!(default_value["source"]["mode"], "template");
        assert_eq!(default_value["source"]["templateId"], "strict");

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
    fn validate_value_pattern_rejects_over_512_bytes() {
        let huge = "a".repeat(PII_PATTERN_MAX_LEN + 1);
        let err = validate_value_pattern(&huge).unwrap_err();
        assert!(err.contains("512"));
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
            .map(|i| CustomPiiPattern {
                id: format!("PAT_{i}"),
                display_name: format!("Pat {i}"),
                pattern: r"\d{3}".to_string(),
                case_insensitive: false,
                forced: false,
            })
            .collect();
        let cfg = PiiPolicyUserConfig {
            custom_patterns: Some(patterns),
            ..Default::default()
        };
        assert!(validate_user_policy_config(&cfg).is_err());
    }

    #[test]
    fn validate_user_policy_config_rejects_duplicate_pattern_ids() {
        let cfg = PiiPolicyUserConfig {
            custom_patterns: Some(vec![
                CustomPiiPattern {
                    id: "DUP".to_string(),
                    display_name: "Dup 1".to_string(),
                    pattern: r"\d{3}".to_string(),
                    case_insensitive: false,
                    forced: false,
                },
                CustomPiiPattern {
                    id: "DUP".to_string(),
                    display_name: "Dup 2".to_string(),
                    pattern: r"\d{4}".to_string(),
                    case_insensitive: false,
                    forced: false,
                },
            ]),
            ..Default::default()
        };
        assert!(validate_user_policy_config(&cfg).is_err());
    }

    #[test]
    fn validate_user_policy_config_rejects_over_length_display_name() {
        let cfg = PiiPolicyUserConfig {
            custom_patterns: Some(vec![CustomPiiPattern {
                id: "EMPLOYEE_ID".to_string(),
                display_name: "a".repeat(PII_PATTERN_NAME_MAX_LEN + 1),
                pattern: r"\d{3}".to_string(),
                case_insensitive: false,
                forced: false,
            }]),
            ..Default::default()
        };
        let err = validate_user_policy_config(&cfg).unwrap_err();
        assert!(err.contains("display name exceeds"));
    }

    #[test]
    fn validate_user_policy_config_accepts_max_length_display_name() {
        let cfg = PiiPolicyUserConfig {
            custom_patterns: Some(vec![CustomPiiPattern {
                id: "EMPLOYEE_ID".to_string(),
                display_name: "a".repeat(PII_PATTERN_NAME_MAX_LEN),
                pattern: r"\d{3}".to_string(),
                case_insensitive: false,
                forced: false,
            }]),
            ..Default::default()
        };
        assert!(validate_user_policy_config(&cfg).is_ok());
    }

    #[test]
    fn validate_user_policy_config_rejects_too_many_sensitive_keys() {
        let cfg = PiiPolicyUserConfig {
            sensitive_keys: Some(PiiSensitiveKeyDelta {
                add: (0..PII_MAX_SENSITIVE_KEYS + 1)
                    .map(|i| format!("k{i}"))
                    .collect(),
                remove: vec![],
            }),
            ..Default::default()
        };
        assert!(validate_user_policy_config(&cfg).is_err());
    }

    #[test]
    fn validate_user_policy_config_accepts_well_formed_config() {
        let cfg = PiiPolicyUserConfig {
            template_id: Some("strict".to_string()),
            custom_patterns: Some(vec![CustomPiiPattern {
                id: "EMPLOYEE_ID".to_string(),
                display_name: "Employee ID".to_string(),
                pattern: r"\bEMP-\d{4,8}\b".to_string(),
                case_insensitive: false,
                forced: false,
            }]),
            sensitive_keys: Some(PiiSensitiveKeyDelta {
                add: vec!["salary".to_string()],
                remove: vec![],
            }),
            ..Default::default()
        };
        assert!(validate_user_policy_config(&cfg).is_ok());
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

    /// Snapshot: written JSON matches the pinned contract shape, incl. the
    /// literal `source.mode`/`templateId` values.
    #[test]
    fn write_policy_config_matches_pinned_contract_shape() {
        let tmp = tempfile::tempdir().unwrap();
        let policy = resolve_pii_policy(
            Some(&PiiPolicyUserConfig {
                template_id: Some("gdpr-art32".to_string()),
                custom_patterns: Some(vec![CustomPiiPattern {
                    id: "EMPLOYEE_ID".to_string(),
                    display_name: "Employee ID".to_string(),
                    pattern: r"\bEMP-\d{4,8}\b".to_string(),
                    case_insensitive: false,
                    forced: false,
                }]),
                sensitive_keys: Some(PiiSensitiveKeyDelta {
                    add: vec!["salary".to_string()],
                    remove: vec![],
                }),
                ..Default::default()
            }),
            None,
        );
        write_policy_config_in(tmp.path(), "proj", &policy).unwrap();

        let path = policy_config_path_in(tmp.path(), "proj");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["source"]["mode"], "custom");
        assert_eq!(v["source"]["templateId"], "gdpr-art32");
        assert_eq!(v["categories"]["EMAIL"], true);
        assert!(!v["categories"]["API_KEY"].as_bool().unwrap());
        assert_eq!(v["customPatterns"][0]["id"], "EMPLOYEE_ID");
        assert_eq!(v["customPatterns"][0]["displayName"], "Employee ID");
        assert_eq!(v["sensitiveKeys"]["add"][0], "salary");
        assert_eq!(v["sensitiveKeys"]["forcedAdd"], serde_json::json!([]));
        assert_eq!(v["forcedCategories"], serde_json::json!([]));
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
        other.categories.set(PiiCategory::Email, false);
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
