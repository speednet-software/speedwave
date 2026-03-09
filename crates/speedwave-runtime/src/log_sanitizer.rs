use std::sync::LazyLock;

use regex::Regex;

struct SanitizeRule {
    pattern: Regex,
    replacement: &'static str,
}

static RULES: LazyLock<Vec<SanitizeRule>> = LazyLock::new(|| {
    // Each tuple: (pattern, replacement). If a regex fails to compile (should never
    // happen with static literals), a CRITICAL warning is printed to stderr.
    let definitions: Vec<(&str, &'static str)> = vec![
        // PEM private keys (multi-line: mask entire block)
        (
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
            "-----BEGIN PRIVATE KEY-----\n***REDACTED***\n-----END PRIVATE KEY-----",
        ),
        // Bearer tokens: Bearer <token>
        (r"(?i)(Bearer\s+)\S+", "${1}***REDACTED***"),
        // Authorization header values: Authorization: <scheme> <token>
        (r"(?i)(Authorization:\s*)\S+(\s+\S+)?", "${1}***REDACTED***"),
        // JWT tokens: eyJ<base64>.eyJ<base64>.<signature>
        (
            r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
            "***REDACTED_JWT***",
        ),
        // Slack tokens: xoxb-, xoxp-, xoxa-, xoxr-, xoxs-
        (r"xox[bpars]-[A-Za-z0-9-]+", "***REDACTED_SLACK_TOKEN***"),
        // GitHub tokens: ghp_, ghs_, gho_, ghu_, github_pat_ prefixed (36+ chars after prefix)
        (r"ghp_[A-Za-z0-9]{36,}", "***REDACTED_GITHUB_TOKEN***"),
        (r"ghs_[A-Za-z0-9]{36,}", "***REDACTED_GITHUB_TOKEN***"),
        (r"gho_[A-Za-z0-9]{36,}", "***REDACTED_GITHUB_TOKEN***"),
        (r"ghu_[A-Za-z0-9]{36,}", "***REDACTED_GITHUB_TOKEN***"),
        (
            r"github_pat_[A-Za-z0-9]{36,}",
            "***REDACTED_GITHUB_TOKEN***",
        ),
        // GitLab tokens: glpat- prefixed (20+ alphanumeric/hyphen chars)
        (r"glpat-[A-Za-z0-9\-]{20,}", "***REDACTED_GITLAB_TOKEN***"),
        // Anthropic API keys: sk-ant- prefixed
        (r"sk-ant-[A-Za-z0-9_-]+", "***REDACTED_ANTHROPIC_KEY***"),
        // URL userinfo credentials: ://user:password@host — redact password
        (r"(://[^:/@\s]+:)[^@\s]+(@)", "${1}***REDACTED***${2}"),
        // API keys in URL query parameters: ?key=<value> or &key=<value>
        // Also matches token=, secret=, password= in query strings
        (
            r"(?i)([?&](?:api_key|apikey|key|token|secret|password|access_token)=)[^&\s]+",
            "${1}***REDACTED***",
        ),
        // Generic secret assignments: password=<value>, secret=<value>, api_key=<value>
        // Matches key=value, key="value", and key='value' patterns (not in URLs — no ? or & prefix).
        // The trailing `"?` catches a lone closing quote that follows an unquoted value
        // (e.g. password=abc" where the opening quote was on a previous token).
        (
            r#"(?i)((?:password|passwd|secret|api_key|apikey|api_secret|access_token|private_key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;&]+)"?"#,
            "${1}***REDACTED***",
        ),
    ];

    definitions
        .into_iter()
        .filter_map(|(pat, replacement)| {
            match Regex::new(pat) {
                Ok(pattern) => Some(SanitizeRule { pattern, replacement }),
                Err(e) => {
                    // Safety-critical one-time init warning. The logger may not be
                    // initialized when LazyLock evaluates, so eprintln! is the only
                    // reliable channel. A dropped rule means secrets leak unredacted.
                    #[allow(clippy::print_stderr)]
                    {
                        eprintln!(
                            "[log_sanitizer] CRITICAL: failed to compile sanitizer regex '{pat}': {e}"
                        );
                    }
                    None
                }
            }
        })
        .collect()
});

