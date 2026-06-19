/**
 * Token Management Module — health-status helpers only.
 * @module sharepoint/token-manager
 */

/**
 * Tracks OAuth refresh-side errors for the SharePoint worker's health endpoint.
 */
export class TokenManager {
  private lastTokenSaveError: Error | null = null;

  /**
   * Get the last refresh-side error (if any).
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
