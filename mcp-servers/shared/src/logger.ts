/**
 * Simple logging utilities for MCP servers
 * @module shared/logger
 */

/**
 * Returns current timestamp in [HH:MM:SS] format for logs.
 * Uses local time for readability in Lumadock.
 * @example
 * console.log(`${ts()} 🔧 Tool registered: ${tool.name}`);
 * // Output: [10:30:45] 🔧 Tool registered: get_tree
 */
export function ts(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `[${hh}:${mm}:${ss}]`;
}
