/**
 * Recognizes PII token spans in tool arguments that pass through to a worker still tokenized, for value-free audit counts.
 * @module token-spans
 */

import type { Detection } from '@speedwave/policy-engine';

/** Byte-identical copy of `crates/pii-engine/src/scan.rs::TOKEN_SPAN_RE`, the one token span shape (alignment-tested). */
export const TOKEN_SPAN_RE_SOURCE = String.raw`\[[A-Z0-9_]+:TOKEN_[A-Za-z0-9_-]+\]`;

/**
 * Count token spans per category in a JSON value; the spans themselves are never returned.
 * @param value - Tool arguments.
 */
export function countTokenSpans(value: unknown): Detection[] {
  const text = JSON.stringify(value ?? null);
  const counts = new Map<string, number>();
  for (const [span] of text.matchAll(new RegExp(TOKEN_SPAN_RE_SOURCE, 'g'))) {
    const category = span.slice(1, span.indexOf(':'));
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts].map(([category, count]) => ({ category, action: 'tokenized', count }));
}
