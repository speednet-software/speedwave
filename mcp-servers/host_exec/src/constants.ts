/**
 * Worker-side constants for `host_exec`. These mirror the Rust SSOT in
 * `crates/speedwave-runtime/src/consts.rs` (the `HOST_EXEC_*` constants) — the
 * worker is a separate process and cannot import the Rust values, so they are
 * duplicated here with this pointer. If you change one side, change the other
 * (and the ADR-054 numbers).
 * @module host_exec/constants
 */

/**
 * Per-command timeout (ms). On expiry the worker `SIGKILL`s the recipe's whole
 * process group. Sized so command + confirmation + margin stays under the hub's
 * 600 s long-operation timeout. Overridable via `HOST_EXEC_TIMEOUT_MS` (used by
 * tests to avoid 7-minute waits).
 */
export const COMMAND_TIMEOUT_MS = envInt('HOST_EXEC_TIMEOUT_MS', 420_000);

/**
 * How long the worker waits for the per-recipe confirmation reply on the
 * confirm channel before failing closed (MCP tool error "confirmation
 * unavailable"). This is the *worker's* guard; the Tauri side has its own,
 * shorter, frontend-reply timeout. Overridable via `HOST_EXEC_CONFIRM_TIMEOUT_MS`.
 */
export const CONFIRM_TIMEOUT_MS = envInt('HOST_EXEC_CONFIRM_TIMEOUT_MS', 130_000);

/** Per-stream output cap (bytes). The tail is kept; `truncated` is set. */
export const MAX_OUTPUT_BYTES = 64 * 1024;

/** Per-stream output cap (lines), applied alongside `MAX_OUTPUT_BYTES`. */
export const MAX_OUTPUT_LINES = 2000;

/** Hard ceiling on a recipe parameter's value length (and on a declared `maxLen`). */
export const PARAM_MAX_LEN = 65536;

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
