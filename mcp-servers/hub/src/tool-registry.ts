/**
 * Tool Registry - Dynamic Discovery. Workers are the SSOT for tool metadata (contract + policy).
 * Startup populates from workers, unavailable workers get an empty entry, refresh keeps it current.
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

// ── Mutable Tool Registry ────────────────────────────────────────────────────────────────────────

/**
 * Mutable registry of all tool metadata by service, populated/refreshed by initializeRegistry().
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

/** Read-only view of the registry for consumers; keys and values may change after refresh. */
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

// ── Initialization ───────────────────────────────────────────────────────────────────────────────

/**
 * Retry schedule for cold-start workers (SharePoint OAuth can take 5–15s).
 * Tests override via _setDiscoveryRetryDelaysForTesting.
 */
let discoveryRetryDelays: readonly number[] = DISCOVERY_RETRY_DELAYS_MS;

/**
 * Test-only: swap retry schedule so tests don't sleep 7s (`[]` disables retries).
 * @param delaysMs - Array of delays in ms; `[]` disables retries entirely.
 * @internal
 */
export function _setDiscoveryRetryDelaysForTesting(delaysMs: readonly number[]): void {
  discoveryRetryDelays = delaysMs;
}

/**
 * Discover tools for a single service with retry + backoff. Only retries on zero tools —
 * a non-empty registry is authoritative even if smaller than expected.
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
 * Initialize the registry from workers. Called once at startup before initializeBridges().
 * Discovers each service with startup retry; unavailable services get empty entries.
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
 * Refresh tools for a service from its worker; called by background refresh or on-demand.
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
 * Per-service exponential backoff (10s → 60s cap) for empty-registry catch-up.
 * Replaces legacy fixed 10s poll.
 */
let EMPTY_REGISTRY_RECHECK_BASE_MS = 10 * 1000;
const EMPTY_REGISTRY_RECHECK_MAX_MS = 60 * 1000;

/**
 * Override the empty-recheck base delay (for testing only).
 * Pass a small value (e.g. 5 ms) so the schedule-fire-reschedule chain
 * completes in milliseconds rather than minutes.
 * @param ms - Base delay in milliseconds.
 * @internal
 */
export function _setEmptyRecheckBaseMsForTesting(ms: number): void {
  EMPTY_REGISTRY_RECHECK_BASE_MS = ms;
}

/** Per-service timer + failure-count state. Cleared on successful discovery. */
interface EmptyServiceState {
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
}
const _emptyServiceTimers = new Map<string, EmptyServiceState>();

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
  /* c8 ignore next 3 — Node.js setInterval returns Timeout with .unref(), browser returns number */
  if (_refreshInterval && typeof _refreshInterval === 'object' && 'unref' in _refreshInterval) {
    _refreshInterval.unref();
  }

  // Start catch-up timers for initially-empty services with exponential backoff.
  for (const service of SERVICE_NAMES) {
    if (Object.keys(_registry[service] ?? {}).length === 0) {
      _scheduleEmptyServiceRecheck(service, 0);
    }
  }
}

/**
 * Compute backoff delay for the n-th consecutive empty-discovery failure.
 * @param failures - 0-based count of consecutive empty discoveries.
 * @internal
 */
export function _emptyRecheckDelayMs(failures: number): number {
  return Math.min(EMPTY_REGISTRY_RECHECK_BASE_MS * 2 ** failures, EMPTY_REGISTRY_RECHECK_MAX_MS);
}

/**
 * Schedule the next catch-up discovery for an empty service. Idempotent.
 * @param service - Service name to recheck.
 * @param failures - Number of preceding failed rechecks (drives backoff).
 */
function _scheduleEmptyServiceRecheck(service: string, failures: number): void {
  const existing = _emptyServiceTimers.get(service);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  const delay = _emptyRecheckDelayMs(failures);
  const timer = setTimeout(async () => {
    /* c8 ignore next 4 — race with 5-min refresh; testing requires coordinating both schedulers */
    if (_refreshInProgress) {
      _scheduleEmptyServiceRecheck(service, failures);
      return;
    }
    _refreshInProgress = true;
    try {
      await refreshServiceTools(service);
    } finally {
      _refreshInProgress = false;
    }
    if (Object.keys(_registry[service] ?? {}).length > 0) {
      // Success — drop timer; 5-min refresh handles maintenance.
      _emptyServiceTimers.delete(service);
      return;
    }
    _scheduleEmptyServiceRecheck(service, failures + 1);
  }, delay);
  // Don't keep the process alive for catch-up timers.
  if (timer && typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }
  _emptyServiceTimers.set(service, { failures, timer });
}

/**
 * Stop background refresh (for testing).
 */
export function stopBackgroundRefresh(): void {
  if (_refreshInterval) {
    clearInterval(_refreshInterval);
    _refreshInterval = null;
  }
  for (const { timer } of _emptyServiceTimers.values()) {
    if (timer) clearTimeout(timer);
  }
  _emptyServiceTimers.clear();
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

// ── Registry Accessors (same API as before) ──────────────────────────────────────────────────────

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

// ── Timeout Detection (SSOT - based on tool policy) ──────────────────────────────────────────────

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

// ── Service Filtering (ENABLED_SERVICES / DISABLED_OS_SERVICES) ──────────────────────────────────

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

// ── Bridge Generation ────────────────────────────────────────────────────────────────────────────

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
    // Bridge surface uses camelCase `methodName`; `tools/call` needs the worker's own tool name
    // (e.g. snake_case for @playwright/mcp), falling back to `methodName` for legacy metadata.
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

// ── Executor Wrapper Generation ──────────────────────────────────────────────────────────────────

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
 * @param toolName - camelCase tool method name, for tool-result PII audit attribution.
 */
export type WrapBridgeCallFn = <T>(
  bridgeCall: () => Promise<T>,
  serviceName: string,
  toolName?: string
) => Promise<T>;

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
        return wrapBridgeCall(() => bridgeMethod(p), service, methodName);
      }
    );
  }

  return wrappers;
}

// ── Validation ───────────────────────────────────────────────────────────────────────────────────

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
