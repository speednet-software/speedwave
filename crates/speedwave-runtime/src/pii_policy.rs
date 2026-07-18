//! PII policy config model: the built-in rule library, built-in templates, the
//! resolved `policy.json` v3 contract, and save-time validation (TS counterpart:
//! `mcp-servers/policies`). Rules are an open id set: the library
//! (`mcp-servers/policies/rules.yaml`) defines what a rule id detects, and
//! templates/user policies decide which ids are tokenized/logged and add their
//! own additive rules and literal keyword substitutions.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// Maximum stored length (bytes) of a rule's display name.
const PII_RULE_NAME_MAX_LEN: usize = 64;
/// Minimum length (bytes) of an additive rule's regex source, mirroring `pattern-lint.ts`'s `MIN_LENGTH`.
const PII_PATTERN_MIN_LEN: usize = 3;
/// Maximum bound of a group-applied counted quantifier (the `){n}`/`){n,}`/`){n,m}`
/// form), mirroring `pattern-lint.ts`'s `MAX_QUANTIFIER_COUNT`. Atom and char-class
/// quantifiers are exempt (linear-time, not a ReDoS risk), as in the TS lint.
const PII_PATTERN_MAX_QUANTIFIER: u32 = 128;
/// Validator names the engine (`pii-engine::patterns::validator_by_name`) recognizes.
const KNOWN_VALIDATORS: [&str; 4] = ["pesel", "nip", "iban", "luhn"];

fn default_true() -> bool {
    true
}

/// Per-rule-id enablement in a v3 `categories` map (template or user policy),
/// mirroring the engine's `CategoryFlags` as an independent serde type since
/// writer and reader schemas are validated separately.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuleFlags {
    /// Whether hits in this rule are tokenized (sealed) before leaving the engine.
    pub tokenize: bool,
    /// Whether hits in this rule are logged (observation mode).
    pub log: bool,
}

/// Field-by-field OR of two flag pairs (union semantics: a rule is on/logged
/// if ANY policy in the effective set turns it on).
fn or_rule_flags(a: RuleFlags, b: RuleFlags) -> RuleFlags {
    RuleFlags {
        tokenize: a.tokenize || b.tokenize,
        log: a.log || b.log,
    }
}

/// One literal keyword substitution (mirrors `pii-engine`'s `KeywordV3`):
/// an exact string and the alias substituted for it, bidirectionally, in the proxy.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeywordV3 {
    /// The literal text to mask; matched case-sensitively unless `case_sensitive` is `false`.
    pub r#match: String,
    /// The alias substituted for `match`; must match `^[A-Za-z][A-Za-z0-9]*$`.
    pub alias: String,
    /// Whether matching is case-sensitive; defaults to `true`.
    #[serde(default = "default_true")]
    pub case_sensitive: bool,
}

/// An additive detection rule defined by a template or user policy: full schema
/// (id/patterns/validator) plus its own `{tokenize, log}` pair, distinct from a
/// library rule (which carries no flags — the library defines detection, not policy).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnRuleV3 {
    /// Rule id, `^[A-Z][A-Z0-9_]{0,63}$`; must not collide with a library rule id.
    pub id: String,
    /// Human-readable name shown in UI and audit.
    pub display_name: String,
    /// Regex patterns; a hit on any one counts as a hit on the rule.
    pub patterns: Vec<String>,
    /// Named checksum validator (`pesel`/`nip`/`iban`/`luhn`), run on a match before it counts as a hit.
    #[serde(default)]
    pub validator: Option<String>,
    /// Whether patterns are matched case-sensitively; defaults to `true`.
    #[serde(default = "default_true")]
    pub case_sensitive: bool,
    /// Whether hits in this rule are tokenized (sealed) before leaving the engine.
    pub tokenize: bool,
    /// Whether hits in this rule are logged (observation mode).
    pub log: bool,
}

/// One rule from the built-in library (`mcp-servers/policies/rules.yaml`):
/// detection only, no flags — the library defines what to detect, policies
/// (templates/user configs) decide what to do with it via `categories`.
#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryRule {
    /// Rule id, `^[A-Z][A-Z0-9_]{0,63}$`; referenced by a policy's `categories` map.
    pub id: String,
    /// Human-readable name shown in UI and audit.
    pub display_name: String,
    /// Regex patterns; a hit on any one counts as a hit on the rule.
    pub patterns: Vec<String>,
    /// Named checksum validator (`pesel`/`nip`/`iban`/`luhn`).
    #[serde(default)]
    pub validator: Option<String>,
}

#[derive(Deserialize)]
struct LibraryFile {
    version: u32,
    rules: Vec<LibraryRule>,
}

/// A rule id, in either the library or an additive `rules` list, must match
/// `^[A-Z][A-Z0-9_]{0,63}$` (mirrors `pii-engine::policy::RULE_ID_RE`).
static RULE_ID_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"^[A-Z][A-Z0-9_]{0,63}$"));
/// A keyword alias must match `^[A-Za-z][A-Za-z0-9]*$` (mirrors `pii-engine::policy::ALIAS_RE`).
static KEYWORD_ALIAS_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9]*$"));
static TEMPLATE_ID_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9-]{1,63}$"));

/// Fetches a lazily-compiled id-shape regex, mapping a compile failure to a
/// validation error instead of a panic (no-panic rule outside tests).
fn id_regex(re: &'static LazyLock<Result<Regex, regex::Error>>) -> Result<&'static Regex, String> {
    (**re)
        .as_ref()
        .map_err(|e| format!("internal id pattern failed to compile: {e}"))
}

/// Validates a rule id's shape (library or additive `rules` entry): `^[A-Z][A-Z0-9_]{0,63}$`.
fn validate_rule_id(id: &str) -> Result<(), String> {
    if !id_regex(&RULE_ID_RE)?.is_match(id) {
        return Err(format!(
            "rule id \"{id}\" must match ^[A-Z][A-Z0-9_]{{0,63}}$"
        ));
    }
    Ok(())
}

fn load_rule_library() -> anyhow::Result<Vec<LibraryRule>> {
    const RAW: &str = include_str!("../../../mcp-servers/policies/rules.yaml");
    let file: LibraryFile = serde_yaml_ng::from_str(RAW)
        .map_err(|e| anyhow::anyhow!("built-in rule library failed to parse: {e}"))?;
    if file.version != 3 {
        anyhow::bail!(
            "built-in rule library has unsupported version {}, expected 3",
            file.version
        );
    }
    let mut seen = HashSet::new();
    for r in &file.rules {
        validate_rule_id(&r.id).map_err(|e| anyhow::anyhow!("built-in rule library: {e}"))?;
        if !seen.insert(r.id.clone()) {
            anyhow::bail!("built-in rule library has duplicate rule id \"{}\"", r.id);
        }
        if r.patterns.is_empty() {
            anyhow::bail!("built-in rule library rule \"{}\" has no patterns", r.id);
        }
    }
    Ok(file.rules)
}

static RULE_LIBRARY: LazyLock<anyhow::Result<Vec<LibraryRule>>> = LazyLock::new(load_rule_library);

/// The built-in rule library, parsed once from the embedded `rules.yaml`.
pub fn rule_library() -> anyhow::Result<&'static [LibraryRule]> {
    match &*RULE_LIBRARY {
        Ok(v) => Ok(v),
        Err(e) => Err(anyhow::anyhow!("{e}")),
    }
}

