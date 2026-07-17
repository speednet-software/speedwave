import type { LlmProviderKind } from '../../../models/llm';

/**
 * Mirrors Rust `model_id::wire_model_id` (Task 8): anthropic kinds pass the
 * catalog id through; proxy-routed kinds get `<entryId>/` prefixed exactly once.
 * @param kind - Active provider kind deciding passthrough vs. prefix.
 * @param entryId - Provider entry id used as the wire route prefix.
 * @param catalogId - Provider-native model id, possibly already wire-shaped.
 * @returns The id sent over `/model` and matched by the proxy's first-segment router.
 */
export function wireModelId(kind: LlmProviderKind, entryId: string, catalogId: string): string {
  if (kind === 'anthropic_oauth' || kind === 'anthropic_api_key') return catalogId;
  const prefix = `${entryId}/`;
  return catalogId.startsWith(prefix) ? catalogId : `${prefix}${catalogId}`;
}

/**
 * Mirrors Rust `model_id::normalize_observed`: strips one leading `<entryId>/`
 * from an observed wire id for display; a non-matching prefix (including a
 * different first segment) passes through unchanged.
 * @param observed - Observed/stored model id (bare or `<entryId>/<catalogId>`).
 * @param entryId - Provider entry id whose prefix is stripped, if present.
 * @returns The catalog id for display, prefix removed only on an exact match.
 */
export function normalizeObserved(observed: string, entryId: string): string {
  const prefix = `${entryId}/`;
  return observed.startsWith(prefix) ? observed.slice(prefix.length) : observed;
}
