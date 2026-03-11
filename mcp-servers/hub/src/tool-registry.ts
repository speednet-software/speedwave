/**
 * Tool Registry - Single Source of Truth
 * @module tool-registry
 *
 * Central registry aggregating all tool metadata from service index files.
 * Provides functions to generate bridge and executor wrappers dynamically,
 * eliminating duplication between http-bridge.ts and executor.ts.
 *
 * Architecture:
 * - Tool metadata in tools/{service}/*.ts is the ONLY source of truth
 * - Bridge functions are generated from registry (callWorker mapping)
 * - Executor wrappers are generated from registry (audit + PII handling)
 * @example
 * // Generate bridge for a service
 * const redmineBridge = buildServiceBridge('redmine', callWorker);
 *
 * // Generate executor wrappers
 * const redmineTools = buildExecutorWrappers('redmine', bridge, wrapWithAudit, ...);
 */

import { ToolMetadata, ToolCategory, TimeoutClass } from './hub-types.js';
import { toolMetadata as slackTools } from './tools/slack/index.js';
import { toolMetadata as sharepointTools } from './tools/sharepoint/index.js';
import { toolMetadata as redmineTools } from './tools/redmine/index.js';
import { toolMetadata as gitlabTools } from './tools/gitlab/index.js';
import { toolMetadata as osTools } from './tools/os/index.js';
import { ts, TIMEOUTS } from '@speedwave/mcp-shared';

/**
 * Escape special regex characters in a string to prevent regex injection.
 * @param str - String to escape
 * @returns Escaped string safe for use in RegExp
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

//═══════════════════════════════════════════════════════════════════════════════
// Tool Registry
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Central registry of all tool metadata by service.
 * This is the Single Source of Truth for tool definitions.
 * Frozen to prevent accidental runtime modifications.
 */
export const TOOL_REGISTRY = Object.freeze({
  slack: Object.freeze(slackTools),
  sharepoint: Object.freeze(sharepointTools),
  redmine: Object.freeze(redmineTools),
  gitlab: Object.freeze(gitlabTools),
  os: Object.freeze(osTools),
}) as Readonly<Record<string, Readonly<Record<string, ToolMetadata>>>>;

/**
 * List of all service names in the registry
 */
export const SERVICE_NAMES = Object.keys(TOOL_REGISTRY) as readonly string[];

/**
 * Get tool metadata for a specific service and method
 * @param service - Service name (e.g., 'redmine', 'gitlab')
 * @param method - Method name (e.g., 'createRelation', 'getMrFull')
 * @returns Tool metadata or undefined if not found
 */
export function getToolMetadata(service: string, method: string): ToolMetadata | undefined {
  return TOOL_REGISTRY[service]?.[method];
}

/**
 * Get all method names for a service
 * @param service - Service name
 * @returns Array of method names
 */
export function getServiceMethods(service: string): string[] {
  const tools = TOOL_REGISTRY[service];
  return tools ? Object.keys(tools) : [];
}

/**
 * Get tool category for audit logging
 * @param service - Service name
 * @param method - Method name
 * @returns Tool category or 'read' as default (with warning if metadata missing)
 */
export function getToolCategory(service: string, method: string): ToolCategory {
  const meta = getToolMetadata(service, method);
  if (!meta) {
    console.warn(
      `${ts()} [tool-registry] No metadata for ${service}.${method}, defaulting to 'read'`
    );
  }
  return meta?.category ?? 'read';
}

//═══════════════════════════════════════════════════════════════════════════════
// Timeout Detection (SSOT - based on tool metadata)
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Cached result for getLongTimeoutTools() - computed once since TOOL_REGISTRY is frozen/immutable
 */
let cachedLongTimeoutTools: Array<{ service: string; method: string }> | null = null;

/**
 * Get list of all tools with 'long' timeout class from registry.
 * These are tools that require extended execution time (sync, extract, AI generation).
 * Result is cached since TOOL_REGISTRY is immutable.
 * @returns Array of {service, method} for all long-running tools
 */
