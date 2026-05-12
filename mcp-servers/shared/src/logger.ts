/**
 * Simple logging utilities for MCP servers
 * @module shared/logger
 */

/**
 * Zero-pad a number's magnitude to two digits.
 * @param n - The value (sign ignored — used for date/time/offset components).
 */
function pad2(n: number): string {
  return String(Math.abs(n)).padStart(2, '0');
}

/**
 * Returns `[<ISO 8601 with local offset>]` for log-line prefixes — local time
 * (the container's `TZ`, injected from the host by `speedwave-runtime`'s
 * `tz::detect_host_timezone`), so log timestamps match the host clock and line
 * up with the Rust SSOT (`speedwave-runtime`'s `log_ts::log_timestamp()`).
 * @example
 * console.log(`${ts()} 🔧 Tool registered: ${tool.name}`);
 * // Output: [2026-05-12T14:34:02.814+02:00] 🔧 Tool registered: get_tree
 */
export function ts(): string {
  const d = new Date();
  // `getTimezoneOffset()` is minutes *behind* UTC, so negate it for the sign.
  const offMin = -d.getTimezoneOffset();
  const sign = offMin < 0 ? '-' : '+';
  const offset =
    offMin === 0 ? '+00:00' : `${sign}${pad2(Math.trunc(offMin / 60))}:${pad2(offMin % 60)}`;
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `[${date}T${time}.${ms}${offset}]`;
}
