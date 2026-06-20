/**
 * Tiny shared utilities for the office worker.
 * @module mcp-office/util
 */

/**
 * No-op error handler for `.catch()` on best-effort cleanup where failure is not actionable.
 */
export function ignoreError(): void {
  /* deliberately empty — used for best-effort cleanup */
}