export function getLongTimeoutTools(): Array<{ service: string; method: string }> {
  if (cachedLongTimeoutTools !== null) {
    return cachedLongTimeoutTools;
  }

  cachedLongTimeoutTools = [];
  for (const [service, tools] of Object.entries(TOOL_REGISTRY)) {
    for (const [method, metadata] of Object.entries(tools)) {
      if (metadata.timeoutClass === 'long') {
        cachedLongTimeoutTools.push({ service, method });
      }
    }
  }

  return cachedLongTimeoutTools;
}

/**
 * Determine the required timeout class for code execution.
 * Checks if any 'long' timeout tools from registry are mentioned in the code.
 *
 * Note: This uses simple string matching (service.method pattern).
 * It may have false positives (commented code, strings) but is safe -
 * a longer timeout doesn't cause harm, only prevents premature termination.
 * @param code - JavaScript code to analyze
 * @returns 'long' if any long-running tools are detected, 'standard' otherwise
 */
export function getRequiredTimeoutClass(code: string): TimeoutClass {
  const longTools = getLongTimeoutTools();

  for (const { service, method } of longTools) {
    // Match service.method pattern with optional whitespace
    // e.g., "sharepoint.sync", "sharepoint .sync", "sharepoint. sync"
    // Use escapeRegex to prevent regex injection from service/method names
    const pattern = new RegExp(`${escapeRegex(service)}\\s*\\.\\s*${escapeRegex(method)}\\b`);
    if (pattern.test(code)) {
      return 'long';
    }
  }

  return 'standard';
}

/**
 * Get the appropriate execution timeout based on code content.
 * Uses tool registry as Single Source of Truth for timeout classification.
 * @param code - JavaScript code to analyze
 * @param defaultMs - Default timeout for standard operations
 * @returns Timeout in milliseconds (EXECUTION_MS or LONG_OPERATION_MS)
 */
export function getExecutionTimeout(
  code: string,
  defaultMs: number
): {
  timeoutMs: number;
  maxTimeoutMs: number;
  timeoutClass: TimeoutClass;
} {
  const timeoutClass = getRequiredTimeoutClass(code);

  if (timeoutClass === 'long') {
    return {
      timeoutMs: TIMEOUTS.LONG_OPERATION_MS,
      maxTimeoutMs: TIMEOUTS.LONG_OPERATION_MS,
      timeoutClass,
    };
  }

  return {
    timeoutMs: defaultMs,
    maxTimeoutMs: TIMEOUTS.EXECUTION_MS,
    timeoutClass,
  };
}

//═══════════════════════════════════════════════════════════════════════════════
// Service Filtering (ENABLED_SERVICES / DISABLED_OS_SERVICES)
//═══════════════════════════════════════════════════════════════════════════════

let _enabledServicesCache: Set<string> | null = null;

/**
 * Get the set of enabled services from ENABLED_SERVICES env var.
 * If env var is not set, no services are enabled (fail-closed).
 * Result is cached since env vars don't change at runtime.
 * @returns Set of enabled service names
 */
