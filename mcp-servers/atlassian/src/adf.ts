/**
 * Atlassian Document Format (Jira v3) and Confluence storage-representation body helpers; scope enforcement lives in `./scope.ts`.
 * @module mcp-atlassian/adf
 */

import type { AdfDoc, AdfNode } from './types.js';

/**
 * Convert plain text to a minimal ADF doc: one paragraph per line, blanks collapsed to empty ones.
 * No inline marks; callers needing rich formatting pass a raw ADF object via {@link toAdf}.
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
 * Narrow check: is `value` already a `{ version: 1, type: 'doc', ... }` ADF object?
 * @param value - The value to test.
 * @returns `true` if `value` looks like an ADF document.
 */
export function isAdfDoc(value: unknown): value is AdfDoc {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'doc' &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/**
 * Resolve a body to ADF: pass through a pre-built doc, else convert text via {@link textToAdf}.
 * @param body - Plain text or a raw ADF object.
 * @returns ADF document.
 */
export function toAdf(body: string | AdfDoc): AdfDoc {
  return isAdfDoc(body) ? body : textToAdf(String(body ?? ''));
}

/**
 * Wrap a value as a Confluence "storage representation" body object. Caller must ensure it is
 * already valid storage XHTML (escape via {@link textToStorage} or use {@link resolveBodyPayload}).
 * @param value - Storage-format body string.
 * @returns Confluence body value object.
 */
export function storageBody(value: string): { representation: 'storage'; value: string } {
  return { representation: 'storage', value: String(value ?? '') };
}

/**
 * Minimal HTML escaping for plain text into a safe Confluence storage body (single `<p>` wrap).
 * Not a sanitizer — only for text the worker itself produces from tool input.
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

/** A Confluence page/comment body supplied to create/update: raw storage XHTML, or plain text. */
export type StorageBodyInput = { storage?: string; text?: string };

/**
 * Resolve a {@link StorageBodyInput}: `storage` (raw XHTML) wins, else `text` is HTML-escaped and
 * wrapped in `<p>`. SSOT for body resolution shared by the Confluence page and content domains.
 * @param body - The body input (`storage` and/or `text`).
 * @returns The Confluence body value object.
 */
export function resolveBodyPayload(body: StorageBodyInput): {
  representation: 'storage';
  value: string;
} {
  if (body.storage !== undefined) return storageBody(body.storage);
  return storageBody(textToStorage(body.text ?? ''));
}
