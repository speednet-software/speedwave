/**
 * Models for the `host_exec` integration — the per-project host-side worker
 * that runs a user-whitelisted set of project-toolchain commands (build / test
 * / lint, `docker compose`, …) on the host machine, in the project directory,
 * behind the per-project MCP hub (ADR-054, SPW-83).
 *
 * `host_exec` is a deliberate, scoped weakening of Speedwave's container
 * isolation: it is opt-in per project, the whitelist starts empty, the config
 * lives only in `~/.speedwave/config.json` (never the repo `.speedwave.json`),
 * every recipe carries a confirmation policy, and enabling it pops a blocking
 * danger modal explaining the consequences. See `docs/architecture/security.md`.
 *
 * The shapes here mirror the Rust SSOT in `crates/speedwave-runtime/src/config.rs`
 * (`HostExecRecipe` / `HostExecParam`, both `#[serde(rename_all = "camelCase")]`)
 * and the TypeScript worker's `HostExecRecipe` (`mcp-servers/host_exec/src/types.ts`)
 * — keep them in sync with both. The Tauri commands they back are
 * `get_host_exec`, `set_host_exec_enabled`, `host_exec_save_settings`,
 * `host_exec_load_settings`, `host_exec_resolve_executable`, and
 * `host_exec_confirm_reply` (`desktop/src-tauri/src/host_exec_cmd.rs` +
 * `host_exec_process.rs`).
 * @module models/host-exec
 */

/**
 * When the per-recipe confirmation dialog is shown before a recipe runs.
 *
 * - `'ask'` — prompt every time (the default; the only choice for recipes the
 *   backend flags as state-changing — DB clients, `docker compose up/down/...`,
 *   migrations).
 * - `'session'` — prompt the first time with a given argv/cwd in an app
 *   session, then silent for the rest of that session.
 * - `'always'` — never prompt (user has deliberately trusted this recipe in
 *   this project; only offered when *editing* a recipe, behind a second
 *   warning, and not for state-changing recipes).
 *
 * Serialised lowercase — matches the Rust `HostExecConfirm` enum
 * (`#[serde(rename_all = "lowercase")]`).
 */
export type HostExecConfirm = 'ask' | 'session' | 'always';

/**
 * One named parameter a recipe accepts from Claude, substituted into a fixed
 * position in the recipe's `args` (each substitution is one argv element, never
 * re-split). The `pattern`'s semantics (compilation + a full match against the
 * value Claude supplies) are enforced in the worker; the UI and the Rust
 * validator only sanity-check the `pattern` string and the `maxLen` ceiling.
 */
export interface HostExecParam {
  /**
   * Parameter name — `snake_case`, unique within the recipe; the `{name}`
   * token in `args` this entry defines.
   */
  name: string;
  /**
   * Regex the supplied value must fully match (the worker anchors it as
   * `^(?:…)$`). Non-empty, no NUL/newline.
   */
  pattern: string;
  /**
   * Optional upper bound on the supplied value's length. If omitted the
   * worker's default ceiling applies. Serialised as `maxLen`.
   */
  maxLen?: number;
}

/**
 * One whitelisted command the worker may run, in the project directory.
 * Exposed to Claude as the MCP tool `host_exec.<camelCase(name)>()`.
 */
export interface HostExecCommand {
  /**
   * Recipe name — `^[a-z][a-z0-9_]{0,63}$` (snake_case, so the hub's
   * `toCamelCase` bridge exposes it as a valid JS identifier); unique across
   * the whitelist.
   */
  name: string;
  /**
   * The executable to run. A relative path (`./gradlew`, `npm`, `docker`)
   * resolves against the project directory or the recovered host `PATH`; an
   * absolute path is allowed but flagged in the UI. Must not be a shell/eval
   * launcher (`bash`, `sh`, `eval`, `xargs`, …). No `..`, NUL, `=`, newlines.
   */
  exec: string;
  /**
   * Fixed argument list — literals plus `{name}` parameter tokens. Every
   * `{name}` must have a matching {@link HostExecParam} in `params`.
   */
  args: string[];
  /**
   * Optional subdirectory inside the project directory to run in (monorepo
   * support). Relative, no `..`, no absolute path. Serialised as `cwdSub`.
   */
  cwdSub?: string;
  /** Named parameters this recipe accepts from Claude. */
  params?: HostExecParam[];
  /**
   * Literal environment variables for the recipe (no Claude-supplied values).
   * Keys must not be reserved (`PATH`, `LD_*`, `NODE_OPTIONS`, …). May hold
   * secrets — the on-disk snapshot is `0600` and the host log redacts these
   * values — but the UI warns against it (prefer a repo `.env`).
   */
  env?: Record<string, string>;
  /** When the per-recipe confirmation dialog is shown. Defaults to `'ask'`. */
  confirm: HostExecConfirm;
}

