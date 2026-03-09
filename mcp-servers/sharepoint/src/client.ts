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
import { loadToken, TIMEOUTS, ts } from '../../shared/dist/index.js';
import { TokenManager } from './token-manager.js';
import { PathValidator } from './path-validator.js';
import {
  SyncEngine,
  FileOperationExecutor,
  SyncFileEntry,
  SyncOperation,
  SyncPlan,
  DirectorySyncResult,
  SyncMode,
  buildSyncStateFromResults,
} from './sync-engine.js';
import { SyncStateStore } from './sync-state.js';
import { splitPath, validateNotProtectedFile } from './path-utils.js';

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

/**
 * Parameters for syncDirectory method
 * @interface SyncDirectoryParams
 */
export interface SyncDirectoryParams {
  /** Local directory path (must be in allowed locations) */
  localPath: string;
  /** SharePoint directory path (relative to basePath) */
  sharepointPath?: string;
  /** Sync mode: two_way, pull, or push */
  mode: SyncMode;
  /** Whether to propagate deletions (default: false - safe mode) */
  delete?: boolean;
  /** Glob patterns to ignore */
  ignorePatterns?: string[];
  /** Dry run - compute plan only, don't execute */
  dryRun?: boolean;
  /** Include full plan.operations and executed arrays in response. Default: false (slim mode to save tokens). Note: dryRun=true always returns full plan regardless of this setting. Errors, conflicts, and summary are always included. */
  verbose?: boolean;
}

// Re-export types from sync-engine for convenience
export type { SyncMode, SyncFileEntry, SyncOperation, SyncPlan, DirectorySyncResult };

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
 * Acts as a facade coordinating TokenManager, PathValidator, and SyncEngine modules
 * @class SharePointClient
 */
export class SharePointClient implements FileOperationExecutor {
  private config: SharePointConfig;
  private tokensDir: string;
  private tokenManager: TokenManager;
  private pathValidator: PathValidator;
  private syncEngine: SyncEngine;
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

    this.syncEngine = new SyncEngine(this.pathValidator, this, config.basePath);
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
      return 'Authentication failed. Your SharePoint token may have expired. Run: speedwave setup sharepoint';
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
      return 'Token refresh failed. Run: speedwave setup sharepoint';
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
                throw new Error(`Graph API request timeout after ${TIMEOUTS.API_CALL_MS}ms`);
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
              throw new Error(`Graph API request timeout after ${TIMEOUTS.API_CALL_MS}ms`);
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
        throw new Error(`Graph API request timeout after ${TIMEOUTS.API_CALL_MS}ms`);
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
        // This allows syncDirectory to push to new folders while listFileIds can detect non-existence
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
   * Sync file (file mode with ETag CAS)
   * Uploads local file to SharePoint with optional Compare-And-Swap using ETags
   * @param {Object} params - Sync parameters
   * @param {string} params.localPath - Local file path to upload
   * @param {string} params.sharepointPath - Destination path in SharePoint (relative)
   * @param {string} [params.expectedEtag] - Expected ETag for CAS (If-Match header)
   * @param {boolean} [params.createOnly] - Only create if file doesn't exist (If-None-Match: *)
   * @param {boolean} [params.overwrite] - Overwrite existing file without ETag check
   * @returns {Promise<{success: boolean, etag?: string, size?: number}>} Upload result with new ETag
   * @throws {Error} If path is invalid, file doesn't exist, or upload fails
   */
  async syncFile(params: {
    localPath: string;
    sharepointPath: string;
    expectedEtag?: string;
    createOnly?: boolean;
    overwrite?: boolean;
  }): Promise<{ success: boolean; etag?: string; size?: number }> {
    const { localPath, sharepointPath, expectedEtag, createOnly, overwrite } = params;

    if (!this.pathValidator.validatePath(sharepointPath)) {
      throw new Error('Invalid sharepoint_path (security check failed)');
    }

    // Security: validate local path to prevent exfiltration of sensitive files
    if (!this.pathValidator.validateLocalPath(localPath)) {
      throw new Error(
        'Invalid local_path: must be /home/speedwave/.claude/context or /context subdirectory'
      );
    }

    // Translate Claude container path to MCP container path
    const translatedLocalPath = this.pathValidator.translatePath(localPath);

    // Read local file
    const buffer = await fs.readFile(translatedLocalPath);
    const fullPath = `${this.config.basePath}/${sharepointPath}`;

    // Ensure parent folders exist
    await this.ensureParentFolders(fullPath);

    // Upload with CAS headers
    const uploadUrl = `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root:/${this.encodeGraphPath(fullPath)}:/content`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
    };