/// A named, shippable policy preset loaded from `templates/*.yaml` (v3 schema).
/// Unknown top-level keys are hard rejected.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyTemplate {
    /// Schema version; the resolver supports exactly 3.
    pub version: u32,
    /// Template id, `^[a-z][a-z0-9-]{1,63}$`; "custom" is reserved.
    pub id: String,
    /// Human-readable template name.
    pub name: String,
    /// Human-readable template description.
    pub description: String,
    /// Per-library-rule-id `{tokenize, log}` overrides; a rule id absent here
    /// is disabled by this template. Every key must be a real library rule id.
    #[serde(default)]
    pub categories: HashMap<String, RuleFlags>,
    /// Additive custom detection rules shipped with the template.
    #[serde(default)]
    pub rules: Vec<OwnRuleV3>,
    /// Literal keyword substitutions shipped with the template.
    #[serde(default)]
    pub keywords: Vec<KeywordV3>,
}

/// Provenance of a resolved policy.json v3 (mirrors the contract's `source` object).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedPiiPolicySource {
    /// The effective policy id set (user selection ∪ MDM-forced ids).
    pub policies: Vec<String>,
    /// The subset of `policies` forced on by MDM.
    pub forced: Vec<String>,
}

/// One rule as written to `policy.json` v3: library or additive-rule fields
/// plus the flags resolved for it in the effective policy set.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuleOutput {
    /// Rule id.
    pub id: String,
    /// Human-readable name shown in UI and audit.
    pub display_name: String,
    /// Regex patterns; a hit on any one counts as a hit.
    pub patterns: Vec<String>,
    /// Named checksum validator, when the rule declares one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validator: Option<String>,
    /// Whether patterns are matched case-sensitively.
    pub case_sensitive: bool,
    /// Whether hits are tokenized (sealed) before leaving the engine.
    pub tokenize: bool,
    /// Whether hits are logged (observation mode).
    pub log: bool,
}

/// The fully-resolved policy written to `policy.json` v3, consumed by
/// `speedwave_pii_engine::compile_policy_v3`. Self-contained: every rule and
/// keyword is rendered inline, no reference back to a library or template.
/// `Default` is the compiled-in fallback: every library rule tokenized, no
/// additive rules or keywords.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPiiPolicy {
    /// Schema version; the engine supports exactly 3.
    pub version: u32,
    /// Provenance of this resolved policy.
    pub source: ResolvedPiiPolicySource,
    /// Rules with at least one flag on, library rules (file order) then additive
    /// rules (id order).
    pub rules: Vec<RuleOutput>,
    /// Literal keyword substitutions, union of the effective policy set.
    pub keywords: Vec<KeywordV3>,
}

impl Default for ResolvedPiiPolicy {
    fn default() -> Self {
        safe_default_policy()
    }
}

/// Fail-closed fallback (every library rule tokenized, no additive rules or
/// keywords): both `Default` and the empty-effective-set resolution, kept
/// panic-free so it can back `Default`.
fn safe_default_policy() -> ResolvedPiiPolicy {
    let rules = rule_library()
        .map(|lib| {
            lib.iter()
                .map(|r| RuleOutput {
                    id: r.id.clone(),
                    display_name: r.display_name.clone(),
                    patterns: r.patterns.clone(),
                    validator: r.validator.clone(),
                    case_sensitive: true,
                    tokenize: true,
                    log: false,
                })
                .collect()
        })
        .unwrap_or_default();
    ResolvedPiiPolicy {
        version: 3,
        source: ResolvedPiiPolicySource::default(),
        rules,
        keywords: Vec::new(),
    }
}

