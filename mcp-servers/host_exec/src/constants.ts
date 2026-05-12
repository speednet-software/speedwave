/**
 * Worker-side constants for `host_exec` — mirror the Rust SSOT in
 * `crates/speedwave-runtime/src/consts.rs` (`HOST_EXEC_*`). The worker is a
 * separate process and cannot import the Rust values; change both sides together.
 * @module host_exec/constants
 */

/**
 * Per-command timeout (ms). On expiry the worker `SIGKILL`s the recipe's whole
 * process group. Sized so command + margin stays under the hub's 600 s
 * long-operation timeout. Overridable via `HOST_EXEC_TIMEOUT_MS` (used by
 * tests to avoid 7-minute waits).
 */
export const COMMAND_TIMEOUT_MS = envInt('HOST_EXEC_TIMEOUT_MS', 420_000);

/** Per-stream output cap (bytes). The tail is kept; `truncated` is set. */
export const MAX_OUTPUT_BYTES = 64 * 1024;

/** Per-stream output cap (lines), applied alongside `MAX_OUTPUT_BYTES`. */
export const MAX_OUTPUT_LINES = 2000;

/** Hard ceiling on a recipe parameter's value length (and on a declared `maxLen`). */
export const PARAM_MAX_LEN = 65536;

/**
 * Audit-log size ceiling (bytes). When the worker's append would push the log
 * past this, it truncates to the last ~half first, so a long-lived worker
 * doesn't grow the log unbounded between respawns. Matches the Tauri side's
 * `LOG_MAX_BYTES` (2 MiB), which truncates at spawn.
 */
export const LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Read a non-negative integer from an env var, falling back to `fallback` if
 * unset, empty, or not a valid non-negative integer. Exported for testing.
 * @param name - Environment variable name.
 * @param fallback - Default value.
 * @returns The parsed value, or `fallback`.
 */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
