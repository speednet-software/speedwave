/**
 * Tiny shared utilities for the office worker.
 * @module mcp-office/util
 */

/**
 * No-op error handler — pass to `.catch()` on best-effort cleanup (`fs.rm` of a temp file)
 * where a failure is genuinely not actionable. Centralised so the pattern is documented once
 * rather than scattered as anonymous `() => undefined` arrows.
 */
export function ignoreError(): void {
  /* deliberately empty — used for best-effort cleanup */
}
