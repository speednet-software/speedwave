/**
 * Project/space scope enforcement. Optional allowlists narrow surface; empty = unrestricted.
 * @module mcp-atlassian/scope
 */

/** Thrown when an operation targets a project/space outside the configured allowlist. */
export class ScopeError extends Error {
  /**
   * Create a scope-violation error.
   * @param message - Human-readable violation detail.
   */
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

/**
 * Check if key is in allowlist (case-insensitive). Reject if missing or not in allowlist.
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
 * Enforce allowlist for issue key. Numeric IDs rejected if allowlist is configured; callers must resolve key first.
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
 * Filter items by allowlist keys (case-insensitive). Empty allowlist = no filtering.
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
