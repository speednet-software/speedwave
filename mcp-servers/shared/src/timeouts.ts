/**
 * Centralna konfiguracja timeoutów - SSOT
 * @module shared/timeouts
 *
 * Wszystkie timeouty w Speedwave MCP powinny być importowane z tego modułu.
 * Bazowy timeout jest konfigurowalny przez zmienną środowiskową SPEEDWAVE_TIMEOUT_MS.
 *
 * Konwencja nazewnictwa:
 * - UPPER_SNAKE_CASE
 * - Suffix _MS dla wartości w milisekundach
 */

import { ts } from './logger.js';

/**
 * Parse and validate base timeout from environment variable.
 * Returns default 120s (120000ms) if invalid.
 */
const parseBaseTimeout = (): number => {
  const DEFAULT_TIMEOUT = 120000;
  const envValue = process.env.SPEEDWAVE_TIMEOUT_MS;

  if (!envValue) {
    return DEFAULT_TIMEOUT;
  }

  const parsed = parseInt(envValue, 10);

  // Invalid: NaN, negative, or zero
  if (isNaN(parsed) || parsed <= 0) {
    console.warn(
      `${ts()} [timeouts] Invalid SPEEDWAVE_TIMEOUT_MS value: "${envValue}". Using default: ${DEFAULT_TIMEOUT}ms`
    );
    return DEFAULT_TIMEOUT;
  }

  return parsed;
};

/** Base timeout from env or default 120s */
const BASE_MS = parseBaseTimeout();

/**
 * All timeout constants in milliseconds.
 * Naming: UPPER_SNAKE_CASE, suffix _MS
 */
export const TIMEOUTS = {
  /** Single API call (Graph, Redmine, etc.) - fixed 30s */
  API_CALL_MS: 30_000,

  /** OAuth token refresh - fixed 30s */
  TOKEN_REFRESH_MS: 30_000,

  /** Worker health check - fixed 5s */
  HEALTH_CHECK_MS: 5_000,

  /** Worker status cache TTL - fixed 1 min */
  CACHE_TTL_MS: 60_000,

  /** Minimum timeout for any operation - fixed 1s */
  MIN_MS: 1_000,

  /** Code execution in Hub = BASE */
  EXECUTION_MS: BASE_MS,

  /** Hub to Worker HTTP request = BASE */
  WORKER_REQUEST_MS: BASE_MS,

  /** Long operations (sync) = BASE * 5 (10min default) */
  LONG_OPERATION_MS: Math.round(BASE_MS * 5),

  /** Async jobs (extraction) = BASE * 7.5 (15min default) */
  ASYNC_JOB_MS: Math.round(BASE_MS * 7.5),

  /** Chunk processing staleness detection - fixed 30 minutes */
  STALE_CHUNK_TIMEOUT_MS: 30 * 60 * 1000,

  /** SharePoint sync operation - configurable via SHAREPOINT_SYNC_TIMEOUT_MS env (default: 15min) */
  SHAREPOINT_SYNC_MS: parseInt(process.env.SHAREPOINT_SYNC_TIMEOUT_MS || '900000', 10),
} as const;

/**
 * Type representing valid keys of the TIMEOUTS object.
 * Use this type when you need to reference timeout keys dynamically.
 * @typedef {keyof typeof TIMEOUTS} TimeoutKey
 * @internal
 */
export type TimeoutKey = keyof typeof TIMEOUTS;