/// The beta-off no-op policy: nothing tokenized or logged, no rules, no
/// keywords — the proxy and hub engines compile it to zero rules.
pub fn disabled_policy() -> ResolvedPiiPolicy {
    ResolvedPiiPolicy {
        version: 3,
        source: ResolvedPiiPolicySource::default(),
        rules: Vec::new(),
        keywords: Vec::new(),
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

/// Save-time gate, a superset of the TS load lint so a saved rule never gets silently dropped
/// at load: length in [`PII_PATTERN_MIN_LEN`]..=`consts::PII_MAX_PATTERN_LENGTH` bytes, compiles under `regex`,
/// does not match the empty string, no group-applied counted quantifier over
/// [`PII_PATTERN_MAX_QUANTIFIER`], free of `(a+)+`-nesting.
pub fn validate_value_pattern(pattern: &str) -> Result<(), String> {
    if pattern.len() < PII_PATTERN_MIN_LEN || pattern.len() > crate::consts::PII_MAX_PATTERN_LENGTH
    {
        return Err(format!(
            "pattern length {} is outside the allowed {PII_PATTERN_MIN_LEN}..={} bytes",
            pattern.len(),
            crate::consts::PII_MAX_PATTERN_LENGTH
        ));
    }
    let compiled = Regex::new(pattern).map_err(|e| format!("pattern does not compile: {e}"))?;
    if compiled.is_match("") {
        return Err("pattern must not match the empty string".to_string());
    }
    scan_quantifier_bounds(pattern)?;
    scan_nested_quantifiers(pattern)
}

/// Validates one additive rule (template/policy `rules[]` entry): id shape and
/// no collision with a library rule id, display name, pattern set, validator name.
fn validate_own_rule(r: &OwnRuleV3, library_ids: &HashSet<&str>) -> Result<(), String> {
    validate_rule_id(&r.id)?;
    if library_ids.contains(r.id.as_str()) {
        return Err(format!(
            "rule id \"{}\" collides with a built-in library rule",
            r.id
        ));
    }
    if r.display_name.trim().is_empty() {
        return Err(format!("rule \"{}\": display name must not be empty", r.id));
    }
    if r.display_name.len() > PII_RULE_NAME_MAX_LEN {
        return Err(format!(
            "rule \"{}\": display name exceeds {PII_RULE_NAME_MAX_LEN} bytes",
            r.id
        ));
    }
    if r.patterns.is_empty() {
        return Err(format!("rule \"{}\": must have at least one pattern", r.id));
    }
    for p in &r.patterns {
        validate_value_pattern(p).map_err(|e| format!("rule \"{}\": {e}", r.id))?;
    }
    if let Some(v) = &r.validator {
        if !KNOWN_VALIDATORS.contains(&v.as_str()) {
            return Err(format!("rule \"{}\": unknown validator \"{v}\"", r.id));
        }
    }
    Ok(())
}

/// Validates one keyword's own fields (length, alias shape, match != alias);
/// cross-policy checks (uniqueness, alias/match collisions) run at merge time.
fn validate_keyword_fields(kw: &KeywordV3) -> Result<(), String> {
    let match_len = kw.r#match.chars().count();
    if !(3..=128).contains(&match_len) {
        return Err(format!(
            "keyword match \"{}\" must be 3-128 characters",
            kw.r#match
        ));
    }
    let alias_len = kw.alias.chars().count();
    if !(3..=128).contains(&alias_len) {
        return Err(format!(
            "keyword alias \"{}\" must be 3-128 characters",
            kw.alias
        ));
    }
    if !id_regex(&KEYWORD_ALIAS_RE)?.is_match(&kw.alias) {
        return Err(format!(
            "keyword alias \"{}\" must match ^[A-Za-z][A-Za-z0-9]*$",
            kw.alias
        ));
    }
    if kw.r#match.to_lowercase() == kw.alias.to_lowercase() {
        return Err(format!(
            "keyword match and alias must differ: \"{}\"",
            kw.r#match
        ));
    }
    Ok(())
}

/// Unions keywords from every member of the effective policy set: per-field
/// validation, count cap, identical-duplicate collapse, then the cross-policy
/// checks from the design doc (`SPEED-311-yaml-rules-design.md` §4): the same
/// `match` with a different `alias`/`caseSensitive` is an error, an `alias`
/// must be unique, and an `alias` must never equal another keyword's `match`.
fn merge_and_validate_keywords(raw: Vec<KeywordV3>) -> Result<Vec<KeywordV3>, String> {
    if raw.len() > crate::consts::PII_MAX_KEYWORDS {
        return Err(format!(
            "too many keywords: {} exceeds the limit of {}",
            raw.len(),
            crate::consts::PII_MAX_KEYWORDS
        ));
    }
    for kw in &raw {
        validate_keyword_fields(kw)?;
    }

    let mut merged: Vec<KeywordV3> = Vec::new();
    for kw in raw {
        match merged.iter().find(|m| m.r#match == kw.r#match) {
            None => merged.push(kw),
            Some(existing) => {
                if existing.alias != kw.alias || existing.case_sensitive != kw.case_sensitive {
                    return Err(format!(
                        "keyword \"{}\" is defined with a different alias or caseSensitive flag \
                         across policies in the effective set",
                        kw.r#match
                    ));
                }
                // Identical duplicate across two policies: collapse to one.
            }
        }
    }

    let matches: HashSet<&str> = merged.iter().map(|k| k.r#match.as_str()).collect();
    let mut seen_alias = HashSet::new();
    for kw in &merged {
        if !seen_alias.insert(kw.alias.clone()) {
            return Err(format!(
                "duplicate keyword alias \"{}\" across policies in the effective set",
                kw.alias
            ));
        }
        if matches.contains(kw.alias.as_str()) {
            return Err(format!(
                "keyword alias \"{}\" collides with another keyword's match",
                kw.alias
            ));
        }
    }

    Ok(merged)
}

/// Validates a template: version, id shape/reservation, `categories` keys are
/// real library rule ids, additive rules and keywords are well-formed and unique.
fn validate_template(t: &PolicyTemplate, library_ids: &HashSet<&str>) -> Result<(), String> {
    if t.version != 3 {
        return Err(format!("unsupported version {}, expected 3", t.version));
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
    for rule_id in t.categories.keys() {
        if !library_ids.contains(rule_id.as_str()) {
            return Err(format!(
                "template \"{}\": categories references unknown rule id \"{rule_id}\"",
                t.id
            ));
        }
    }
    let mut seen = HashSet::new();
    for r in &t.rules {
        validate_own_rule(r, library_ids)?;
        if !seen.insert(r.id.clone()) {
            return Err(format!(
                "template \"{}\": duplicate rule id \"{}\"",
                t.id, r.id
            ));
        }
    }
    for kw in &t.keywords {
        validate_keyword_fields(kw).map_err(|e| format!("template \"{}\": {e}", t.id))?;
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
    let library = rule_library()?;
    let library_ids: HashSet<&str> = library.iter().map(|r| r.id.as_str()).collect();

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
        validate_template(&template, &library_ids)
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

/// Save-time gate for one policy definition's own contents: `categories` keys,
/// additive rules, and keywords, plus the list-size caps.
fn validate_policy_definition_contents(
    def: &crate::config::PiiPolicyDefinition,
    library_ids: &HashSet<&str>,
) -> Result<(), String> {
    if def.name.trim().is_empty() {
        return Err(format!("policy \"{}\": name must not be empty", def.id));
    }
    for rule_id in def.categories.keys() {
        if !library_ids.contains(rule_id.as_str()) {
            return Err(format!(
                "policy \"{}\": categories references unknown rule id \"{rule_id}\"",
                def.id
            ));
        }
    }
    if def.rules.len() > crate::consts::PII_MAX_RULES {
        return Err(format!(
            "policy \"{}\": at most {} rules are allowed",
            def.id,
            crate::consts::PII_MAX_RULES
        ));
    }
    let mut seen = HashSet::new();
    for r in &def.rules {
        validate_own_rule(r, library_ids).map_err(|e| format!("policy \"{}\": {e}", def.id))?;
        if !seen.insert(r.id.clone()) {
            return Err(format!(
                "policy \"{}\": duplicate rule id \"{}\"",
                def.id, r.id
            ));
        }
    }
    if def.keywords.len() > crate::consts::PII_MAX_KEYWORDS {
        return Err(format!(
            "policy \"{}\": at most {} keywords are allowed",
            def.id,
            crate::consts::PII_MAX_KEYWORDS
        ));
    }
    for kw in &def.keywords {
        validate_keyword_fields(kw).map_err(|e| format!("policy \"{}\": {e}", def.id))?;
    }
    Ok(())
}

/// Save-time gate for a full user PII policy selection: per-definition
/// validation, id collisions/duplicates, and unknown ids in `policies`.
pub fn validate_user_policy_config(cfg: &crate::config::PiiPolicyUserConfig) -> Result<(), String> {
    let templates = builtin_templates().map_err(|e| e.to_string())?;
    let library = rule_library().map_err(|e| e.to_string())?;
    let library_ids: HashSet<&str> = library.iter().map(|r| r.id.as_str()).collect();

    let mut seen_ids = HashSet::new();
    for def in &cfg.custom_policies {
        validate_policy_id_against_templates(&def.id, templates)?;
        if !seen_ids.insert(def.id.clone()) {
            return Err(format!("duplicate custom policy id \"{}\"", def.id));
        }
        validate_policy_definition_contents(def, &library_ids)?;
    }

    let known_ids: HashSet<&str> = templates
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

/// A resolved policy-set member, borrowed from either a builtin template or a
/// user policy definition — symmetric inputs to the union.
struct PolicyMember<'a> {
    id: &'a str,
    categories: &'a HashMap<String, RuleFlags>,
    rules: &'a [OwnRuleV3],
    keywords: &'a [KeywordV3],
}

/// Resolves `user.policies ∪ managed.forced_policies` into a policy.json v3 document.
/// Fail-closed: any ambiguity or unresolvable id is an `Err`, never a silent degrade.
pub fn resolve_pii_policy(
    user: Option<&crate::config::PiiPolicyUserConfig>,
    managed: Option<&crate::config::ManagedPiiPolicyConfig>,
) -> Result<ResolvedPiiPolicy, String> {
    let templates = builtin_templates().map_err(|e| e.to_string())?;
    let library = rule_library().map_err(|e| e.to_string())?;
    let library_ids: HashSet<&str> = library.iter().map(|r| r.id.as_str()).collect();
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
    let mut seen_custom_ids = HashSet::new();
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
                categories: &t.categories,
                rules: &t.rules,
                keywords: &t.keywords,
            });
        } else if let Some(d) = custom_policies.iter().find(|d| &d.id == id) {
            members.push(PolicyMember {
                id: &d.id,
                categories: &d.categories,
                rules: &d.rules,
                keywords: &d.keywords,
            });
        } else {
            return Err(format!("unknown PII policy id \"{id}\""));
        }
    }

    // Categories: OR each library rule id's flags across the effective set;
    // every referenced id must be a real library rule.
    let mut merged_categories: HashMap<String, RuleFlags> = HashMap::new();
    for m in &members {
        for (rule_id, flags) in m.categories {
            if !library_ids.contains(rule_id.as_str()) {
                return Err(format!(
                    "policy \"{}\": categories references unknown rule id \"{rule_id}\"",
                    m.id
                ));
            }
            merged_categories
                .entry(rule_id.clone())
                .and_modify(|f| *f = or_rule_flags(*f, *flags))
                .or_insert(*flags);
        }
    }

    // Additive rules: union by id, first-seen order; a shared id must match
    // (patterns, validator, caseSensitive) or it's Err; flags OR across duplicates.
    let mut own_rule_order: Vec<String> = Vec::new();
    let mut own_rules: HashMap<String, OwnRuleV3> = HashMap::new();
    for m in &members {
        for r in m.rules {
            validate_own_rule(r, &library_ids).map_err(|e| format!("policy \"{}\": {e}", m.id))?;
            match own_rules.get_mut(&r.id) {
                None => {
                    own_rule_order.push(r.id.clone());
                    own_rules.insert(r.id.clone(), r.clone());
                }
                Some(existing) => {
                    if existing.patterns != r.patterns
                        || existing.validator != r.validator
                        || existing.case_sensitive != r.case_sensitive
                    {
                        return Err(format!(
                            "rule id \"{}\" is defined with a different pattern set, validator, \
                             or caseSensitive flag across policies in the effective set",
                            r.id
                        ));
                    }
                    existing.tokenize = existing.tokenize || r.tokenize;
                    existing.log = existing.log || r.log;
                }
            }
        }
    }
    own_rule_order.sort();

    // Keywords: union across the effective set, validated per §4 of the design doc.
    let mut raw_keywords: Vec<KeywordV3> = Vec::new();
    for m in &members {
        raw_keywords.extend(m.keywords.iter().cloned());
    }
    let keywords = merge_and_validate_keywords(raw_keywords)?;

    // Rules output: library rules (file order) with at least one flag on, then
    // additive rules (id order) with at least one flag on.
    let mut rules: Vec<RuleOutput> = Vec::new();
    for lib in library {
        let flags = merged_categories
            .get(&lib.id)
            .copied()
            .unwrap_or(RuleFlags {
                tokenize: false,
                log: false,
            });
        if flags.tokenize || flags.log {
            rules.push(RuleOutput {
                id: lib.id.clone(),
                display_name: lib.display_name.clone(),
                patterns: lib.patterns.clone(),
                validator: lib.validator.clone(),
                case_sensitive: true,
                tokenize: flags.tokenize,
                log: flags.log,
            });
        }
    }
    for id in &own_rule_order {
        let r = &own_rules[id];
        if r.tokenize || r.log {
            rules.push(RuleOutput {
                id: r.id.clone(),
                display_name: r.display_name.clone(),
                patterns: r.patterns.clone(),
                validator: r.validator.clone(),
                case_sensitive: r.case_sensitive,
                tokenize: r.tokenize,
                log: r.log,
            });
        }
    }

    if rules.len() > crate::consts::PII_MAX_RULES {
        return Err(format!(
            "too many rules in the effective policy set: {} exceeds the limit of {}",
            rules.len(),
            crate::consts::PII_MAX_RULES
        ));
    }
    let total_patterns: usize = rules.iter().map(|r| r.patterns.len()).sum();
    if total_patterns > crate::consts::PII_MAX_PATTERNS {
        return Err(format!(
            "too many patterns in the effective policy set: {total_patterns} exceeds the limit of {}",
            crate::consts::PII_MAX_PATTERNS
        ));
    }

    Ok(ResolvedPiiPolicy {
        version: 3,
        source: ResolvedPiiPolicySource {
            policies: effective,
            forced,
        },
        rules,
        keywords,
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

    fn flags(tokenize: bool, log: bool) -> RuleFlags {
        RuleFlags { tokenize, log }
    }

    fn keyword(m: &str, alias: &str, case_sensitive: bool) -> KeywordV3 {
        KeywordV3 {
            r#match: m.to_string(),
            alias: alias.to_string(),
            case_sensitive,
        }
    }

    fn own_rule(id: &str, pattern: &str, tokenize: bool, log: bool) -> OwnRuleV3 {
        OwnRuleV3 {
            id: id.to_string(),
            display_name: id.to_string(),
            patterns: vec![pattern.to_string()],
            validator: None,
            case_sensitive: true,
            tokenize,
            log,
        }
    }

    fn custom_policy(
        id: &str,
        categories: HashMap<String, RuleFlags>,
        rules: Vec<OwnRuleV3>,
        keywords: Vec<KeywordV3>,
    ) -> crate::config::PiiPolicyDefinition {
        crate::config::PiiPolicyDefinition {
            id: id.to_string(),
            name: id.to_string(),
            categories,
            rules,
            keywords,
        }
    }

    fn all_on_categories() -> HashMap<String, RuleFlags> {
        rule_library()
            .unwrap()
            .iter()
            .map(|r| (r.id.clone(), flags(true, false)))
            .collect()
    }

    // ---- rule library ------------------------------------------------------

    #[test]
    fn rule_library_parses_and_has_seven_unique_rules() {
        let library = rule_library().unwrap();
        assert_eq!(library.len(), 7);
        let mut ids = HashSet::new();
        for r in library {
            assert!(
                ids.insert(r.id.clone()),
                "duplicate library rule id {}",
                r.id
            );
            for p in &r.patterns {
                validate_value_pattern(p).unwrap();
            }
        }
    }

    #[test]
    fn rule_library_matches_pii_engine_default_policy_rule_set() {
        // Same rules.yaml, same SSOT: the resolver's empty-effective-set default
        // must name exactly the rules the engine's own default_policy_json() does.
        let library = rule_library().unwrap();
        let engine_default: serde_json::Value =
            serde_json::from_str(&speedwave_pii_engine::default_policy_json()).unwrap();
        let engine_ids: HashSet<String> = engine_default["rules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_string())
            .collect();
        let resolver_ids: HashSet<String> = library.iter().map(|r| r.id.clone()).collect();
        assert_eq!(resolver_ids, engine_ids);
    }

    // ---- builtin templates -----------------------------------------------

    #[test]
    fn builtin_templates_parse_and_have_unique_non_custom_ids() {
        let templates = builtin_templates().unwrap();
        assert_eq!(templates.len(), 3);
        let mut ids = HashSet::new();
        for t in templates {
            assert_ne!(t.id, "custom");
            assert!(ids.insert(t.id.clone()), "duplicate template id {}", t.id);
            for r in &t.rules {
                for p in &r.patterns {
                    validate_value_pattern(p).unwrap();
                }
            }
        }
    }

    #[test]
    fn strict_template_matches_compiled_default() {
        let templates = builtin_templates().unwrap();
        let strict = templates.iter().find(|t| t.id == "strict").unwrap();
        assert_eq!(strict.categories, all_on_categories());
        let default = ResolvedPiiPolicy::default();
        assert_eq!(resolve_pii_policy(None, None).unwrap(), default);
        let strict_resolved = resolve_pii_policy(
            Some(&PiiPolicyUserConfig {
                policies: vec!["strict".to_string()],
                ..Default::default()
            }),
            None,
        )
        .unwrap();
        assert_eq!(strict_resolved.rules, default.rules);
    }

    #[test]
    fn gdpr_and_ai_act_templates_have_expected_category_overrides() {
        let templates = builtin_templates().unwrap();
        let gdpr = templates.iter().find(|t| t.id == "gdpr-art32").unwrap();
        assert!(!gdpr.categories["API_KEY"].tokenize);
        assert!(gdpr.categories["NIP"].tokenize);

        let ai_act = templates.iter().find(|t| t.id == "eu-ai-act-art5").unwrap();
        assert!(!ai_act.categories["NIP"].tokenize);
        assert!(!ai_act.categories["API_KEY"].tokenize);
        assert!(ai_act.categories["EMAIL"].tokenize);
    }

    #[test]
    fn policy_template_rejects_unknown_top_level_field() {
        let yaml = r#"
version: 3
id: strict
name: "x"
description: "x"
categories: { EMAIL: {tokenize: true, log: false} }
rules: []
keywords: []
inherit: something
"#;
        let result: Result<PolicyTemplate, _> = serde_yaml_ng::from_str(yaml);
        assert!(result.is_err());
    }

    #[test]
    fn policy_template_rejects_unknown_category_flag_pair_key() {
        let yaml = r#"
version: 3
id: strict
name: "x"
description: "x"
categories: { EMAIL: {tokenize: true, log: false, bogus: true} }
rules: []
keywords: []
"#;
        let result: Result<PolicyTemplate, _> = serde_yaml_ng::from_str(yaml);
        assert!(result.is_err());
    }

    #[test]
    fn policy_template_rejects_unsupported_version() {
        let yaml = r#"
version: 2
id: strict
name: "x"
description: "x"
categories: { EMAIL: {tokenize: true, log: false} }
rules: []
keywords: []
"#;
        let template: PolicyTemplate = serde_yaml_ng::from_str(yaml).unwrap();
        let library_ids: HashSet<&str> = rule_library()
            .unwrap()
            .iter()
            .map(|r| r.id.as_str())
            .collect();
        assert!(validate_template(&template, &library_ids).is_err());
    }

    #[test]
    fn policy_template_rejects_categories_referencing_unknown_rule_id() {
        let yaml = r#"
version: 3
id: strict
name: "x"
description: "x"
categories: { BOGUS_RULE: {tokenize: true, log: false} }
rules: []
keywords: []
"#;
        let template: PolicyTemplate = serde_yaml_ng::from_str(yaml).unwrap();
        let library_ids: HashSet<&str> = rule_library()
            .unwrap()
            .iter()
            .map(|r| r.id.as_str())
            .collect();
        let err = validate_template(&template, &library_ids).unwrap_err();
        assert!(err.contains("BOGUS_RULE"));
    }

    // ---- resolve_pii_policy semantics ------------------------------------

    #[test]
    fn resolve_with_no_user_and_no_managed_is_safe_default() {
        let resolved = resolve_pii_policy(None, None).unwrap();
        assert_eq!(resolved.rules.len(), 7);
        assert!(resolved.rules.iter().all(|r| r.tokenize && !r.log));
        assert_eq!(
            resolved.source,
            ResolvedPiiPolicySource {
                policies: Vec::new(),
                forced: Vec::new(),
            }
        );
        assert!(resolved.keywords.is_empty());
    }

    #[test]
    fn disabled_policy_compiles_to_engine_noop() {
        let policy = disabled_policy();
        assert!(policy.rules.is_empty());
        assert!(policy.keywords.is_empty());
        let compiled =
            speedwave_pii_engine::compile_policy_v3(&serde_json::to_string(&policy).unwrap())
                .expect("the beta-off policy must be a valid v3 document");
        assert!(compiled.rules().is_empty(), "no rules");
        assert!(compiled.keywords().is_empty(), "no keywords");
    }

    #[test]
    fn pii_feature_enabled_gates_on_beta_or_mdm_forced() {
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
        assert!(!resolved.rules.iter().any(|r| r.id == "API_KEY"));
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
                all_on_categories(),
                Vec::new(),
                Vec::new(),
            )],
        };
        assert!(resolve_pii_policy(Some(&user), None).is_err());
    }

    #[test]
    fn resolve_duplicate_custom_policy_ids_errs() {
        let def = custom_policy("acme", HashMap::new(), Vec::new(), Vec::new());
        let user = PiiPolicyUserConfig {
            policies: vec!["acme".to_string()],
            custom_policies: vec![def.clone(), def],
        };
        assert!(resolve_pii_policy(Some(&user), None).is_err());
    }

    #[test]
    fn resolve_effective_set_is_user_policies_then_unseen_forced_ids() {
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
    fn resolve_categories_are_ored_per_rule_across_the_effective_set() {
        let user = PiiPolicyUserConfig {
            policies: vec!["gdpr-art32".to_string(), "eu-ai-act-art5".to_string()],
            ..Default::default()
        };
        let resolved = resolve_pii_policy(Some(&user), None).unwrap();
        assert!(
            resolved.rules.iter().any(|r| r.id == "NIP"),
            "on in gdpr-art32"
        );
        assert!(
            !resolved.rules.iter().any(|r| r.id == "API_KEY"),
            "off in both — OR must not invent a true"
        );
        assert!(resolved.rules.iter().any(|r| r.id == "EMAIL"), "on in both");
    }

    #[test]
    fn resolve_own_rules_with_same_id_and_definition_merge_flags_with_or() {
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string(), "b".to_string()],
            custom_policies: vec![
                custom_policy(
                    "a",
                    HashMap::new(),
                    vec![own_rule("EMPLOYEE_ID", r"\d{3}", true, false)],
                    Vec::new(),
                ),
                custom_policy(
                    "b",
                    HashMap::new(),
                    vec![own_rule("EMPLOYEE_ID", r"\d{3}", false, true)],
                    Vec::new(),
                ),
            ],
        };
        let resolved = resolve_pii_policy(Some(&user), None).unwrap();
        let rule = resolved
            .rules
            .iter()
            .find(|r| r.id == "EMPLOYEE_ID")
            .unwrap();
        assert!(rule.tokenize);
        assert!(rule.log);
    }

    #[test]
    fn resolve_own_rules_with_same_id_but_different_pattern_errs() {
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string(), "b".to_string()],
            custom_policies: vec![
                custom_policy(
                    "a",
                    HashMap::new(),
                    vec![own_rule("EMPLOYEE_ID", r"\d{3}", true, false)],
                    Vec::new(),
                ),
                custom_policy(
                    "b",
                    HashMap::new(),
                    vec![own_rule("EMPLOYEE_ID", r"\d{4}", true, false)],
                    Vec::new(),
                ),
            ],
        };
        let err = resolve_pii_policy(Some(&user), None).unwrap_err();
        assert!(err.contains("EMPLOYEE_ID"));
    }

    #[test]
    fn resolve_own_rule_colliding_with_library_id_errs() {
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string()],
            custom_policies: vec![custom_policy(
                "a",
                HashMap::new(),
                vec![own_rule("EMAIL", r"x{3}", true, false)],
                Vec::new(),
            )],
        };
        let err = resolve_pii_policy(Some(&user), None).unwrap_err();
        assert!(err.contains("EMAIL"));
    }

    #[test]
    fn resolve_errs_on_an_unusable_stored_own_rule_pattern() {
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string()],
            custom_policies: vec![custom_policy(
                "a",
                HashMap::new(),
                vec![own_rule("BAD_ID", "(a+)+", true, false)],
                Vec::new(),
            )],
        };
        assert!(resolve_pii_policy(Some(&user), None).is_err());
    }

    #[test]
    fn resolve_categories_referencing_unknown_rule_id_errs() {
        let mut categories = HashMap::new();
        categories.insert("NOT_A_RULE".to_string(), flags(true, false));
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string()],
            custom_policies: vec![custom_policy("a", categories, Vec::new(), Vec::new())],
        };
        let err = resolve_pii_policy(Some(&user), None).unwrap_err();
        assert!(err.contains("NOT_A_RULE"));
    }

    // ---- keywords -----------------------------------------------------------

    #[test]
    fn resolve_merges_keywords_from_multiple_policies() {
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string(), "b".to_string()],
            custom_policies: vec![
                custom_policy(
                    "a",
                    HashMap::new(),
                    Vec::new(),
                    vec![keyword("Coca-Cola", "Brandex", true)],
                ),
                custom_policy(
                    "b",
                    HashMap::new(),
                    Vec::new(),
                    vec![keyword("Calgon", "Solvex", false)],
                ),
            ],
        };
        let resolved = resolve_pii_policy(Some(&user), None).unwrap();
        assert_eq!(resolved.keywords.len(), 2);
        assert!(resolved
            .keywords
            .iter()
            .any(|k| k.r#match == "Coca-Cola" && k.alias == "Brandex"));
        assert!(resolved
            .keywords
            .iter()
            .any(|k| k.r#match == "Calgon" && k.alias == "Solvex" && !k.case_sensitive));
    }

    #[test]
    fn resolve_deduplicates_identical_keywords_across_policies() {
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string(), "b".to_string()],
            custom_policies: vec![
                custom_policy(
                    "a",
                    HashMap::new(),
                    Vec::new(),
                    vec![keyword("Coca-Cola", "Brandex", true)],
                ),
                custom_policy(
                    "b",
                    HashMap::new(),
                    Vec::new(),
                    vec![keyword("Coca-Cola", "Brandex", true)],
                ),
            ],
        };
        let resolved = resolve_pii_policy(Some(&user), None).unwrap();
        assert_eq!(resolved.keywords.len(), 1);
    }

    #[test]
    fn resolve_same_match_different_alias_across_policies_errs() {
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string(), "b".to_string()],
            custom_policies: vec![
                custom_policy(
                    "a",
                    HashMap::new(),
                    Vec::new(),
                    vec![keyword("Coca-Cola", "Brandex", true)],
                ),
                custom_policy(
                    "b",
                    HashMap::new(),
                    Vec::new(),
                    vec![keyword("Coca-Cola", "Fizzex", true)],
                ),
            ],
        };
        let err = resolve_pii_policy(Some(&user), None).unwrap_err();
        assert!(err.contains("Coca-Cola"));
    }

    #[test]
    fn resolve_duplicate_alias_across_policies_errs() {
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string(), "b".to_string()],
            custom_policies: vec![
                custom_policy(
                    "a",
                    HashMap::new(),
                    Vec::new(),
                    vec![keyword("Coca-Cola", "Brandex", true)],
                ),
                custom_policy(
                    "b",
                    HashMap::new(),
                    Vec::new(),
                    vec![keyword("Calgon", "Brandex", true)],
                ),
            ],
        };
        let err = resolve_pii_policy(Some(&user), None).unwrap_err();
        assert!(err.contains("Brandex"));
    }

    #[test]
    fn resolve_alias_colliding_with_another_keywords_match_errs() {
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string(), "b".to_string()],
            custom_policies: vec![
                custom_policy(
                    "a",
                    HashMap::new(),
                    Vec::new(),
                    vec![keyword("Coca-Cola", "Brandex", true)],
                ),
                custom_policy(
                    "b",
                    HashMap::new(),
                    Vec::new(),
                    vec![keyword("Brandex", "Otherex", true)],
                ),
            ],
        };
        let err = resolve_pii_policy(Some(&user), None).unwrap_err();
        assert!(err.contains("Brandex"));
    }

    #[test]
    fn resolve_validates_keyword_match_min_length() {
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string()],
            custom_policies: vec![custom_policy(
                "a",
                HashMap::new(),
                Vec::new(),
                vec![keyword("ab", "xyzalias", true)],
            )],
        };
        let err = resolve_pii_policy(Some(&user), None).unwrap_err();
        assert!(err.contains("match"));
    }

    #[test]
    fn resolve_validates_keyword_alias_format() {
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string()],
            custom_policies: vec![custom_policy(
                "a",
                HashMap::new(),
                Vec::new(),
                vec![keyword("secretco", "123bad", true)],
            )],
        };
        let err = resolve_pii_policy(Some(&user), None).unwrap_err();
        assert!(err.contains("alias"));
    }

    #[test]
    fn resolve_validates_keyword_match_and_alias_differ() {
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string()],
            custom_policies: vec![custom_policy(
                "a",
                HashMap::new(),
                Vec::new(),
                vec![keyword("secret", "secret", true)],
            )],
        };
        let err = resolve_pii_policy(Some(&user), None).unwrap_err();
        assert!(err.contains("differ"));
    }

    #[test]
    fn resolve_enforces_keyword_count_limit() {
        let keywords: Vec<KeywordV3> = (0..crate::consts::PII_MAX_KEYWORDS + 1)
            .map(|i| keyword(&format!("needle-{i}"), &format!("alias{i}"), true))
            .collect();
        let user = PiiPolicyUserConfig {
            policies: vec!["a".to_string()],
            custom_policies: vec![custom_policy("a", HashMap::new(), Vec::new(), keywords)],
        };
        let err = resolve_pii_policy(Some(&user), None).unwrap_err();
        assert!(err.contains("too many keywords"));
    }

    #[test]
    fn policy_json_v3_includes_keywords_and_compiles_in_the_engine() {
        let user = PiiPolicyUserConfig {
            policies: vec!["strict".to_string(), "custom".to_string()],
            custom_policies: vec![custom_policy(
                "custom",
                HashMap::new(),
                Vec::new(),
                vec![keyword("Coca-Cola", "Brandex", true)],
            )],
        };
        let resolved = resolve_pii_policy(Some(&user), None).unwrap();
        let json = serde_json::to_value(&resolved).unwrap();
        assert_eq!(json["version"], 3);
        assert!(json["rules"].is_array());
        assert!(json["keywords"].is_array());
        for kw in json["keywords"].as_array().unwrap() {
            assert!(kw.get("match").is_some());
            assert!(kw.get("alias").is_some());
            assert!(kw.get("caseSensitive").is_some());
        }

        let compiled =
            speedwave_pii_engine::compile_policy_v3(&serde_json::to_string(&resolved).unwrap())
                .expect("resolver output must be a valid v3 document for the engine");
        assert_eq!(compiled.keywords().len(), 1);
        assert_eq!(compiled.keywords()[0].match_text, "Coca-Cola");
        assert_eq!(compiled.keywords()[0].alias, "Brandex");
    }

    // ---- serde round-trips -------------------------------------------------

    #[test]
    fn resolved_pii_policy_json_round_trips_and_uses_camel_case() {
        let user = PiiPolicyUserConfig {
            policies: vec!["gdpr-art32".to_string(), "custom".to_string()],
            custom_policies: vec![custom_policy(
                "custom",
                HashMap::new(),
                vec![own_rule("EMPLOYEE_ID", r"\bEMP-\d{4,8}\b", true, false)],
                vec![keyword("Coca-Cola", "Brandex", true)],
            )],
        };
        let resolved = resolve_pii_policy(Some(&user), None).unwrap();

        let value = serde_json::to_value(&resolved).unwrap();
        assert_eq!(value["version"], 3);
        assert!(value.get("rules").is_some());
        assert!(value.get("keywords").is_some());
        assert!(value.get("categories").is_none());
        assert!(value.get("customPatterns").is_none());
        assert!(value.get("sensitiveKeys").is_none());
        let employee_id = value["rules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == "EMPLOYEE_ID")
            .unwrap();
        assert_eq!(employee_id["displayName"], "EMPLOYEE_ID");
        assert_eq!(employee_id["tokenize"], true);
        assert_eq!(employee_id["log"], false);
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
        let huge = "a".repeat(crate::consts::PII_MAX_PATTERN_LENGTH + 1);
        let err = validate_value_pattern(&huge).unwrap_err();
        assert!(err.contains(&crate::consts::PII_MAX_PATTERN_LENGTH.to_string()));
    }

    #[test]
    fn validate_value_pattern_rejects_empty_string_match() {
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
        assert!(validate_value_pattern("a{129}").is_ok());
        assert!(validate_value_pattern("[a-z]{1,255}").is_ok());
        assert!(validate_value_pattern(r"\d{200}").is_ok());
    }

    #[test]
    fn validate_value_pattern_ignores_braces_in_char_class_or_escaped() {
        assert!(validate_value_pattern(r"[a{300}]bbb").is_ok());
        assert!(validate_value_pattern(r"a\{300,999\}bbb").is_ok());
    }

    #[test]
    fn builtin_templates_have_no_pattern_exceeding_the_quantifier_cap() {
        for template in builtin_templates().unwrap() {
            for r in &template.rules {
                for p in &r.patterns {
                    assert!(validate_value_pattern(p).is_ok());
                }
            }
        }
    }

    // ---- validate_user_policy_config ---------------------------------------

    #[test]
    fn validate_user_policy_config_rejects_too_many_rules() {
        let rules: Vec<OwnRuleV3> = (0..crate::consts::PII_MAX_RULES + 1)
            .map(|i| own_rule(&format!("RULE_{i}"), r"\d{3}", true, false))
            .collect();
        let cfg = PiiPolicyUserConfig {
            policies: vec!["custom".to_string()],
            custom_policies: vec![custom_policy("custom", HashMap::new(), rules, Vec::new())],
        };
        assert!(validate_user_policy_config(&cfg).is_err());
    }

    #[test]
    fn validate_user_policy_config_rejects_duplicate_rule_ids() {
        let cfg = PiiPolicyUserConfig {
            policies: vec!["custom".to_string()],
            custom_policies: vec![custom_policy(
                "custom",
                HashMap::new(),
                vec![
                    own_rule("DUP", r"\d{3}", true, false),
                    own_rule("DUP", r"\d{4}", true, false),
                ],
                Vec::new(),
            )],
        };
        assert!(validate_user_policy_config(&cfg).is_err());
    }

    #[test]
    fn validate_user_policy_config_rejects_over_length_display_name() {
        let mut rule = own_rule("EMPLOYEE_ID", r"\d{3}", true, false);
        rule.display_name = "a".repeat(PII_RULE_NAME_MAX_LEN + 1);
        let cfg = PiiPolicyUserConfig {
            policies: vec!["custom".to_string()],
            custom_policies: vec![custom_policy(
                "custom",
                HashMap::new(),
                vec![rule],
                Vec::new(),
            )],
        };
        let err = validate_user_policy_config(&cfg).unwrap_err();
        assert!(err.contains("display name exceeds"));
    }

    #[test]
    fn validate_user_policy_config_accepts_max_length_display_name() {
        let mut rule = own_rule("EMPLOYEE_ID", r"\d{3}", true, false);
        rule.display_name = "a".repeat(PII_RULE_NAME_MAX_LEN);
        let cfg = PiiPolicyUserConfig {
            policies: vec!["custom".to_string()],
            custom_policies: vec![custom_policy(
                "custom",
                HashMap::new(),
                vec![rule],
                Vec::new(),
            )],
        };
        assert!(validate_user_policy_config(&cfg).is_ok());
    }

    #[test]
    fn validate_user_policy_config_rejects_too_many_keywords() {
        let keywords: Vec<KeywordV3> = (0..crate::consts::PII_MAX_KEYWORDS + 1)
            .map(|i| keyword(&format!("needle-{i}"), &format!("alias{i}"), true))
            .collect();
        let cfg = PiiPolicyUserConfig {
            policies: vec!["custom".to_string()],
            custom_policies: vec![custom_policy(
                "custom",
                HashMap::new(),
                Vec::new(),
                keywords,
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
                HashMap::new(),
                vec![own_rule("EMPLOYEE_ID", r"\bEMP-\d{4,8}\b", true, false)],
                vec![keyword("Coca-Cola", "Brandex", true)],
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
                HashMap::new(),
                Vec::new(),
                Vec::new(),
            )],
        };
        assert!(validate_user_policy_config(&cfg).is_err());
    }

    #[test]
    fn validate_user_policy_config_rejects_duplicate_custom_policy_ids() {
        let def = custom_policy("acme", HashMap::new(), Vec::new(), Vec::new());
        let cfg = PiiPolicyUserConfig {
            policies: vec!["acme".to_string()],
            custom_policies: vec![def.clone(), def],
        };
        assert!(validate_user_policy_config(&cfg).is_err());
    }

    #[test]
    fn validate_user_policy_config_rejects_categories_referencing_unknown_rule_id() {
        let mut categories = HashMap::new();
        categories.insert("NOT_A_RULE".to_string(), flags(true, false));
        let cfg = PiiPolicyUserConfig {
            policies: vec!["custom".to_string()],
            custom_policies: vec![custom_policy("custom", categories, Vec::new(), Vec::new())],
        };
        let err = validate_user_policy_config(&cfg).unwrap_err();
        assert!(err.contains("NOT_A_RULE"));
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

    /// Snapshot: written JSON matches the pinned v3 contract shape.
    #[test]
    fn write_policy_config_matches_pinned_contract_shape() {
        let tmp = tempfile::tempdir().unwrap();
        let mut api_key_off = HashMap::new();
        for rule in rule_library().unwrap() {
            api_key_off.insert(rule.id.clone(), flags(rule.id != "API_KEY", false));
        }
        let mut rule = own_rule("EMPLOYEE_ID", r"\bEMP-\d{4,8}\b", true, false);
        rule.display_name = "Employee ID".to_string();
        let user = PiiPolicyUserConfig {
            policies: vec!["gdpr-art32".to_string(), "custom".to_string()],
            custom_policies: vec![custom_policy(
                "custom",
                api_key_off,
                vec![rule],
                vec![keyword("Coca-Cola", "Brandex", true)],
            )],
        };
        let policy = resolve_pii_policy(Some(&user), None).unwrap();
        write_policy_config_in(tmp.path(), "proj", &policy).unwrap();

        let path = policy_config_path_in(tmp.path(), "proj");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["version"], 3);
        assert_eq!(
            v["source"]["policies"],
            serde_json::json!(["gdpr-art32", "custom"])
        );
        assert_eq!(v["source"]["forced"], serde_json::json!([]));
        assert!(!v["rules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == "API_KEY"));
        let employee_id = v["rules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == "EMPLOYEE_ID")
            .unwrap();
        assert_eq!(employee_id["displayName"], "Employee ID");
        assert_eq!(employee_id["tokenize"], true);
        assert_eq!(v["keywords"][0]["match"], "Coca-Cola");
        assert_eq!(v["keywords"][0]["alias"], "Brandex");
        assert!(v.get("categories").is_none());
        assert!(v.get("customPatterns").is_none());
        assert!(v.get("sensitiveKeys").is_none());
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
        other.rules.retain(|r| r.id != "EMAIL");
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
