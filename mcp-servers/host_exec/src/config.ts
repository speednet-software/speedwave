/**
 * Reads and uses the per-project config snapshot the Tauri side writes to
 * `HOST_EXEC_CONFIG_PATH`. The snapshot is re-read on every tool call (so a
 * removed/disabled recipe fails closed even before the hub re-discovers); the
 * structural validation already happened Rust-side (`validate_host_exec_config`),
 * so here we only do what needs the project directory: compile + full-match
 * recipe parameter regexes, and canonicalise `cwdSub` to confirm it stays under
 * the project root with no symlink escape (the algorithm
 * `compose.rs::ensure_resources_dir_safe` uses, re-implemented in TS).
 * @module host_exec/config
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { HostExecConfigSnapshot, HostExecRecipe } from './types.js';
import { PARAM_MAX_LEN } from './constants.js';

/** Raised when a tool call must be answered with an MCP tool *error* (not a result). */
export class HostExecToolError extends Error {}

/**
 * Read and minimally parse the config snapshot. Throws (a plain `Error`, fatal)
 * if the file is missing or malformed — the worker cannot run without it.
 * @param configPath - Path from `HOST_EXEC_CONFIG_PATH`.
 * @returns The parsed snapshot.
 */
export async function readConfigSnapshot(configPath: string): Promise<HostExecConfigSnapshot> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf-8');
  } catch (e) {
    throw new Error(`host_exec: cannot read config snapshot at ${configPath}: ${errMsg(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`host_exec: config snapshot at ${configPath} is not valid JSON: ${errMsg(e)}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { projectDir?: unknown }).projectDir !== 'string' ||
    !Array.isArray((parsed as { commands?: unknown }).commands)
  ) {
    throw new Error(
      `host_exec: config snapshot at ${configPath} has the wrong shape (expected { projectDir: string, commands: [] })`
    );
  }
  return parsed as HostExecConfigSnapshot;
}

/**
 * Find a recipe by name in a snapshot.
 * @param snapshot - The config snapshot.
 * @param name - The recipe name (as Claude called it, e.g. via `host_exec.<name>()`).
 * @returns The recipe, or `undefined` if no such recipe is whitelisted.
 */
export function findRecipe(
  snapshot: HostExecConfigSnapshot,
  name: string
): HostExecRecipe | undefined {
  return snapshot.commands.find((r) => r.name === name);
}

/**
 * Validate the parameters Claude supplied against a recipe's declared `params`:
 * each declared parameter must be present, its value must be a string within
 * `maxLen` (or `PARAM_MAX_LEN`), and must *fully* match the parameter's regex
 * (anchored as `^(?:…)$`). A pattern that fails to compile is treated as a tool
 * error (the Rust side bounds the pattern string but does not compile it — see
 * `host_exec.rs` — so a bad regex surfaces here). Returns the validated values
 * keyed by name.
 * @param recipe - The recipe.
 * @param supplied - The arguments object from the MCP `tools/call` request.
 * @throws {HostExecToolError} If a parameter is missing, the wrong type, too long, or fails its regex.
 * @returns Map of parameter name to validated string value.
 */
export function validateSuppliedParams(
  recipe: HostExecRecipe,
  supplied: Record<string, unknown>
): Map<string, string> {
  const out = new Map<string, string>();
  const declared = recipe.params ?? [];
  // Reject unexpected keys — Claude must supply exactly the declared parameters.
  for (const key of Object.keys(supplied)) {
    if (!declared.some((p) => p.name === key)) {
      throw new HostExecToolError(
        `recipe '${recipe.name}' does not accept a parameter named '${key}'`
      );
    }
  }
  for (const p of declared) {
    const v = supplied[p.name];
    if (typeof v !== 'string') {
      throw new HostExecToolError(
        `recipe '${recipe.name}': parameter '${p.name}' is required and must be a string`
      );
    }
    const cap = p.maxLen ?? PARAM_MAX_LEN;
    if (v.length > cap) {
      throw new HostExecToolError(
        `recipe '${recipe.name}': parameter '${p.name}' is too long (${v.length} chars, max ${cap})`
      );
    }
    let re: RegExp;
    try {
      re = new RegExp(`^(?:${p.pattern})$`);
    } catch (e) {
      throw new HostExecToolError(
        `recipe '${recipe.name}': parameter '${p.name}' has an invalid regex pattern: ${errMsg(e)}`
      );
    }
    if (!re.test(v)) {
      throw new HostExecToolError(
        `recipe '${recipe.name}': parameter '${p.name}' value does not match the required pattern`
      );
    }
    out.set(p.name, v);
  }
  return out;
}

/**
 * Build the argv for a recipe: each `args` element is either a literal or
 * contains `{name}` tokens that get replaced by the validated parameter values.
 * A substituted element stays a *single* argv element — it is never re-split, so
 * `psql -c {sql}` produces `["…","psql","-c","<value>"]`, not a value split on
 * spaces. Unknown `{token}`s are left as literals (the Rust validator already
 * rejected any `{token}` without a matching `params` entry, so this only
 * matters for `{}`-shaped literals).
 * @param recipe - The recipe.
 * @param params - The validated parameter values from {@link validateSuppliedParams}.
 * @returns The argv array.
 */