/**
 * What `get_host_exec` returns for a project: whether `host_exec` is enabled
 * and the current recipe whitelist (so the editor can render it). Mirrors the
 * Rust `HostExecStatus` (`desktop/src-tauri/src/host_exec_cmd.rs`).
 */
export interface HostExecStatus {
  /** Whether `host_exec` is enabled for this project (user config only). */
  enabled: boolean;
  /** The recipe whitelist — empty unless the user has added recipes. */
  commands: HostExecCommand[];
}

/**
 * Payload of the `host-exec://confirm-request` Tauri event the per-project
 * worker emits (via the Rust process manager) before it runs a recipe whose
 * `confirm` is not auto-allowed. The UI shows a dialog and answers with
 * `host_exec_confirm_reply({ project, id, decision })`.
 */
export interface HostExecConfirmRequest {
  /** The project the worker belongs to. */
  project: string;
  /** The recipe name being invoked. */
  recipe: string;
  /**
   * The fully-resolved argv (`exec` first, then `args` with params
   * substituted) — shown to the user so they see exactly what runs.
   */
  argv: string[];
  /**
   * The working-directory label — `'.'` for the project root, or the
   * recipe's `cwdSub`.
   */
  cwd: string;
  /** Correlation id — echoed back in the reply. */
  id: string;
}

/**
 * The decision the UI sends back via `host_exec_confirm_reply`. `'allow'` runs
 * it once; `'allow-session'` also remembers this exact argv/cwd for the rest of
 * the app session; `'deny'` (and a non-answer — the worker fails closed) blocks
 * it. Must match the strings the `host_exec_confirm_reply` command accepts.
 */
export type HostExecConfirmDecision = 'allow' | 'allow-session' | 'deny';

/**
 * Event name the worker/process-manager emits per-recipe confirmation
 * requests on.
 */
export const HOST_EXEC_CONFIRM_EVENT = 'host-exec://confirm-request';

/**
 * Recipe-name pattern enforced by the backend (`RECIPE_NAME_PATTERN` in
 * `crates/speedwave-runtime/src/host_exec.rs`). The UI mirrors it for inline
 * validation; the backend re-validates.
 */
export const HOST_EXEC_RECIPE_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Parameter-name pattern (same `snake_case` rule, mirrored for inline
 * validation).
 */
export const HOST_EXEC_PARAM_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Shell / eval launchers a recipe's `exec` may not be (checked on the
 * basename, case-insensitive). Mirrors `HOST_EXEC_SHELL_LAUNCHERS` in
 * `crates/speedwave-runtime/src/consts.rs` — the backend is authoritative;
 * this list only drives the inline UI hint.
 */
export const HOST_EXEC_SHELL_LAUNCHERS: readonly string[] = [
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'eval',
  'env',
  'xargs',
  'find',
  'ssh',
  'sshpass',
];

/**
 * "Meta" interpreters/runners that may not take a *bare* `{param}` argument
 * (the whole argv element being the parameter = "run whatever Claude types").
 * A literal sub-command is fine (`make test`, `npm run build`). Mirrors
 * `HOST_EXEC_META_TOOLS` in `crates/speedwave-runtime/src/consts.rs` — the
 * backend is authoritative; this drives the inline UI hint.
 */
export const HOST_EXEC_META_TOOLS: readonly string[] = [
  'node',
  'deno',
  'python',
  'python3',
  'perl',
  'ruby',
  'make',
  'npm',
  'npx',
  'pnpm',
  'yarn',
];

