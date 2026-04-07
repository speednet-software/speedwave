/**
 * Tool Discovery - Dynamic tool fetching from workers
 * @module tool-discovery
 *
 * Fetches tool definitions from workers via JSON-RPC `tools/list`.
 * Merges worker tool data with _meta metadata to produce ToolMetadata.
 *
 * Workers are the SSOT for ALL tool metadata:
 * - Contract: name, description, inputSchema, inputExamples, keywords, example, outputSchema, annotations
 * - Policy: deferLoading, timeoutClass, timeoutMs, osCategory (via _meta field)
 */

import { randomUUID } from 'crypto';
import type { Tool } from '@speedwave/mcp-shared';
import { TIMEOUTS, LATEST_PROTOCOL_VERSION, ts } from '@speedwave/mcp-shared';
import type { ToolMetadata } from './hub-types.js';
import { getAuthToken } from './auth-tokens.js';
import { validateWorkerUrl } from '@speedwave/mcp-shared';
import { parseResponse, buildWorkerHeaders } from './http-bridge.js';

/**
 * Convert snake_case tool name to camelCase method name.
 * Workers use snake_case, hub uses camelCase.
 * @param str - snake_case string to convert
 */
export function toCamelCase(str: string): string {
  return str.replace(/_([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Perform MCP initialize handshake with a worker.
 * Sends `initialize` request followed by `notifications/initialized` notification.
 * Returns the Mcp-Session-Id if the worker set one, or undefined.
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

  const initResult = await parseResponse(response);
  if (initResult.error) {
    throw new Error(
      `Worker initialize failed: [${initResult.error.code}] ${initResult.error.message}`
    );
  }
  const sessionId = response.headers.get('Mcp-Session-Id') ?? undefined;

  // Send notifications/initialized (no id = notification, no response expected)
  const notifResponse = await fetch(workerUrl, {
    method: 'POST',
    headers: { ...headers, ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(TIMEOUTS.TOOL_DISCOVERY_MS),
    redirect: 'error',
  });

  if (!notifResponse.ok) {
    console.warn(
      `${ts()} [tool-discovery] notifications/initialized returned ${notifResponse.status} for ${workerUrl}`
    );
  }

  return sessionId;
}

/** Maximum number of pagination pages to fetch before breaking to prevent infinite loops. */
export const MAX_PAGINATION_PAGES = 50;

/**
 * Fetch all tools from a worker with cursor-based pagination.
 * Iterates `tools/list` until no `nextCursor` is returned or
 * MAX_PAGINATION_PAGES is reached.
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
 * Fetch tool list from a worker service via MCP initialize handshake + paginated tools/list.
 * @param service - Service name (e.g., 'redmine', 'gitlab')
 * @returns Array of Tool definitions from the worker, or empty array on failure
 */
export async function discoverServiceTools(service: string): Promise<Tool[]> {
  const url = process.env[`WORKER_${service.toUpperCase()}_URL`];
  if (!url) {
    console.warn(`${ts()} [tool-discovery] No WORKER_${service.toUpperCase()}_URL configured`);
    return [];
  }

  if (!validateWorkerUrl(url)) {
    console.error(`${ts()} [tool-discovery] SSRF protection: rejected URL for ${service}`);
    return [];
  }

  try {
    const authToken = getAuthToken(service);
    const headers = buildWorkerHeaders(authToken);

    // Perform MCP initialize handshake
    const sessionId = await initializeWorker(url, headers);
    const toolHeaders = sessionId ? { ...headers, 'Mcp-Session-Id': sessionId } : headers;

    // Fetch all tools with pagination
    const tools = await fetchAllTools(url, toolHeaders);
    console.log(`${ts()} [tool-discovery] Discovered ${tools.length} tools from ${service}`);
    return tools;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`${ts()} [tool-discovery] Failed to discover ${service}: ${msg}`);
    return [];
  }
}

/**
 * Merge a worker Tool definition with its _meta to produce ToolMetadata.
 * Workers are the SSOT for all fields — both contract and policy (via _meta).
 * @param tool - Worker Tool definition (including _meta with policy fields)
 * @param service - Service name (e.g., 'redmine')
 * @param methodName - camelCase method name (e.g., 'createIssue')
 */
export function mergeToolWithMeta(tool: Tool, service: string, methodName: string): ToolMetadata {
  const meta = tool._meta ?? {};
  const validOsCategories = ['reminders', 'calendar', 'mail', 'notes'] as const;
  const rawOsCategory = typeof meta.osCategory === 'string' ? meta.osCategory : undefined;
  return {
    name: methodName,
    description: tool.description,
    keywords: tool.keywords ?? [],
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    example: tool.example ?? '',
    inputExamples: tool.inputExamples,
    service,
    deferLoading: typeof meta.deferLoading === 'boolean' ? meta.deferLoading : true,
    timeoutClass:
      meta.timeoutClass === 'long'
        ? 'long'
        : meta.timeoutClass === 'standard'
          ? 'standard'
          : undefined,
    timeoutMs:
      typeof meta.timeoutMs === 'number' && meta.timeoutMs > 0 ? meta.timeoutMs : undefined,
    osCategory:
      rawOsCategory && (validOsCategories as readonly string[]).includes(rawOsCategory)
        ? (rawOsCategory as ToolMetadata['osCategory'])
        : undefined,
  };
}

/**
 * Validate that merged ToolMetadata has all required fields.
 * Returns an array of validation error messages (empty if valid).
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
 * Discover and merge tools for a service.
 * Fetches tool list from worker, merges with _meta, validates.
 * Single unified path for all services (built-in and plugin).
 * @param service - Service name
 * @returns Record of camelCase method names to ToolMetadata
 */
export async function discoverAndMergeService(
  service: string
): Promise<Record<string, ToolMetadata>> {
  const result: Record<string, ToolMetadata> = {};
  const workerTools = await discoverServiceTools(service);

  for (const tool of workerTools) {
    const methodName = toCamelCase(tool.name);
    const merged = mergeToolWithMeta(tool, service, methodName);
    const errors = validateMergeResult(service, methodName, merged);
    if (errors.length > 0) {
      console.warn(
        `${ts()} [tool-discovery] Validation errors for ${service}.${methodName}: ${errors.join('; ')} — skipping`
      );
    } else {
      result[methodName] = merged;
    }
  }

  return result;
}
