/**
 * Runs a single `host_exec` recipe and produces the result contract (ADR-054).
 *
 * Key properties:
 * - `spawn(exec, argv, { cwd, shell: false, detached: true, stdio: ['ignore','pipe','pipe'] })`
 *   — never a shell, never stdin (a recipe cannot prompt), its own process
 *   group so the timeout can kill the *whole tree* (`gradle`/`npm`/`docker
 *   compose` spawn daemons that outlive `child.kill()`).
 * - Per-command timeout → `process.kill(-pid, 'SIGKILL')` (Unix) /
 *   `taskkill /T /F /PID` (Windows) → `status: 'killed_timeout'`.
 * - stdout and stderr collected separately, each tail-capped, ANSI-stripped,
 *   `\r`-collapsed, lossily decoded ({@link OutputCollector}).
 * - `exitCode !== 0` is a **successful** ToolResult, not an error. The
 *   orchestration ({@link runRecipeCall}) decides what is an MCP tool *error*:
 *   unknown recipe, a parameter failing its regex, a `cwdSub` escape, a denied
 *   or unanswerable confirmation, or a `spawn_error`.
 * @module host_exec/runner
 */

import { spawn } from 'node:child_process';
import { ts } from '@speedwave/mcp-shared';
import type { ConfirmRequest, ConfirmTransport } from './confirm.js';
import { awaitConfirmation } from './confirm.js';
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

/** Random correlation id for a confirm round-trip. */
function newId(): string {
  // crypto.randomUUID is available in Node 18+; fall back defensively.
  try {
    return (globalThis.crypto as Crypto).randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Spawn one recipe and resolve to its {@link HostExecResult}. Does not throw —
 * a spawn failure becomes `status: 'spawn_error'`, a timeout becomes
 * `status: 'killed_timeout'`, anything else `status: 'exited'`.
 * @param exec - The executable (`exec` from the recipe; relative paths resolve
 *   against `cwd`/`PATH`).
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
      // No stdin: a recipe cannot prompt; this also prevents it reading the
      // worker's stdin (which carries confirm replies).
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
 * group. On Windows there are no process groups in the POSIX sense — use
 * `taskkill /T /F /PID` to kill the tree. Best-effort: if the pid is gone or
 * the kill fails, the `'close'` handler still resolves the result.
 * @param pid - The child's pid (may be `undefined` if spawn failed).
 * @param onWindows - Whether we're on Windows.
 */
export function killTree(pid: number | undefined, onWindows: boolean): void {
  if (pid === undefined) return;
  if (onWindows) {
    // `taskkill /T /F /PID` kills the process and all descendants. Attach an
    // 'error' handler so a missing/failed `taskkill` (or running this code path
    // off-Windows, e.g. in a unit test) does not surface as an unhandled error.
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    killer.on('error', (e) => {
      console.error(`${ts()} host_exec: taskkill failed for pid ${pid}: ${errMsg(e)}`);
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // negative pid → the whole process group
  } catch {
    // The group may already be gone, or `-pid` invalid if the child never
    // became a group leader; fall back to killing just the child.
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already dead */
    }
  }
}

/**
 * A successful ToolResult payload — exactly the {@link HostExecResult}. Claude
 * receives this as JSON; `exitCode !== 0` here is **not** an error.
 */
export type RecipeCallSuccess = { ok: true; result: HostExecResult };
/** An MCP tool *error* — the orchestration could not (or must not) run the recipe. */
export type RecipeCallToolError = { ok: false; message: string };
/** The outcome of {@link runRecipeCall}. */
export type RecipeCallOutcome = RecipeCallSuccess | RecipeCallToolError;

/**
 * Orchestrate one tool call: re-read the config snapshot (so a removed/disabled
 * recipe fails closed even before the hub re-discovers), find the recipe,
 * validate the supplied parameters, resolve the working directory, ask for
 * confirmation, run the recipe, audit, and return either a successful result or
 * a tool error. Does not throw.
 * @param configPath - `HOST_EXEC_CONFIG_PATH`.
 * @param recipeName - The recipe Claude called.
 * @param suppliedParams - The arguments object from the `tools/call` request.
 * @param transport - The confirm channel transport.
 * @param confirmTimeoutMs - Optional confirm-guard-timeout override.
 * @param commandTimeoutMs - Optional per-command timeout override.
 * @returns The outcome.
 */
export async function runRecipeCall(
  configPath: string,
  recipeName: string,
  suppliedParams: Record<string, unknown>,
  transport: ConfirmTransport,
  confirmTimeoutMs?: number,
  commandTimeoutMs?: number
): Promise<RecipeCallOutcome> {
  let recipe: HostExecRecipe | undefined;
  let argv: string[] = [];
  let decision: string = 'n/a';
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

    // Confirmation — fail closed on deny or no answer.
    const req: ConfirmRequest = {
      type: 'confirm',
      id: newId(),
      recipe: recipe.name,
      argv,
      cwd: label,
    };
    const { allowed, timedOut } = await awaitConfirmation(transport, req, confirmTimeoutMs);
    decision = timedOut ? 'timeout' : allowed ? 'allow' : 'deny';
    if (timedOut) {
      await auditRecipeCall(recipe, argv, 'timeout', undefined);
      return { ok: false, message: `confirmation unavailable for recipe '${recipe.name}'` };
    }
    if (!allowed) {
      await auditRecipeCall(recipe, argv, 'deny', undefined);
      return { ok: false, message: `recipe '${recipe.name}' was denied by the user` };
    }

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
    await auditRecipeCall(recipe, argv, decision, result);
    return { ok: true, result };
  } catch (e) {
    // HostExecToolError → a clean tool error; anything else → also a tool
    // error (the worker should never crash a request), with the message.
    const message =
      e instanceof HostExecToolError ? e.message : `host_exec internal error: ${errMsg(e)}`;
    if (recipe) {
      // best-effort audit of the failed attempt — `auditRecipeCall` already
      // swallows its own write errors, so the extra `.catch` is double-defensive.
      /* c8 ignore next — auditRecipeCall never rejects (it logs and returns), so
         this rejection handler is unreachable. */
      await auditRecipeCall(recipe, argv.length ? argv : [recipe.exec], decision, undefined).catch(
        () => {}
      );
    }
    return { ok: false, message };
  }
}