/// Masks known secret patterns in log message content.
///
/// This function applies regex-based redaction rules to replace sensitive
/// data (tokens, keys, passwords, PEM blocks) with `***REDACTED***` markers.
///
/// Used in two places:
/// 1. Real-time in the log pipeline (format callbacks in Desktop/CLI loggers)
/// 2. In diagnostic export (second pass over container/Lima logs)
pub fn sanitize(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    let mut result = input.to_string();
    for rule in RULES.iter() {
        result = rule
            .pattern
            .replace_all(&result, rule.replacement)
            .into_owned();
    }
    result
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    // ── Guard tests — ensure no rules are silently dropped ────────────────

    /// The definitions vec contains exactly this many rules. If a new rule is
    /// added to the vec but fails to compile, RULES.len() will be less than
    /// this constant and the test will fail, catching the silent drop.
    const EXPECTED_RULE_COUNT: usize = 15;

    #[test]
    fn test_rules_count() {
        assert_eq!(
            RULES.len(),
            EXPECTED_RULE_COUNT,
            "RULES.len() ({}) does not match EXPECTED_RULE_COUNT ({}). \
             A sanitizer regex may have failed to compile, or a rule was added/removed \
             without updating EXPECTED_RULE_COUNT.",
            RULES.len(),
            EXPECTED_RULE_COUNT,
        );
    }

    #[test]
    fn test_all_static_patterns_are_valid_regex() {
        // Re-declare the same patterns from the production definitions vec.
        // If any pattern is invalid, Regex::new will return Err and the test
        // fails explicitly instead of being silently filtered out.
        let patterns: &[&str] = &[
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
            r"(?i)(Bearer\s+)\S+",
            r"(?i)(Authorization:\s*)\S+(\s+\S+)?",
            r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
            r"xox[bpars]-[A-Za-z0-9-]+",
            r"ghp_[A-Za-z0-9]{36,}",
            r"ghs_[A-Za-z0-9]{36,}",
            r"gho_[A-Za-z0-9]{36,}",
            r"ghu_[A-Za-z0-9]{36,}",
            r"github_pat_[A-Za-z0-9]{36,}",
            r"glpat-[A-Za-z0-9\-]{20,}",
            r"sk-ant-[A-Za-z0-9_-]+",
            r"(://[^:/@\s]+:)[^@\s]+(@)",
            r"(?i)([?&](?:api_key|apikey|key|token|secret|password|access_token)=)[^&\s]+",
            r#"(?i)((?:password|passwd|secret|api_key|apikey|api_secret|access_token|private_key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;&]+)"?"#,
        ];

        assert_eq!(
            patterns.len(),
            EXPECTED_RULE_COUNT,
            "Pattern list in test ({}) does not match EXPECTED_RULE_COUNT ({})",
            patterns.len(),
            EXPECTED_RULE_COUNT,
        );

        for pat in patterns {
            assert!(
                Regex::new(pat).is_ok(),
                "Static sanitizer pattern failed to compile: '{pat}'"
            );
        }
    }

    #[test]
    fn test_access_token_as_standalone_assignment() {
        // Ensures the generic assignment regex covers `access_token` outside URL context.
        let input = "access_token=mytoken123";
        let output = sanitize(input);
        assert!(
            !output.contains("mytoken123"),
            "access_token value should be redacted: {output}"
        );
        assert!(
            output.contains("access_token=***REDACTED***"),
            "access_token assignment should show redacted marker: {output}"
        );
    }

    // ── Individual pattern tests ─────────────────────────────────────────

    #[test]
    fn test_bearer_token_redaction() {
        let input = "Authorization failed: Bearer sk-abc123xyz";
        let output = sanitize(input);
        assert!(
            output.contains("Bearer ***REDACTED***"),
            "Bearer token not redacted: {output}"
        );
        assert!(
            !output.contains("sk-abc123xyz"),
            "Token value should not appear: {output}"
        );
    }

    #[test]
    fn test_bearer_case_insensitive() {
        let input = "Token: bearer my-secret-token-123";
        let output = sanitize(input);
        assert!(
            !output.contains("my-secret-token-123"),
            "Token value should not appear: {output}"
        );
        assert!(
            output.contains("bearer ***REDACTED***"),
            "Output should contain 'bearer ***REDACTED***' preserving original case: {output}"
        );
    }

    #[test]
    fn test_authorization_header_redaction() {
        let input = "Header: Authorization: Basic dXNlcjpwYXNz";
        let output = sanitize(input);
        assert!(
            output.contains("Authorization: ***REDACTED***"),
            "Authorization header not redacted: {output}"
        );
        assert!(
            !output.contains("dXNlcjpwYXNz"),
            "Credentials should not appear: {output}"
        );
    }

    #[test]
    fn test_jwt_token_redaction() {
        let input = "Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED_JWT***"),
            "JWT not redacted: {output}"
        );
        assert!(
            !output.contains("eyJhbGciOiJIUzI1NiI"),
            "JWT header should not appear: {output}"
        );
    }

    #[test]
    fn test_slack_xoxb_token_redaction() {
        let input = "Using Slack token: xoxb-FAKE-TOKEN-VALUE";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED_SLACK_TOKEN***"),
            "Slack token not redacted: {output}"
        );
        assert!(
            !output.contains("xoxb-"),
            "Slack token prefix should not appear: {output}"
        );
    }

    #[test]
    fn test_slack_xoxp_token_redaction() {
        let input = "xoxp-token-goes-here";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED_SLACK_TOKEN***"),
            "Slack xoxp token not redacted: {output}"
        );
    }

    #[test]
    fn test_api_key_in_url_redaction() {
        let input = "GET https://api.example.com/data?key=secret123&format=json";
        let output = sanitize(input);
        assert!(
            !output.contains("secret123"),
            "API key in URL should not appear: {output}"
        );
        assert!(
            output.contains("format=json"),
            "Non-secret params should remain: {output}"
        );
    }

    #[test]
    fn test_api_key_param_redaction() {
        let input = "URL: https://api.example.com?api_key=abc123def456";
        let output = sanitize(input);
        assert!(
            !output.contains("abc123def456"),
            "API key param should not appear: {output}"
        );
    }

    #[test]
    fn test_access_token_in_url_redaction() {
        let input = "Callback: https://oauth.example.com/cb?access_token=ya29.a0AfB_byC&state=xyz";
        let output = sanitize(input);
        assert!(
            !output.contains("ya29.a0AfB_byC"),
            "Access token in URL should not appear: {output}"
        );
        assert!(
            output.contains("state=xyz"),
            "Non-secret params should remain: {output}"
        );
    }

    #[test]
    fn test_password_assignment_redaction() {
        let input = "Config: password=my-super-secret";
        let output = sanitize(input);
        assert!(
            !output.contains("my-super-secret"),
            "Password value should not appear: {output}"
        );
        assert!(
            output.contains("password=***REDACTED***"),
            "Should show redacted password: {output}"
        );
    }

    #[test]
    fn test_secret_assignment_redaction() {
        let input = "secret=hidden_value_123";
        let output = sanitize(input);
        assert!(
            !output.contains("hidden_value_123"),
            "Secret value should not appear: {output}"
        );
    }

    #[test]
    fn test_api_key_assignment_redaction() {
        let input = "api_key=sk-proj-abc123";
        let output = sanitize(input);
        assert!(
            !output.contains("sk-proj-abc123"),
            "API key value should not appear: {output}"
        );
    }

    #[test]
    fn test_pem_private_key_redaction() {
        let input = "Key data:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy5AHB...\n-----END RSA PRIVATE KEY-----\nDone.";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED***"),
            "PEM key should be redacted: {output}"
        );
        assert!(
            !output.contains("MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn"),
            "PEM key content should not appear: {output}"
        );
    }

    #[test]
    fn test_pem_ec_private_key_redaction() {
        let input = "-----BEGIN EC PRIVATE KEY-----\nMHQCAQEE...\n-----END EC PRIVATE KEY-----";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED***"),
            "EC PEM key should be redacted: {output}"
        );
    }

    // ── Plain text passthrough ──────────────────────────────────────────

    #[test]
    fn test_plain_text_unchanged() {
        let input = "Starting container speedwave_acme_claude on port 4000";
        let output = sanitize(input);
        assert_eq!(output, input);
    }

    #[test]
    fn test_empty_string() {
        assert_eq!(sanitize(""), "");
    }

    #[test]
    fn test_long_input_without_secrets() {
        let input = "a]".repeat(10_000);
        let output = sanitize(&input);
        assert_eq!(output, input);
    }

    // ── Multiple secrets in one line ────────────────────────────────────

    #[test]
    fn test_multiple_secrets_in_one_line() {
        let input = "token=Bearer sk-123 and password=abc123 also xoxb-slack-token";
        let output = sanitize(input);
        assert!(
            !output.contains("sk-123"),
            "Bearer token should not appear: {output}"
        );
        assert!(
            !output.contains("abc123"),
            "Password should not appear: {output}"
        );
        assert!(
            !output.contains("xoxb-slack-token"),
            "Slack token should not appear: {output}"
        );
    }

    // ── False positive tests ────────────────────────────────────────────

    #[test]
    fn test_false_positive_password_policy() {
        // "password policy" should NOT be redacted — no assignment operator
        let input = "The password policy requires at least 8 characters";
        let output = sanitize(input);
        assert_eq!(
            output, input,
            "False positive: 'password policy' should not be redacted"
        );
    }

    #[test]
    fn test_false_positive_url_with_key_in_path() {
        let input = "GET /api/v1/key/list";
        let output = sanitize(input);
        assert_eq!(
            output, input,
            "False positive: 'key' in URL path should not be redacted"
        );
    }

    #[test]
    fn test_false_positive_bearer_as_standalone_word() {
        // "Bearer" alone without a token after should still match but redact next word
        let input = "The bearer of this document";
        let output = sanitize(input);
        // "bearer of" — "of" gets redacted, which is acceptable (security > false negatives)
        assert_eq!(
            output, "The bearer ***REDACTED*** this document",
            "Expected 'of' to be redacted as a false-positive token: {output}"
        );
    }

    #[test]
    fn test_false_positive_key_equals_in_non_secret_context() {
        // key= in non-URL context is fine — only ?key= and &key= in URLs trigger
        let input = "cache_key=user_123";
        let output = sanitize(input);
        assert_eq!(
            output, input,
            "False positive: cache_key should not be redacted"
        );
    }

    // ── Edge cases ──────────────────────────────────────────────────────

    #[test]
    fn test_partial_jwt_not_redacted() {
        // Only one eyJ segment — not a full JWT
        let input = "eyJhbGciOiJIUzI1NiJ9 is just a header";
        let output = sanitize(input);
        assert_eq!(
            output, input,
            "Partial JWT (single segment) should not be redacted"
        );
    }

    #[test]
    fn test_password_with_colon_separator() {
        let input = "password: supersecret123";
        let output = sanitize(input);
        assert!(
            !output.contains("supersecret123"),
            "Password with colon should be redacted: {output}"
        );
    }

    #[test]
    fn test_quoted_password() {
        let input = r#"password="my secret""#;
        let output = sanitize(input);
        assert!(
            !output.contains("my secret"),
            "Quoted password should be redacted: {output}"
        );
    }

    // ── Additional coverage ──────────────────────────────────────────

    #[test]
    fn test_slack_xoxa_token_redaction() {
        let input = "App token: xoxa-2-abcdef123456";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED_SLACK_TOKEN***"),
            "Slack xoxa token not redacted: {output}"
        );
        assert!(
            !output.contains("xoxa-"),
            "Slack xoxa prefix should not appear: {output}"
        );
    }

    #[test]
    fn test_slack_xoxr_token_redaction() {
        let input = "Refresh token: xoxr-rotation-token-value";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED_SLACK_TOKEN***"),
            "Slack xoxr token not redacted: {output}"
        );
        assert!(
            !output.contains("xoxr-"),
            "Slack xoxr prefix should not appear: {output}"
        );
    }

    #[test]
    fn test_slack_xoxs_token_redaction() {
        let input = "Session: xoxs-session-abc-789";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED_SLACK_TOKEN***"),
            "Slack xoxs token not redacted: {output}"
        );
        assert!(
            !output.contains("xoxs-"),
            "Slack xoxs prefix should not appear: {output}"
        );
    }

    #[test]
    fn test_url_token_param_redaction() {
        let input = "GET https://api.example.com/v1?token=abc123secret&page=2";
        let output = sanitize(input);
        assert!(
            !output.contains("abc123secret"),
            "token= param value should not appear: {output}"
        );
        assert!(
            output.contains("token=***REDACTED***"),
            "token= param should be redacted: {output}"
        );
        assert!(
            output.contains("page=2"),
            "Non-secret params should remain: {output}"
        );
    }

    #[test]
    fn test_url_secret_param_redaction() {
        let input = "Webhook: https://hooks.example.com/fire?secret=abcTopSecret&retry=3";
        let output = sanitize(input);
        assert!(
            !output.contains("abcTopSecret"),
            "secret= param value should not appear: {output}"
        );
        assert!(
            output.contains("secret=***REDACTED***"),
            "secret= param should be redacted: {output}"
        );
        assert!(
            output.contains("retry=3"),
            "Non-secret params should remain: {output}"
        );
    }

    #[test]
    fn test_url_password_param_redaction() {
        let input = "DB: postgres://db.local?password=hunter2&ssl=true";
        let output = sanitize(input);
        assert!(
            !output.contains("hunter2"),
            "password= param value should not appear: {output}"
        );
        assert!(
            output.contains("ssl=true"),
            "Non-secret params should remain: {output}"
        );
    }

    #[test]
    fn test_passwd_assignment_redaction() {
        let input = "Config: passwd=super-secret-val";
        let output = sanitize(input);
        assert!(
            !output.contains("super-secret-val"),
            "passwd= value should not appear: {output}"
        );
        assert!(
            output.contains("passwd=***REDACTED***"),
            "passwd= should be redacted: {output}"
        );
    }

    #[test]
    fn test_api_secret_assignment_redaction() {
        let input = "api_secret=TopSecretValue42";
        let output = sanitize(input);
        assert!(
            !output.contains("TopSecretValue42"),
            "api_secret= value should not appear: {output}"
        );
        assert!(
            output.contains("api_secret=***REDACTED***"),
            "api_secret= should be redacted: {output}"
        );
    }

    #[test]
    fn test_private_key_assignment_redaction() {
        let input = "private_key=base64encodedKeyData";
        let output = sanitize(input);
        assert!(
            !output.contains("base64encodedKeyData"),
            "private_key= value should not appear: {output}"
        );
        assert!(
            output.contains("private_key=***REDACTED***"),
            "private_key= should be redacted: {output}"
        );
    }

    #[test]
    fn test_apikey_assignment_redaction() {
        let input = "apikey=sk-abcdef123456";
        let output = sanitize(input);
        assert!(
            !output.contains("sk-abcdef123456"),
            "apikey= value should not appear: {output}"
        );
        assert!(
            output.contains("apikey=***REDACTED***"),
            "apikey= should be redacted: {output}"
        );
    }

    #[test]
    fn test_single_quoted_password_redaction() {
        let input = "password='my-secret'";
        let output = sanitize(input);
        assert!(
            !output.contains("my-secret"),
            "Single-quoted password value should not appear: {output}"
        );
    }

    #[test]
    fn test_multiple_pem_blocks_redacted() {
        let input = concat!(
            "First key:\n",
            "-----BEGIN RSA PRIVATE KEY-----\n",
            "MIIEowIBAAKCAQEAzFirst...\n",
            "-----END RSA PRIVATE KEY-----\n",
            "Second key:\n",
            "-----BEGIN EC PRIVATE KEY-----\n",
            "MHQCAQEESecond...\n",
            "-----END EC PRIVATE KEY-----\n",
            "Done."
        );
        let output = sanitize(input);
        assert!(
            !output.contains("MIIEowIBAAKCAQEAzFirst"),
            "First PEM key content should not appear: {output}"
        );
        assert!(
            !output.contains("MHQCAQEESecond"),
            "Second PEM key content should not appear: {output}"
        );
        // Exactly two redaction markers expected
        let count = output.matches("***REDACTED***").count();
        assert_eq!(
            count, 2,
            "Expected 2 REDACTED markers for 2 PEM blocks, got {count}: {output}"
        );
    }

    #[test]
    fn test_whitespace_only_input_unchanged() {
        let input = "   \n\t  ";
        let output = sanitize(input);
        assert_eq!(
            output, input,
            "Whitespace-only input should pass through unchanged"
        );
    }

    #[test]
    fn test_authorization_bearer_header_redaction() {
        let input = "Authorization: Bearer mytoken123";
        let output = sanitize(input);
        assert!(
            !output.contains("mytoken123"),
            "Bearer token in Authorization header should not appear: {output}"
        );
        assert!(
            output.contains("Authorization:"),
            "Authorization header key should remain: {output}"
        );
    }

    // ── GitHub token tests ───────────────────────────────────────────────

    #[test]
    fn test_github_ghp_token_redaction() {
        let input = "Using token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED_GITHUB_TOKEN***"),
            "GitHub ghp_ token not redacted: {output}"
        );
        assert!(
            !output.contains("ghp_"),
            "GitHub ghp_ prefix should not appear: {output}"
        );
    }

    #[test]
    fn test_github_ghs_token_redaction() {
        let input = "Server token: ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED_GITHUB_TOKEN***"),
            "GitHub ghs_ token not redacted: {output}"
        );
        assert!(
            !output.contains("ghs_"),
            "GitHub ghs_ prefix should not appear: {output}"
        );
    }

    #[test]
    fn test_github_gho_token_redaction() {
        let input = "OAuth: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED_GITHUB_TOKEN***"),
            "GitHub gho_ token not redacted: {output}"
        );
        assert!(
            !output.contains("gho_"),
            "GitHub gho_ prefix should not appear: {output}"
        );
    }

    #[test]
    fn test_github_ghu_token_redaction() {
        let input = "User token: ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED_GITHUB_TOKEN***"),
            "GitHub ghu_ token not redacted: {output}"
        );
        assert!(
            !output.contains("ghu_"),
            "GitHub ghu_ prefix should not appear: {output}"
        );
    }

    #[test]
    fn test_github_pat_token_redaction() {
        let input = "Fine-grained: github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED_GITHUB_TOKEN***"),
            "GitHub github_pat_ token not redacted: {output}"
        );
        assert!(
            !output.contains("github_pat_"),
            "GitHub github_pat_ prefix should not appear: {output}"
        );
    }

    #[test]
    fn test_github_token_too_short_not_redacted() {
        // Only 10 chars after prefix — below 36-char threshold
        let input = "ghp_ABCDEFGHIJ";
        let output = sanitize(input);
        assert_eq!(
            output, input,
            "Short ghp_ string should not be redacted (below 36 chars)"
        );
    }

    // ── GitLab token tests ───────────────────────────────────────────────

    #[test]
    fn test_gitlab_token_redaction() {
        let input = "GitLab PAT: glpat-abcdefghij1234567890";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED_GITLAB_TOKEN***"),
            "GitLab token not redacted: {output}"
        );
        assert!(
            !output.contains("glpat-"),
            "GitLab glpat- prefix should not appear: {output}"
        );
    }

    #[test]
    fn test_gitlab_token_too_short_not_redacted() {
        // Only 10 chars after prefix — below 20-char threshold
        let input = "glpat-abcdefghij";
        let output = sanitize(input);
        assert_eq!(
            output, input,
            "Short glpat- string should not be redacted (below 20 chars)"
        );
    }

    // ── Anthropic API key tests ──────────────────────────────────────────

    #[test]
    fn test_anthropic_key_redaction() {
        let input = "Key: sk-ant-api03-abcdef123456789-abcdef";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED_ANTHROPIC_KEY***"),
            "Anthropic key not redacted: {output}"
        );
        assert!(
            !output.contains("sk-ant-"),
            "Anthropic sk-ant- prefix should not appear: {output}"
        );
    }

    #[test]
    fn test_anthropic_key_false_positive() {
        // "sk-antenna" does not start with "sk-ant-" (no trailing hyphen)
        let input = "The sk-antenna module is ready";
        let output = sanitize(input);
        assert_eq!(
            output, input,
            "False positive: 'sk-antenna' should not be redacted"
        );
    }

    // ── URL userinfo credential tests ────────────────────────────────────

    #[test]
    fn test_url_userinfo_postgres() {
        let input = "DB: postgres://admin:supersecret@db.example.com/mydb";
        let output = sanitize(input);
        assert!(
            !output.contains("supersecret"),
            "Password in postgres URL should not appear: {output}"
        );
        assert!(
            output.contains("://admin:***REDACTED***@db.example.com"),
            "URL userinfo should be redacted preserving structure: {output}"
        );
    }

    #[test]
    fn test_url_userinfo_https() {
        let input = "Endpoint: https://admin:secret@example.com/path";
        let output = sanitize(input);
        assert!(
            !output.contains(":secret@"),
            "Password in HTTPS URL should not appear: {output}"
        );
        assert!(
            output.contains("://admin:***REDACTED***@example.com"),
            "URL userinfo should be redacted preserving structure: {output}"
        );
    }

    #[test]
    fn test_url_without_userinfo_not_redacted() {
        let input = "GET https://example.com/api/v1/resource";
        let output = sanitize(input);
        assert_eq!(
            output, input,
            "False positive: URL without userinfo should not be redacted"
        );
    }

    // ── PKCS#8 PEM key test ─────────────────────────────────────────────

    #[test]
    fn test_pem_pkcs8_private_key_redaction() {
        let input = "Key:\n-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBg...\n-----END PRIVATE KEY-----\nDone.";
        let output = sanitize(input);
        assert!(
            output.contains("***REDACTED***"),
            "PKCS#8 PEM key should be redacted: {output}"
        );
        assert!(
            !output.contains("MIIEvAIBADANBg"),
            "PKCS#8 PEM key content should not appear: {output}"
        );
    }

    // ── Invalid Slack prefix test ────────────────────────────────────────

    #[test]
    fn test_invalid_slack_prefix_not_redacted() {
        let input = "Token: xoxz-fake-token-value";
        let output = sanitize(input);
        assert_eq!(
            output, input,
            "False positive: xoxz- is not a valid Slack prefix and should not be redacted"
        );
    }
}