    // overwrite: skip ETag check and force overwrite
    // expectedEtag: only set If-Match if not in overwrite mode
    // createOnly: only create if file doesn't exist
    if (overwrite) {
      // Overwrite mode: no conditional headers, always replace
      // Note: we don't set any If-Match or If-None-Match headers
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

    const data = (await response.json()) as {
      eTag?: string;
      size?: number;
    };

    return {
      success: true,
      etag: data.eTag,
      size: data.size,
    };
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

  //═════════════════════════════════════════════════════════════════════════════
  // FileOperationExecutor Implementation (for SyncEngine)
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Upload file from local path to SharePoint (FileOperationExecutor interface)
   * @param {string} sharepointPath - SharePoint path (relative to basePath)
   * @param {string} localPath - Local file path (must be within allowed directories)
   * @returns {Promise<{ etag?: string }>} Result with new etag from SharePoint
   * @throws {Error} If local path is outside allowed directories
   */
  async uploadFile(sharepointPath: string, localPath: string): Promise<{ etag?: string }> {
    // Security: validate sharepoint path for defense-in-depth
    // Note: SyncEngine already validates before calling, but defense-in-depth requires validation here too
    if (!this.pathValidator.validatePath(sharepointPath)) {
      throw new Error('Invalid sharepoint_path (security check failed)');
    }

    // Security: block .sync-state.json upload (internal metadata that should never be on SharePoint)
    validateNotProtectedFile(sharepointPath, 'upload');

    // Security: validate local path to prevent exfiltration of sensitive files
    if (!this.pathValidator.validateLocalPath(localPath)) {
      throw new Error(
        'Invalid local_path: must be /home/speedwave/.claude/context or /context subdirectory'
      );
    }

    const buffer = await fs.readFile(localPath);
    const fullPath = `${this.config.basePath}/${sharepointPath}`;
    await this.ensureParentFolders(fullPath);

    const uploadUrl = `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root:/${this.encodeGraphPath(fullPath)}:/content`;
    const response = await this.callGraphAPI(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer,
    });

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: { message?: string } };
      throw new Error(errorData.error?.message || 'Upload failed');
    }

    // Parse response to get new etag
    const data = (await response.json()) as { eTag?: string };
    return { etag: data.eTag };
  }

  /**
   * Download file from SharePoint using streaming (FileOperationExecutor interface)
   * @param {string} sharepointPath - SharePoint path (relative to basePath)
   * @param {string} localPath - Local destination path
   * @returns {Promise<void>}
   */
  async downloadFile(sharepointPath: string, localPath: string): Promise<void> {
    return this.downloadFileStream(sharepointPath, localPath);
  }

  /**
   * Download file from SharePoint using streaming (backward compatibility alias)
   * @param {string} sharepointPath - SharePoint path (relative to basePath)
   * @param {string} localPath - Local destination path
   * @returns {Promise<void>}
   */
  async downloadFileStream(sharepointPath: string, localPath: string): Promise<void> {
    // Security: block downloading .sync-state.json (internal metadata that should never be on SharePoint)
    validateNotProtectedFile(sharepointPath, 'download');

    // Validate local path for security
    if (!this.pathValidator.validateLocalPath(localPath)) {
      throw new Error(
        'Invalid local_path: must be /home/speedwave/.claude/context or subdirectory'
      );
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
   * Delete file from SharePoint (FileOperationExecutor interface)
   * @param {string} sharepointPath - SharePoint path (relative to basePath)
   * @returns {Promise<void>}
   */
  async deleteRemoteFile(sharepointPath: string): Promise<void> {
    if (!this.pathValidator.validatePath(sharepointPath)) {
      throw new Error('Invalid sharepoint_path (security check failed)');
    }

    // Security: block deleting .sync-state.json (internal metadata that should never be on SharePoint)
    validateNotProtectedFile(sharepointPath, 'delete');

    const fullPath = `${this.config.basePath}/${sharepointPath}`;
    const deleteUrl = `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root:/${this.encodeGraphPath(fullPath)}`;

    const response = await this.callGraphAPI(deleteUrl, {
      method: 'DELETE',
    });

    if (!response.ok && response.status !== 404) {
      const errorData = (await response.json()) as { error?: { message?: string } };
      throw new Error(errorData.error?.message || 'Failed to delete file');
    }
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Directory Sync Methods (delegated to SyncEngine)
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * List files recursively from SharePoint
   * @param {string} sharepointPath - SharePoint path (relative to basePath)
   * @param {Object} [options] - Listing options
   * @param {boolean} [options.includeEmptyFolders] - Include empty folders in the result (default: false)
   * @returns {Promise<SyncFileEntry[]>} Array of file entries
   */
  async listFilesRecursive(
    sharepointPath: string = '',
    options?: { includeEmptyFolders?: boolean }
  ): Promise<SyncFileEntry[]> {
    const files: SyncFileEntry[] = [];
    const includeEmptyFolders = options?.includeEmptyFolders ?? false;

    const processDirectory = async (relativePath: string): Promise<void> => {
      const result = await this.listFiles({ path: relativePath });

      for (const item of result.files) {
        if (item.isFolder) {
          // Track count before processing to detect empty folders
          const countBefore = files.length;

          // Recursively process subdirectory
          await processDirectory(item.path);

          const countAfter = files.length;

          // Check if folder is empty (no files added during recursive processing)
          if (includeEmptyFolders && countAfter === countBefore) {
            files.push({
              path: item.path,
              size: 0,
              lastModified: item.lastModified || new Date().toISOString(),
              etag: 'folder', // Special marker for empty folders
              isFolder: true,
            });
          }
        } else {
          files.push({
            path: item.path,
            size: item.size || 0,
            lastModified: item.lastModified || new Date().toISOString(),
            etag: item.eTag || item.id, // Use actual eTag from API, fallback to ID
            isFolder: false,
          });
        }
      }
    };

    await processDirectory(sharepointPath);
    return files;
  }

  /**
   * Synchronize a local directory with SharePoint
   * @param {SyncDirectoryParams} params - Sync parameters
   * @returns {Promise<DirectorySyncResult>} Sync result
   */
  async syncDirectory(params: SyncDirectoryParams): Promise<DirectorySyncResult> {
    const {
      localPath: rawLocalPath,
      sharepointPath: inputSharepointPath,
      mode,
      delete: deleteParam,
      ignorePatterns = [],
      dryRun = false,
      verbose = false,
    } = params;

    // For two_way mode, delete defaults to true (OneDrive-like behavior)
    // For pull/push modes, delete defaults to false (safe mode)
    const deleteEnabled = deleteParam ?? mode === 'two_way';

    // Validate that localPath is a string before normalization
    if (typeof rawLocalPath !== 'string') {
      throw new Error(
        'Invalid local_path: must be /home/speedwave/.claude/context or subdirectory'
      );
    }

    // Normalize local path to handle edge cases like //home/... or trailing slashes
    const inputLocalPath = path.normalize(rawLocalPath);

    // Validate local path
    if (!this.pathValidator.validateLocalPath(inputLocalPath)) {
      throw new Error(
        'Invalid local_path: must be /home/speedwave/.claude/context or subdirectory'
      );
    }

    // Translate Claude container path to MCP container path
    // Claude uses: /home/speedwave/.claude/context
    // MCP container has it mounted at: /context
    const localPath = this.pathValidator.translatePath(inputLocalPath);
    debugLog(`🔄 Path translation: ${inputLocalPath} → ${localPath}`);

    // Auto-calculate sharepointPath from localPath if not provided
    // This ensures symmetry: /context/opportunities/MASŁO → context/opportunities/MASŁO
    let sharepointPath = inputSharepointPath;
    if (!sharepointPath) {
      // Normalize localPath using path.resolve to handle edge cases like double slashes
      const normalizedLocalPath = path.resolve(localPath);
      // For /context or /context/subfolder → context or context/subfolder
      sharepointPath = normalizedLocalPath.startsWith('/')
        ? normalizedLocalPath.slice(1)
        : normalizedLocalPath;
      debugLog(`📍 Auto-calculated sharepointPath from localPath: ${sharepointPath}`);
    }

    // Security: sharepointPath must be 'context' or start with 'context/'
    // This prevents syncing files outside the context directory (e.g., CLAUDE.md, project.json, teams/)
    if (sharepointPath !== 'context' && !sharepointPath.startsWith('context/')) {
      throw new Error(
        'Invalid sharepoint_path: must be "context" or start with "context/" for security. ' +
          'Files like CLAUDE.md and project.json are synced by speedwave sync bash script, not MCP.'
      );
    }

    // Ensure local directory exists
    await fs.mkdir(localPath, { recursive: true });

    // List files from both sources (include empty folders for proper sync)
    debugLog(`📂 Listing local files in ${localPath}...`);
    let localFiles = await this.syncEngine.listLocalFilesRecursive(localPath, localPath, {
      includeEmptyFolders: true,
    });
    debugLog(`   Found ${localFiles.length} local files/folders`);

    debugLog(`☁️  Listing SharePoint files in ${sharepointPath || 'root'}...`);
    let remoteFiles = await this.listFilesRecursive(sharepointPath, { includeEmptyFolders: true });

    // Normalize remote file paths: strip sharepointPath prefix so paths are relative to sync root
    // e.g., when sharepointPath='context', paths like 'context/file.txt' become 'file.txt'
    if (sharepointPath) {
      const prefixToStrip = sharepointPath + '/';
      remoteFiles = remoteFiles.map((file) => ({
        ...file,
        path: file.path.startsWith(prefixToStrip)
          ? file.path.slice(prefixToStrip.length)
          : file.path === sharepointPath
            ? ''
            : file.path,
      }));
    }
    debugLog(`   Found ${remoteFiles.length} remote files`);

    // Apply user-specified ignore patterns to filter files
    if (ignorePatterns.length > 0) {
      debugLog(`🚫 Applying ${ignorePatterns.length} ignore patterns...`);
      const localFilesBeforeFilter = localFiles.length;
      const remoteFilesBeforeFilter = remoteFiles.length;

      localFiles = localFiles.filter(
        (file) => !this.pathValidator.shouldIgnoreFile(file.path, ignorePatterns)
      );
      remoteFiles = remoteFiles.filter(
        (file) => !this.pathValidator.shouldIgnoreFile(file.path, ignorePatterns)
      );

      const localFilesIgnored = localFilesBeforeFilter - localFiles.length;
      const remoteFilesIgnored = remoteFilesBeforeFilter - remoteFiles.length;

      debugLog(
        `   Filtered: ${localFilesIgnored} local files, ${remoteFilesIgnored} remote files ignored`
      );
    }

    // Load previous sync state for OneDrive-like deletion tracking
    const stateStore = new SyncStateStore(localPath);
    const previousState = await stateStore.load();
    if (previousState) {
      debugLog(`📁 Loaded previous sync state (${Object.keys(previousState.files).length} files)`);
    }

    // Compute sync plan using SyncEngine with state
    debugLog(`📋 Computing sync plan (mode: ${mode}, delete: ${deleteEnabled})...`);
    const plan = this.syncEngine.computeSyncPlanWithState(
      localFiles,
      remoteFiles,
      previousState,
      mode,
      deleteEnabled
    );
    debugLog(`   Plan: ${plan.summary.toUpload} uploads, ${plan.summary.toDownload} downloads`);
    debugLog(
      `         ${plan.summary.toDeleteLocal} local deletes, ${plan.summary.toDeleteRemote} remote deletes`
    );
    debugLog(`         ${plan.summary.conflicts} conflicts, ${plan.summary.skipped} unchanged`);

    // Initialize result
    const result: DirectorySyncResult = {
      success: true,
      plan,
      executed: [],
      conflicts: [],
      errors: [],
      summary: {
        uploaded: 0,
        downloaded: 0,
        deletedLocal: 0,
        deletedRemote: 0,
        conflicts: 0,
        failed: 0,
      },
    };

    // If dry run, return plan without executing
    if (dryRun) {
      debugLog('🔍 Dry run - no changes made');
      return result;
    }

    // Execute operations in batches of 50
    const BATCH_SIZE = 50;
    const operations = plan.operations.filter((op) => op.action !== 'skip');

    for (let i = 0; i < operations.length; i += BATCH_SIZE) {
      const batch = operations.slice(i, i + BATCH_SIZE);
      debugLog(
        `⚙️  Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(operations.length / BATCH_SIZE)}...`
      );

      // Execute batch operations (could be parallelized but keeping sequential for safety)
      for (const operation of batch) {
        try {
          const execResult = await this.syncEngine.executeSyncOperation(
            operation,
            localPath,
            sharepointPath
          );
          // Store resultEtag from upload for state tracking
          if (execResult.etag) {
            operation.resultEtag = execResult.etag;
          }
          result.executed.push(operation);

          // Log individual operation with reason
          const reason = operation.reason ? ` (${operation.reason})` : '';
          switch (operation.action) {
            case 'upload':
              debugLog(`   ⬆️  Upload: ${operation.path}${reason}`);
              result.summary.uploaded++;
              break;
            case 'download':
              debugLog(`   ⬇️  Download: ${operation.path}${reason}`);
              result.summary.downloaded++;
              break;
            case 'delete_local':
              debugLog(`   🗑️  Delete local: ${operation.path}${reason}`);
              result.summary.deletedLocal++;
              break;
            case 'delete_remote':
              debugLog(`   🗑️  Delete remote: ${operation.path}${reason}`);
              result.summary.deletedRemote++;
              break;
            case 'conflict':
              debugLog(`   ⚠️  Conflict: ${operation.path}${reason}`);
              result.summary.conflicts++;
              result.conflicts.push(operation.path);
              break;
          }
        } catch (error) {
          result.errors.push({
            path: operation.path,
            error: error instanceof Error ? error.message : String(error),
          });
          result.summary.failed++;
          result.success = false;
        }
      }
    }

    debugLog(
      `✅ Sync complete: ${result.summary.uploaded} uploaded, ${result.summary.downloaded} downloaded`
    );
    if (result.errors.length > 0) {
      debugLog(`⚠️  ${result.errors.length} errors occurred`);
    }

    // Save new sync state after successful sync (or partial success)
    if (result.success || result.executed.length > 0) {
      const newState = buildSyncStateFromResults(
        localFiles,
        remoteFiles,
        result.executed,
        sharepointPath
      );
      await stateStore.save(newState);
      debugLog(`💾 Saved sync state (${Object.keys(newState.files).length} files)`);
    }

    // Slim response mode (default) - exclude large arrays to save tokens (~97% reduction)
    // Full plan.operations[] and executed[] are only needed for debugging
    // Exception: dryRun mode always returns full plan.operations (that's the whole point of dry run)
    if (!verbose && !dryRun) {
      return {
        ...result,
        plan: { ...result.plan, operations: [] },
        executed: [],
      };
    }

    return result;
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
        `${ts()} SharePoint tokens are empty or incomplete. Missing: ${missingTokens.join(', ')}. Run: speedwave setup sharepoint`
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
