/**
 * SharePoint/Microsoft Graph API Client with OAuth token refresh and path traversal protection
 * @module sharepoint/client
 */

import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import {
  loadToken,
  tokensDir as defaultTokensDir,
  TIMEOUTS,
  ts,
  withSetupGuidance,
  authedRequest,
  RefreshLock,
  OAuthScopeMismatchError,
  PROACTIVE_REFRESH_SECONDS,
  ConnectionStatusTracker,
  memoizedPromise,
} from '@speedwave/mcp-shared';
import type { HealthStatus, AuthedTokenState } from '@speedwave/mcp-shared';
import { TokenManager } from './token-manager.js';
import { PathValidator } from './path-validator.js';
import { splitPath } from './path-utils.js';

//═══════════════════════════════════════════════════════════════════════════════
// Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * SharePoint worker runtime config. Post-ADR-060 the worker holds only the
 * mount-resident state (`accessToken` + `siteId`); refresh is delegated to
 * the host-side `oauth` worker.
 */
export interface SharePointConfig {
  siteId: string;
  accessToken: string;
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

/** Projection of `driveItem` with the fields image web part composition requires. */
export interface DriveItemForImage {
  id: string;
  name: string;
  webUrl?: string;
  size?: number;
  image?: { width?: number; height?: number };
  sharepointIds: {
    siteId: string;
    webId: string;
    listId: string;
    listItemId?: string;
    listItemUniqueId: string;
    tenantId?: string;
    siteUrl?: string;
  };
}

//═══════════════════════════════════════════════════════════════════════════════
// Client Class
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Conditional debug logging — only when the DEBUG env var is set.
 * @param {string} message - Debug message
 * @param {unknown} data - Context object to log alongside the message
 */
function debugLog(message: string, data: unknown): void {
  if (process.env.DEBUG) {
    console.log(`${ts()} ${message}`, data);
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
  /** Serializes token refresh across concurrent Graph calls (ADR-060). */
  private refreshLock = new RefreshLock();
  /** Connection status tracker — surfaces siteId resolve / token health. */
  public readonly statusTracker = new ConnectionStatusTracker();
  /** Memoized lazy resolve of composite siteId via {@link memoizedPromise}. */
  private readonly _resolveSiteIdMemo = memoizedPromise<void>({
    fetch: () => this._resolveSiteIdOnce(),
  });

  /**
   * Create a SharePoint client
   * @param {SharePointConfig} config - SharePoint configuration
   * @param {string} tokensDir - Path to tokens directory
   */
  constructor(config: SharePointConfig, tokensDir: string) {
    this.config = config;
    this.tokensDir = tokensDir;

    this.tokenManager = new TokenManager();
    this.pathValidator = new PathValidator();
  }

  /**
   * Resolve path-form siteId to composite; updates the status tracker.
   * Throws on failure so the memoized cache clears for retry.
   */
  private async _resolveSiteIdOnce(): Promise<void> {
    if (!this.config.siteId.includes(':')) {
      // Already composite — mark ok without touching the network.
      this.statusTracker.setOk();
      return;
    }
    const rawSiteId = this.config.siteId;
    try {
      const resolution = await resolveCompositeSiteId(rawSiteId, this.config.accessToken, {
        tokensDir: this.tokensDir,
        refreshOn401: true,
      });
      if (!resolution.ok) {
        const err = new Error(`SharePoint siteId resolve failed: ${resolution.detail}`);
        this.statusTracker.setFailed(err);
        throw err;
      }
      // Re-read access_token in case resolveCompositeSiteId triggered a
      // refresh-on-401 — disk may now hold a newer token than memory.
      const fresh = await loadToken(path.join(this.tokensDir, 'access_token'));
      if (fresh) {
        this.config.accessToken = fresh;
      }
      this.config.siteId = resolution.compositeId;
      this.statusTracker.setOk();
      console.log(`${ts()} ✅ SharePoint siteId resolved (composite form)`);
    } catch (err) {
      this.statusTracker.setFailed(err);
      console.warn(
        `${ts()} SharePoint siteId background resolve failed: ${err instanceof Error ? err.message : String(err)}`
      );
      throw err;
    }
  }

  /** Fire-and-forget background siteId resolution; mutates config.siteId once Graph responds. */
  warmupSiteId(): void {
    void this._resolveSiteIdMemo().catch(() => {
      // Failure already logged + tracker updated in _resolveSiteIdOnce.
      // Memo clears its cache on rejection so a subsequent call retries.
    });
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

  /** Get health status including `tokenSaveError` (ADR-060). */
  getHealthStatus(): HealthStatus {
    const { tokenSaveError } = this.tokenManager.getHealthStatus();
    return {
      ...this.statusTracker.getHealth(),
      tokenSaveError,
    };
  }

  /**
   * Public Graph API wrapper used by `tools/page-tools.ts` and other domain
   * tools that need to call non-file Graph endpoints (PR4 / PR5). Accepts a
   * full URL or a `/sites/{site-id}/...` path; the path form auto-substitutes
   * the configured site id and prefixes `https://graph.microsoft.com/v1.0`.
   * Inherits the 401-refresh + retry behaviour of the file methods.
   * @param method - HTTP method (GET, POST, PATCH, DELETE)
   * @param urlOrPath - absolute URL or `/sites/{site-id}/...` path
   * @param body - optional JSON-serialisable body
   * @returns parsed JSON response (or undefined for 204 No Content)
   * @throws {Error} on non-2xx status (with Graph error message when present)
   */
  async graphRequest<T = unknown>(
    method: string,
    urlOrPath: string,
    body?: unknown
  ): Promise<T | undefined> {
    const url = urlOrPath.startsWith('http')
      ? urlOrPath
      : `https://graph.microsoft.com/v1.0${urlOrPath.replace('{site-id}', this.config.siteId)}`;

    const options: RequestInit = { method };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
      options.headers = { 'Content-Type': 'application/json' };
    }

    const response = await this.callGraphAPI(url, options);
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const errBody = (await response.json()) as { error?: { message?: string } };
        if (errBody.error?.message) detail = `${detail}: ${errBody.error.message}`;
      } catch {
        // body not JSON — keep status line
      }
      throw new Error(`Graph API ${method} ${url} failed: ${detail}`);
    }
    if (response.status === 204) return undefined;
    return (await response.json()) as T;
  }

