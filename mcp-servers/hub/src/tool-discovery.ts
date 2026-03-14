/**
 * Tool Discovery - Dynamic tool fetching from workers
 * @module tool-discovery
 *
 * Fetches tool definitions from workers via JSON-RPC `tools/list`.
 * Merges worker tool data with hub policy to produce ToolMetadata.
 *
 * Workers are the SSOT for: name, description, inputSchema, inputExamples,
 * keywords, example, outputSchema.
 *
 * Hub policy is authoritative for: category (audit), deferLoading, timeoutClass,
 * timeoutMs, osCategory, service.
 */

import { randomUUID } from 'crypto';
import type { Tool } from '@speedwave/mcp-shared';
import { TIMEOUTS, ts } from '@speedwave/mcp-shared';
import type { ToolMetadata } from './hub-types.js';
import type { ToolPolicy } from './hub-tool-policy.js';
import { getServicePolicies, getPluginToolPolicy } from './hub-tool-policy.js';
import { isPluginService } from './service-list.js';
import { getAuthToken } from './auth-tokens.js';
import { validateWorkerUrl } from '@speedwave/mcp-shared';

/**
 * Convert snake_case tool name to camelCase method name.
 * Workers use snake_case, hub uses camelCase.
 * @param str - snake_case string to convert
 */
export function toCamelCase(str: string): string {
  return str.replace(/_([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Fetch tool list from a worker service via JSON-RPC tools/list.
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

  const requestId = randomUUID();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.TOOL_DISCOVERY_MS);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const authToken = getAuthToken(service);
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/list',
        params: {},
      }),
      signal: controller.signal,
      redirect: 'error',
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`${ts()} [tool-discovery] Worker ${service} returned ${response.status}`);
      return [];
    }

    const result = (await response.json()) as {
      jsonrpc: '2.0';
      id: string | number;
      result?: { tools?: Tool[] };
      error?: { code: number; message: string };
    };

    if (result.error) {
      console.error(`${ts()} [tool-discovery] Worker ${service} error: ${result.error.message}`);
      return [];
    }

    const tools = result.result?.tools ?? [];
    console.log(`${ts()} [tool-discovery] Discovered ${tools.length} tools from ${service}`);
    return tools;
  } catch (error) {
    clearTimeout(timeoutId);
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`${ts()} [tool-discovery] Failed to discover ${service}: ${msg}`);
    return [];
  }
}

/**
 * Merge a worker Tool definition with hub ToolPolicy to produce ToolMetadata.
 * Worker fields take precedence for the tool contract.
 * Hub policy provides operational fields.
 * @param tool - Worker Tool definition
 * @param policy - Hub-side policy for this tool
 * @param service - Service name (e.g., 'redmine')
 * @param methodName - camelCase method name (e.g., 'createIssue')
 */
export function mergeToolWithPolicy(
  tool: Tool,
  policy: ToolPolicy,
  service: string,
  methodName: string
): ToolMetadata {
  return {
    name: methodName,
    description: tool.description,
    keywords: tool.keywords ?? [],
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    example: tool.example ?? '',
    inputExamples: tool.inputExamples,
    service,
    deferLoading: policy.deferLoading,
    category: policy.category,
    timeoutClass: policy.timeoutClass,
    timeoutMs: policy.timeoutMs,
    osCategory: policy.osCategory,
  };
}

/**
 * Build a skeleton ToolMetadata from policy alone when worker is unavailable.
 * This allows the hub to start and serve basic tool info (names, categories)
 * even if workers haven't started yet.
 * @param service - Service name (e.g., 'redmine')
 * @param methodName - camelCase method name (e.g., 'listIssueIds')
 * @param policy - Hub-side policy for this tool
 */
export function buildSkeletonFromPolicy(
  service: string,
  methodName: string,
  policy: ToolPolicy
): ToolMetadata {
  return {
    name: methodName,
    description: `${methodName} — use search_tools for full schema`,
    keywords: [],
    inputSchema: { type: 'object', properties: {} },
    example: '',
    service,
    deferLoading: policy.deferLoading,
    category: policy.category,
    timeoutClass: policy.timeoutClass,
    timeoutMs: policy.timeoutMs,
    osCategory: policy.osCategory,
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
  const validCategories = ['read', 'write', 'delete'];
  if (!validCategories.includes(metadata.category)) {
    errors.push(`${prefix}: invalid category '${metadata.category}'`);
  }

  return errors;
}

/**
 * Discover and merge tools for a service.
 * Fetches tool list from worker, merges with hub policy, validates.
 * Falls back to skeleton entries for tools not found in worker response.
 * @param service - Service name
 * @returns Record of camelCase method names to ToolMetadata
 */
export async function discoverAndMergeService(
  service: string
): Promise<Record<string, ToolMetadata>> {
  const result: Record<string, ToolMetadata> = {};

  // Fetch from worker
  const workerTools = await discoverServiceTools(service);

  // Plugin services: accept ALL worker tools, no policy-gating
  if (isPluginService(service)) {
    for (const tool of workerTools) {
      const methodName = toCamelCase(tool.name);
      const policy = getPluginToolPolicy(tool);
      const merged = mergeToolWithPolicy(tool, policy, service, methodName);
      const errors = validateMergeResult(service, methodName, merged);
      if (errors.length > 0) {
        console.warn(
          `${ts()} [tool-discovery] Validation errors for plugin ${service}.${methodName}: ${errors.join('; ')} — skipping`
        );
      } else {
        result[methodName] = merged;
      }
    }
    return result;
  }

  // Built-in services: merge with hub policy
  const policies = getServicePolicies(service);

  // Index worker tools by camelCase name
  const toolsByMethod = new Map<string, Tool>();
  for (const tool of workerTools) {
    const methodName = toCamelCase(tool.name);
    toolsByMethod.set(methodName, tool);
  }

  // Merge each policy entry with worker data (or build skeleton)
  for (const [methodName, policy] of Object.entries(policies)) {
    const workerTool = toolsByMethod.get(methodName);

    if (workerTool) {
      const merged = mergeToolWithPolicy(workerTool, policy, service, methodName);
      const errors = validateMergeResult(service, methodName, merged);
      if (errors.length > 0) {
        console.warn(
          `${ts()} [tool-discovery] Validation errors for ${service}.${methodName}: ${errors.join('; ')} — using skeleton`
        );
        result[methodName] = buildSkeletonFromPolicy(service, methodName, policy);
      } else {
        result[methodName] = merged;
      }
    } else {
      console.warn(
        `${ts()} [tool-discovery] Tool ${service}.${methodName} not found in worker, using skeleton`
      );
      result[methodName] = buildSkeletonFromPolicy(service, methodName, policy);
    }
  }

  // Warn about tools in worker but not in policy (new tools not yet registered)
  for (const [methodName] of toolsByMethod) {
    if (!policies[methodName]) {
      console.warn(
        `${ts()} [tool-discovery] Worker ${service} has tool '${methodName}' not in policy — ignoring`
      );
    }
  }

  return result;
}
