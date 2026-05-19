/**
 * Tool Registry - Dynamic Discovery
 * @module tool-registry
 *
 * Central registry of tool metadata fetched from workers.
 * Workers are the SSOT for ALL tool metadata (contract + policy via _meta).
 *
 * Lifecycle:
 * 1. At startup, initializeRegistry() populates the registry from workers
 * 2. If a worker is unavailable, its service has an empty registry entry
 * 3. Background refresh periodically updates tools from workers
 * 4. All consumers (search-tools, executor, handlers) use the same API
 */

import { ToolMetadata, TimeoutClass } from './hub-types.js';
import { getAllServiceNames } from './service-list.js';
import { discoverAndMergeService } from './tool-discovery.js';
import { ts, TIMEOUTS } from '@speedwave/mcp-shared';
import { DISCOVERY_RETRY_DELAYS_MS } from './http-bridge.js';

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
 * Empty until initializeRegistry() reads ENABLED_SERVICES env var.
 */
export let SERVICE_NAMES: readonly string[] = [];

//═══════════════════════════════════════════════════════════════════════════════
// Initialization
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Retry backoff for initial tool discovery. Uses the longer
 * `DISCOVERY_RETRY_DELAYS_MS` schedule (~30 s total) because some workers
 * do real I/O on cold start: SharePoint resolves site_id through Graph
 * and may have to refresh an expired OAuth token via the host-side oauth
 * worker — that whole chain can run 5–15 s and the previous 7 s budget
 * left the registry empty until the 5-minute background refresh.
 *
 * Tests can override with `[0, 0, 0]` via `_setDiscoveryRetryDelaysForTesting`
 * so the suite doesn't pay the 30 s real wall-clock of the production schedule.
 */
let discoveryRetryDelays: readonly number[] = DISCOVERY_RETRY_DELAYS_MS;

/**
 * Test-only hook: swap the discovery retry schedule so unit tests don't sleep
 * for up to 7 s. Keep the production value intact otherwise.
 * @param delaysMs - Array of delays in ms; `[]` disables retries entirely.
 * @internal
 */
export function _setDiscoveryRetryDelaysForTesting(delaysMs: readonly number[]): void {
  discoveryRetryDelays = delaysMs;
}

/**
 * Discover tools for a single service with retry + backoff.
 * Only retries when discovery returned zero tools — a non-empty registry
 * is considered authoritative even if it is smaller than expected.
 * @param service - Service name to discover
 */
async function discoverWithStartupRetry(service: string): Promise<Record<string, ToolMetadata>> {
  const attempts = discoveryRetryDelays.length + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const tools = await discoverAndMergeService(service);
      if (Object.keys(tools).length > 0) return tools;
    } catch (error) {
      console.warn(
        `${ts()} [tool-registry] ${service}: discovery attempt ${attempt + 1} failed — ` +
          (error instanceof Error ? error.message : String(error))
      );
    }

    const delay = discoveryRetryDelays[attempt];
    if (delay === undefined) break;
    console.log(
      `${ts()} [tool-registry] ${service}: retrying discovery in ${delay / 1000}s (${attempt + 1}/${discoveryRetryDelays.length})...`
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  console.warn(
    `${ts()} [tool-registry] ${service}: registry empty after ${discoveryRetryDelays.length + 1} attempts — will populate on next background refresh`
  );
  return {};
}

/**
 * Initialize the registry from workers.
 * Called once at startup before initializeBridges().
 *
 * For each service:
 * 1. Try to discover tools from worker (JSON-RPC tools/list)
 * 2. Retry with backoff if the first attempt returns zero tools — a
 *    slow-starting worker (e.g. `mcp-playwright` spinning up Chromium)
 *    may not be ready when the hub boots, and without the retry the
 *    service's registry stays empty until the next background refresh
 *    five minutes later.
 * 3. Merge tool data including `_meta` fields.
 * 4. If the worker is still unavailable after retries, the service gets
 *    an empty registry entry; background refresh will populate it later.
 */
