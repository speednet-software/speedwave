/**
 * Raises Claude Code's result-size cap for tools that return whole pages.
 */
export const LARGE_RESULT_TOOLS: ReadonlySet<string> = new Set<string>(['readPage', 'evalJs']);

/** Character budget advertised to Claude Code for the tools above. */
export const LARGE_RESULT_MAX_CHARS = 500_000;

/**
 * Attaches the `anthropic/maxResultSizeChars` hint for large-result tools.
 */
export function withLargeResultMeta(toolName: string, result: unknown): unknown {
  if (!LARGE_RESULT_TOOLS.has(toolName)) return result;
  return {
    ...(result as Record<string, unknown>),
    _meta: { 'anthropic/maxResultSizeChars': LARGE_RESULT_MAX_CHARS },
  };
}