  /**
   * Return the configured site id. Page/list tools use this to enforce the
   * "no site_id from model" invariant (ADR-060): the model never picks a site,
   * the worker always uses the one stored in `/tokens/site_id`.
   */
  getSiteId(): string {
    return this.config.siteId;
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

    if (message.includes('429') || message.includes('activityLimitReached')) {
      return 'Rate limited by Microsoft Graph (429). Wait and retry the same call.';
    }

    if (message.includes('423') || message.includes('resourceLocked')) {
      return 'Resource is locked in SharePoint (checked out or being edited elsewhere). Retry later.';
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
   * Call Graph API with shared refresh-retry (ADR-060). Delegates proactive
   * refresh, the 401 retry, and single-flight locking to {@link authedRequest};
   * scope-mismatch propagates as a typed error for the re-consent UI.
   * @param url - Graph API endpoint URL
   * @param options - fetch options (Authorization is added by the helper)
   * @returns API response (caller checks `response.ok`)
   * @throws {Error} on request timeout
   * @throws {OAuthScopeMismatchError} when refresh detects scope mismatch
   */
  private async callGraphAPI(url: string, options: RequestInit = {}): Promise<Response> {
    // Distinguish "the whole site never resolved" from "this item was not found" —
    // otherwise a model retries individual params against a config-level failure.
    if (this.statusTracker.getStatus() === 'failed') {
      throw new Error(
        'SharePoint site connection is not established (siteId resolve failed). ' +
          'This is a configuration issue, not a parameter problem: ask the user to check the SharePoint integration settings.'
      );
    }
    // Live view onto config.accessToken so the helper's writes are shared.
    const config = this.config;
    const state: AuthedTokenState = {
      get accessToken() {
        return config.accessToken;
      },
      set accessToken(v: string) {
        config.accessToken = v;
      },
    };

    const send = async (accessToken: string): Promise<Response> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.API_CALL_MS);
      try {
        return await fetch(url, {
          ...options,
          headers: { Authorization: `Bearer ${accessToken}`, ...options.headers },
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`Graph API request timeout after ${TIMEOUTS.API_CALL_MS}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    };

    return authedRequest({
      service: 'sharepoint',
      state,
      lock: this.refreshLock,
      send,
      tokensDir: this.tokensDir,
      proactiveWithinSeconds: PROACTIVE_REFRESH_SECONDS,
    });
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

    // Empty path → list the site's drive root; otherwise list the supplied
    // path relative to the drive root. `site_id` already scopes the worker
    // to a single site, so no additional `base_path` sandbox is applied.
    const initialUrl = relativePath
      ? `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root:/${this.encodeGraphPath(relativePath)}:/children`
      : `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root/children`;

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
   * @param {string} sharepointPath - SharePoint path relative to the site's drive root
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
    await this.ensureParentFolders(sharepointPath);

    const uploadUrl = `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root:/${this.encodeGraphPath(sharepointPath)}:/content`;

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
   * Fetch a driveItem by its path under the site's default drive.
   * @param sharepointPath - path relative to the drive root (e.g. "speedwave-hero.jpg")
   * @returns driveItem id, sharepointIds, image dimensions, webUrl, name
   * @throws {Error} If path is invalid or the driveItem is not found
   */
  async getDriveItemForSharePointPath(sharepointPath: string): Promise<DriveItemForImage> {
    if (!this.pathValidator.validatePath(sharepointPath)) {
      throw new Error('Invalid sharepoint_path (security check failed)');
    }
    const url =
      `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root:/${this.encodeGraphPath(sharepointPath)}` +
      `?$select=id,name,webUrl,size,image,sharepointIds`;
    const response = await this.callGraphAPI(url);
    if (!response.ok) {
      const errorData = (await response.json()) as { error?: { message?: string } };
      throw new Error(
        errorData.error?.message ||
          `driveItem lookup failed: ${response.status} ${response.statusText}`
      );
    }
    const data = (await response.json()) as DriveItemForImage;
    if (!data.id || !data.sharepointIds) {
      throw new Error('driveItem response missing id or sharepointIds');
    }
    return data;
  }

  /**
   * Download file from SharePoint to local path using streaming
   * @param {string} sharepointPath - SharePoint path relative to the site's drive root
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

    // `site_id` already scopes us to a single site; the supplied path is
    // resolved against the site's drive root (no `base_path` prefix).
    const metadataUrl = `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root:/${this.encodeGraphPath(sharepointPath)}`;
    const metadataResponse = await this.callGraphAPI(metadataUrl);

    if (!metadataResponse.ok) {
      const errorData = (await metadataResponse.json()) as { error?: { message?: string } };
      throw new Error(errorData.error?.message || 'Failed to get file metadata for download');
    }

    const metadata = (await metadataResponse.json()) as DriveItemMetadata;
    const downloadUrl = metadata['@microsoft.graph.downloadUrl'];

    if (!downloadUrl) {
      throw new Error(
        'No download URL available for file. This can happen if the item is a folder, is checked out to another user, or is an online-only document type; verify with getFileFull or listFileIds first.'
      );
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
   * @param {string} remotePath - SharePoint folder path relative to the site's drive root
   * @returns {Promise<void>}
   * @throws {Error} If path is invalid, permission denied, or API call fails (except 409 Conflict)
   */
  async createRemoteFolder(remotePath: string): Promise<void> {
    // Security: validate remote path to prevent path traversal attacks
    if (!this.pathValidator.validatePath(remotePath)) {
      throw new Error('Invalid path (security check failed)');
    }

    // 1. Ensure parent folders exist if needed
    await this.ensureParentFolders(remotePath);

    // 2. Create the folder itself
    const { parentDir, name: folderName } = splitPath(remotePath);

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

/** Outcome of `resolveCompositeSiteId` — successful id or a typed error. */
export type ResolveResult =
  | { ok: true; compositeId: string }
  | { ok: false; reason: 'validation' | 'transient' | 'not_found' | 'network'; detail: string };

/**
 * Resolve a path-form site id to its composite id; re-validates via `validateGraphSiteId`.
 * @param siteId - site id loaded from `/tokens/site_id` (any accepted form)
 * @param accessToken - bearer token used for the lookup
 * @param opts - cold-start refresh tuning
 * @param opts.tokensDir - tokens mount path (default {@link defaultTokensDir}); only read when refreshing
 * @param opts.refreshOn401 - on a 401, refresh via `authedRequest` and retry once (default true)
 * @returns the composite id (or untouched value if already composite), or a typed error
 */
export async function resolveCompositeSiteId(
  siteId: string,
  accessToken: string,
  opts: { tokensDir?: string; refreshOn401?: boolean } = {}
): Promise<ResolveResult> {
  const validationError = validateGraphSiteId(siteId);
  if (validationError) {
    return { ok: false, reason: 'validation', detail: validationError };
  }
  // Composite ids never contain `:` (they use `,` as separator). If a value
  // both has a comma AND a colon it's malformed — refuse to interpolate it.
  if (siteId.includes(',') && siteId.includes(':')) {
    return {
      ok: false,
      reason: 'validation',
      detail: 'site_id mixes composite (",") and path-form (":") separators',
    };
  }
  if (!siteId.includes(':')) {
    return { ok: true, compositeId: siteId };
  }
  const refreshOn401 = opts.refreshOn401 !== false;
  const tokensDir = opts.tokensDir ?? defaultTokensDir();
  // Cold-start hang here blocks initializeSharePointClient indefinitely, which
  // in turn blocks the hub's discovery retry budget. Apply the same per-request
  // timeout the steady-state path uses (callGraphAPI's TIMEOUTS.API_CALL_MS).
  const siteLookupWithTimeout = async (bearer: string): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.API_CALL_MS);
    try {
      return await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}`, {
        headers: { Authorization: `Bearer ${bearer}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };
  try {
    // Cold-start (no client yet): use the shared helper with a throwaway state;
    // a refresh failure falls through to the not_found / transient branch below.
    let response: Response;
    if (refreshOn401) {
      const state: AuthedTokenState = { accessToken };
      try {
        response = await authedRequest({
          service: 'sharepoint',
          state,
          lock: new RefreshLock(),
          send: siteLookupWithTimeout,
          tokensDir,
        });
      } catch (err) {
        // Scope mismatch can't self-heal — propagate so the re-consent UI fires.
        if (err instanceof OAuthScopeMismatchError) throw err;
        console.warn(
          `${ts()} SharePoint site lookup: token refresh failed during init — ${err instanceof Error ? err.message : String(err)}`
        );
        response = await siteLookupWithTimeout(state.accessToken);
      }
    } else {
      response = await siteLookupWithTimeout(accessToken);
    }
    if (!response.ok) {
      const detail = `Graph lookup of "${siteId}" failed: ${response.status} ${response.statusText}`;
      const reason = response.status >= 500 || response.status === 429 ? 'transient' : 'not_found';
      return { ok: false, reason, detail };
    }
    const data = (await response.json()) as unknown;
    const id =
      data &&
      typeof data === 'object' &&
      'id' in data &&
      typeof (data as { id: unknown }).id === 'string'
        ? (data as { id: string }).id
        : null;
    if (!id) {
      return {
        ok: false,
        reason: 'not_found',
        detail: 'Graph site lookup response did not contain a string `id` field',
      };
    }
    return { ok: true, compositeId: id };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return {
        ok: false,
        reason: 'transient',
        detail: `Graph site lookup timed out after ${TIMEOUTS.API_CALL_MS}ms`,
      };
    }
    return {
      ok: false,
      reason: 'network',
      detail: `Graph site lookup network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Validate a Graph site id, fail-closed (accept only composite or path form).
 * @param siteId - raw value loaded from `/tokens/site_id`
 * @returns user-facing error message, or `null` when the value is acceptable
 */
export function validateGraphSiteId(siteId: string): string | null {
  const guidance =
    'Use either composite form "{hostname},{site-guid},{web-guid}" or path form "{hostname}:/sites/{path}:".';
  const quoted = JSON.stringify(siteId);
  if (siteId.length === 0) {
    return `SharePoint site_id is empty. ${guidance}`;
  }
  if (/^https?:\/\//i.test(siteId)) {
    return `SharePoint site_id must be a Graph site id, not a URL (got ${quoted}). ${guidance}`;
  }
  if (/\s/.test(siteId)) {
    return `SharePoint site_id contains whitespace (got ${quoted}). ${guidance}`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(siteId)) {
    return `SharePoint site_id contains control characters. ${guidance}`;
  }
  if (siteId.includes('?') || siteId.includes('#')) {
    return `SharePoint site_id must not contain query (?) or fragment (#) characters (got ${quoted}). ${guidance}`;
  }
  if (siteId.includes('..')) {
    return `SharePoint site_id must not contain "..". ${guidance}`;
  }
  // Block non-ASCII (IDN homographs, RTL overrides) — Graph site ids are ASCII.
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(siteId)) {
    return `SharePoint site_id must be ASCII only (got ${quoted}). ${guidance}`;
  }
  return null;
}

/**
 * Initialize the SharePoint client; returns null (not throws) when tokens are missing/invalid.
 * @returns Configured SharePointClient instance, or null if tokens not found/invalid
 */
export async function initializeSharePointClient(): Promise<SharePointClient | null> {
  try {
    const tokensDir = defaultTokensDir();

    // Load tokens that live in the worker-mounted dir (ADR-060). After PR3,
    // `client_id`, `tenant_id`, and `refresh_token` are NO LONGER mounted into
    // this container — they live in `~/.speedwave/oauth/<project>/sharepoint.json`
    // on the host and are read only by the `oauth` worker.
    const accessToken = await loadToken(path.join(tokensDir, 'access_token'));
    const siteId = await loadToken(path.join(tokensDir, 'site_id'));

    // Validate tokens are not empty (0-byte placeholder files)
    const missingTokens: string[] = [];
    if (!accessToken) missingTokens.push('access_token');
    if (!siteId) missingTokens.push('site_id');

    if (missingTokens.length > 0) {
      console.warn(
        `${ts()} ${withSetupGuidance(`SharePoint tokens are empty or incomplete. Missing: ${missingTokens.join(', ')}.`)}`
      );
      // Graceful degradation: log warning, return null, let server start
      // DO NOT throw here - see JSDoc above for rationale
      return null;
    }

    const siteIdError = validateGraphSiteId(siteId);
    if (siteIdError) {
      console.warn(`${ts()} ${withSetupGuidance(siteIdError)}`);
      return null;
    }

    console.log(`${ts()} ✅ SharePoint tokens loaded from /tokens/`);

    // Store the raw siteId from /tokens/. Path-form values get resolved to
    // composite by SharePointClient.warmupSiteId() in the background, which
    // mutates this.config.siteId in place once Graph responds. Most Graph
    // endpoints accept both forms during the warm-up window.
    const config: SharePointConfig = { siteId, accessToken };

    const client = new SharePointClient(config, tokensDir);
    // Fire-and-forget: resolves to composite + re-reads access_token after
    // any refresh-on-401. Server starts immediately; tools degrade gracefully
    // if Graph is slow or unreachable at boot.
    client.warmupSiteId();
    return client;
  } catch (error) {
    console.warn(
      `${ts()} Failed to initialize SharePoint client: ${error instanceof Error ? error.message : String(error)}`
    );
    // Graceful degradation: log warning, return null, let server start
    // DO NOT throw here - see JSDoc above for rationale
    return null;
  }
}
