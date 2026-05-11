/**
 * Helpers for Atlassian content formats and project/space scope enforcement.
 *
 * - {@link textToAdf}: plain text → minimal Atlassian Document Format document
 *   (Jira Cloud REST v3 requires ADF for `description`, comment bodies, etc.).
 * - {@link toAdf}: accept either plain text or a pre-built ADF object.
 * - {@link storageBody}: wrap text/HTML as a Confluence "storage representation" body.
 * - {@link assertJiraProjectAllowed} / {@link assertConfluenceSpaceAllowed}: throw
 *   {@link ScopeError} when an allowlist is configured and the key is not in it.
 * @module mcp-atlassian/adf
 */

import type { AdfDoc, AdfNode } from './types.js';

/**
 * Convert plain text to a minimal ADF document: one paragraph per line, blank
 * lines collapsed to empty paragraphs. No inline marks — this is the "good
 * enough" representation for tool-generated content; callers needing rich
 * formatting pass a raw ADF object via {@link toAdf}.
 * @param text - Plain text (may contain `\n`).
 * @returns ADF document.
 */
export function textToAdf(text: string): AdfDoc {
  const lines = String(text ?? '').split('\n');
  const content: AdfNode[] = lines.map((line) =>
    line.length === 0
      ? { type: 'paragraph', content: [] }
      : { type: 'paragraph', content: [{ type: 'text', text: line }] }
  );
  return { version: 1, type: 'doc', content };
}

/**
 * Narrow check: is `value` already a `{ type: 'doc', ... }` ADF object?
 * @param value - The value to test.
 * @returns `true` if `value` looks like an ADF document.
 */
export function isAdfDoc(value: unknown): value is AdfDoc {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'doc' &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/**
 * Resolve a body to ADF: pass through a pre-built ADF doc, otherwise convert
 * from plain text via {@link textToAdf}.
 * @param body - Plain text or a raw ADF object.
 * @returns ADF document.
 */
export function toAdf(body: string | AdfDoc): AdfDoc {
  return isAdfDoc(body) ? body : textToAdf(String(body ?? ''));
}

/**
 * Wrap a Confluence page/comment body as a "storage representation" value object.
 * The caller is responsible for the content already being valid storage XHTML
 * (for tool-generated text, escape it first via {@link textToStorage}).
 * @param value - Storage-format body string.
 * @returns Confluence body value object.
 */
export function storageBody(value: string): { representation: 'storage'; value: string } {
  return { representation: 'storage', value: String(value ?? '') };
}

/**
 * Minimal HTML escaping for turning plain text into a safe Confluence storage
 * body (wrapped in a single `<p>`). Not a sanitizer — only for text the worker
 * itself produces from tool input.
 * @param text - Plain text.
 * @returns A `<p>`-wrapped, HTML-escaped paragraph.
 */
export function textToStorage(text: string): string {
  const escaped = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<p>${escaped}</p>`;
}

//═══════════════════════════════════════════════════════════════════════════════
// Scope enforcement
//═══════════════════════════════════════════════════════════════════════════════

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
