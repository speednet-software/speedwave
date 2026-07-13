//! Built-in PII value patterns and sensitive key-name detection
//! (TS counterpart: `mcp-servers/policies/src/patterns.ts`).

use crate::validators::{validate_iban, validate_luhn, validate_nip, validate_pesel};
use regex::Regex;
use std::sync::LazyLock;

/// A built-in detection rule: category id, value regex, optional checksum validator.
pub struct BuiltinRule {
    /// Category id: one of the value-pattern entries of [`BUILTIN_CATEGORIES`].
    pub category: &'static str,
    /// Compiled value-match regex for this category.
    pub regex: &'static Regex,
    /// Checksum validator run on a regex match before it counts as a hit.
    pub validator: Option<fn(&str) -> bool>,
}

/// Category id for key-name based detection (no value regex).
pub const SENSITIVE_FIELD: &str = "SENSITIVE_FIELD";

/// All eight built-in category ids, wire order as in the TS enum `PIIType`.
pub const BUILTIN_CATEGORIES: [&str; 8] = [
    "EMAIL",
    "PHONE_PL",
    "PESEL",
    "NIP",
    "IBAN",
    "CARD",
    "API_KEY",
    SENSITIVE_FIELD,
];

/// A built-in regex failed to compile; unreachable in practice since the
/// pattern set is fixed, kept fail-closed rather than panicking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatternError {
    /// A built-in value pattern did not compile.
    Compile,
}

impl std::fmt::Display for PatternError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Compile => write!(f, "a built-in PII pattern failed to compile"),
        }
    }
}

impl std::error::Error for PatternError {}

static EMAIL_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,10}"));
static PHONE_PL_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"\+?48[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{3}"));
static PESEL_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)\d{11}(?-u:\b)"));
static NIP_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)\d{10}(?-u:\b)"));
static IBAN_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}([A-Z0-9]?){0,16}"));
static CARD_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)(?:\d{4}[\s-]?){3}\d{4}(?-u:\b)"));
static API_KEY_RE: LazyLock<Result<Regex, regex::Error>> = LazyLock::new(|| {
    Regex::new(
        r"(?-u:\b)(sk-[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9_-]{35}|xoxb-[a-zA-Z0-9-]+|xoxp-[a-zA-Z0-9-]+)(?-u:\b)",
    )
});

/// camelCase → snake_case boundary insertion, mirroring the TS
/// `/([a-z0-9])([A-Z])/g` step of `isSensitiveKey`.
static CAMEL_BOUNDARY_RE: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])"));

/// Fetches a lazily-compiled built-in regex, mapping a compile failure to
/// [`PatternError`] instead of a panic (no-panic rule outside tests).
fn regex_ref(
    re: &'static LazyLock<Result<Regex, regex::Error>>,
) -> Result<&'static Regex, PatternError> {
    re.as_ref().map_err(|_| PatternError::Compile)
}

static BUILTIN_RULES: LazyLock<Result<Vec<BuiltinRule>, PatternError>> = LazyLock::new(|| {
    Ok(vec![
        BuiltinRule {
            category: "EMAIL",
            regex: regex_ref(&EMAIL_RE)?,
            validator: None,
        },
        BuiltinRule {
            category: "PHONE_PL",
            regex: regex_ref(&PHONE_PL_RE)?,
            validator: None,
        },
        BuiltinRule {
            category: "PESEL",
            regex: regex_ref(&PESEL_RE)?,
            validator: Some(validate_pesel),
        },
        BuiltinRule {
            category: "NIP",
            regex: regex_ref(&NIP_RE)?,
            validator: Some(validate_nip),
        },
        BuiltinRule {
            category: "IBAN",
            regex: regex_ref(&IBAN_RE)?,
            validator: Some(validate_iban),
        },
        BuiltinRule {
            category: "CARD",
            regex: regex_ref(&CARD_RE)?,
            validator: Some(validate_luhn),
        },
        BuiltinRule {
            category: "API_KEY",
            regex: regex_ref(&API_KEY_RE)?,
            validator: None,
        },
    ])
});

