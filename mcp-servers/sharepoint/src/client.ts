/**
 * SharePoint/Microsoft Graph API Client with OAuth token refresh and path traversal protection
 * @module sharepoint/client
 */

import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { Mutex } from 'async-mutex';
import { loadToken, TIMEOUTS, ts, withSetupGuidance } from '@speedwave/mcp-shared';
import { TokenManager } from './token-manager.js';
import { PathValidator } from './path-validator.js';
import { splitPath } from './path-utils.js';

//═══════════════════════════════════════════════════════════════════════════════
// Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Configuration for SharePoint client with OAuth credentials and site details
 * @interface SharePointConfig
 * @property {string} clientId - Azure AD application client ID
 * @property {string} tenantId - Azure AD tenant ID
 * @property {string} siteId - SharePoint site ID
 * @property {string} basePath - Base path for file operations
 * @property {string} accessToken - OAuth access token
 * @property {string} refreshToken - OAuth refresh token
 */
export interface SharePointConfig {
  clientId: string;
  tenantId: string;
  siteId: string;
  basePath: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Represents a SharePoint file or folder with metadata
 * @interface SharePointFile
 * @property {string} [id] - File/folder ID
 * @property {string} name - File/folder name
 * @property {string} path - Relative path
 * @property {number} [size] - File size in bytes
 * @property {string} [lastModified] - Last modified date (ISO string)
 * @property {boolean} isFolder - Whether this is a folder
 * @property {string} [webUrl] - SharePoint web URL
 * @property {string} [eTag] - Entity tag for change detection
 */
export interface SharePointFile {
  id?: string;
  name: string;
  path: string;
  size?: number;
  lastModified?: string;
  isFolder: boolean;
  webUrl?: string;
  eTag?: string;
}

/**
 * Represents a SharePoint user with authentication details
 * @interface SharePointUser
 * @property {string} displayName - User's display name
 * @property {string} email - User's email address
 * @property {string} userPrincipalName - User principal name
 * @property {string} id - User ID
 */
export interface SharePointUser {
  displayName: string;
  email: string;
  userPrincipalName: string;
  id: string;
}

/**
 * Metadata for a SharePoint drive item from Microsoft Graph API
 * @interface DriveItemMetadata
 * @property {string} [id] - Item ID
 * @property {string} name - Item name
 * @property {number} [size] - Item size
 * @property {string} [lastModifiedDateTime] - Last modified date
 * @property {string} [webUrl] - Web URL
 * @property {Object} [file] - File metadata
 * @property {string} file.mimeType - MIME type
 * @property {Object} [folder] - Folder metadata
 * @property {number} folder.childCount - Number of children
 * @property {string} [eTag] - Entity tag for version control
 */
export interface DriveItemMetadata {
  id?: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  webUrl?: string;
  file?: { mimeType: string };
  folder?: { childCount: number };
  '@microsoft.graph.downloadUrl'?: string;
  eTag?: string;
}

//═══════════════════════════════════════════════════════════════════════════════
// Client Class
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Helper function for conditional debug logging
 * Only logs when DEBUG environment variable is set
 * @param {string} message - Debug message
 * @param {unknown} [data] - Optional data to log
 */
function debugLog(message: string, data?: unknown): void {
  if (process.env.DEBUG) {
    if (data !== undefined) {
      console.log(`${ts()} ${message}`, data);
    } else {
      console.log(`${ts()} ${message}`);
    }
  }
}

/**
 * SharePoint/Microsoft Graph API client with automatic token refresh and error handling
 * Acts as a facade coordinating TokenManager and PathValidator modules
 * @class SharePointClient
 */
export class SharePointClient {
  private config: SharePointConfig;
  private tokensDir: string;
  private tokenManager: TokenManager;
  private pathValidator: PathValidator;
  private refreshMutex: Mutex;

  /**
   * Create a SharePoint client
   * @param {SharePointConfig} config - SharePoint configuration
   * @param {string} tokensDir - Path to tokens directory
   */
  constructor(config: SharePointConfig, tokensDir: string) {
    this.config = config;
    this.tokensDir = tokensDir;

    // Initialize modules
    this.tokenManager = new TokenManager({
      clientId: config.clientId,
      tenantId: config.tenantId,
      tokensDir,
    });

    this.pathValidator = new PathValidator();
    this.refreshMutex = new Mutex();
  }

