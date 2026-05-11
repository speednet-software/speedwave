/**
 * Project/space scope enforcement for the Atlassian worker.
 *
 * The worker authenticates as a real Atlassian account, so by default it can
 * reach everything that account can. The optional `jira_project_keys` /
 * `confluence_space_keys` allowlists narrow that surface: when configured, any
 * operation whose project/space is not in the list — or whose project/space
 * cannot be determined — is rejected with {@link ScopeError}. An empty allowlist
 * means "unrestricted".
 * @module mcp-atlassian/scope
 */

/** Thrown when an operation targets a project/space outside the configured allowlist. */
export class ScopeError extends Error {
  /**
   * Create a scope-violation error.
   * @param message - Human-readable explanation of the violation.
   */
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

/**
 * Throw {@link ScopeError} if `allowlist` is non-empty and `key` is not in it.
 * Comparison is case-insensitive (Atlassian keys are upper-case). A missing/empty
 * `key` with a configured allowlist is also rejected — callers must resolve the
 * key before the check.
 * @param key - Project/space key to check (may be `undefined`).
 * @param allowlist - Configured allowed keys (empty = unrestricted).
 * @param kind - `'Jira project'` or `'Confluence space'`, for the error message.
 */
function assertAllowed(
  key: string | undefined,
  allowlist: readonly string[],
  kind: 'Jira project' | 'Confluence space'
): void {
  if (allowlist.length === 0) return;
  const allowed = allowlist.map((k) => k.trim().toUpperCase());
  const normalized = (key ?? '').trim().toUpperCase();
  if (!normalized) {
    throw new ScopeError(
      `Cannot determine the ${kind} key for this operation; access is restricted to: ${allowed.join(', ')}`
    );
  }
  if (!allowed.includes(normalized)) {
    throw new ScopeError(
      `${kind} '${normalized}' is outside the allowed list (${allowed.join(', ')})`
    );
  }
}

/**
 * Enforce the Jira project allowlist for `key` (see {@link assertAllowed}).
 * @param key - Jira project key to check (may be `undefined`).
 * @param allowlist - Configured allowed project keys (empty = unrestricted).
 */
export function assertJiraProjectAllowed(
  key: string | undefined,
  allowlist: readonly string[]
): void {
  assertAllowed(key, allowlist, 'Jira project');
}

/**
 * Enforce the Confluence space allowlist for `key` (see {@link assertAllowed}).
 * @param key - Confluence space key to check (may be `undefined`).
 * @param allowlist - Configured allowed space keys (empty = unrestricted).
 */
export function assertConfluenceSpaceAllowed(
  key: string | undefined,
  allowlist: readonly string[]
): void {
  assertAllowed(key, allowlist, 'Confluence space');
}

/**
 * Enforce the Jira project allowlist for an issue ref. When `issueIdOrKey` is a
 * `PROJ-123`-style key the project is parsed directly; when it is a bare numeric
 * ID the key cannot be derived from the string, so — if an allowlist is
 * configured — the operation is rejected with {@link ScopeError} (callers that
 * need numeric-ID support with an allowlist must resolve the issue key first).
 * No-op when no allowlist is configured.
 * @param issueIdOrKey - The Jira issue key (e.g. `PROJ-123`) or numeric ID.
 * @param allowlist - Configured allowed project keys (empty = unrestricted).
 */
export function assertJiraIssueKeyAllowed(
  issueIdOrKey: string,
  allowlist: readonly string[]
): void {
  if (allowlist.length === 0) return;
  const m = /^([A-Za-z][A-Za-z0-9_]+)-\d+$/.exec(issueIdOrKey.trim());
  assertJiraProjectAllowed(m ? m[1] : undefined, allowlist);
}

/**
 * Filter a list of items to those whose key is in the allowlist. When the
 * allowlist is empty the list passes through unchanged.
 * @param items - Items to filter.
 * @param keyOf - Extracts the project/space key from an item.
 * @param allowlist - Configured allowed keys (empty = unrestricted).
 * @returns The filtered (or original) list.
 */
export function filterByAllowlist<T>(
  items: T[],
  keyOf: (item: T) => string | undefined,
  allowlist: readonly string[]
): T[] {
  if (allowlist.length === 0) return items;
  const allowed = allowlist.map((k) => k.trim().toUpperCase());
  return items.filter((item) => {
    const k = (keyOf(item) ?? '').trim().toUpperCase();
    return k.length > 0 && allowed.includes(k);
  });
}