/// Compiled built-in rules; `Err` only if a built-in pattern fails to
/// compile (defensive, fail-closed).
pub fn builtin_rules() -> Result<&'static [BuiltinRule], PatternError> {
    match BUILTIN_RULES.as_ref() {
        Ok(rules) => Ok(rules.as_slice()),
        Err(e) => Err(*e),
    }
}

/// Default sensitive key-name substrings, lowercased, exactly the TS
/// `SENSITIVE_KEYS` list.
pub fn default_sensitive_keys() -> &'static [&'static str] {
    &[
        "password",
        "passphrase",
        "token",
        "secret",
        "credential",
        "auth",
        "bearer",
        "api_key",
        "apikey",
        "private_key",
        "signing_key",
        "encryption_key",
        "access_token",
        "refresh_token",
        "client_secret",
        "session",
        "cookie",
        "jwt",
        "pin",
        "otp",
        "2fa",
        "mfa",
    ]
}

/// Removes `author`/`authors` at word boundaries (TS-ported: no regex lookahead in Rust).
/// Keeps the preceding non-`[a-z]` boundary char.
fn strip_author_segments(s: &str) -> String {
    const WORD: [char; 6] = ['a', 'u', 't', 'h', 'o', 'r'];
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len();
    let mut result = String::with_capacity(s.len());
    let mut i = 0;
    while i < n {
        let prev_is_lower_ascii = i > 0 && chars[i - 1].is_ascii_lowercase();
        let matches_word = i + WORD.len() <= n && chars[i..i + WORD.len()] == WORD;
        if !prev_is_lower_ascii && matches_word {
            let after_word = i + WORD.len();
            let has_s = after_word < n && chars[after_word] == 's';
            let s_end = if has_s { after_word + 1 } else { after_word };
            let boundary_ok = s_end >= n || !chars[s_end].is_ascii_lowercase();
            if boundary_ok {
                i = s_end;
                continue;
            }
        }
        result.push(chars[i]);
        i += 1;
    }
    result
}

/// Case-insensitive substring match (excludes `author`/`authors` variants).
/// Matches TS `isSensitiveKey` behavior: camelCase→snake_case, lowercase, strip author.
pub fn is_sensitive_key(key: &str, keys: &[impl AsRef<str>]) -> bool {
    let snake = match CAMEL_BOUNDARY_RE.as_ref() {
        Ok(re) => re.replace_all(key, "${1}_${2}").to_lowercase(),
        Err(_) => key.to_lowercase(),
    };
    let stripped = strip_author_segments(&snake);
    keys.iter().any(|k| stripped.contains(k.as_ref()))
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test code: panics on setup failure are acceptable"
)]
mod tests {
    use super::*;

