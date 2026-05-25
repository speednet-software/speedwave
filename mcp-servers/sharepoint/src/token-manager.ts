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
 * Tracks OAuth refresh-side errors for the SharePoint worker's health endpoint.
 * Post-ADR-060 the worker no longer performs the refresh itself (the host-side
 * `oauth` worker does); this class just remembers the most recent error so
 * the health endpoint can surface it.
 */
export class TokenManager {
  private lastTokenSaveError: Error | null = null;

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
