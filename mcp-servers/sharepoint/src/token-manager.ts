/**
 * Token Management Module — health-status helpers only.
 *
 * Refresh logic moved to the host-side `oauth` worker (ADR-060 / PR3). The
 * SharePoint container has a `/tokens:ro` mount and cannot write tokens
 * itself; refresh is delegated via `@speedwave/mcp-shared`'s `oauth-client`.
 *
 * This file keeps the previous `lastTokenSaveError` accessors so the worker's
 * health endpoint can still report token-related errors that surface during
 * the refresh round-trip.
 * @module sharepoint/token-manager
 */

/**
 * Token management configuration. After ADR-060 `clientId`/`tenantId` are no
 * longer mounted into the worker — they live in the host-only oauth.json. The
 * fields are kept as empty strings in the SharePoint config to preserve API
 * shape for callers; they are not consulted here.
 * @interface TokenManagerConfig
 */
export interface TokenManagerConfig {
  clientId: string;
  tenantId: string;
  tokensDir: string;
}

/**
 * Manages OAuth health reporting for the SharePoint worker. Refresh is now
 * delegated to the host-side `oauth` worker; this class only tracks the most
 * recent refresh-side error so the worker's health endpoint can expose it.
 */
export class TokenManager {
  private lastTokenSaveError: Error | null = null;

  /**
   * Create a TokenManager. The `config` is accepted for API compatibility
   * with v1; only `tokensDir` is used today.
   * @param _config - token manager configuration (unused after ADR-060)
   */
  constructor(_config: TokenManagerConfig) {}

  /**
   * Get the last refresh-side error (if any). Set by callers (e.g. SharePoint
   * client) when an oauth-client call surfaces a non-fatal error worth
   * reporting on the health endpoint.
   * @returns last error or null
   */
  getLastTokenSaveError(): Error | null {
    return this.lastTokenSaveError;
  }

  /**
   * Record a refresh-side error to expose on the health endpoint.
   * @param err - the error to record
   */
  setLastTokenSaveError(err: Error): void {
    this.lastTokenSaveError = err;
  }

  /**
   * Clear the last error after it has been observed/handled.
   */
  clearTokenSaveError(): void {
    this.lastTokenSaveError = null;
  }

  /**
   * Health status summary for the worker's /health endpoint.
   * @returns object with the latest token-related error message, or null
   */
  getHealthStatus(): { tokenSaveError: string | null } {
    return {
      tokenSaveError: this.lastTokenSaveError?.message ?? null,
    };
  }
}
