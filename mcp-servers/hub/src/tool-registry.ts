/**
 * Tool Registry - Dynamic Discovery with Policy
 * @module tool-registry
 *
 * Central registry that merges worker-fetched tool metadata with hub policies.
 * Workers are the SSOT for tool contracts (name, description, inputSchema, etc.).
 * Hub policies control operational behavior (deferLoading, timeoutClass, etc.).
 *
 * Lifecycle:
 * 1. At startup, initializeRegistry() populates the registry from workers
 * 2. If a worker is unavailable, skeleton entries are used (from policy data)
 * 3. Background refresh periodically updates tools from workers
 * 4. All existing consumers (search-tools, executor, handlers) use the same API
 */

import { ToolMetadata, TimeoutClass } from './hub-types.js';
import { TOOL_POLICIES, SUPPORTED_SERVICES, getServicePolicies } from './hub-tool-policy.js';
import { getAllServiceNames } from './service-list.js';
import { discoverAndMergeService, buildSkeletonFromPolicy } from './tool-discovery.js';
import { ts, TIMEOUTS } from '@speedwave/mcp-shared';

/**
 * Escape special regex characters in a string to prevent regex injection.
 * @param str - String to escape
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

//═══════════════════════════════════════════════════════════════════════════════
// Mutable Tool Registry
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Mutable registry of all tool metadata by service.
 * Populated by initializeRegistry() and refreshed periodically.
 * Consumers should access via exported functions, not directly.
 */
const _registry: Record<string, Record<string, ToolMetadata>> = {};

/**
 * Whether the registry has been initialized
 */
let _initialized = false;

/**
 * Background refresh interval handle
 */
let _refreshInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Read-only view of the registry for consumers.
 * Returns the current snapshot. Keys and values may change after refresh.
 */
export function getRegistry(): Readonly<Record<string, Readonly<Record<string, ToolMetadata>>>> {
  return _registry;
}

/**
 * Backward-compatible alias: consumers that used TOOL_REGISTRY directly.
 * Typed as Readonly for production safety. Tests cast to mutable via _resetRegistryForTesting.
 */
export const TOOL_REGISTRY: Readonly<Record<string, Readonly<Record<string, ToolMetadata>>>> =
  _registry;

/**
 * List of all service names in the registry.
 * Initially set to built-in services; updated during initializeRegistry()
 * to include plugin services from ENABLED_SERVICES env var.
 */
export let SERVICE_NAMES: readonly string[] = [...SUPPORTED_SERVICES];

//═══════════════════════════════════════════════════════════════════════════════
// Initialization
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize the registry from workers + policies.
 * Called once at startup before initializeBridges().
 *
 * For each service:
 * 1. Try to discover tools from worker (JSON-RPC tools/list)
 * 2. Merge with hub policy
 * 3. Fall back to skeleton entries if worker unavailable
 */
export async function initializeRegistry(): Promise<void> {
  if (_initialized) return;
  _initialized = true; // Set immediately to prevent concurrent double-initialization

  // Update SERVICE_NAMES to include plugin services from env
  SERVICE_NAMES = getAllServiceNames();

  console.log(`${ts()} [tool-registry] Initializing dynamic registry...`);

  const enabledServices = getEnabledServices();

  for (const service of SERVICE_NAMES) {
    if (!enabledServices.has(service)) {
      // Still populate skeleton so bridge generation works (built-in only)
      _populateSkeletons(service);
      continue;
    }

    try {
      const tools = await discoverAndMergeService(service);
      _registry[service] = tools;
      console.log(`${ts()} [tool-registry] ${service}: ${Object.keys(tools).length} tools loaded`);
    } catch (error) {
      console.warn(
        `${ts()} [tool-registry] ${service}: discovery failed, using skeletons`,
        error instanceof Error ? error.message : error
      );
      _populateSkeletons(service);
    }
  }

  // Start background refresh (every 5 minutes)
  _startBackgroundRefresh();

  const stats = getRegistryStats();
  console.log(
    `${ts()} [tool-registry] Registry initialized: ${stats.total} tools across ${Object.keys(stats.services).length} services`
  );
}

