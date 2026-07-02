// Mirrors the Rust SSOT (`crates/speedwave-runtime/src/log_sanitizer.rs`). Keep rule list in sync.

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '-----BEGIN PRIVATE KEY-----\n***REDACTED***\n-----END PRIVATE KEY-----',
  ],
  [/((?:\/Users\/|\/home\/|[A-Z]:\\Users\\))[^/\\\s]+/gi, '$1<user>'],
  [/(Set-Cookie:\s*)[^;\r\n]+/gi, '$1***REDACTED***'],
  // Cookie request header anchored at start-of-line/whitespace to avoid Set-Cookie double-match.
  [/(^|\s)(Cookie:\s*)[^\r\n]+/gi, '$1$2***REDACTED***'],
  [/(Bearer\s+)\S+/gi, '$1***REDACTED***'],
  [/(Authorization:\s*)\S+(\s+\S+)?/gi, '$1***REDACTED***'],
  [/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***REDACTED_JWT***'],
  // Rotating-token formats (xoxe.xoxp-… / xoxe-1-…) ordered before xox[bpars]-.
  [/xoxe[.-][A-Za-z0-9.-]+/g, '***REDACTED_SLACK_TOKEN***'],
  [/xox[bpars]-[A-Za-z0-9-]+/g, '***REDACTED_SLACK_TOKEN***'],
  [/ghp_[A-Za-z0-9]{36,}/g, '***REDACTED_GITHUB_TOKEN***'],
  [/ghs_[A-Za-z0-9]{36,}/g, '***REDACTED_GITHUB_TOKEN***'],
  [/gho_[A-Za-z0-9]{36,}/g, '***REDACTED_GITHUB_TOKEN***'],
  [/ghu_[A-Za-z0-9]{36,}/g, '***REDACTED_GITHUB_TOKEN***'],
  [/github_pat_[A-Za-z0-9]{36,}/g, '***REDACTED_GITHUB_TOKEN***'],
  [/glpat-[A-Za-z0-9-]{20,}/g, '***REDACTED_GITLAB_TOKEN***'],
  [/ATATT[A-Za-z0-9_-]{20,}/g, '***REDACTED_ATLASSIAN_TOKEN***'],
  [/sk-ant-[A-Za-z0-9_-]+/g, '***REDACTED_ANTHROPIC_KEY***'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '***REDACTED_API_KEY***'],
  [/(:\/\/[^:/@\s]+:)[^@\s]+(@)/g, '$1***REDACTED***$2'],
  [/([?&](?:api_key|apikey|key|token|secret|password|access_token)=)[^&\s]+/gi, '$1***REDACTED***'],
  [/(X-Redmine-API-Key:\s*)\S+/gi, '$1***REDACTED***'],
  [
    /((?:password|passwd|secret|api_key|apikey|api_secret|access_token|private_key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;&]+)"?/gi,
    '$1***REDACTED***',
  ],
];

/** Count of redaction rules — must equal `EXPECTED_RULE_COUNT` in Rust SSOT. */
export const RULE_COUNT = RULES.length;

/**
 * Redact secret patterns before a log line reaches stdout.
 * @param input - Raw log message.
 */
export function sanitize(input: string): string {
  let out = input;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
