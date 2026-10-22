/**
 * SSOT for `_meta` key names on MCP tools: prefixed `speedwave.pl/…` keys plus a reader falling back to legacy unprefixed keys.
 * @module shared/meta-keys
 */

/** MCP-spec-compliant prefixed `_meta` keys used by Speedwave. */
export const META_KEYS = Object.freeze({
  /** Result set depends on the authenticated user's identity. */
  USER_SCOPED: 'speedwave.pl/user-scoped',
  /** Name of the sibling tool that resolves "me"/"my" without an explicit id param. */
  CURRENT_USER_TOOL: 'speedwave.pl/current-user-tool',
  /** Name of the input param that accepts a self-referential value (e.g. "me"). */
  SELF_PARAM: 'speedwave.pl/self-param',
  /** Defer loading: true = on-demand discovery, false = always loaded. */
  DEFER_LOADING: 'speedwave.pl/defer-loading',
  /** Timeout class: 'standard' or 'long'. */
  TIMEOUT_CLASS: 'speedwave.pl/timeout-class',
  /** Custom timeout in milliseconds. */
  TIMEOUT_MS: 'speedwave.pl/timeout-ms',
  /** OS sub-integration category (os service only). */
  OS_CATEGORY: 'speedwave.pl/os-category',
  /** Gate-assigned tool state (`allowed`/`pending`/`blocked`/`changed`); prefixed only, no legacy key. */
  TOOL_STATE: 'speedwave.pl/tool-state',
  /** Gate-assigned name the upstream server knows the tool by; prefixed only, no legacy key. */
  UPSTREAM_NAME: 'speedwave.pl/upstream-name',
} as const);

/** Legacy unprefixed `_meta` keys the hub still reads as fallbacks; a gate strips them from upstream tools. */
export const LEGACY_META_KEYS: readonly string[] = Object.freeze([
  'userScoped',
  'currentUserTool',
  'selfParam',
  'deferLoading',
  'timeoutClass',
  'timeoutMs',
  'osCategory',
]);

/** Union of all prefixed `_meta` key string values. */
export type MetaKey = (typeof META_KEYS)[keyof typeof META_KEYS];

/**
 * Read a `_meta` value, preferring the prefixed key and falling back to the legacy unprefixed key
 * (back-compat for third-party plugin workers); e.g. `META_KEYS.DEFER_LOADING` / `'deferLoading'`.
 * @param meta - The tool's `_meta` object, or undefined.
 * @param prefixedKey - The MCP-spec-compliant prefixed key to look up first.
 * @param legacyKey - The unprefixed legacy key to fall back to.
 */
export function metaValue(
  meta: Record<string, unknown> | undefined,
  prefixedKey: MetaKey,
  legacyKey: string
): unknown {
  if (!meta) return undefined;
  if (prefixedKey in meta) return meta[prefixedKey];
  return meta[legacyKey];
}
