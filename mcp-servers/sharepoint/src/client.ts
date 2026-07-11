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

// ── Types ───────────────────────────────────────────────────────────────────────────────────────

/**
 * SharePoint worker runtime config. Post-ADR-060 the worker holds only the mount-resident state
 * (`accessToken` + `siteId`); refresh is delegated to the host-side `oauth` worker.
 */
export interface SharePointConfig {
  siteId: string;
  accessToken: string;
}

/** A SharePoint file or folder with metadata. */
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

/** A SharePoint user with authentication details. */
export interface SharePointUser {
  displayName: string;
  email: string;
  userPrincipalName: string;
  id: string;
}

/** Metadata for a SharePoint drive item from Microsoft Graph API. */
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

/** Carries the HTTP status of a failed Graph response so callers can branch on it. */
export class GraphApiError extends Error {
  /**
   * Build an error tagged with the failed Graph response status.
   * @param message - Human-readable failure detail.
   * @param status - HTTP status of the failed Graph response.
   */
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'GraphApiError';
  }
}

/** Minimum spacing between siteId resolve retries while the worker is wedged. */
const RESOLVE_RETRY_COOLDOWN_MS = TIMEOUTS.API_CALL_MS;

// ── Client Class ────────────────────────────────────────────────────────────────────────────────

/**
 * Conditional debug logging — only when the DEBUG env var is set.
 * @param message - Debug message.
 * @param data - Context object to log alongside the message.
 */
function debugLog(message: string, data: unknown): void {
  if (process.env.DEBUG) {
    console.log(`${ts()} ${message}`, data);
  }
}

