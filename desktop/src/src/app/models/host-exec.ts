/**
 * Models for the `host_exec` integration (ADR-054). Mirror Rust SSOT in
 * `crates/speedwave-runtime/src/config.rs` and the worker's `types.ts`.
 * @module models/host-exec
 */

/** One named parameter a recipe accepts from Claude (ADR-054 §"Config schema"). */
export interface HostExecParam {
  /** Parameter name — `snake_case`, unique within the recipe. */
  name: string;
  /** Regex the supplied value must fully match (worker anchors as `^(?:…)$`). */
  pattern: string;
  /** Optional upper bound on the supplied value's length. */
  maxLen?: number;
}

/**
 * One whitelisted command the worker may run, in the project directory.
 * Exposed to Claude as the MCP tool `host_exec.<camelCase(name)>()`.
 */
export interface HostExecCommand {
  /** Recipe name — `^[a-z][a-z0-9_]{0,63}$`, unique across the whitelist. */
  name: string;
  /** Executable. Relative resolves against project dir or PATH (ADR-054 §"PATH"). */
  exec: string;
  /** Fixed argument list — literals plus `{name}` parameter tokens. */
  args: string[];
  /** Optional subdirectory inside the project directory to run in. */
  cwdSub?: string;
  /** Named parameters this recipe accepts from Claude. */
  params?: HostExecParam[];
  /** Literal env vars; reserved keys rejected (see `HOST_EXEC_RESERVED_ENV_KEYS`). */
  env?: Record<string, string>;
}

/** What `get_host_exec` returns for a project — mirrors Rust `HostExecStatus`. */
export interface HostExecStatus {
  /** Whether `host_exec` is enabled for this project (user config only). */
  enabled: boolean;
  /** The recipe whitelist — empty unless the user has added recipes. */
  commands: HostExecCommand[];
}

/** Recipe-name pattern; mirrors `RECIPE_NAME_PATTERN` in `host_exec.rs`. */
export const HOST_EXEC_RECIPE_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Parameter-name pattern (same `snake_case` rule). */
export const HOST_EXEC_PARAM_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Banned `exec` basenames; mirrors `HOST_EXEC_SHELL_LAUNCHERS` (backend is authoritative). */
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
  'busybox',
  'toybox',
  // Windows interpreters — each accepts an inline command / script argument.
  'powershell',
  'cmd',
  'pwsh',
  'cscript',
  'wscript',
  'mshta',
  'wsl',
];

/** Meta runners banned from a bare `{param}` argv; mirrors `HOST_EXEC_META_TOOLS`. */
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
  'awk',
  'gawk',
  'mawk',
  'nawk',
];

/** Reserved env-var names a recipe's `env` may not set; mirrors `RESERVED_ENV_KEYS` SSOT. */
export const HOST_EXEC_RESERVED_ENV_KEYS: readonly string[] = [
  // Reserved by Speedwave — auto-injected
  'PORT',
  'SPW_CREDENTIALS_DIGEST',
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
  // host_exec worker-internal env (must never reach a recipe child)
  'HOST_EXEC_AUTH_TOKEN',
  'HOST_EXEC_CONFIG_PATH',
  'HOST_EXEC_LOG_FILE',
];

/**
 * Lowercased basename of `exec`, Windows extension stripped — for launcher / meta-tool checks.
 * @param exec - The recipe `exec` string.
 */
export function execBasenameLower(exec: string): string {
  const base = exec.split(/[/\\]/).pop() ?? exec;
  return base.toLowerCase().replace(/\.(exe|bat|cmd|com)$/, '');
}

/**
 * Names referenced by `{name}` tokens in one `args` element (no braces).
 * @param arg - One `args` element to scan.
 */
export function argParamRefs(arg: string): string[] {
  const refs: string[] = [];
  const re = /\{([a-z][a-z0-9_]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arg)) !== null) refs.push(m[1]);
  return refs;
}

/**
 * True if an `args` element is exactly a single `{param}` token — banned for meta-tool execs.
 * @param arg - One `args` element.
 */
export function isBareParamArg(arg: string): boolean {
  return /^\{[a-z][a-z0-9_]*\}$/.test(arg);
}

/**
 * Heuristic: DB client, migration tool, or container-lifecycle recipe — drives amber UI warning.
 * @param cmd - The recipe.
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
 * True if `exec` is docker/podman with a lifecycle verb — mirrors Rust `is_container_lifecycle_recipe`.
 * @param cmd - The recipe.
 */
export function isContainerLifecycleRecipe(cmd: Pick<HostExecCommand, 'exec' | 'args'>): boolean {
  const base = execBasenameLower(cmd.exec);
  if (base !== 'docker' && base !== 'docker-compose' && base !== 'podman') return false;
  const lifecycle = new Set(['up', 'down', 'exec', 'rm', 'prune']);
  return cmd.args.some((a) => lifecycle.has(a.toLowerCase()));
}

/**
 * Renders `exec` + `args` for display. Tokens stay as-is (`{name}`).
 * @param cmd - The recipe.
 */
export function renderRecipeCommand(cmd: Pick<HostExecCommand, 'exec' | 'args'>): string {
  return [cmd.exec, ...cmd.args].join(' ');
}

/** Result of {@link parseArgLine}: the parsed argv list, or a human-readable error. */
export type ParsedArgLine = { args: string[] } | { error: string };

/**
 * Splits an argument line into `args[]`. Honors `"…"`/`'…'`; otherwise verbatim (no shell).
 * @param line - The raw argument line.
 * @returns `{ args }` on success, `{ error }` on unbalanced quote.
 */
export function parseArgLine(line: string): ParsedArgLine {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let started = false; // current token has any content (including empty `""`)
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
 * Renders `args[]` back to a line — inverse of {@link parseArgLine}. Whitespace tokens quoted.
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

/** Built-in recipe templates for the add/edit dialog — prefill only, never auto-whitelisted. */
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
