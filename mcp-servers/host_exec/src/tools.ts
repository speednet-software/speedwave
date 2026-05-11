/**
 * Builds the MCP tool definitions (and their handlers) from the per-project
 * recipe whitelist. One tool per recipe, named after the recipe; Claude calls
 * it as `host_exec.<camelCase(name)>()` via the hub's sandbox bridge. Each tool
 * declares only the recipe's parameters in its `inputSchema`, and a `_meta`
 * policy (`deferLoading: false` — there are few recipes and they are the point;
 * `timeoutClass: 'long'`; a `timeoutMs` covering the command timeout plus the
 * confirmation wait). The handler delegates to {@link runRecipeCall}: a
 * successful result (including `exitCode !== 0`) comes back as JSON; a tool
 * error (unknown recipe, bad parameter, `cwdSub` escape, denied/unanswerable
 * confirmation, spawn failure) comes back as an MCP error result. See ADR-054.
 * @module host_exec/tools
 */

import type { Tool, ToolDefinition, ToolHandler } from '@speedwave/mcp-shared';
import { jsonResult, errorResult } from '@speedwave/mcp-shared';
import type { ConfirmTransport } from './confirm.js';
import { runRecipeCall } from './runner.js';
import { COMMAND_TIMEOUT_MS, CONFIRM_TIMEOUT_MS } from './constants.js';
import type { HostExecRecipe } from './types.js';

/** Generous margin (ms) added on top of command + confirm for the hub's per-call budget. */
const TIMEOUT_MARGIN_MS = 30_000;

/**
 * Render a recipe's command line for the tool description so Claude can see
 * exactly what runs (`./gradlew test`, `docker compose exec -T db psql -c {sql}`).
 * @param recipe - The recipe.
 * @returns The space-joined `exec` + `args`.
 */
export function renderCommand(recipe: HostExecRecipe): string {
  return [recipe.exec, ...recipe.args].join(' ');
}

/**
 * Build the `inputSchema` for a recipe: an object whose properties are the
 * declared parameters, all required, each a string with the parameter's regex
 * recorded in `pattern` (informational for Claude — the worker enforces the
 * anchored match) and `maxLength` from `maxLen` when set.
 * @param recipe - The recipe.
 * @returns The JSON-Schema input shape.
 */
export function buildInputSchema(recipe: HostExecRecipe): Tool['inputSchema'] {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of recipe.params ?? []) {
    properties[p.name] = {
      type: 'string',
      description: `Must fully match the pattern ${p.pattern}`,
      pattern: p.pattern,
      ...(p.maxLen !== undefined ? { maxLength: p.maxLen } : {}),
    };
    required.push(p.name);
  }
  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties };
}

/**
 * Convert a `snake_case` recipe name to the `camelCase` form Claude uses in the
 * sandbox (`gradle_help` → `gradleHelp`) — matches the hub's `toCamelCase`.
 * Used only to render the `example` string; the tool's `name` stays the
 * snake_case recipe name (the hub does the camelCase mapping).
 * @param name - The recipe name.
 * @returns The camelCase form.
 */
function toCamelCase(name: string): string {
  return name.replace(/_([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * Build the `Tool` definition for one recipe.
 * @param recipe - The recipe.
 * @returns The tool definition (without a handler).
 */
export function buildToolDefinition(recipe: HostExecRecipe): Tool {
  const cmd = renderCommand(recipe);
  const cwdNote = recipe.cwdSub ? ` (in subdirectory '${recipe.cwdSub}')` : '';
  const params = recipe.params ?? [];
  const paramExample =
    params.length > 0 ? `({ ${params.map((p) => `${p.name}: "…"`).join(', ')} })` : '()';
  return {
    name: recipe.name,
    description:
      `Run \`${cmd}\` on the user's machine, in this project's directory${cwdNote}. ` +
      `Executes code from this repository (e.g. build scripts, package scripts). ` +
      `Returns the command's exit code, captured stdout/stderr (possibly truncated to the tail), ` +
      `and a status — a non-zero exit code is a normal result, not an error.`,
    keywords: ['host_exec', 'host', 'shell', 'build', 'test', 'run', recipe.name],
    example: `const r = await host_exec.${toCamelCase(recipe.name)}${paramExample}`,
    inputSchema: buildInputSchema(recipe),
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['exited', 'killed_timeout', 'spawn_error'] },
        exitCode: { type: ['integer', 'null'] },
        signal: { type: ['string', 'null'] },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        truncated: { type: 'boolean' },
        durationMs: { type: 'integer' },
        command: { type: 'string' },
        cwd: { type: 'string' },
      },
    },
    _meta: {
      // Show the recipe tools to Claude upfront — there are only a handful and
      // they are the reason host_exec exists.
      deferLoading: false,
      // Build/test runs are long; the hub's long timeout is 600s. The per-call
      // budget needs to cover the per-command timeout PLUS the confirmation
      // wait; the hub honours timeoutMs after the small executor change (ADR-054
      // §Timeout budget), otherwise this still fits under the 600s long timeout.
      timeoutClass: 'long',
      timeoutMs: COMMAND_TIMEOUT_MS + CONFIRM_TIMEOUT_MS + TIMEOUT_MARGIN_MS,
    },
  };
}

/**
 * Build a handler for one recipe. The handler reads the config snapshot afresh
 * on every call (so the recipe's current shape — or its absence — is what's
 * enforced), runs it through {@link runRecipeCall}, and maps the outcome to an
 * MCP tool result.
 * @param recipeName - The recipe name (the snapshot is the source of truth for its body).
 * @param configPath - `HOST_EXEC_CONFIG_PATH`.
 * @param transport - The confirm channel transport.
 * @returns The tool handler.
 */
export function buildToolHandler(
  recipeName: string,
  configPath: string,
  transport: ConfirmTransport
): ToolHandler {
  return async (params: Record<string, unknown>) => {
    const outcome = await runRecipeCall(configPath, recipeName, params, transport);
    if (outcome.ok) {
      return jsonResult(outcome.result);
    }
    return errorResult(outcome.message);
  };
}

/**
 * Build all tool definitions (with handlers) for the recipes in a snapshot.
 * @param recipes - The whitelist from the config snapshot.
 * @param configPath - `HOST_EXEC_CONFIG_PATH`.
 * @param transport - The confirm channel transport.
 * @returns The list of `{ tool, handler }` pairs to pass to `createMCPServer`.
 */
export function buildTools(
  recipes: HostExecRecipe[],
  configPath: string,
  transport: ConfirmTransport
): ToolDefinition[] {
  return recipes.map((recipe) => ({
    tool: buildToolDefinition(recipe),
    handler: buildToolHandler(recipe.name, configPath, transport),
  }));
}
