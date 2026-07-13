/**
 * Connection status tracking for MCP workers with external dependencies: each holds one
 * `ConnectionStatusTracker` exposing {@link HealthStatus} via `getHealthStatus()`.
 * @module shared/health-status
 */

import { ts } from './logger.js';

/** Connection state for a worker's external dependency. */
export type ConnectionStatus = 'unknown' | 'ok' | 'failed';

/** Health snapshot exposed by every worker with external dependencies. */
export interface HealthStatus {
  /** Current connection state to the external service. */
  connection: ConnectionStatus;
  /** Last connection error message, or null when healthy / unknown. */
  connectionError: string | null;
  /** Optional token-save error for SharePoint (ADR-060); only workers owning a TokenManager set it. */
  tokenSaveError?: string | null;
}

/** Default warm-up window during which `unknown` status is treated as healthy. */
export const DEFAULT_WARMUP_MS = 10_000;

/**
 * Tracks the connection status of an external dependency. Workers create one instance per client and
 * update it via {@link setOk} / {@link setFailed}; `createMCPServer`'s healthCheck reads it via {@link makeStandardHealthCheck}.
 */
export class ConnectionStatusTracker {
  private _status: ConnectionStatus = 'unknown';
  private _error: string | null = null;
  private _warmupExpiresAt: number;

  /**
   * Build a fresh tracker starting in the `unknown` state.
   * @param warmupMs - Window in which `unknown` is treated as healthy (background test in flight). Default 10 s.
   */
  constructor(warmupMs: number = DEFAULT_WARMUP_MS) {
    this._warmupExpiresAt = Date.now() + warmupMs;
  }

  /** Mark the connection as healthy. Clears any prior error. */
  setOk(): void {
    this._status = 'ok';
    this._error = null;
  }

  /**
   * Mark the connection as failed with the supplied error.
   * @param err - The failure reason; `Error.message` is preferred, otherwise stringified.
   */
  setFailed(err: unknown): void {
    this._status = 'failed';
    this._error = err instanceof Error ? err.message : String(err);
  }

  /**
   * Reset to `unknown` with a fresh warm-up window.
   * @param warmupMs - New warm-up duration in milliseconds.
   */
  reset(warmupMs: number = DEFAULT_WARMUP_MS): void {
    this._status = 'unknown';
    this._error = null;
    this._warmupExpiresAt = Date.now() + warmupMs;
  }

  /** Current connection status. */
  getStatus(): ConnectionStatus {
    return this._status;
  }

  /** Last failure message, or `null` when not failed. */
  getError(): string | null {
    return this._error;
  }

  /** True while status is `unknown` AND the warm-up window has not elapsed. */
  isInWarmup(): boolean {
    return this._status === 'unknown' && Date.now() < this._warmupExpiresAt;
  }

  /** Build a {@link HealthStatus} snapshot. */
  getHealth(): HealthStatus {
    return {
      connection: this._status,
      connectionError: this._error,
    };
  }
}

/**
 * Build a healthCheck callback for `createMCPServer` driven by a tracker: `ok` → healthy; `failed` → throws
 * with the error; `unknown` → healthy during warm-up, else throws `${serviceName} not configured` (legacy UX).
 * @param tracker - Shared status tracker owned by the worker client.
 * @param serviceName - Human-readable service name (e.g. `'GitLab'`).
 */
export function makeStandardHealthCheck(
  tracker: ConnectionStatusTracker,
  serviceName: string
): () => Promise<void> {
  return async () => {
    const status = tracker.getStatus();
    if (status === 'failed') {
      throw new Error(`${serviceName} connection failed: ${tracker.getError() ?? 'unknown error'}`);
    }
    if (status === 'unknown' && !tracker.isInWarmup()) {
      throw new Error(`${serviceName} not configured`);
    }
  };
}

/**
 * Schedule a background connection test that updates a tracker on completion; the `test` promise is
 * consumed with `void` so the caller is never blocked. Failures are logged at `warn` level with the service name.
 * @param tracker - Status tracker that receives the test result.
 * @param test - Async probe that throws on failure.
 * @param serviceName - Human-readable service name (e.g. `'Slack'`).
 */
export function backgroundConnectionTest(
  tracker: ConnectionStatusTracker,
  test: () => Promise<void>,
  serviceName: string
): void {
  void test()
    .then(() => tracker.setOk())
    .catch((err) => {
      tracker.setFailed(err);
      console.warn(
        `${ts()} ${serviceName}: background connection test failed: ${tracker.getError()}`
      );
    });
}