export async function initializeRegistry(): Promise<void> {
  if (_initialized) return;
  _initialized = true; // Set immediately to prevent concurrent double-initialization

  // Update SERVICE_NAMES to include plugin services from env
  SERVICE_NAMES = getAllServiceNames();

  console.log(`${ts()} [tool-registry] Initializing dynamic registry...`);

  for (const service of SERVICE_NAMES) {
    const tools = await discoverWithStartupRetry(service);
    _registry[service] = tools;
    console.log(`${ts()} [tool-registry] ${service}: ${Object.keys(tools).length} tools loaded`);
  }

  // Start background refresh (every 5 minutes)
  _startBackgroundRefresh();

  const stats = getRegistryStats();
  console.log(
    `${ts()} [tool-registry] Registry initialized: ${stats.total} tools across ${Object.keys(stats.services).length} services`
  );
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
    cachedLongTimeoutTools = null; // Invalidate cache after update
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
 * Fast catch-up interval for services whose initial discovery returned zero
 *  tools. Without this, an unlucky cold-start race left the registry empty
 *  for up to 5 minutes (the regular background refresh interval) — which
 *  shows up to the user as "SharePoint MCP is not enabled" even though the
 *  worker started successfully a second after the hub's discovery timeout.
 *  10 s is fast enough to feel instant in a Claude session, slow enough
 *  not to spam Graph with discovery requests when a worker is genuinely
 *  broken. Each catch-up tick only touches services with an empty
 *  registry — populated services skip until the next 5-minute pass.
 */
const EMPTY_REGISTRY_RECHECK_MS = 10 * 1000;
let _emptyRecheckInterval: NodeJS.Timeout | number | null = null;

/**
 * Start background refresh of all enabled services.
 */
function _startBackgroundRefresh(): void {
  /* c8 ignore next — guard for re-entrant callers; initializeRegistry() only
   * calls this once (returns early on duplicate calls via _initialized flag) */
  if (_refreshInterval) return;

  const REFRESH_MS = 5 * 60 * 1000; // 5 minutes
  _refreshInterval = setInterval(async () => {
    if (_refreshInProgress) return; // Skip overlapping refresh
    _refreshInProgress = true;
    try {
      for (const service of SERVICE_NAMES) {
        await refreshServiceTools(service);
      }
    } finally {
      _refreshInProgress = false;
    }
  }, REFRESH_MS);

  // Don't prevent process from exiting
  /* c8 ignore next 3 — in Node.js setInterval always returns a Timeout with .unref();
   * the false branch only fires in browser-like environments (setInterval returns a number) */
  if (_refreshInterval && typeof _refreshInterval === 'object' && 'unref' in _refreshInterval) {
    _refreshInterval.unref();
  }

  // Faster catch-up loop for services that started with empty registries.
  // Self-stops once every service has at least one tool — back to the 5-min
  // schedule for ongoing maintenance. The setInterval callback is exercised
  // end-to-end during cold-start; reproducing in unit tests would require
  // fake-timer plumbing + production SERVICE_NAMES fixture — disproportionate
  // for a recovery loop, hence the v8 ignore.
  /* c8 ignore start */
  _emptyRecheckInterval = setInterval(async () => {
    if (_refreshInProgress) return;
    const emptyServices = SERVICE_NAMES.filter((s) => Object.keys(_registry[s] ?? {}).length === 0);
    if (emptyServices.length === 0) {
      if (_emptyRecheckInterval !== null) {
        clearInterval(_emptyRecheckInterval as NodeJS.Timeout);
        _emptyRecheckInterval = null;
      }
      return;
    }
    _refreshInProgress = true;
    try {
      for (const service of emptyServices) {
        await refreshServiceTools(service);
      }
    } finally {
      _refreshInProgress = false;
    }
  }, EMPTY_REGISTRY_RECHECK_MS);
  /* c8 ignore stop */

  /* c8 ignore next 3 — Node.js Timeout always has .unref() in production */
  if (
    _emptyRecheckInterval &&
    typeof _emptyRecheckInterval === 'object' &&
    'unref' in _emptyRecheckInterval
  ) {
    _emptyRecheckInterval.unref();
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
  if (_emptyRecheckInterval !== null) {
    clearInterval(_emptyRecheckInterval as NodeJS.Timeout);
    _emptyRecheckInterval = null;
  }
}

/**
 * Reset registry state (for testing only).
 * Import via `test-helpers.ts`, not directly from this module.
 * @internal
 */
export function _resetRegistryForTesting(): void {
  for (const key of Object.keys(_registry)) {
    delete _registry[key];
  }
  _initialized = false;
  _refreshInProgress = false;
  SERVICE_NAMES = [];
  cachedLongTimeoutTools = null;
  stopBackgroundRefresh();
}

/**
 * Set SERVICE_NAMES from test helpers (for testing only).
 * Import via `test-helpers.ts`, not directly from this module.
 * @internal
 * @param names - Array of service names
 */
export function _setServiceNamesForTesting(names: string[]): void {
  SERVICE_NAMES = names;
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
 * Cached result for getLongTimeoutTools().
 * Invalidated on registry reset and rebuilt on next call.
 */
let cachedLongTimeoutTools: Array<{ service: string; method: string }> | null = null;

/**
 * Get list of all tools with 'long' timeout class.
 * Reads from the live registry so it reflects the latest discovery state.
 */
export function getLongTimeoutTools(): Array<{ service: string; method: string }> {
  if (cachedLongTimeoutTools !== null) {
    return cachedLongTimeoutTools;
  }

  cachedLongTimeoutTools = [];
  for (const [service, tools] of Object.entries(_registry)) {
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
    // The JS bridge surface uses `methodName` (camelCase, e.g. `browserNavigate`)
    // but the actual `tools/call` request must carry the worker's own tool
    // name (often snake_case, e.g. `browser_navigate` for `@playwright/mcp`).
    // Fall back to `methodName` for legacy metadata that was built without
    // `workerToolName` — covers all in-house workers whose tool names
    // already match the camelCase convention.
    const workerToolName = metadata.workerToolName ?? methodName;
    bridge[methodName] = (params?: Record<string, unknown>) => {
      const perToolTimeout = metadata.timeoutMs;
      const remainingTimeout = getTimeoutMs?.();
      const timeoutMs = perToolTimeout ?? remainingTimeout;
      const options = timeoutMs ? { timeoutMs } : undefined;
      return callWorker(service, workerToolName, params || {}, options);
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
