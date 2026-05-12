/**
 * Runs a single `host_exec` recipe (`spawn`, no shell, no stdin, own process
 * group, per-command timeout then group `SIGKILL`) and produces the result
 * contract (ADR-054). `exitCode !== 0` is a successful ToolResult — tool
 * errors are: unknown recipe, a parameter failing its regex, a `cwdSub`
 * escape, a `spawn_error`. No per-call confirmation (enabling host_exec is the
 * consent; the audit log is the after-the-fact record).
 * @module host_exec/runner
 */

import { spawn } from 'node:child_process';
import { ts } from '@speedwave/mcp-shared';
import {
  buildArgv,
  errMsg,
  findRecipe,
  HostExecToolError,
  readConfigSnapshot,
  resolveCwd,
  validateSuppliedParams,
} from './config.js';
import { COMMAND_TIMEOUT_MS } from './constants.js';
import { buildRecipeEnv } from './env.js';
import { OutputCollector } from './output.js';
import { auditRecipeCall } from './audit.js';
import type { HostExecRecipe, HostExecResult } from './types.js';

/**
 * Spawn one recipe and resolve to its {@link HostExecResult}. Does not throw —
 * a spawn failure becomes `status: 'spawn_error'`, a timeout
 * `status: 'killed_timeout'`, anything else `status: 'exited'`.
 * @param exec - The executable (`exec` from the recipe; relative paths resolve against `cwd`/`PATH`).
 * @param argv - The arguments (already substituted).
 * @param cwd - The absolute working directory.
 * @param recipeName - For the result's `command` field.
 * @param cwdLabel - For the result's `cwd` field (`'.'` or the `cwdSub`).
 * @param env - The child environment ({@link buildRecipeEnv}).
 * @param timeoutMs - Per-command timeout (default {@link COMMAND_TIMEOUT_MS}).
 * @returns The result.
 */
export function spawnRecipe(
  exec: string,
  argv: string[],
  cwd: string,
  recipeName: string,
  cwdLabel: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number = COMMAND_TIMEOUT_MS
): Promise<HostExecResult> {
  return new Promise<HostExecResult>((resolve) => {
    const started = Date.now();
    const onWindows = process.platform === 'win32';
    const stdoutCol = new OutputCollector();
    const stderrCol = new OutputCollector();
    let settled = false;
    let timedOut = false;

    const child = spawn(exec, argv, {
      cwd,
      env,
      // No shell — argv is passed verbatim, never re-parsed.
      shell: false,
      // No stdin: a recipe cannot prompt.
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group / job so the timeout can kill the whole tree.
      detached: !onWindows,
      windowsHide: true,
    });

    const finish = (
      status: HostExecResult['status'],
      exitCode: number | null,
      signal: string | null
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = stdoutCol.render();
      const err = stderrCol.render();
      resolve({
        status,
        exitCode,
        signal,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        durationMs: Date.now() - started,
        command: recipeName,
        cwd: cwdLabel,
      });
    };

    child.on('error', (e: NodeJS.ErrnoException) => {
      // ENOENT / EACCES etc. — could not start. Report as spawn_error with the
      // OS message on stderr (Claude needs to know "docker: not found").
      stderrCol.push(Buffer.from(`spawn error: ${errMsg(e)}\n`, 'utf-8'));
      finish('spawn_error', null, null);
    });
    child.stdout?.on('data', (d: Buffer) => stdoutCol.push(d));
    child.stderr?.on('data', (d: Buffer) => stderrCol.push(d));
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish('killed_timeout', null, signal ?? 'SIGKILL');
      } else {
        finish('exited', code, signal);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, onWindows);
    }, timeoutMs);
  });
}

/**
 * Kill a child and its descendants. On Unix the child was spawned `detached`,
 * so it leads its own process group; killing the negative pid `SIGKILL`s the
 * group. On Windows use `taskkill /T /F /PID`. Best-effort.
 * @param pid - The child's pid (`undefined` if spawn failed).
 * @param onWindows - Whether we're on Windows.
 */
export function killTree(pid: number | undefined, onWindows: boolean): void {
  if (pid === undefined) return;
  if (onWindows) {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    killer.on('error', (e) => {
      console.error(`${ts()} host_exec: taskkill failed for pid ${pid}: ${errMsg(e)}`);
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // negative pid → the whole process group
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already dead */
    }
  }
}

/** A successful ToolResult payload — exactly the {@link HostExecResult}. */
export type RecipeCallSuccess = { ok: true; result: HostExecResult };
/** An MCP tool *error* — the orchestration could not (or must not) run the recipe. */
export type RecipeCallToolError = { ok: false; message: string };
/** The outcome of {@link runRecipeCall}. */
export type RecipeCallOutcome = RecipeCallSuccess | RecipeCallToolError;

/**
 * Orchestrate one tool call: re-read the config snapshot (so a removed/disabled
 * recipe fails closed even before the hub re-discovers), find the recipe,
 * validate the supplied parameters, resolve the working directory, run the
 * recipe, audit, and return either a successful result or a tool error. Does
 * not throw.
 * @param configPath - `HOST_EXEC_CONFIG_PATH`.
 * @param recipeName - The recipe Claude called.
 * @param suppliedParams - The arguments object from the `tools/call` request.
 * @param commandTimeoutMs - Optional per-command timeout override.
 * @returns The outcome.
 */
export async function runRecipeCall(
  configPath: string,
  recipeName: string,
  suppliedParams: Record<string, unknown>,
  commandTimeoutMs?: number
): Promise<RecipeCallOutcome> {
  let recipe: HostExecRecipe | undefined;
  let argv: string[] = [];
  try {
    const snapshot = await readConfigSnapshot(configPath);
    recipe = findRecipe(snapshot, recipeName);
    if (!recipe) {
      // Unknown / removed / disabled recipe — fail closed.
      return {
        ok: false,
        message: `no host_exec recipe named '${recipeName}' is whitelisted for this project`,
      };
    }
    const params = validateSuppliedParams(recipe, suppliedParams);
    const argTail = buildArgv(recipe, params);
    argv = [recipe.exec, ...argTail];
    const { cwd, label } = await resolveCwd(snapshot.projectDir, recipe);

    const env = buildRecipeEnv(recipe.env);
    const result = await spawnRecipe(
      recipe.exec,
      argTail,
      cwd,
      recipe.name,
      label,
      env,
      commandTimeoutMs
    );
    await auditRecipeCall(recipe, argv, result);
    return { ok: true, result };
  } catch (e) {
    const message =
      e instanceof HostExecToolError ? e.message : `host_exec internal error: ${errMsg(e)}`;
    if (recipe) {
      /* c8 ignore next — auditRecipeCall never rejects (it logs and returns). */
      await auditRecipeCall(recipe, argv.length ? argv : [recipe.exec], undefined).catch(() => {});
    }
    return { ok: false, message };
  }
}