/**
 * Reserved env-var names a recipe's `env` may not set (case-insensitive).
 * Mirrors `RESERVED_ENV_KEYS` in `crates/speedwave-runtime/src/consts.rs`
 * (the SSOT — keep in sync); the backend is authoritative, this only drives
 * the inline UI hint.
 */
export const HOST_EXEC_RESERVED_ENV_KEYS: readonly string[] = [
  // Reserved by Speedwave — auto-injected
  'PORT',
  // Dynamic linker hijacks (Linux)
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  // Dynamic linker hijacks (macOS)
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FORCE_FLAT_NAMESPACE',
  // Language-runtime hijacks
  'NODE_OPTIONS',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  // Shell / process environment
  'PATH',
  'HOME',
  'SHELL',
  'IFS',
  'BASH_ENV',
  'ENV',
];

/**
 * Returns the basename of a path-ish `exec` string, lowercased and with any
 * Windows `.exe`/`.bat`/`.cmd`/`.com` extension stripped — used for the
 * shell-launcher / meta-tool inline checks (the backend does the same on its
 * side).
 * @param exec - The recipe `exec` string (a path or bare command name).
 */
export function execBasenameLower(exec: string): string {
  const base = exec.split(/[/\\]/).pop() ?? exec;
  return base.toLowerCase().replace(/\.(exe|bat|cmd|com)$/, '');
}

/**
 * Extracts the `{name}` parameter references from one `args` element (returns
 * the names without braces). `'{tgt}'` → `['tgt']`; `'--out={dir}/build'` →
 * `['dir']`; a literal → `[]`.
 * @param arg - One `args` element to scan for `{name}` tokens.
 */
export function argParamRefs(arg: string): string[] {
  const refs: string[] = [];
  const re = /\{([a-z][a-z0-9_]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arg)) !== null) refs.push(m[1]);
  return refs;
}

/**
 * True if an `args` element is *exactly* a single `{param}` token (the whole
 * element, no surrounding literal text) — the "pass whatever Claude types"
 * shape that's banned for {@link HOST_EXEC_META_TOOLS} execs.
 * @param arg - One `args` element.
 */
export function isBareParamArg(arg: string): boolean {
  return /^\{[a-z][a-z0-9_]*\}$/.test(arg);
}

/**
 * Heuristic mirror of `host_exec::is_state_changing_recipe` (Rust). A recipe
 * the backend will refuse to set to `confirm: 'always'` — the UI disables the
 * `'always'` option for it (with a hint) and the backend re-enforces. Matches:
 * a DB-client `exec`; a `docker` / `docker-compose` `exec` whose `args` include
 * `up` / `down` / `exec` / `rm` / `prune`; or any `args` token that looks like
 * a migration tool (`migrat*`, `flyway`, `liquibase`).
 * @param cmd - The recipe (only `exec` / `args` are inspected).
 */
export function isStateChangingRecipe(cmd: Pick<HostExecCommand, 'exec' | 'args'>): boolean {
  const base = execBasenameLower(cmd.exec);
  const dbClients = new Set(['psql', 'mysql', 'mysqlsh', 'mongo', 'mongosh', 'sqlite3']);
  if (dbClients.has(base)) return true;
  const argsLower = cmd.args.map((a) => a.toLowerCase());
  if (base === 'docker' || base === 'docker-compose') {
    const stateful = new Set(['up', 'down', 'exec', 'rm', 'prune']);
    if (argsLower.some((a) => stateful.has(a))) return true;
  }
  if (argsLower.some((a) => /migrat|flyway|liquibase/.test(a))) return true;
  return false;
}

/**
 * Renders a recipe's `exec` + `args` the way it'll be run — for the recipe
 * list and the confirmation copy. Tokens stay as-is (`{name}`).
 * @param cmd - The recipe (only `exec` / `args` are rendered).
 */
export function renderRecipeCommand(cmd: Pick<HostExecCommand, 'exec' | 'args'>): string {
  return [cmd.exec, ...cmd.args].join(' ');
}