    fn rule(category: &str) -> &'static BuiltinRule {
        builtin_rules()
            .expect("built-in patterns must compile")
            .iter()
            .find(|r| r.category == category)
            .expect("category must exist")
    }

    /// A hit requires the regex to match, and any validator to accept the matched text.
    fn detects(category: &str, value: &str) -> bool {
        let rule = rule(category);
        rule.regex
            .find_iter(value)
            .any(|m| rule.validator.is_none_or(|v| v(m.as_str())))
    }

    #[test]
    fn builtin_rules_ok_with_exactly_seven_entries_in_category_order() {
        let rules = builtin_rules().expect("compiles");
        assert_eq!(rules.len(), 7);
        let categories: Vec<&str> = rules.iter().map(|r| r.category).collect();
        assert_eq!(categories, &BUILTIN_CATEGORIES[..7]);
        assert_eq!(BUILTIN_CATEGORIES[7], SENSITIVE_FIELD);
        assert!(!categories.contains(&SENSITIVE_FIELD));
    }

    #[test]
    fn email_detects_positive_and_negative() {
        assert!(detects("EMAIL", "test@example.com"));
        assert!(detects("EMAIL", "nested@example.com"));
        assert!(!detects("EMAIL", "plaintext"));
        assert!(!detects("EMAIL", "user@"));
    }

    #[test]
    fn phone_pl_detects_positive_and_negative() {
        assert!(detects("PHONE_PL", "+48 123 456 789"));
        assert!(detects("PHONE_PL", "48123456789"));
        assert!(!detects("PHONE_PL", "123-456-789"));
        assert!(!detects("PHONE_PL", "+1 202 555 0101"));
    }

    #[test]
    fn pesel_detects_positive_and_negative() {
        assert!(detects("PESEL", "44051401359"));
        assert!(!detects("PESEL", "12345678901"));
        assert!(!detects("PESEL", "1234567890"));
    }

    #[test]
    fn nip_detects_positive_and_negative() {
        assert!(detects("NIP", "5261040828"));
        assert!(!detects("NIP", "1234567890"));
        assert!(!detects("NIP", "123456789"));
    }

    #[test]
    fn iban_detects_positive_and_negative() {
        assert!(detects("IBAN", "PL61109010140000071219812874"));
        assert!(!detects("IBAN", "PL99109010140000071219812874"));
        assert!(!detects("IBAN", "PL6110901"));
    }

    #[test]
    fn card_detects_positive_and_negative() {
        assert!(detects("CARD", "4532015112830366"));
        assert!(detects("CARD", "4532-0151-1283-0366"));
        assert!(!detects("CARD", "4532015112830367"));
        assert!(!detects("CARD", "123456789012"));
    }

    #[test]
    fn api_key_detects_positive_and_negative() {
        assert!(detects("API_KEY", "sk-1234567890abcdefghij"));
        assert!(detects("API_KEY", "xoxb-1234567890abcdef"));
        assert!(!detects("API_KEY", "sk-short"));
        assert!(!detects("API_KEY", "randomstring"));
    }

    #[test]
    fn default_sensitive_keys_matches_ts_list_exactly() {
        assert_eq!(
            default_sensitive_keys(),
            &[
                "password",
                "passphrase",
                "token",
                "secret",
                "credential",
                "auth",
                "bearer",
                "api_key",
                "apikey",
                "private_key",
                "signing_key",
                "encryption_key",
                "access_token",
                "refresh_token",
                "client_secret",
                "session",
                "cookie",
                "jwt",
                "pin",
                "otp",
                "2fa",
                "mfa",
            ]
        );
    }

    #[test]
    fn is_sensitive_key_matches_case_insensitive_substring() {
        let keys = default_sensitive_keys();
        assert!(is_sensitive_key("myPassword", keys));
        assert!(is_sensitive_key("PASSWORD", keys));
        assert!(is_sensitive_key("Token", keys));
        assert!(is_sensitive_key("API_KEY", keys));
        assert!(!is_sensitive_key("username", keys));
        assert!(!is_sensitive_key("status", keys));
    }

    #[test]
    fn is_sensitive_key_excludes_author_prose_fields() {
        let keys = default_sensitive_keys();
        assert!(!is_sensitive_key("author", keys));
        assert!(!is_sensitive_key("authors", keys));
        assert!(!is_sensitive_key("author_name", keys));
        assert!(!is_sensitive_key("message_author", keys));
        assert!(!is_sensitive_key("coAuthor", keys));
    }

    #[test]
    fn is_sensitive_key_still_matches_real_auth_keys() {
        let keys = default_sensitive_keys();
        assert!(is_sensitive_key("authorization", keys));
        assert!(is_sensitive_key("oauth", keys));
        assert!(is_sensitive_key("author_token", keys));
    }

    #[test]
    fn pesel_matches_with_non_ascii_boundary() {
        assert!(detects("PESEL", "44051401359ą"));
    }

    #[test]
    fn nip_matches_with_non_ascii_boundary() {
        assert!(detects("NIP", "5261040828ę"));
    }

    #[test]
    fn card_matches_with_non_ascii_boundary() {
        assert!(detects("CARD", "卡号4532015112830366です"));
    }

    #[test]
    fn api_key_matches_with_non_ascii_boundary() {
        assert!(detects(
            "API_KEY",
            "klucz to xoxb-1234567890abcdef日本語です"
        ));
    }
}