/**
 * Populate registry with skeleton entries for a service (from policy only).
 * @param service - Service name
 */
function _populateSkeletons(service: string): void {
  const policies = getServicePolicies(service);
  _registry[service] = {};
  for (const [methodName, policy] of Object.entries(policies)) {
    _registry[service][methodName] = buildSkeletonFromPolicy(service, methodName, policy);
  }
}

/**
 * Refresh tools for a specific service from its worker.
 * Called by background refresh or on-demand.
 * @param service - Service name to refresh
 */
export async function refreshServiceTools(service: string): Promise<void> {
  try {
    const tools = await discoverAndMergeService(service);
    _registry[service] = tools;
  } catch (error) {
    console.warn(
      `${ts()} [tool-registry] Refresh failed for ${service}:`,
      error instanceof Error ? error.message : error
    );
    // Keep existing data on refresh failure
  }
}

/**
 * Whether a background refresh is currently in progress
 */
let _refreshInProgress = false;

/**
 * Start background refresh of all enabled services.
 */
function _startBackgroundRefresh(): void {
  if (_refreshInterval) return;

  const REFRESH_MS = 5 * 60 * 1000; // 5 minutes
  _refreshInterval = setInterval(async () => {
    if (_refreshInProgress) return; // Skip overlapping refresh
    _refreshInProgress = true;
    try {
      const enabled = getEnabledServices();
      for (const service of SERVICE_NAMES) {
        if (enabled.has(service)) {
          await refreshServiceTools(service);
        }
      }
    } finally {
      _refreshInProgress = false;
    }
  }, REFRESH_MS);

  // Don't prevent process from exiting
  if (_refreshInterval && typeof _refreshInterval === 'object' && 'unref' in _refreshInterval) {
    _refreshInterval.unref();
  }
}

/**
 * Stop background refresh (for testing).
 */
export function stopBackgroundRefresh(): void {
  if (_refreshInterval) {
    clearInterval(_refreshInterval);
    _refreshInterval = null;
  }
}

/**
 * Reset registry state (for testing only).
 */
export function _resetRegistryForTesting(): void {
  for (const key of Object.keys(_registry)) {
    delete _registry[key];
  }
  _initialized = false;
  _refreshInProgress = false;
  SERVICE_NAMES = [...SUPPORTED_SERVICES];
  stopBackgroundRefresh();
}

//═══════════════════════════════════════════════════════════════════════════════
// Registry Accessors (same API as before)
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Get tool metadata for a specific service and method
 * @param service - Service name
 * @param method - camelCase method name
 */
export function getToolMetadata(service: string, method: string): ToolMetadata | undefined {
  return _registry[service]?.[method];
}

/**
 * Get all method names for a service
 * @param service - Service name
 */
export function getServiceMethods(service: string): string[] {
  const tools = _registry[service];
  return tools ? Object.keys(tools) : [];
}

//═══════════════════════════════════════════════════════════════════════════════
// Timeout Detection (SSOT - based on tool policy)
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Cached result for getLongTimeoutTools()
 */
let cachedLongTimeoutTools: Array<{ service: string; method: string }> | null = null;

/**
 * Get list of all tools with 'long' timeout class.
 * Uses TOOL_POLICIES as the source since this is a hub-side concern.
 */
export function getLongTimeoutTools(): Array<{ service: string; method: string }> {
  if (cachedLongTimeoutTools !== null) {
    return cachedLongTimeoutTools;
  }

  cachedLongTimeoutTools = [];
  for (const [service, tools] of Object.entries(TOOL_POLICIES)) {
    for (const [method, policy] of Object.entries(tools)) {
      if (policy.timeoutClass === 'long') {
        cachedLongTimeoutTools.push({ service, method });
      }
    }
  }

  return cachedLongTimeoutTools;
}