  /**
   * Get the last token save error (if any)
   * This allows callers to check if token refresh succeeded but saving to disk failed
   * @returns {Error | null} Last token save error or null if no error occurred
   */
  getLastTokenSaveError(): Error | null {
    return this.tokenManager.getLastTokenSaveError();
  }

  /**
   * Clear the last token save error
   * Useful after handling the error or acknowledging it
   */
  clearTokenSaveError(): void {
    this.tokenManager.clearTokenSaveError();
  }

  /**
   * Get health status including token save errors
   * @returns {Object} Health status with token save error information
   */
  getHealthStatus(): { tokenSaveError: string | null } {
    return this.tokenManager.getHealthStatus();
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Error Handling
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Format error messages consistently
   * Sanitizes errors and provides user-friendly messages
   * @param {unknown} error - Error object from Graph API
   * @returns {string} Formatted, user-friendly error message
   */
  static formatError(error: unknown): string {
    const e = error as { message?: string };
    const message = e.message || '';

    // Handle Graph API error responses
    if (message.includes('401') || message.includes('Unauthorized')) {
      return withSetupGuidance('Authentication failed. Your SharePoint token may have expired.');
    }

    if (message.includes('403') || message.includes('Forbidden')) {
      return 'Permission denied. Your SharePoint token may not have sufficient permissions.';
    }

    if (message.includes('404') || message.includes('not found')) {
      return 'Resource not found in SharePoint.';
    }

    if (message.includes('security check failed') || message.includes('traversal')) {
      return 'Invalid path: security check failed (path traversal not allowed).';
    }

    if (message.includes('refresh') || message.includes('token')) {
      return withSetupGuidance('Token refresh failed.');
    }

    return message || 'SharePoint API error';
  }

  /**
   * Get current config (for external access to updated tokens)
   * @returns {SharePointConfig} Current configuration with potentially refreshed tokens
   */
  getConfig(): SharePointConfig {
    return this.config;
  }

  /**
   * Refresh access token using refresh token
   * Updates config with new tokens and writes them to /tokens/ directory
   * @returns {Promise<void>}
   * @throws {Error} If token refresh fails or request times out
   * @private
   */
  private async refreshAccessToken(): Promise<void> {
    const newTokens = await this.tokenManager.refreshAccessToken(this.config.refreshToken);

    // Update config with new tokens
    this.config.accessToken = newTokens.accessToken;
    this.config.refreshToken = newTokens.refreshToken;
  }

  /**
   * Call Graph API with automatic token refresh
   * Automatically retries with refreshed token on 401 responses
   * @param {string} url - Graph API endpoint URL
   * @param {RequestInit} [options={}] - Fetch request options
   * @returns {Promise<Response>} API response
   * @throws {Error} If request times out
   * @private
   */
  private async callGraphAPI(url: string, options: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.API_CALL_MS);

    const headers = {
      Authorization: `Bearer ${this.config.accessToken}`,
      ...options.headers,
    };

    try {
      let response = await fetch(url, { ...options, headers, signal: controller.signal });

      // Handle token expiration with mutex to prevent race conditions
      if (response.status === 401) {
        clearTimeout(timeoutId);

        // Save token before acquiring mutex - for double-check locking
        const tokenBeforeRefresh = this.config.accessToken;
        const release = await this.refreshMutex.acquire();

        try {
          // Double-check: another thread may have already refreshed the token
          if (tokenBeforeRefresh !== this.config.accessToken) {
            // Token was refreshed by another thread - retry with the new token
            const retryController = new AbortController();
            const retryTimeoutId = setTimeout(() => retryController.abort(), TIMEOUTS.API_CALL_MS);

            try {
              response = await fetch(url, {
                ...options,
                headers: {
                  Authorization: `Bearer ${this.config.accessToken}`,
                  ...options.headers,
                },
                signal: retryController.signal,
              });
              return response;
            } catch (error) {
              if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`Graph API request timeout after ${TIMEOUTS.API_CALL_MS}ms`, {
                  cause: error,
                });
              }
              throw error;
            } finally {
              clearTimeout(retryTimeoutId);
            }
          }

          // Token hasn't changed - we need to refresh it
          debugLog('🔄 Access token expired, refreshing...');
          await this.refreshAccessToken();

          // Retry with new token and fresh timeout
          const retryController = new AbortController();
          const retryTimeoutId = setTimeout(() => retryController.abort(), TIMEOUTS.API_CALL_MS);

          try {
            response = await fetch(url, {
              ...options,
              headers: {
                Authorization: `Bearer ${this.config.accessToken}`,
                ...options.headers,
              },
              signal: retryController.signal,
            });
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
              throw new Error(`Graph API request timeout after ${TIMEOUTS.API_CALL_MS}ms`, {
                cause: error,
              });
            }
            throw error;
          } finally {
            clearTimeout(retryTimeoutId);
          }
        } finally {
          release();
        }
      }

      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Graph API request timeout after ${TIMEOUTS.API_CALL_MS}ms`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Encode path for Graph API
   * Encodes each path segment separately to handle special characters
   * @param {string} pathStr - Path to encode
   * @returns {string} URL-encoded path
   * @private
   */
  private encodeGraphPath(pathStr: string): string {
    return pathStr
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  /**
   * Build URL for folder children endpoint
   * @param {string} parentDir - Parent directory path
   * @returns {string} Graph API URL for folder children
   * @private
   */
  private buildFolderChildrenUrl(parentDir: string): string {
    if (parentDir) {
      return `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root:/${this.encodeGraphPath(parentDir)}:/children`;
    }
    return `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root/children`;
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Tool Implementations
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * List files in context directory with pagination support
   * Handles Microsoft Graph API pagination via `@odata.nextLink` to ensure
   * complete listings for directories with more items than the default page size.
   *
   * **404 Handling:** Returns empty array if folder doesn't exist.
   * This enables push operations to create new folders safely.
   * @param {Object} [params={}] - Parameters
   * @param {string} [params.path] - Relative path to list (default: root)
   * @returns {Promise<{files: SharePointFile[], exists: boolean}>} Array of files and exists flag
   * @throws {Error} If path is invalid or API call fails (except 404)
   */
  async listFiles(
    params: { path?: string } = {}
  ): Promise<{ files: SharePointFile[]; exists: boolean }> {
    const relativePath = params.path || '';

    if (relativePath && !this.pathValidator.validatePath(relativePath)) {
      throw new Error('Invalid path (security check failed)');
    }

    const fullPath = relativePath
      ? `${this.config.basePath}/${relativePath}`
      : this.config.basePath;

    const initialUrl = `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root:/${this.encodeGraphPath(fullPath)}:/children`;

    // Collect all items across paginated responses
    const allItems: Array<{
      id?: string;
      name: string;
      size?: number;
      lastModifiedDateTime?: string;
      folder?: unknown;
      webUrl?: string;
      eTag?: string;
    }> = [];

    let nextUrl: string | undefined = initialUrl;

    // Follow pagination links until all items are retrieved
    while (nextUrl) {
      const response = await this.callGraphAPI(nextUrl);

      if (!response.ok) {
        // 404 means folder doesn't exist yet - return empty list with exists: false
        // This allows push operations to create new folders while listFileIds can detect non-existence
        if (response.status === 404) {
          return { files: [], exists: false };
        }
        const errorData = (await response.json()) as { error?: { message?: string } };
        throw new Error(errorData.error?.message || 'Failed to list files');
      }

      const data = (await response.json()) as {
        value?: Array<{
          id?: string;
          name: string;
          size?: number;
          lastModifiedDateTime?: string;
          folder?: unknown;
          webUrl?: string;
          eTag?: string;
        }>;
        '@odata.nextLink'?: string;
      };

      const items = data.value || [];
      allItems.push(...items);

      // Get next page URL if available
      nextUrl = data['@odata.nextLink'];
    }

    const files: SharePointFile[] = allItems.map((item) => ({
      id: item.id,
      name: item.name,
      path: relativePath ? `${relativePath}/${item.name}` : item.name,
      size: item.size,
      lastModified: item.lastModifiedDateTime,
      isFolder: !!item.folder,
      webUrl: item.webUrl,
      eTag: item.eTag,
    }));

    return { files, exists: true };
  }

  /**
   * Get file metadata by ID
   * @param {string} fileId - SharePoint file/folder ID
   * @returns {Promise<DriveItemMetadata>} File metadata including download URL
   * @throws {Error} If file not found or API call fails
   */
  async getFileMetadata(fileId: string): Promise<DriveItemMetadata> {
    const url = `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/items/${fileId}`;

    const response = await this.callGraphAPI(url);

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: { message?: string } };
      throw new Error(errorData.error?.message || 'Failed to get file metadata');
    }

    return (await response.json()) as DriveItemMetadata;
  }

  /**
   * Get current authenticated user
   * @returns {Promise<SharePointUser>} User information including display name and email
   * @throws {Error} If API call fails
   */
  async getCurrentUser(): Promise<SharePointUser> {
    const response = await this.callGraphAPI('https://graph.microsoft.com/v1.0/me');

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: { message?: string } };
      throw new Error(errorData.error?.message || 'Failed to get user info');
    }

    const data = (await response.json()) as {
      displayName?: string;
      mail?: string;
      userPrincipalName?: string;
      id?: string;
    };

    return {
      displayName: data.displayName || 'Unknown User',
      email: data.mail || data.userPrincipalName || 'unknown@example.com',
      userPrincipalName: data.userPrincipalName || 'unknown',
      id: data.id || 'unknown',
    };
  }

  /**
   * Upload file from local path to SharePoint with optional Compare-And-Swap (CAS)
   * @param {string} sharepointPath - SharePoint path (relative to basePath)
   * @param {string} localPath - Local file path (must be within /workspace)
   * @param {Object} [options] - Upload options
   * @param {string} [options.expectedEtag] - Expected ETag for CAS (If-Match header)
   * @param {boolean} [options.createOnly] - Only create if file doesn't exist (If-None-Match: *)
   * @param {boolean} [options.overwrite] - Overwrite existing file without ETag check
   * @returns {Promise<{ etag?: string; size?: number }>} Result with new etag from SharePoint
   * @throws {Error} If local path is outside allowed directories or upload fails
   */
  async uploadFile(
    sharepointPath: string,
    localPath: string,
    options?: { expectedEtag?: string; createOnly?: boolean; overwrite?: boolean }
  ): Promise<{ etag?: string; size?: number }> {
    // Security: validate sharepoint path for defense-in-depth
    if (!this.pathValidator.validatePath(sharepointPath)) {
      throw new Error('Invalid sharepoint_path (security check failed)');
    }

    // Security: validate local path to prevent exfiltration of sensitive files
    if (!this.pathValidator.validateLocalPath(localPath)) {
      throw new Error('Invalid local_path: must be under /workspace');
    }

    const buffer = await fs.readFile(localPath);
    const fullPath = `${this.config.basePath}/${sharepointPath}`;
    await this.ensureParentFolders(fullPath);

    const uploadUrl = `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root:/${this.encodeGraphPath(fullPath)}:/content`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
    };

    // CAS headers
    const expectedEtag = options?.expectedEtag;
    const createOnly = options?.createOnly;
    const overwrite = options?.overwrite;

    if (overwrite) {
      // Overwrite mode: no conditional headers, always replace
    } else if (expectedEtag) {
      headers['If-Match'] = expectedEtag;
    }

    if (createOnly) {
      headers['If-None-Match'] = '*';
    }

    const response = await this.callGraphAPI(uploadUrl, {
      method: 'PUT',
      headers,
      body: buffer,
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: { message?: string } };
      throw new Error(errorData.error?.message || 'Upload failed');
    }

    // Parse response to get new etag and size
    const data = (await response.json()) as { eTag?: string; size?: number };
    return { etag: data.eTag, size: data.size };
  }

  /**
   * Download file from SharePoint to local path using streaming
   * @param {string} sharepointPath - SharePoint path (relative to basePath)
   * @param {string} localPath - Local destination path (must be within /workspace)
   * @returns {Promise<void>}
   * @throws {Error} If local path is outside allowed directories or download fails
   */
  async downloadFile(sharepointPath: string, localPath: string): Promise<void> {
    // Validate local path for security
    if (!this.pathValidator.validateLocalPath(localPath)) {
      throw new Error('Invalid local_path: must be under /workspace');
    }

    // Security: validate sharepoint path for defense-in-depth
    if (!this.pathValidator.validatePath(sharepointPath)) {
      throw new Error('Invalid sharepoint_path (security check failed)');
    }

    // Get file metadata with download URL
    const fullPath = sharepointPath
      ? `${this.config.basePath}/${sharepointPath}`
      : this.config.basePath;

    const metadataUrl = `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root:/${this.encodeGraphPath(fullPath)}`;
    const metadataResponse = await this.callGraphAPI(metadataUrl);

    if (!metadataResponse.ok) {
      const errorData = (await metadataResponse.json()) as { error?: { message?: string } };
      throw new Error(errorData.error?.message || 'Failed to get file metadata for download');
    }

    const metadata = (await metadataResponse.json()) as DriveItemMetadata;
    const downloadUrl = metadata['@microsoft.graph.downloadUrl'];

    if (!downloadUrl) {
      throw new Error('No download URL available for file');
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(localPath);
    await fs.mkdir(parentDir, { recursive: true });

    // Download file using streaming
    const downloadResponse = await fetch(downloadUrl);

    if (!downloadResponse.ok) {
      throw new Error(`Download failed with status ${downloadResponse.status}`);
    }

    if (!downloadResponse.body) {
      throw new Error('No response body for download');
    }

    // Stream to file
    const fileStream = createWriteStream(localPath);
    const readable = Readable.fromWeb(downloadResponse.body as import('stream/web').ReadableStream);
    await pipeline(readable, fileStream);
  }

  /**
   * Create a remote folder on SharePoint
   * @param {string} remotePath - SharePoint folder path (relative to basePath)
   * @returns {Promise<void>}
   * @throws {Error} If path is invalid, permission denied, or API call fails (except 409 Conflict)
   */
  async createRemoteFolder(remotePath: string): Promise<void> {
    // Security: validate remote path to prevent path traversal attacks
    if (!this.pathValidator.validatePath(remotePath)) {
      throw new Error('Invalid path (security check failed)');
    }

    const fullPath = `${this.config.basePath}/${remotePath}`;

    // 1. Ensure parent folders exist if needed
    await this.ensureParentFolders(fullPath);

    // 2. Create the folder itself
    const { parentDir, name: folderName } = splitPath(fullPath);

    if (!folderName) {
      throw new Error('Invalid folder path: cannot determine folder name');
    }

    const postUrl = this.buildFolderChildrenUrl(parentDir);

    const response = await this.callGraphAPI(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: folderName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      }),
    });

    // 3. Handle 409 Conflict (folder already exists - idempotent operation)
    if (!response.ok && response.status !== 409) {
      let errorMessage = `Failed to create folder: ${response.status}`;
      try {
        const errorData = (await response.json()) as { error?: { message?: string } };
        if (errorData?.error?.message) {
          errorMessage = errorData.error.message;
        }
      } catch (parseError) {
        debugLog(`⚠️  Failed to parse error response`, { parseError });
        try {
          const text = await response.text();
          if (text) errorMessage = `${response.status} - ${text.slice(0, 200)}`;
        } catch (textParseError) {
          // Text parsing failed - log the error for debugging
          console.error(`${ts()} Failed to parse error response as text:`, {
            error:
              textParseError instanceof Error ? textParseError.message : String(textParseError),
            status: response.status,
          });
        }
      }
      throw new Error(errorMessage);
    }
  }

  /**
   * Ensure parent folders exist
   * Recursively creates parent folders if they don't exist
   * @param {string} fullPath - Full path including filename
   * @returns {Promise<void>}
   */
  async ensureParentFolders(fullPath: string): Promise<void> {
    // Security: validate full path to prevent path traversal attacks
    // This is defense-in-depth - callers should validate, but we verify here too
    if (!this.pathValidator.validatePath(fullPath)) {
      throw new Error('Invalid path in ensureParentFolders (security check failed)');
    }

    const parts = fullPath.split('/');
    parts.pop(); // Remove filename
    const parent = parts.join('/');

    if (!parent) return;

    let accum = '';
    for (const p of parent.split('/')) {
      accum = accum ? `${accum}/${p}` : p;
      const checkUrl = `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root:/${this.encodeGraphPath(accum)}`;
      const checkResp = await this.callGraphAPI(checkUrl);

      if (checkResp.status === 404) {
        // Create folder
        const { parentDir, name } = splitPath(accum);
        const postUrl = this.buildFolderChildrenUrl(parentDir);

        const createResp = await this.callGraphAPI(postUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            folder: {},
            '@microsoft.graph.conflictBehavior': 'fail',
          }),
        });

        // Validate response - 409 Conflict means folder already exists (race condition), which is OK
        if (!createResp.ok && createResp.status !== 409) {
          let errorBody: string;
          try {
            errorBody = await createResp.text();
          } catch (bodyError) {
            const bodyErrorMsg = bodyError instanceof Error ? bodyError.message : String(bodyError);
            console.warn(
              `${ts()} [sharepoint] Failed to read error body for folder creation: ${bodyErrorMsg}`
            );
            errorBody = `Unable to read error body: ${bodyErrorMsg}`;
          }
          throw new Error(`Failed to create folder '${name}': ${createResp.status} - ${errorBody}`);
        }
      }
    }
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Factory & Initialization
//═══════════════════════════════════════════════════════════════════════════════

/**
 * IMPORTANT: Returns null (not throws) when tokens are missing or invalid.
 * This enables "graceful degradation" - server starts even without config:
 * - User can run `speedwave up` without configuring all integrations
 * - Healthcheck reports `configured: false` for unconfigured services
 * - Tools return clear "not configured" error when called
 *
 * DO NOT change this to throw - it breaks container startup for unconfigured services.
 * @returns Configured SharePointClient instance, or null if tokens not found/invalid
 */
export async function initializeSharePointClient(): Promise<SharePointClient | null> {
  try {
    const tokensDir = process.env.TOKENS_DIR || '/tokens';

    // Load tokens
    const accessToken = await loadToken(path.join(tokensDir, 'access_token'));
    const refreshToken = await loadToken(path.join(tokensDir, 'refresh_token'));
    const clientId = await loadToken(path.join(tokensDir, 'client_id'));
    const tenantId = await loadToken(path.join(tokensDir, 'tenant_id'));
    const siteId = await loadToken(path.join(tokensDir, 'site_id'));
    const basePath = await loadToken(path.join(tokensDir, 'base_path'));

    // Validate tokens are not empty (0-byte placeholder files)
    const missingTokens: string[] = [];
    if (!accessToken) missingTokens.push('access_token');
    if (!refreshToken) missingTokens.push('refresh_token');
    if (!clientId) missingTokens.push('client_id');
    if (!tenantId) missingTokens.push('tenant_id');
    if (!siteId) missingTokens.push('site_id');
    if (!basePath) missingTokens.push('base_path');

    if (missingTokens.length > 0) {
      console.warn(
        `${ts()} ${withSetupGuidance(`SharePoint tokens are empty or incomplete. Missing: ${missingTokens.join(', ')}.`)}`
      );
      // Graceful degradation: log warning, return null, let server start
      // DO NOT throw here - see JSDoc above for rationale
      return null;
    }

    console.log(`${ts()} ✅ SharePoint tokens loaded from /tokens/`);

    const config: SharePointConfig = {
      clientId,
      tenantId,
      siteId,
      basePath,
      accessToken,
      refreshToken,
    };

    return new SharePointClient(config, tokensDir);
  } catch (error) {
    console.warn(
      `${ts()} Failed to initialize SharePoint client: ${error instanceof Error ? error.message : String(error)}`
    );
    // Graceful degradation: log warning, return null, let server start
    // DO NOT throw here - see JSDoc above for rationale
    return null;
  }
}
