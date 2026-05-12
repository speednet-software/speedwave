/**
 * Models for the `host_exec` integration — the per-project host-side worker
 * that runs a user-whitelisted set of project-toolchain commands (build / test
 * / lint, `docker compose`, …) on the host machine, in the project directory,
 * behind the per-project MCP hub (ADR-054, SPW-83).
 *
 * `host_exec` is a deliberate, scoped weakening of Speedwave's container
 * isolation: it is opt-in per project, the whitelist starts empty, the config
 * lives only in `~/.speedwave/config.json` (never the repo `.speedwave.json`),
 * and enabling it pops a blocking danger modal explaining the consequences —
 * which **is the consent**: once enabled, Claude runs any whitelisted recipe
 * without further prompting (there is no per-call confirmation); the audit log
 * is the after-the-fact record. See `docs/architecture/security.md`.
 *
 * The shapes here mirror the Rust SSOT in `crates/speedwave-runtime/src/config.rs`
 * (`HostExecRecipe` / `HostExecParam`, both `#[serde(rename_all = "camelCase")]`)
 * and the TypeScript worker's `HostExecRecipe` (`mcp-servers/host_exec/src/types.ts`)
 * — keep them in sync with both. The Tauri commands they back are
 * `get_host_exec`, `set_host_exec_enabled`, `host_exec_save_settings`,
 * `host_exec_load_settings`, and `host_exec_resolve_executable`
 * (`desktop/src-tauri/src/host_exec_cmd.rs`).
 * @module models/host-exec
 */

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
 * Heuristic — a recipe whose `exec` is a DB client or whose `args` look like a
 * migration tool (`migrat*`, `flyway`, `liquibase`), or a container-lifecycle
 * recipe (see {@link isContainerLifecycleRecipe}). Drives an amber inline
 * warning when adding/editing such a recipe ("changes state — only whitelist it
 * if you trust this repo"); not blocking — enabling host_exec is the consent.
 * @param cmd - The recipe (only `exec` / `args` are inspected).
 */
export function isStateChangingRecipe(cmd: Pick<HostExecCommand, 'exec' | 'args'>): boolean {
  const base = execBasenameLower(cmd.exec);
  const dbClients = new Set(['psql', 'mysql', 'mysqlsh', 'mongo', 'mongosh', 'sqlite3']);
  if (dbClients.has(base)) return true;
  if (isContainerLifecycleRecipe(cmd)) return true;
  const argsLower = cmd.args.map((a) => a.toLowerCase());
  if (argsLower.some((a) => /migrat|flyway|liquibase/.test(a))) return true;
  return false;
}

/**
 * Mirror of `host_exec::is_container_lifecycle_recipe` (Rust). True if `exec`
 * is `docker` / `docker-compose` / `podman` and `args` contains a lifecycle
 * verb (`up` / `down` / `exec` / `rm` / `prune`). Such a recipe is effectively
 * `docker run` with arbitrary mounts/privileges from a compose file Claude can
 * edit (`/workspace:rw`) — i.e. host root. The add/edit dialog shows an amber
 * warning when it matches (not blocking — enabling host_exec is the consent).
 * @param cmd - The recipe (only `exec` / `args` are inspected).
 */
export function isContainerLifecycleRecipe(cmd: Pick<HostExecCommand, 'exec' | 'args'>): boolean {
  const base = execBasenameLower(cmd.exec);
  if (base !== 'docker' && base !== 'docker-compose' && base !== 'podman') return false;
  const lifecycle = new Set(['up', 'down', 'exec', 'rm', 'prune']);
  return cmd.args.some((a) => lifecycle.has(a.toLowerCase()));
}

/**
 * Renders a recipe's `exec` + `args` the way it'll be run — for the recipe
 * list and the warning copy. Tokens stay as-is (`{name}`).
 * @param cmd - The recipe (only `exec` / `args` are rendered).
 */
export function renderRecipeCommand(cmd: Pick<HostExecCommand, 'exec' | 'args'>): string {
  return [cmd.exec, ...cmd.args].join(' ');
}

/** Result of {@link parseArgLine}: the parsed argv list, or a human-readable error. */
export type ParsedArgLine = { args: string[] } | { error: string };

/**
 * Split a command-line-style argument string into an `args[]` list — splits on
 * runs of whitespace, with `"double"` and `'single'` quotes grouping a token
 * that contains spaces. **This is not a shell**: `$VAR`, `&&`, `|`, `;` and
 * globs are kept verbatim (they become literal characters inside an argv
 * element — `spawn` with `shell:false` never re-parses them). Used so the UI
 * can offer a single "type it as on a command line" field instead of one input
 * per argument; the resulting `args[]` is exactly what the worker receives.
 * @param line - The raw argument line (no `exec` — just the args after it).
 * @returns `{ args }` on success, `{ error }` on an unbalanced quote.
 */
export function parseArgLine(line: string): ParsedArgLine {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let started = false; // whether the current token has any content (even empty `""`)
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      started = true;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else cur += ch;
      started = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      started = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        out.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (inSingle || inDouble) return { error: 'Unbalanced quote in the argument line.' };
  if (started) out.push(cur);
  return { args: out };
}

/**
 * Inverse of {@link parseArgLine} — render an `args[]` back into a single line
 * (so the UI can load an existing recipe into the command-line field). Any
 * token containing whitespace is wrapped in double quotes; an empty token
 * becomes `""`. Round-trips with `parseArgLine` for the cases the field
 * produces (it does not attempt to escape quotes-within-tokens — those don't
 * occur in practice and `parseArgLine` wouldn't survive them either).
 * @param args - The argument list.
 * @returns A command-line string.
 */
export function joinArgLine(args: readonly string[]): string {
  return args.map((a) => (a === '' || /\s/.test(a) ? `"${a}"` : a)).join(' ');
}

/** A starter template for the "Add command" dialog — prefills name/exec/args/params. */
export interface HostExecPreset {
  /** Stable key used as the `<option value>`. */
  key: string;
  /** Human label shown in the dropdown. */
  label: string;
  /** Suggested recipe name (snake_case). */
  name: string;
  /** Suggested executable. */
  exec: string;
  /** Suggested argument line (parsed via {@link parseArgLine} into `args[]`). */
  argLine: string;
  /** Suggested parameters (usually empty; named-test presets ship one). */
  params: HostExecParam[];
  /** A short note replacing the executable hint while this preset is selected. */
  execHint: string;
}

/**
 * Built-in recipe templates surfaced in the add/edit dialog. They mirror the
 * stacks the team reported (Gradle, npm/yarn, Maven, Docker, repo shell
 * scripts — see the SPW-83 discovery thread). Each one only *prefills* the
 * fields — the user edits everything; nothing is whitelisted automatically.
 */
export const HOST_EXEC_PRESETS: readonly HostExecPreset[] = [
  {
    key: 'gradle-test',
    label: 'Gradle · run tests  (./gradlew test)',
    name: 'gradle_test',
    exec: './gradlew',
    argLine: 'test',
    params: [],
    execHint: 'A wrapper script in the project — runs against the project directory.',
  },
  {
    key: 'gradle-test-named',
    label: 'Gradle · run a named test',
    name: 'gradle_test_named',
    exec: './gradlew',
    argLine: 'test --tests {test_class}',
    params: [{ name: 'test_class', pattern: '^[A-Za-z][A-Za-z0-9_.$]*$', maxLen: 200 }],
    execHint: 'A wrapper script in the project — runs against the project directory.',
  },
  {
    key: 'npm-script',
    label: 'npm / yarn · run a package script',
    name: 'npm_build',
    exec: './node_modules/.bin/yarn',
    argLine: 'build',
    params: [],
    execHint: 'The project-local yarn binary — keeps Host Exec off the meta-runner ban list.',
  },
  {
    key: 'mvn-goal',
    label: 'Maven · run a goal  (mvn verify)',
    name: 'mvn_verify',
    exec: 'mvn',
    argLine: 'verify',
    params: [],
    execHint: 'Resolved on the recovered host PATH (or pick an absolute path).',
  },
  {
    key: 'docker-ps',
    label: 'Docker · list running containers',
    name: 'docker_ps',
    exec: 'docker',
    argLine: 'ps',
    params: [],
    execHint: 'Resolved on the recovered host PATH (or pick an absolute path).',
  },
  {
    key: 'docker-ps-all',
    label: 'Docker · list all containers (-a)',
    name: 'docker_ps_all',
    exec: 'docker',
    argLine: 'ps -a',
    params: [],
    execHint: 'Resolved on the recovered host PATH (or pick an absolute path).',
  },
  {
    key: 'docker-compose-up',
    label: 'Docker compose · up -d  (⚠ lifecycle)',
    name: 'compose_up',
    exec: 'docker',
    argLine: 'compose up -d',
    params: [],
    execHint:
      'Resolved on the recovered host PATH. This is a container-lifecycle recipe — see the warning below.',
  },
  {
    key: 'shell-script',
    label: 'Shell script in the repo  (./scripts/…)',
    name: 'run_script',
    exec: './scripts/migrate.sh',
    argLine: '',
    params: [],
    execHint:
      'A script in the repo — Host Exec runs it directly (no shell launcher); the script itself does the work.',
  },
];