/**
 * Determine the required timeout class for code execution.
 * @param code - JavaScript code to analyze for long-running operations
 */
export function getRequiredTimeoutClass(code: string): TimeoutClass {
  const longTools = getLongTimeoutTools();

  for (const { service, method } of longTools) {
    const pattern = new RegExp(`${escapeRegex(service)}\\s*\\.\\s*${escapeRegex(method)}\\b`);
    if (pattern.test(code)) {
      return 'long';
    }
  }

  return 'standard';
}

/**
 * Get the appropriate execution timeout based on code content.
 * @param code - JavaScript code to analyze
 * @param defaultMs - Default timeout in milliseconds
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
 * Uses current registry data (refreshed dynamically).
 * @param service - Service name
 * @param callWorker - Function to call worker via JSON-RPC
 * @param getTimeoutMs - Optional getter for remaining execution timeout
 */
export function buildServiceBridge(
  service: string,
  callWorker: CallWorkerFn,
  getTimeoutMs?: () => number
): Record<string, (params?: Record<string, unknown>) => Promise<unknown>> {
  const tools = _registry[service];
  if (!tools) {
    throw new Error(`Unknown service in registry: ${service}`);
  }

  const bridge: Record<string, (params?: Record<string, unknown>) => Promise<unknown>> = {};

  for (const methodName of Object.keys(tools)) {
    const metadata = tools[methodName];
    bridge[methodName] = (params?: Record<string, unknown>) => {
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
 * Function type for wrapping tool calls with audit logging.
 */
export type WrapWithAuditFn = <TParams, TResult>(
  service: string,
  tool: string,
  fn: (params: TParams) => Promise<TResult>
) => (params: TParams) => Promise<TResult>;

/**
 * Function type for preparing parameters before bridge call.
 */
export type PrepareParamsFn = <T>(params: T) => T;

/**
 * Function type for wrapping bridge calls with error handling.
 */
export type WrapBridgeCallFn = <T>(bridgeCall: () => Promise<T>, serviceName: string) => Promise<T>;

/**
 * Build executor tool wrappers for a service from registry.
 * @param service - Service name
 * @param bridge - Bridge functions for the service
 * @param wrapWithAudit - Audit logging wrapper
 * @param prepareParams - Parameter preparation function
 * @param wrapBridgeCall - Bridge call wrapper with error handling
 * @param disabledOsCategories - Optional set of disabled OS categories to skip
 */
export function buildExecutorWrappers(
  service: string,
  bridge: Record<string, (params?: Record<string, unknown>) => Promise<unknown>>,
  wrapWithAudit: WrapWithAuditFn,
  prepareParams: PrepareParamsFn,
  wrapBridgeCall: WrapBridgeCallFn,
  disabledOsCategories?: Set<string>
): Record<string, (params?: Record<string, unknown>) => Promise<unknown>> {
  const tools = _registry[service];
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
      throw new Error(
        `[tool-registry] Bridge method not found: ${service}.${methodName}. ` +
          `Available bridge methods: ${Object.keys(bridge).join(', ')}`
      );
    }

    wrappers[methodName] = wrapWithAudit(
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
 */
export function validateRegistry(): string[] {
  const errors: string[] = [];

  for (const [service, tools] of Object.entries(_registry)) {
    for (const [methodName, metadata] of Object.entries(tools)) {
      if (metadata.name !== methodName) {
        errors.push(
          `${service}.${methodName}: metadata.name ('${metadata.name}') does not match key`
        );
      }
      if (metadata.service !== service) {
        errors.push(
          `${service}.${methodName}: metadata.service ('${metadata.service}') does not match service`
        );
      }
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
 */
export function getRegistryStats(): { services: Record<string, number>; total: number } {
  const services: Record<string, number> = {};
  let total = 0;

  for (const [service, tools] of Object.entries(_registry)) {
    const count = Object.keys(tools).length;
    services[service] = count;
    total += count;
  }

  return { services, total };
}
