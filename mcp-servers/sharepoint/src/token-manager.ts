/**
 * Token Management Module - Handles OAuth token refresh, save, and load operations
 * @module sharepoint/token-manager
 */

import fs from 'fs/promises';
import path from 'path';
import { TIMEOUTS, ts } from '@speedwave/mcp-shared';

/**
 * OAuth token response from Microsoft identity platform
 * @interface OAuthTokenResponse
 * @property {string} access_token - New access token
 * @property {string} [refresh_token] - New refresh token (optional)
 * @property {string} token_type - Token type (usually "Bearer")
 * @property {number} expires_in - Token expiration time in seconds
 */
interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

/**
 * Token management configuration
 * @interface TokenManagerConfig
 */
export interface TokenManagerConfig {
  clientId: string;
  tenantId: string;
  tokensDir: string;
}

/**
 * Token data structure
 * @interface TokenData
 */
export interface TokenData {
  accessToken: string;
  refreshToken: string;
}

/**
 * Manages OAuth token lifecycle including refresh, persistence, and error tracking
 * @class TokenManager
 */
export class TokenManager {
  private config: TokenManagerConfig;
  private lastTokenSaveError: Error | null = null;

  /**
   * Create a TokenManager
   * @param {TokenManagerConfig} config - Token manager configuration
   */
  constructor(config: TokenManagerConfig) {
    this.config = config;
  }

  /**
   * Get the last token save error (if any)
   * This allows callers to check if token refresh succeeded but saving to disk failed
   * @returns {Error | null} Last token save error or null if no error occurred
   */
  getLastTokenSaveError(): Error | null {
    return this.lastTokenSaveError;
  }

  /**
   * Clear the last token save error
   * Useful after handling the error or acknowledging it
   */
  clearTokenSaveError(): void {
    this.lastTokenSaveError = null;
  }

  /**
   * Get health status including token save errors
   * @returns {Object} Health status with token save error information
   */
  getHealthStatus(): { tokenSaveError: string | null } {
    return {
      tokenSaveError: this.lastTokenSaveError ? this.lastTokenSaveError.message : null,
    };
  }

  /**
   * Save tokens to disk with retry logic for transient failures
   * @param {string} accessToken - Access token to save
   * @param {string} [refreshToken] - Optional refresh token to save
   * @param {number} maxRetries - Maximum number of retry attempts (default: 2)
   * @param {number} retryDelayMs - Delay between retries in milliseconds (default: 100)
   * @returns {Promise<void>}
   * @throws {Error} If all retry attempts fail
   */
  async saveTokensWithRetry(
    accessToken: string,
    refreshToken?: string,
    maxRetries: number = 2,
    retryDelayMs: number = 100
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await fs.writeFile(path.join(this.config.tokensDir, 'access_token'), accessToken, {
          mode: 0o600,
        });
        if (refreshToken) {
          await fs.writeFile(path.join(this.config.tokensDir, 'refresh_token'), refreshToken, {
            mode: 0o600,
          });
        }
        // Success - clear any previous error
        this.lastTokenSaveError = null;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries) {
          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }

    // All retries failed - store the error for later inspection
    if (lastError) {
      this.lastTokenSaveError = lastError;
      throw lastError;
    }
  }

  /**
   * Refresh access token using refresh token
   * Updates tokens in memory and writes them to /tokens/ directory
   * @param {string} currentRefreshToken - Current refresh token to use
   * @returns {Promise<TokenData>} New token data
   * @throws {Error} If token refresh fails or request times out
   */
  async refreshAccessToken(currentRefreshToken: string): Promise<TokenData> {
    const { tenantId, clientId } = this.config;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.TOKEN_REFRESH_MS);

    try {
      const response = await fetch(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: currentRefreshToken,
            scope:
              'https://graph.microsoft.com/Sites.Read.All https://graph.microsoft.com/Files.ReadWrite.All https://graph.microsoft.com/User.Read offline_access',
          }),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        const error = await response.json();
        console.error(`${ts()} Token refresh failed:`, error);
        throw new Error('Failed to refresh access token');
      }

      const data = (await response.json()) as OAuthTokenResponse;

      // Prepare new token data
      const newTokens: TokenData = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || currentRefreshToken,
      };

      // Write updated tokens back to /tokens/ with retry logic
      try {
        await this.saveTokensWithRetry(newTokens.accessToken, data.refresh_token);
        console.log(`${ts()} ✅ Tokens refreshed and saved`);
      } catch (saveError) {
        // Token refresh succeeded but save failed - tokens work in memory but won't survive restart
        // The error is also stored in this.lastTokenSaveError for programmatic access
        console.error(`${ts()} ❌ Failed to save refreshed tokens to disk after retries:`, {
          error: saveError instanceof Error ? saveError.message : String(saveError),
          consequence:
            'Tokens valid in memory but old tokens on disk. After container restart, authentication may fail.',
          suggestion: 'Check if tokens directory is writable (not read-only mount)',
          retriesAttempted: 2,
        });
      }

      return newTokens;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Token refresh timeout after ${TIMEOUTS.TOKEN_REFRESH_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