/** SharePoint/Graph API client with automatic token refresh; facades TokenManager + validator. */
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
  /** Epoch ms before which a wedged-call resolve retry is skipped (cooldown). */
  private _resolveRetryBlockedUntil = 0;

  /**
   * Create a SharePoint client.
   * @param config - SharePoint configuration.
   * @param tokensDir - Path to tokens directory.
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

  /** Get the last token save error, if refresh succeeded but disk save failed. */
  getLastTokenSaveError(): Error | null {
    return this.tokenManager.getLastTokenSaveError();
  }

  /** Clear the last token save error, after handling or acknowledging it. */
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
   * Public Graph API wrapper for domain tools calling non-file Graph endpoints. Accepts a full URL
   * or `/sites/{site-id}/...` path (auto-substituted); inherits 401-refresh + retry behaviour.
   * @param method - HTTP method (GET, POST, PATCH, DELETE).
   * @param urlOrPath - Absolute URL or `/sites/{site-id}/...` path.
   * @param body - Optional JSON-serialisable body.
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
      throw new GraphApiError(`Graph API ${method} ${url} failed: ${detail}`, response.status);
    }
    if (response.status === 204) return undefined;
    return (await response.json()) as T;
  }

  /**
   * Return the configured site id. Enforces the "no site_id from model" invariant (ADR-060): the
   * model never picks a site, the worker always uses the one stored in `/tokens/site_id`.
   */
  getSiteId(): string {
    return this.config.siteId;
  }

  // ── Error Handling ─────────────────────────────────────────────────────────────────────────────

  /**
   * Sanitize a Graph API error into a consistent, user-friendly message.
   * @param error - Error object from the Graph API call.
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

  /** Get current config, for external access to potentially refreshed tokens. */
  getConfig(): SharePointConfig {
    return this.config;
  }

  /**
   * Call Graph API with shared refresh-retry (ADR-060) via {@link authedRequest}.
   * @param url - Graph API endpoint URL.
   * @param options - Fetch options (Authorization is added by the helper).
   * @throws {OAuthScopeMismatchError} when refresh detects scope mismatch
   */
  private async callGraphAPI(url: string, options: RequestInit = {}): Promise<Response> {
    if (this.statusTracker.getStatus() === 'failed') {
      url = await this._retryWedgedResolve(url);
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
   * Re-resolve the siteId for a wedged worker and rewrite `url` with the fresh id so this very
   * call benefits; cooldown-guarded, scope-mismatch propagated.
   * @param url - Graph URL built from the stale siteId.
   */
  private async _retryWedgedResolve(url: string): Promise<string> {
    if (Date.now() < this._resolveRetryBlockedUntil) {
      throw this._siteConnectionError();
    }
    const staleSiteId = this.config.siteId;
    try {
      await this._resolveSiteIdMemo();
    } catch (err) {
      if (err instanceof OAuthScopeMismatchError) throw err;
      this._resolveRetryBlockedUntil = Date.now() + RESOLVE_RETRY_COOLDOWN_MS;
      throw this._siteConnectionError();
    }
    this._resolveRetryBlockedUntil = 0;
    return this.config.siteId === staleSiteId
      ? url
      : url.split(staleSiteId).join(this.config.siteId);
  }

  /** Teaching error for a wedged worker whose siteId still cannot be resolved. */
  private _siteConnectionError(): Error {
    return new Error(
      'SharePoint site connection is not established (siteId resolve failed). ' +
        'This is a configuration issue, not a parameter problem: ask the user to check the SharePoint integration settings.'
    );
  }

  /**
   * Encode a path for Graph API, encoding each segment separately for special characters.
   * @param pathStr - Path to encode.
   */
  private encodeGraphPath(pathStr: string): string {
    return pathStr
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  /**
   * Build the Graph API URL for a folder's children endpoint.
   * @param parentDir - Parent directory path.
   */
  private buildFolderChildrenUrl(parentDir: string): string {
    if (parentDir) {
      return `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root:/${this.encodeGraphPath(parentDir)}:/children`;
    }
    return `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/root/children`;
  }

  // ── Tool Implementations ───────────────────────────────────────────────────────────────────────

  /**
   * List files in a directory, paginating via `@odata.nextLink`. Returns `exists: false` with an
   * empty array on 404 (folder doesn't exist yet) so push operations can create it safely.
   * @param params - Listing parameters.
   * @param params.path - Relative path to list (default: root).
   */
  async listFiles(
    params: { path?: string } = {}
  ): Promise<{ files: SharePointFile[]; exists: boolean }> {
    const relativePath = params.path || '';

    if (relativePath && !this.pathValidator.validatePath(relativePath)) {
      throw new Error('Invalid path (security check failed)');
    }

    // Empty path → list the site's drive root; `site_id` already scopes the worker to a single
    // site, so no additional `base_path` sandbox is applied.
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
   * Get file metadata by ID.
   * @param fileId - SharePoint file/folder ID.
   */
  async getFileMetadata(fileId: string): Promise<DriveItemMetadata> {
    const url = `https://graph.microsoft.com/v1.0/sites/${this.config.siteId}/drive/items/${fileId}`;

    const response = await this.callGraphAPI(url);

    if (!response.ok) {
      const errorData = (await response.json()) as { error?: { message?: string } };
      throw new GraphApiError(
        errorData.error?.message || 'Failed to get file metadata',
        response.status
      );
    }

    return (await response.json()) as DriveItemMetadata;
  }

  /** Get the current authenticated user. */
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
   * Upload a file from a local path to SharePoint with optional Compare-And-Swap (`expectedEtag`
   * → If-Match, `createOnly` → If-None-Match: *, `overwrite` → no conditional headers).
   * @param sharepointPath - SharePoint path relative to the site's drive root.
   * @param localPath - Local file path (must be within /workspace).
   * @param options - Upload options.
   * @param options.expectedEtag - Expected ETag for CAS (If-Match header).
   * @param options.createOnly - Only create if file doesn't exist (If-None-Match: *).
   * @param options.overwrite - Overwrite existing file without ETag check.
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
   * Fetch a driveItem (id, sharepointIds, image dimensions, webUrl, name) by its path.
   * @param sharepointPath - Path relative to the drive root (e.g. "speedwave-hero.jpg").
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
   * Download a file from SharePoint to a local path (must be within /workspace) via streaming.
   * @param sharepointPath - SharePoint path relative to the site's drive root.
   * @param localPath - Local destination path (must be within /workspace).
   */
  async downloadFile(sharepointPath: string, localPath: string): Promise<void> {
    if (!this.pathValidator.validateLocalPath(localPath)) {
      throw new Error('Invalid local_path: must be under /workspace');
    }

    if (!this.pathValidator.validatePath(sharepointPath)) {
      throw new Error('Invalid sharepoint_path (security check failed)');
    }

    // `site_id` already scopes us to a single site; no `base_path` prefix is applied.
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
   * Create a remote folder on SharePoint; 409 Conflict (already exists) is treated as success.
   * @param remotePath - SharePoint folder path relative to the site's drive root.
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
   * Recursively create parent folders of `fullPath` that don't yet exist.
   * @param fullPath - Full path including filename.
   */
  async ensureParentFolders(fullPath: string): Promise<void> {
    // Defense-in-depth: callers should validate, but we verify here too.
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

// ── Factory & Initialization ───────────────────────────────────────────────────────────────────

/** Outcome of `resolveCompositeSiteId` — successful id or a typed error. */
export type ResolveResult =
  | { ok: true; compositeId: string }
  | { ok: false; reason: 'validation' | 'transient' | 'not_found' | 'network'; detail: string };

/**
 * Resolve a path-form site id to its composite id; re-validates via `validateGraphSiteId`.
 * On a 401 refreshes via `authedRequest` and retries once when `opts.refreshOn401` (default true).
 * @param siteId - Site id loaded from `/tokens/site_id` (any accepted form).
 * @param accessToken - Bearer token used for the lookup.
 * @param opts - Cold-start refresh tuning.
 * @param opts.tokensDir - Tokens mount path (default {@link defaultTokensDir}); only read when refreshing.
 * @param opts.refreshOn401 - On a 401, refresh via `authedRequest` and retry once (default true).
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
  // A cold-start hang here blocks initializeSharePointClient and the hub's discovery retry
  // budget; apply the same per-request timeout the steady-state path uses.
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
        // Scope mismatch can't self-heal; propagate so the re-consent UI fires.
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
    // Scope mismatch can't self-heal; propagate so the re-consent UI fires.
    if (e instanceof OAuthScopeMismatchError) throw e;
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
 * @param siteId - Raw value loaded from `/tokens/site_id`.
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

    // Load tokens from the worker-mounted dir (ADR-060); `client_id`/`tenant_id`/`refresh_token`
    // are NOT mounted here — they live host-side in `~/.speedwave/oauth/<project>/sharepoint.json`.
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

    // Store the raw siteId; warmupSiteId() resolves path-form to composite in the background
    // and mutates config.siteId in place. Most Graph endpoints accept both forms meanwhile.
    const config: SharePointConfig = { siteId, accessToken };

    const client = new SharePointClient(config, tokensDir);
    // Fire-and-forget: server starts immediately; tools degrade gracefully if Graph is slow.
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
