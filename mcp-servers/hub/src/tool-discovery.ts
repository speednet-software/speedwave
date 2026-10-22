/**
 * Tool Discovery: fetches tool definitions from workers via JSON-RPC `tools/list`, merging worker
 * data with `_meta`. Workers are the SSOT for both contract and policy fields.
 */

import { randomUUID } from 'crypto';
import type { Tool } from '@speedwave/mcp-shared';
import { TIMEOUTS, LATEST_PROTOCOL_VERSION, ts, META_KEYS, metaValue } from '@speedwave/mcp-shared';
import type { ToolMetadata, ToolState } from './hub-types.js';
import { getAuthToken } from './auth-tokens.js';
import { validateWorkerUrl } from '@speedwave/mcp-shared';
import { parseResponse, buildWorkerHeaders } from './http-bridge.js';
import { deriveWorkerEnv } from './worker-env.js';
import { writeToolCatalog } from './tool-catalog.js';
import { CUSTOM_SERVICE_PREFIX } from './service-list.js';

const TOOL_STATES: ReadonlySet<string> = new Set(['allowed', 'pending', 'blocked', 'changed']);

/**
 * Read the gate-assigned tool state; absent or unknown is `pending` (hidden) for a `custom-*` service and `allowed` for built-in and plugin workers, which have no gate.
 * @param raw - Raw `speedwave.pl/tool-state` value.
 * @param service - Service name.
 * @param label - `service.method` for the warning.
 */
function parseToolState(raw: unknown, service: string, label: string): ToolState {
  if (typeof raw === 'string' && TOOL_STATES.has(raw)) return raw as ToolState;
  const fallback: ToolState = service.startsWith(CUSTOM_SERVICE_PREFIX) ? 'pending' : 'allowed';
  if (raw !== undefined) {
    console.warn(`${ts()} [tool-discovery] ${label}: unknown tool-state — treating as ${fallback}`);
  }
  return fallback;
}

/**
 * Convert snake_case tool name to camelCase (workers use snake_case, hub uses camelCase).
 * @param str - snake_case string to convert
 */
export function toCamelCase(str: string): string {
  return str.replace(/_([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Perform MCP initialize handshake with a worker: `initialize` request then
 * `notifications/initialized`. Returns the Mcp-Session-Id if the worker set one.
 * @param workerUrl - Worker base URL
 * @param headers - Request headers (Content-Type, Accept, auth, etc.)
 * @returns Session ID from the worker, or undefined
 */
export async function initializeWorker(
  workerUrl: string,
  headers: Record<string, string>
): Promise<string | undefined> {
  const response = await fetch(workerUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'speedwave-hub', version: '1.0.0' },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUTS.TOOL_DISCOVERY_MS),
    redirect: 'error',
  });

  if (!response.ok) {
    throw new Error(`Worker initialize returned ${response.status}`);
  }
  const initResult = await parseResponse(response);
  if (initResult.error) {
    throw new Error(
      `Worker initialize failed: [${initResult.error.code}] ${initResult.error.message}`
    );
  }
  const sessionId = response.headers.get('Mcp-Session-Id') ?? undefined;

  const notifResponse = await fetch(workerUrl, {
    method: 'POST',
    headers: { ...headers, ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(TIMEOUTS.TOOL_DISCOVERY_MS),
    redirect: 'error',
  });

  if (!notifResponse.ok) {
    const body = (await notifResponse.text().catch(() => '')).slice(0, 512);
    console.error(
      `${ts()} [tool-discovery] notifications/initialized returned ${notifResponse.status} for ${workerUrl}${body ? `: ${body}` : ''}`
    );
  }

  return sessionId;
}

/** Maximum number of pagination pages to fetch before breaking to prevent infinite loops. */
export const MAX_PAGINATION_PAGES = 50;

/**
 * Fetch all tools from a worker with cursor-based pagination, iterating `tools/list` until
 * `nextCursor` is empty or MAX_PAGINATION_PAGES is reached.
 * @param workerUrl - Worker base URL
 * @param headers - Request headers (Content-Type, Accept, auth, session, etc.)
 * @returns Array of all Tool definitions from the worker
 */
export async function fetchAllTools(
  workerUrl: string,
  headers: Record<string, string>
): Promise<Tool[]> {
  const allTools: Tool[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    if (page >= MAX_PAGINATION_PAGES) {
      console.warn(
        `${ts()} [tool-discovery] Pagination limit reached (${MAX_PAGINATION_PAGES} pages, ${allTools.length} tools) for ${workerUrl} — returning partial results`
      );
      break;
    }

    const response = await fetch(workerUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/list',
        params: cursor ? { cursor } : {},
      }),
      signal: AbortSignal.timeout(TIMEOUTS.TOOL_DISCOVERY_MS),
      redirect: 'error',
    });

    if (!response.ok) {
      throw new Error(`Worker returned ${response.status}`);
    }

    const result = await parseResponse(response);
    if (result.error) {
      throw new Error(result.error.message);
    }

    const resultObj = result.result as { tools?: Tool[]; nextCursor?: string } | undefined;
    allTools.push(...(resultObj?.tools ?? []));
    cursor = resultObj?.nextCursor;
    page++;
  } while (cursor);

  return allTools;
}