export function buildArgv(recipe: HostExecRecipe, params: Map<string, string>): string[] {
  return recipe.args.map((arg) =>
    arg.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, name: string) => {
      const v = params.get(name);
      return v === undefined ? whole : v;
    })
  );
}

/**
 * Resolve and validate the working directory for a recipe. With no `cwdSub` it
 * is the project directory itself. With a `cwdSub` it is `projectDir/cwdSub`,
 * but the *real* (symlink-resolved) path must stay strictly under the *real*
 * project directory and must not be reached via a symlink — the same
 * canonicalise-then-`startsWith` + reject-symlink check the runtime uses for
 * plugin resource dirs. The directory must already exist.
 * @param projectDir - The project directory (from the snapshot).
 * @param recipe - The recipe (whose `cwdSub` is optional and already
 *   structurally validated Rust-side: relative, no `..`, no absolute).
 * @throws {HostExecToolError} If the directory does not exist, is not a
 *   directory, escapes the project root, or is reached via a symlink.
 * @returns `{ cwd, label }` — the absolute working directory and the label for
 *   the result (`'.'` or the `cwdSub`).
 */
export async function resolveCwd(
  projectDir: string,
  recipe: HostExecRecipe
): Promise<{ cwd: string; label: string }> {
  const realProject = await realDir(projectDir, `project directory ${projectDir}`);
  if (!recipe.cwdSub) {
    return { cwd: realProject, label: '.' };
  }
  // Defensive: the Rust validator rejects absolute/`..` cwdSub, but re-check.
  if (path.isAbsolute(recipe.cwdSub) || recipe.cwdSub.split(/[/\\]/).includes('..')) {
    throw new HostExecToolError(
      `recipe '${recipe.name}': cwdSub '${recipe.cwdSub}' must be a relative path with no '..'`
    );
  }
  const joined = path.join(realProject, recipe.cwdSub);
  const realJoined = await realDir(
    joined,
    `recipe '${recipe.name}' working directory ${recipe.cwdSub}`
  );
  // Must be the project dir or strictly inside it. `realProject` and
  // `realJoined` are both canonicalised, so a prefix check with a path
  // separator is sufficient (no `/a/bcd` matching `/a/b` false positive).
  const withSep = realProject.endsWith(path.sep) ? realProject : realProject + path.sep;
  if (realJoined !== realProject && !realJoined.startsWith(withSep)) {
    throw new HostExecToolError(
      `recipe '${recipe.name}': cwdSub '${recipe.cwdSub}' resolves outside the project directory`
    );
  }
  // Reject if the *given* path traverses a symlink, even if the realpath is
  // still inside (the signing/isolation model has no notion of legitimate
  // symlinks here — mirrors compose.rs::ensure_resources_dir_safe).
  await rejectSymlinkOnPath(realProject, recipe.cwdSub, recipe.name);
  return { cwd: realJoined, label: recipe.cwdSub };
}

/**
 * `fs.realpath` a path and assert it is a directory; map errors to a tool error.
 * @param p - The path to resolve.
 * @param desc - A human description for the error message.
 * @throws {HostExecToolError} If the path does not exist or is not a directory.
 * @returns The canonicalised absolute path.
 */
async function realDir(p: string, desc: string): Promise<string> {
  let real: string;
  try {
    real = await fs.realpath(p);
  } catch (e) {
    throw new HostExecToolError(`${desc} does not exist or is not accessible: ${errMsg(e)}`);
  }
  const st = await fs.stat(real);
  if (!st.isDirectory()) {
    throw new HostExecToolError(`${desc} is not a directory`);
  }
  return real;
}

/**
 * Walk each component of `sub` under `base` and reject if any component
 * (including intermediate directories) is a symlink. `base` is already a
 * canonicalised real directory.
 * @param base - The canonical project directory.
 * @param sub - The relative `cwdSub` (no `..`, no absolute — caller-checked).
 * @param recipeName - For the error message.
 * @throws {HostExecToolError} If a symlink is encountered on the path.
 */
async function rejectSymlinkOnPath(base: string, sub: string, recipeName: string): Promise<void> {
  let cur = base;
  for (const segment of sub.split(/[/\\]/)) {
    if (segment === '' || segment === '.') continue;
    cur = path.join(cur, segment);
    let lst;
    try {
      lst = await fs.lstat(cur);
    } catch (e) {
      /* c8 ignore next 3 — defensive TOCTOU guard: `resolveCwd` already
         `realpath`'d `projectDir/cwdSub` successfully a few lines earlier, so
         every component exists when we re-walk it here; the lstat only fails if
         a component is removed in the gap between the two calls. */
      throw new HostExecToolError(
        `recipe '${recipeName}': cwdSub component '${segment}' is not accessible: ${errMsg(e)}`
      );
    }
    if (lst.isSymbolicLink()) {
      throw new HostExecToolError(
        `recipe '${recipeName}': cwdSub must not traverse a symlink (at '${segment}')`
      );
    }
  }
}

/**
 * Extract a message from an unknown thrown value.
 * @param e - The thrown value.
 * @returns A string message.
 */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
