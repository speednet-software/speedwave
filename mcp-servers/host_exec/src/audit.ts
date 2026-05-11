/**
 * Per-project audit log for `host_exec` (ADR-054). Every recipe invocation is
 * appended to `HOST_EXEC_LOG_FILE` (a path the Tauri side sets, under
 * `<data_dir>/host-exec/<project>/log`) with the recipe name, the **full
 * resolved argv**, the working directory, exit code/status/duration, and the
 * confirmation decision — but with the recipe's `env` *values* redacted (keys
 * only). The ToolResult Claude sees carries only the recipe name; the full argv
 * stays here so an operator can audit after an incident. The Tauri side surfaces
 * this file in the diagnostics / system-health views.
 *
 * If the log file path is not set or the append fails, the worker logs the
 * failure to stderr and carries on — auditing is best-effort and must not block
 * a recipe.
 * @module host_exec/audit
 */

import { appendFile } from 'node:fs/promises';
import { ts } from '@speedwave/mcp-shared';
import type { HostExecRecipe, HostExecResult } from './types.js';

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
    await appendFile(logPath, line, 'utf-8');
  } catch (e) {
    console.error(
      `${ts()} host_exec: failed to append to audit log ${logPath}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