/**
 * Fetch tool list from a worker via MCP initialize + paginated tools/list; empty when no valid worker URL is configured.
 * @param service - Service name (e.g., 'redmine', 'gitlab')
 * @returns Array of Tool definitions from the worker
 * @throws {Error} When the worker cannot be reached, times out, or answers initialize or tools/list with an error
 */
export async function discoverServiceTools(service: string): Promise<Tool[]> {
  const envKey = deriveWorkerEnv(service);
  const url = process.env[envKey];
  if (!url) {
    console.warn(`${ts()} [tool-discovery] No ${envKey} configured`);
    return [];
  }

  if (!validateWorkerUrl(url)) {
    console.error(`${ts()} [tool-discovery] SSRF protection: rejected URL for ${service}`);
    return [];
  }

  const authToken = getAuthToken(service);
  const headers = buildWorkerHeaders(authToken);

  const sessionId = await initializeWorker(url, headers);
  const toolHeaders = sessionId ? { ...headers, 'Mcp-Session-Id': sessionId } : headers;

  const tools = await fetchAllTools(url, toolHeaders);
  console.log(`${ts()} [tool-discovery] Discovered ${tools.length} tools from ${service}`);
  return tools;
}

/**
 * Merge a worker Tool definition with its `_meta` to produce ToolMetadata.
 * Workers are the SSOT for all fields — both contract and policy (via `_meta`).
 * @param tool - Worker Tool definition (including _meta with policy fields)
 * @param service - Service name (e.g., 'redmine')
 * @param methodName - camelCase method name (e.g., 'createIssue')
 */
export function mergeToolWithMeta(tool: Tool, service: string, methodName: string): ToolMetadata {
  if (!tool._meta) {
    console.warn(
      `${ts()} [tool-discovery] ${service}.${methodName}: no _meta — defaulting to deferLoading:true`
    );
  }
  const meta = tool._meta ?? {};
  const deferLoading = metaValue(meta, META_KEYS.DEFER_LOADING, 'deferLoading');
  const timeoutClass = metaValue(meta, META_KEYS.TIMEOUT_CLASS, 'timeoutClass');
  const timeoutMsRaw = metaValue(meta, META_KEYS.TIMEOUT_MS, 'timeoutMs');
  const osCategoryRaw = metaValue(meta, META_KEYS.OS_CATEGORY, 'osCategory');
  const userScoped = metaValue(meta, META_KEYS.USER_SCOPED, 'userScoped');
  const currentUserTool = metaValue(meta, META_KEYS.CURRENT_USER_TOOL, 'currentUserTool');
  const selfParam = metaValue(meta, META_KEYS.SELF_PARAM, 'selfParam');
  const upstreamName = meta[META_KEYS.UPSTREAM_NAME];

  const validOsCategories = ['reminders', 'calendar', 'mail', 'notes'] as const;
  const rawOsCategory = typeof osCategoryRaw === 'string' ? osCategoryRaw : undefined;

  return {
    name: methodName,
    workerToolName: tool.name,
    description: tool.description,
    keywords: tool.keywords ?? [],
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    example: tool.example ?? '',
    inputExamples: tool.inputExamples,
    service,
    deferLoading: typeof deferLoading === 'boolean' ? deferLoading : true,
    timeoutClass:
      timeoutClass === 'long' ? 'long' : timeoutClass === 'standard' ? 'standard' : undefined,
    timeoutMs: typeof timeoutMsRaw === 'number' && timeoutMsRaw > 0 ? timeoutMsRaw : undefined,
    osCategory:
      rawOsCategory && (validOsCategories as readonly string[]).includes(rawOsCategory)
        ? (rawOsCategory as ToolMetadata['osCategory'])
        : undefined,
    annotations: tool.annotations,
    userScoped: typeof userScoped === 'boolean' ? userScoped : undefined,
    currentUserTool: typeof currentUserTool === 'string' ? currentUserTool : undefined,
    selfParam: typeof selfParam === 'string' ? selfParam : undefined,
    toolState: parseToolState(meta[META_KEYS.TOOL_STATE], service, `${service}.${methodName}`),
    upstreamName: typeof upstreamName === 'string' ? upstreamName : undefined,
  };
}

/**
 * Validate merged ToolMetadata has required fields; returns error messages (empty if valid).
 * @param service - Service name
 * @param methodName - camelCase method name
 * @param metadata - Merged ToolMetadata to validate
 */
