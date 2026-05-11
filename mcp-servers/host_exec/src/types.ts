/**
 * Shared types for the `host_exec` worker — the on-disk config snapshot the
 * Tauri side writes (mirrors the Rust `HostExecConfig` / `HostExecRecipe` in
 * `crates/speedwave-runtime/src/config.rs`) and the result contract returned to
 * Claude (ADR-054).
 *
 * The Rust side validates the config before writing the snapshot
 * (`host_exec::validate_host_exec_config`); this worker re-validates only the
 * parts it must enforce at runtime — the parameter regexes (compilation + a
 * full match against the value Claude supplied) and the `cwdSub` canonical-path
 * check, which need the project directory the Rust side does not have at
 * config-save time. It does not re-do the structural validation.
 * @module host_exec/types
 */

/** When the per-recipe confirmation dialog is shown before a recipe runs. */
export type HostExecConfirm = 'ask' | 'session' | 'always';

/** One named parameter a recipe accepts from Claude. */
export interface HostExecParam {
  /** Parameter name — the `{name}` token in `args` that this entry defines. */
  name: string;
  /** Regex the supplied value must fully match (the worker anchors it as `^(?:…)$`). */
  pattern: string;
  /** Optional upper bound on the supplied value's length. */
  maxLen?: number;
}

/** One whitelisted command this worker may run, in the project directory. */
export interface HostExecRecipe {
  /** Recipe name — exposed to Claude as the MCP tool `host_exec.<camelCase(name)>()`. */
  name: string;
  /** The executable to run. Relative paths resolve against the project dir or `PATH`. */
  exec: string;
  /** Fixed argument list — literals plus `{name}` parameter tokens. */
  args: string[];
  /** Optional subdirectory inside the project directory to run in. */
  cwdSub?: string;
  /** Named parameters this recipe accepts from Claude. */
  params?: HostExecParam[];
  /** Literal environment variables for the recipe (no Claude-supplied values). */
  env?: Record<string, string>;
  /** When the per-recipe confirmation dialog is shown. */
  confirm: HostExecConfirm;
}

/** The config snapshot file the worker reads (`<data_dir>/host-exec/<project>/config.json`). */
export interface HostExecConfigSnapshot {
  /** Absolute path of the project directory recipes run in. */
  projectDir: string;
  /** The validated whitelist. */
  commands: HostExecRecipe[];
}

/** How a recipe execution ended. */
export type HostExecStatus =
  /** The process exited on its own (with whatever `exitCode`). */
  | 'exited'
  /** The per-command timeout fired and the process group was `SIGKILL`ed. */
  | 'killed_timeout'
  /** The process could not be started (`ENOENT` / `EACCES`). */
  | 'spawn_error';

/**
 * The structured result returned to Claude as a (successful) ToolResult.
 * `exitCode !== 0` is **not** an MCP tool error — it is a successful result
 * carrying the command's exit code (ADR-054). MCP tool *errors* are reserved
 * for: unknown recipe, a parameter that fails its regex, a `cwdSub` escape, the
 * user declining (or the confirmation being unanswerable — fail closed), and a
 * `spawn_error`.
 */
export interface HostExecResult {
  /** How the execution ended. */
  status: HostExecStatus;
  /** Exit code if `status === 'exited'`, else `null`. */
  exitCode: number | null;
  /** Killing signal if the process was killed (e.g. `'SIGKILL'`), else `null`. */
  signal: string | null;
  /** Stdout — possibly truncated to the tail (see `truncated`); ANSI stripped, `\r` collapsed. */
  stdout: string;
  /** Stderr — separate from stdout; possibly truncated; ANSI stripped, `\r` collapsed. */
  stderr: string;
  /** True if either stream exceeded the per-stream cap and only a tail was kept. */
  truncated: boolean;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** The recipe name (not the raw argv — the full argv goes to the host log only). */
  command: string;
  /** The subdirectory the recipe ran in (`cwdSub`), or `'.'` for the project root. */
  cwd: string;
}
