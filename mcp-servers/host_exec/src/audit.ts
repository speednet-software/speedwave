/**
 * Per-project audit log for `host_exec` (ADR-054). Each recipe invocation is
 * appended to `HOST_EXEC_LOG_FILE` (`<data_dir>/host-exec/<project>/log` — the
 * Tauri side pre-creates it `0600`; we re-assert `mode` here in case it
 * doesn't exist) with the recipe name, the **full resolved argv**, the cwd,
 * exit/status/duration, and the confirmation decision. Recipe `env` *values*
 * are redacted (keys only) — but the argv is logged verbatim, so a recipe
 * that substitutes a `{param}` token records whatever value Claude supplied
 * (which may be sensitive). Best-effort: a missing path or failed append goes
 * to stderr and execution continues.
 * @module host_exec/audit
 */

import { appendFile, stat, readFile, writeFile } from 'node:fs/promises';
import { ts } from '@speedwave/mcp-shared';
import { LOG_MAX_BYTES } from './constants.js';
import type { HostExecRecipe, HostExecResult } from './types.js';

/**
 * If the log exceeds {@link LOG_MAX_BYTES}, rewrite it keeping the last ~half
 * (line-aligned) — so a long-lived worker doesn't grow the log unbounded
 * between respawns. Best-effort; any error is ignored (the append still runs).
 * @param logPath - Path to the audit log file.
 */
async function truncateLogIfOversized(logPath: string): Promise<void> {
  try {
    const size = (await stat(logPath)).size;
    if (size <= LOG_MAX_BYTES) return;
    const content = await readFile(logPath, 'utf-8');
    const keepFrom = Math.floor(content.length / 2);
    const nl = content.indexOf('\n', keepFrom);
    const tail = nl >= 0 ? content.slice(nl + 1) : content.slice(keepFrom);
    await writeFile(logPath, tail, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

/**
 * Append one audit-log line for a completed (or failed-to-start) recipe call.
 * @param recipe - The recipe that was invoked.
 * @param argv - The full resolved argv (`exec` first, then args with parameters substituted).
 * @param decision - The confirmation decision (`allow` / `allow-session` / `deny`),
 *   or `'auto'` when the Tauri side auto-allowed (always / warm cache), or
 *   `'n/a'` when no confirmation was reached (e.g. tool error before that).
 * @param result - The execution result, or `undefined` if execution did not happen.
 */
export async function auditRecipeCall(
  recipe: HostExecRecipe,
  argv: string[],
  decision: string,
  result: HostExecResult | undefined
): Promise<void> {
  const logPath = process.env.HOST_EXEC_LOG_FILE;
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      recipe: recipe.name,
      argv,
      cwd: result?.cwd ?? recipe.cwdSub ?? '.',
      envKeys: recipe.env ? Object.keys(recipe.env).sort() : [],
      confirm: decision,
      status: result?.status ?? 'not_executed',
      exitCode: result?.exitCode ?? null,
      signal: result?.signal ?? null,
      durationMs: result?.durationMs ?? null,
      truncated: result?.truncated ?? null,
    }) + '\n';
  if (!logPath) {
    // No audit file configured (shouldn't happen in production) — at least
    // leave a breadcrumb on stderr.
    console.error(`${ts()} host_exec audit (no HOST_EXEC_LOG_FILE): ${line.trim()}`);
    return;
  }
  try {
    await truncateLogIfOversized(logPath);
    // `mode` only applies if the file is being created — the Tauri side
    // normally pre-creates it 0600, but if it didn't, don't create it 0644.
    await appendFile(logPath, line, { encoding: 'utf-8', mode: 0o600 });
  } catch (e) {
    console.error(
      `${ts()} host_exec: failed to append to audit log ${logPath}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