export function validateMergeResult(
  service: string,
  methodName: string,
  metadata: ToolMetadata
): string[] {
  const errors: string[] = [];
  const prefix = `${service}.${methodName}`;

  if (!metadata.name) {
    errors.push(`${prefix}: missing name`);
  }
  if (metadata.name !== methodName) {
    errors.push(`${prefix}: name mismatch (got '${metadata.name}')`);
  }
  if (!metadata.description) {
    errors.push(`${prefix}: missing description`);
  }
  if (!metadata.inputSchema) {
    errors.push(`${prefix}: missing inputSchema`);
  }
  if (!metadata.service) {
    errors.push(`${prefix}: missing service`);
  }
  if (metadata.service !== service) {
    errors.push(`${prefix}: service mismatch (got '${metadata.service}')`);
  }

  return errors;
}

/**
 * Discover and merge tools for a service: fetch from worker, write a custom server's raw catalog, merge with `_meta`, validate,
 * and keep only `allowed` tools (the single drop point for gated tools; search and the sandbox read the result).
 * Single unified path for all services (built-in and plugin).
 * @param service - Service name
 * @returns Prototype-less record of camelCase method names to ToolMetadata
 */
export async function discoverAndMergeService(
  service: string
): Promise<Record<string, ToolMetadata>> {
  const result: Record<string, ToolMetadata> = Object.create(null);
  const workerTools = await discoverServiceTools(service);
  if (service.startsWith(CUSTOM_SERVICE_PREFIX)) writeToolCatalog(service, workerTools);

  let hidden = 0;
  for (const tool of workerTools) {
    const methodName = toCamelCase(tool.name);
    const merged = mergeToolWithMeta(tool, service, methodName);
    const errors = validateMergeResult(service, methodName, merged);
    if (errors.length > 0) {
      console.warn(
        `${ts()} [tool-discovery] Validation errors for ${service}.${methodName}: ${errors.join('; ')} — skipping`
      );
    } else if (merged.toolState !== 'allowed') {
      hidden++;
    } else {
      result[methodName] = merged;
    }
  }
  if (hidden > 0) {
    console.log(
      `${ts()} [tool-discovery] ${service}: ${hidden} tools not allowed in this project — hidden`
    );
  }

  dropDanglingCurrentUserTool(service, result);
  dropDanglingSelfParam(service, result);
  warnMissingIdentityCompanion(service, result);

  return result;
}

/**
 * Warn and drop `currentUserTool` when neither the camelCase method name nor the
 * worker's own tool name resolves to a discovered tool; normalizes a resolved pointer to camelCase.
 * @param service - Service name (for the warning message).
 * @param tools - Merged tools for the service, mutated in place.
 */
function dropDanglingCurrentUserTool(service: string, tools: Record<string, ToolMetadata>): void {
  for (const [methodName, metadata] of Object.entries(tools)) {
    const target = metadata.currentUserTool;
    if (!target) continue;

    const resolved = target in tools ? target : toCamelCase(target);
    if (!(resolved in tools)) {
      console.warn(
        `${ts()} [tool-discovery] ${service}.${methodName}: currentUserTool '${target}' does not exist — dropping`
      );
      delete metadata.currentUserTool;
    } else {
      metadata.currentUserTool = resolved;
    }
  }
}

/**
 * Warn and drop `selfParam` when its leading parameter name is not an input parameter
 * of the declaring tool; never serve a self-reference hint the schema cannot honor.
 * @param service - Service name (for the warning message).
 * @param tools - Merged tools for the service, mutated in place.
 */
function dropDanglingSelfParam(service: string, tools: Record<string, ToolMetadata>): void {
  for (const [methodName, metadata] of Object.entries(tools)) {
    if (!metadata.selfParam) continue;
    const leadingParam = metadata.selfParam.match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
    const schema = metadata.inputSchema as { properties?: Record<string, unknown> };
    if (!leadingParam || !Object.hasOwn(schema.properties ?? {}, leadingParam)) {
      console.warn(
        `${ts()} [tool-discovery] ${service}.${methodName}: selfParam '${metadata.selfParam}' is not an input parameter; dropping`
      );
      delete metadata.selfParam;
    }
  }
}

/**
 * Warn once per tool at discovery when a userScoped tool declares neither companion;
 * the tool is kept and search_tools serves it with a misconfiguration hint.
 * @param service - Service name (for the warning message).
 * @param tools - Merged tools for the service (read-only here).
 */
function warnMissingIdentityCompanion(service: string, tools: Record<string, ToolMetadata>): void {
  for (const [methodName, metadata] of Object.entries(tools)) {
    if (metadata.userScoped && !metadata.currentUserTool && !metadata.selfParam) {
      console.warn(
        `${ts()} [tool-discovery] ${service}.${methodName}: userScoped but declares neither currentUserTool nor selfParam; search results will carry a misconfiguration hint`
      );
    }
  }
}
