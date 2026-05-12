/**
 * Simple logging utilities for MCP servers
 * @module shared/logger
 */

/**
 * Returns `[<ISO 8601, UTC>]` for log-line prefixes. TS SSOT; the Rust
 * counterpart is `speedwave-runtime`'s `log_ts::log_timestamp()`.
 * @example
 * console.log(`${ts()} 🔧 Tool registered: ${tool.name}`);
 * // Output: [2026-05-12T14:34:02.814Z] 🔧 Tool registered: get_tree
 */
export function ts(): string {
  return `[${new Date().toISOString()}]`;
}