export function getEnabledServices(): Set<string> {
  if (_enabledServicesCache) return _enabledServicesCache;
  const envVal = process.env.ENABLED_SERVICES;
  if (envVal === undefined) {
    console.warn(
      `${ts()} [tool-registry] ENABLED_SERVICES not set — defaulting to none (fail-closed)`
    );
    _enabledServicesCache = new Set();
  } else {
    _enabledServicesCache = new Set(
      envVal
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  return _enabledServicesCache;
}

let _disabledOsCategoriesCache: Set<string> | null = null;

/**
 * Get the set of disabled OS sub-integration categories from DISABLED_OS_SERVICES env var.
 * If env var is not set, no OS categories are disabled.
 * Result is cached since env vars don't change at runtime.
 * @returns Set of disabled OS category names (e.g., 'reminders', 'mail')
 */
export function getDisabledOsCategories(): Set<string> {
  if (_disabledOsCategoriesCache) return _disabledOsCategoriesCache;
  const envVal = process.env.DISABLED_OS_SERVICES;
  if (!envVal) {
    _disabledOsCategoriesCache = new Set();
  } else {
    _disabledOsCategoriesCache = new Set(
      envVal
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  return _disabledOsCategoriesCache;
}

/**
 * Reset cached values for getEnabledServices and getDisabledOsCategories.
 * Only needed in tests where env vars change between test cases.
 */
export function resetServiceCaches(): void {
  _enabledServicesCache = null;
  _disabledOsCategoriesCache = null;
}

//═══════════════════════════════════════════════════════════════════════════════
// Bridge Generation
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Options for callWorker function
 */
export interface CallWorkerOptions {
  /** Timeout in milliseconds for this specific call */
  timeoutMs?: number;
}

/**
 * Type for callWorker function used by bridges
 */
export type CallWorkerFn = (
  service: string,
  tool: string,
  params: Record<string, unknown>,
  options?: CallWorkerOptions
) => Promise<unknown>;

/**
 * Build bridge functions for a service from registry.
 * Generates a mapping of camelCase method names to callWorker invocations.
 * @param service - Service name (e.g., 'redmine')
 * @param callWorker - Function to call the worker service
 * @param getTimeoutMs - Optional function that returns remaining timeout for each call
 * @returns Object with method functions
 * @throws {Error} If service is not found in registry
 * @example
 * const bridge = buildServiceBridge('redmine', callWorker);
 * // bridge.createRelation(params) calls callWorker('redmine', 'create_relation', params)
 *
 * // With timeout tracking:
 * const bridge = buildServiceBridge('redmine', callWorker, () => getRemainingTime());
 */
export function buildServiceBridge(
  service: string,
  callWorker: CallWorkerFn,
  getTimeoutMs?: () => number
): Record<string, (params?: Record<string, unknown>) => Promise<unknown>> {
  const tools = TOOL_REGISTRY[service];
  if (!tools) {
    throw new Error(`Unknown service in registry: ${service}`);
  }

  const bridge: Record<string, (params?: Record<string, unknown>) => Promise<unknown>> = {};

  for (const methodName of Object.keys(tools)) {
    const metadata = tools[methodName];
    bridge[methodName] = (params?: Record<string, unknown>) => {
      // Per-tool timeout takes precedence if defined (allows long operations like sync)
      // Otherwise use remaining execution time as fallback
      const perToolTimeout = metadata.timeoutMs;
      const remainingTimeout = getTimeoutMs?.();
      const timeoutMs = perToolTimeout ?? remainingTimeout;
      const options = timeoutMs ? { timeoutMs } : undefined;
      return callWorker(service, methodName, params || {}, options);
    };
  }

  return bridge;
}

//═══════════════════════════════════════════════════════════════════════════════
// Executor Wrapper Generation
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Type for wrapWithAudit function used by executor
 */
export type WrapWithAuditFn = <TParams, TResult>(
  category: ToolCategory,
  service: string,
  tool: string,
  fn: (params: TParams) => Promise<TResult>
) => (params: TParams) => Promise<TResult>;

/**
 * Type for prepareParams function (PII detokenization)
 */
export type PrepareParamsFn = <T>(params: T) => T;

/**
 * Type for wrapBridgeCall function (PII tokenization + error handling)
 */
export type WrapBridgeCallFn = <T>(bridgeCall: () => Promise<T>, serviceName: string) => Promise<T>;

/**
 * Build executor tool wrappers for a service from registry.
 * Generates wrapped functions with audit logging and PII handling.
 * Uses category from tool metadata instead of hardcoding.
 * @param service - Service name (e.g., 'redmine')
 * @param bridge - Bridge object with raw method functions
 * @param wrapWithAudit - Function to wrap with audit logging
 * @param prepareParams - Function to detokenize PII in params
 * @param wrapBridgeCall - Function to tokenize PII in results
 * @param disabledOsCategories - Set of OS categories to exclude (e.g. 'mail', 'notes')
 * @returns Object with wrapped method functions
 * @example
 * const wrappers = buildExecutorWrappers(
 *   'redmine',
 *   serviceBridges.redmine,
 *   wrapWithAudit,
 *   prepareParams,
 *   wrapBridgeCall
 * );
 * // wrappers.createRelation calls with audit='write' from metadata
 */
export function buildExecutorWrappers(
  service: string,
  bridge: Record<string, (params?: Record<string, unknown>) => Promise<unknown>>,
  wrapWithAudit: WrapWithAuditFn,
  prepareParams: PrepareParamsFn,
  wrapBridgeCall: WrapBridgeCallFn,
  disabledOsCategories?: Set<string>
): Record<string, (params?: Record<string, unknown>) => Promise<unknown>> {
  const tools = TOOL_REGISTRY[service];
  if (!tools) {
    throw new Error(`Unknown service in registry: ${service}`);
  }

  const wrappers: Record<string, (params?: Record<string, unknown>) => Promise<unknown>> = {};

  for (const [methodName, metadata] of Object.entries(tools)) {
    if (
      disabledOsCategories &&
      metadata.osCategory &&
      disabledOsCategories.has(metadata.osCategory)
    ) {
      continue;
    }

    const bridgeMethod = bridge[methodName];
    if (!bridgeMethod) {
      // Fail fast - misconfiguration should be caught at startup, not runtime
      throw new Error(
        `[tool-registry] Bridge method not found: ${service}.${methodName}. ` +
          `Available bridge methods: ${Object.keys(bridge).join(', ')}`
      );
    }

    wrappers[methodName] = wrapWithAudit(
      metadata.category, // FROM METADATA - not hardcoded!
      service,
      methodName,
      async (params?: Record<string, unknown>) => {
        const p = prepareParams(params || {});
        return wrapBridgeCall(() => bridgeMethod(p), service);
      }
    );
  }

  return wrappers;
}

//═══════════════════════════════════════════════════════════════════════════════
// Validation
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate that all tools in registry have required fields.
 * Useful for build-time or test-time validation.
 * @returns Array of validation errors (empty if valid)
 */
export function validateRegistry(): string[] {
  const errors: string[] = [];
  const validCategories = ['read', 'write', 'delete'];

  for (const [service, tools] of Object.entries(TOOL_REGISTRY)) {
    for (const [methodName, metadata] of Object.entries(tools)) {
      // Check name matches key
      if (metadata.name !== methodName) {
        errors.push(
          `${service}.${methodName}: metadata.name ('${metadata.name}') does not match key`
        );
      }

      // Check service matches
      if (metadata.service !== service) {
        errors.push(
          `${service}.${methodName}: metadata.service ('${metadata.service}') does not match service`
        );
      }

      // Check category is valid
      if (!validCategories.includes(metadata.category)) {
        errors.push(
          `${service}.${methodName}: invalid category '${metadata.category}' (expected: ${validCategories.join('/')})`
        );
      }

      // Check required fields
      if (!metadata.description) {
        errors.push(`${service}.${methodName}: missing description`);
      }
      if (!metadata.inputSchema) {
        errors.push(`${service}.${methodName}: missing inputSchema`);
      }
    }
  }

  return errors;
}

/**
 * Get registry statistics
 * @returns Object with tool counts per service and total
 */
export function getRegistryStats(): { services: Record<string, number>; total: number } {
  const services: Record<string, number> = {};
  let total = 0;

  for (const [service, tools] of Object.entries(TOOL_REGISTRY)) {
    const count = Object.keys(tools).length;
    services[service] = count;
    total += count;
  }

  return { services, total };
}

//═══════════════════════════════════════════════════════════════════════════════
// Auto-validation at startup (development only)
//═══════════════════════════════════════════════════════════════════════════════

// Validate registry on module load in non-production environments
if (process.env.NODE_ENV !== 'production') {
  const errors = validateRegistry();
  if (errors.length > 0) {
    console.error(`${ts()} [tool-registry] Registry validation errors:`, errors);
    throw new Error(
      `Registry validation failed with ${errors.length} error(s). Fix tool metadata before continuing.`
    );
  }
}
