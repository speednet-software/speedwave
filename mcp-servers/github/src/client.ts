/**
 * GitHub API Client for MCP Worker
 * Isolated GitHub MCP server with per-service token isolation.
 * ONLY has access to GitHub tokens - no other service tokens.
 * Architecture:
 * - Token mounted RO from /tokens/token
 * - github.com only in v1 — no host_url file (unlike GitLab). baseUrl stays default (https://api.github.com).
 * - Exposes the GitHub tools via `@octokit/rest`
 * Security:
 * - Blast radius containment: only GitHub tokens if compromised
 * - Token never exposed in responses
 * - Read-only token mount
 */

import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { retry } from '@octokit/plugin-retry';
import {
  loadTokenFile,
  tokensDir,
  ts,
  withSetupGuidance,
  ConnectionStatusTracker,
  backgroundConnectionTest,
  clampPageSize,
} from '@speedwave/mcp-shared';
import type { HealthStatus } from '@speedwave/mcp-shared';
import type {
  GitHubConfig,
  GitHubRepo,
  GitHubPullRequest,
  GitHubIssue,
  GitHubBranch,
  GitHubCommit,
  GitHubLabel,
  GitHubRelease,
  GitHubWorkflowRun,
  GitHubWorkflowRunArtifact,
  GitHubFileContent,
  GitHubTreeItem,
  GitHubReview,
  GitHubComment,
  GitHubReviewComment,
  GitHubCommitComparison,
  GitHubUser,
} from './types.js';
import type { ConnectionTestResult } from '@speedwave/mcp-shared';
import { TOOL_NAMES } from './tool-names.js';

// Re-export the key types so consumers (the tools layer) can import them from the client too.
export type {
  GitHubConfig,
  GitHubRepo,
  GitHubPullRequest,
  GitHubIssue,
  GitHubBranch,
  GitHubCommit,
  GitHubLabel,
  GitHubRelease,
  GitHubWorkflowRun,
  GitHubWorkflowRunArtifact,
  GitHubFileContent,
  GitHubTreeItem,
  GitHubReview,
  GitHubComment,
  GitHubReviewComment,
  GitHubCommitComparison,
  GitHubUser,
} from './types.js';
export type { ConnectionTestResult } from '@speedwave/mcp-shared';

//═══════════════════════════════════════════════════════════════════════════════
// Octokit composition (rate-limit throttling + transient-error retry)
//═══════════════════════════════════════════════════════════════════════════════

const MyOctokit = Octokit.plugin(throttling, retry);

/** Default page size cap used when no explicit limit is provided. */
const DEFAULT_LIMIT = 100;
/** GitHub's hard per_page maximum. */
const MAX_PER_PAGE = 100;

/**
 * `true` if `url` is a syntactically valid absolute `https://` URL.
 * @param url - Candidate URL string
 * @returns Whether the string parses as an `https:` URL
 */
function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Extracts the redirect target URL from an Octokit response (status 302).
 * @param res - Octokit response object (status 302)
 * @param what - What was being downloaded, for the error message
 * @returns The non-empty `https://` redirect URL
 */
function extractRedirectUrl(res: unknown, what: string): string {
  const r = res as { url?: unknown; headers?: { location?: unknown } };
  const url = String(r.headers?.location || r.url || '');
  if (!url) {
    throw new Error(`GitHub returned no download URL for ${what}`);
  }
  if (!isHttpsUrl(url)) {
    throw new Error(`GitHub returned a non-HTTPS download URL for ${what}`);
  }
  return url;
}

/**
 * Decodes the body of a `mediaType: { format: 'diff' }` response to a string.
 * @param data - The `response.data` from a diff-format request
 * @returns The diff as a UTF-8 string
 */
function decodeDiffData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf-8');
  }
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  return String(data ?? '');
}

/** Generic shape of an Octokit RequestError used by formatError / testConnection. */
interface OctokitErrorLike {
  status?: number;
  message?: string;
  response?: { headers?: Record<string, string | undefined> };
}

/** Coarse category of a GitHub API failure — shared by `formatError` and `testConnection`. */
type ErrorCategory =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'validation'
  | 'network'
  | 'server'
  | 'unknown';

/**
 * Classifies an Octokit-style error into a coarse {@link ErrorCategory}.
 * @param error - The thrown value (an Octokit RequestError or anything else)
 * @returns The matched error category
 */
function classifyOctokitError(error: unknown): ErrorCategory {
  const err = (error || {}) as OctokitErrorLike;
  const status = typeof err.status === 'number' ? err.status : undefined;
  const message = err.message || '';
  if (status === 401 || message.includes('Bad credentials')) return 'auth';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 422) return 'validation';
  if (status && status >= 500 && status < 600) return 'server';
  if (
    message.includes('getaddrinfo') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ENOTFOUND') ||
    /network\s+(error|failed|timeout)/i.test(message)
  ) {
    return 'network';
  }
  return 'unknown';
}

/**
 * An Error already translated into a teaching message for an expected (4xx) API failure.
 * The class identity is the unforgeable marker; the original HTTP status is retained.
 */
class TeachingError extends Error {
  readonly expected = true as const;
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'TeachingError';
  }
}

/**
 * True when `error` was already translated by `withNotFoundMessage`/`withValidationMessage`.
 * @param error - Candidate error to test.
 */
export function isExpectedError(error: unknown): boolean {
  return error instanceof TeachingError;
}

/**
 * Runs `fn`; on a 404, rethrows with `notFoundMessage` instead of Octokit's generic text so the
 * caller learns which param was wrong and which tool supplies a correct value.
 * @param fn - The Octokit call to run
 * @param notFoundMessage - Replacement message naming the failing param + a fix-it tool
 */
async function withNotFoundMessage<T>(fn: () => Promise<T>, notFoundMessage: string): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if ((error as OctokitErrorLike)?.status === 404) {
      throw new TeachingError(notFoundMessage, 404);
    }
    throw error;
  }
}

/**
 * Runs `fn`; on a 422, rethrows with `validationMessage` prefixed to Octokit's own detail so the
 * caller sees both the tool's own param vocabulary and GitHub's raw reason.
 * @param fn - The Octokit call to run
 * @param validationMessage - Replacement message prefix naming the failing param
 */
async function withValidationMessage<T>(
  fn: () => Promise<T>,
  validationMessage: string
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const err = error as OctokitErrorLike;
    if (err?.status === 422) {
      throw new TeachingError(`${validationMessage}: ${err.message || 'invalid request'}`, 422);
    }
    throw error;
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Client Class
//═══════════════════════════════════════════════════════════════════════════════

/**
 * GitHub API client providing methods for repos, pull requests, reviews, branches,
 * commits, repository content, Actions, issues, labels, and releases.
 * Wraps `@octokit/rest` (composed with throttling + retry plugins) with consistent
 * error handling and type-safe response mapping. github.com only in v1.
 */
export class GitHubClient {
  private octokit: InstanceType<typeof MyOctokit>;
  private config: GitHubConfig;
  /** Connection status tracker. Updated by background test scheduled in init. */
  public readonly statusTracker = new ConnectionStatusTracker();

  /** Shared health snapshot. Read by the index.ts healthCheck callback. */
  getHealthStatus(): HealthStatus {
    return this.statusTracker.getHealth();
  }

  /**
   * Creates a new GitHub API client instance with authentication.
   * Configures the underlying Octokit instance with rate-limit throttling
   * (warns and retries up to twice) and transient-error retry.
   * @param config - Client configuration containing the authentication token and optional base URL
   */
  constructor(config: GitHubConfig) {
    if (!config.token || config.token.trim() === '') {
      throw new Error('GitHubClient requires a non-empty authentication token.');
    }
    this.config = config;
    this.octokit = new MyOctokit({
      auth: config.token,
      baseUrl: config.baseUrl,
      throttle: {
        onRateLimit: (
          retryAfter: number,
          options: { method?: string; url?: string },
          _octokit: unknown,
          retryCount: number
        ): boolean => {
          console.warn(
            `${ts()} GitHub rate limit hit for ${options.method} ${options.url}, retrying after ${retryAfter}s (attempt ${retryCount})`
          );
          return retryCount < 2;
        },
        onSecondaryRateLimit: (
          retryAfter: number,
          options: { method?: string; url?: string },
          _octokit: unknown,
          retryCount: number
        ): boolean => {
          console.warn(
            `${ts()} GitHub secondary rate limit for ${options.method} ${options.url}, retrying after ${retryAfter}s (attempt ${retryCount})`
          );
          return retryCount < 2;
        },
      },
    });
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Parameter Validation
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Validates that required parameters are provided and throws descriptive errors if not.
   * @param params - Object mapping parameter names to their values
   * @throws {Error} Error with message listing missing required parameters
   */
  private validateRequired(params: Record<string, unknown>): void {
    const missing = Object.entries(params)
      .filter(([, value]) => value === undefined || value === null || value === '')
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new Error(
        `Missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`
      );
    }
  }

  /**
   * How many items the caller wants: a positive integer with no upper ceiling
   * (missing/0/invalid falls back to {@link DEFAULT_LIMIT}).
   * @param limit - Caller-requested limit (optional)
   */
  private wantedCount(limit?: number): number {
    return clampPageSize(limit, DEFAULT_LIMIT);
  }

  /**
   * Per-page size for a request: the wanted count, capped at GitHub's per-page maximum.
   * @param limit - Caller-requested limit (optional)
   */
  private perPage(limit?: number): number {
    return Math.min(this.wantedCount(limit), MAX_PER_PAGE);
  }

  /**
   * Slices a result array down to the caller-requested count (default 100, no upper cap).
   * @param items - Items returned by the API
   * @param limit - Caller-requested limit (optional)
   * @returns The first `limit` items
   */
  private slice<T>(items: T[], limit?: number): T[] {
    return items.slice(0, this.wantedCount(limit));
  }

  /**
   * Paginates a list endpoint, stopping the fetch once `limit` items are collected
   * (bounds requests to `ceil(limit / per_page)` instead of walking every page).
   * @param route - Octokit endpoint method to paginate
   * @param params - Request parameters (excluding `per_page`)
   * @param limit - Caller-requested limit (optional)
   * @returns The collected items, capped at the wanted count
   */
  private async paginateUpTo(
    route: unknown,
    params: Record<string, unknown>,
    limit?: number
  ): Promise<Array<Record<string, unknown>>> {
    const wanted = this.wantedCount(limit);
    let collected = 0;
    const mapPage = (response: { data: unknown }, done: () => void): unknown[] => {
      const page = (response.data as unknown[] | undefined) ?? [];
      collected += page.length;
      if (collected >= wanted) done();
      return page;
    };
    const paginate = this.octokit.paginate as unknown as (
      r: unknown,
      p: Record<string, unknown>,
      m: (response: { data: unknown }, done: () => void) => unknown[]
    ) => Promise<unknown[]>;
    const items = (await paginate(
      route,
      { ...params, per_page: this.perPage(limit) },
      mapPage
    )) as Array<Record<string, unknown>>;
    return items.slice(0, wanted);
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Response Mappers
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Maps a raw GitHub repository response to the normalized {@link GitHubRepo} shape.
   * @param r - Raw repository object from the GitHub API
   * @returns Normalized repository
   */
  private mapRepo(r: Record<string, unknown>): GitHubRepo {
    const owner = (r.owner || {}) as Record<string, unknown>;
    return {
      id: Number(r.id),
      name: String(r.name || ''),
      full_name: String(r.full_name || ''),
      owner: { login: String(owner.login || '') },
      description: r.description ? String(r.description) : undefined,
      html_url: String(r.html_url || ''),
      default_branch: String(r.default_branch || ''),
      private: Boolean(r.private),
    };
  }

  /**
   * Maps a raw GitHub pull request response to the normalized {@link GitHubPullRequest} shape.
   * @param pr - Raw pull request object from the GitHub API
   * @returns Normalized pull request
   */
  private mapPullRequest(pr: Record<string, unknown>): GitHubPullRequest {
    const head = (pr.head || {}) as Record<string, unknown>;
    const base = (pr.base || {}) as Record<string, unknown>;
    const user = (pr.user || {}) as Record<string, unknown>;
    return {
      number: Number(pr.number),
      title: String(pr.title || ''),
      body: pr.body ? String(pr.body) : undefined,
      state: (pr.state === 'closed' ? 'closed' : 'open') as 'open' | 'closed',
      merged: pr.merged === undefined ? undefined : Boolean(pr.merged),
      head: { ref: String(head.ref || ''), sha: String(head.sha || '') },
      base: { ref: String(base.ref || '') },
      user: { login: String(user.login || '') },
      html_url: String(pr.html_url || ''),
      created_at: String(pr.created_at || ''),
      updated_at: String(pr.updated_at || ''),
      draft: pr.draft === undefined ? undefined : Boolean(pr.draft),
    };
  }

  /**
   * Maps a raw GitHub issue response to the normalized {@link GitHubIssue} shape.
   * @param issue - Raw issue object from the GitHub API
   * @returns Normalized issue
   */
  private mapIssue(issue: Record<string, unknown>): GitHubIssue {
    const user = (issue.user || {}) as Record<string, unknown>;
    const labels = Array.isArray(issue.labels) ? (issue.labels as unknown[]) : [];
    const assignees = Array.isArray(issue.assignees) ? (issue.assignees as unknown[]) : [];
    return {
      number: Number(issue.number),
      title: String(issue.title || ''),
      body: issue.body ? String(issue.body) : undefined,
      state: (issue.state === 'closed' ? 'closed' : 'open') as 'open' | 'closed',
      user: { login: String(user.login || '') },
      labels: labels.map((l) =>
        typeof l === 'string'
          ? { name: l }
          : { name: String((l as Record<string, unknown>).name || '') }
      ),
      assignees: assignees.map((a) => ({
        login: String((a as Record<string, unknown>).login || ''),
      })),
      html_url: String(issue.html_url || ''),
      created_at: String(issue.created_at || ''),
      updated_at: String(issue.updated_at || ''),
    };
  }

  /**
   * Maps a raw GitHub branch response to the normalized {@link GitHubBranch} shape.
   * @param b - Raw branch object from the GitHub API
   * @returns Normalized branch
   */
  private mapBranch(b: Record<string, unknown>): GitHubBranch {
    const commit = (b.commit || {}) as Record<string, unknown>;
    return {
      name: String(b.name || ''),
      commit: { sha: String(commit.sha || '') },
      protected: Boolean(b.protected),
    };
  }

  /**
   * Maps a raw GitHub commit response to the normalized {@link GitHubCommit} shape.
   * @param c - Raw commit object from the GitHub API
   * @returns Normalized commit
   */
  private mapCommit(c: Record<string, unknown>): GitHubCommit {
    const commit = (c.commit || {}) as Record<string, unknown>;
    const author = (commit.author || {}) as Record<string, unknown>;
    return {
      sha: String(c.sha || ''),
      commit: {
        message: String(commit.message || ''),
        author: {
          name: String(author.name || ''),
          email: String(author.email || ''),
          date: String(author.date || ''),
        },
      },
      html_url: String(c.html_url || ''),
    };
  }

  /**
   * Maps a raw GitHub label response to the normalized {@link GitHubLabel} shape.
   * @param l - Raw label object from the GitHub API
   * @returns Normalized label
   */
  private mapLabel(l: Record<string, unknown>): GitHubLabel {
    return {
      id: Number(l.id),
      name: String(l.name || ''),
      color: String(l.color || ''),
      description: l.description ? String(l.description) : undefined,
    };
  }

  /**
   * Maps a raw GitHub release response to the normalized {@link GitHubRelease} shape.
   * @param r - Raw release object from the GitHub API
   * @returns Normalized release
   */
  private mapRelease(r: Record<string, unknown>): GitHubRelease {
    return {
      id: Number(r.id),
      tag_name: String(r.tag_name || ''),
      name: r.name ? String(r.name) : undefined,
      body: r.body ? String(r.body) : undefined,
      draft: Boolean(r.draft),
      prerelease: Boolean(r.prerelease),
      html_url: String(r.html_url || ''),
      created_at: String(r.created_at || ''),
    };
  }

  /**
   * Maps a raw GitHub Actions workflow run response to the normalized {@link GitHubWorkflowRun} shape.
   * @param w - Raw workflow run object from the GitHub API
   * @returns Normalized workflow run
   */
  private mapWorkflowRun(w: Record<string, unknown>): GitHubWorkflowRun {
    return {
      id: Number(w.id),
      name: w.name ? String(w.name) : undefined,
      status: String(w.status || ''),
      conclusion: w.conclusion === null || w.conclusion === undefined ? null : String(w.conclusion),
      head_branch: String(w.head_branch || ''),
      head_sha: String(w.head_sha || ''),
      html_url: String(w.html_url || ''),
      created_at: String(w.created_at || ''),
      updated_at: String(w.updated_at || ''),
    };
  }

  /**
   * Maps a raw GitHub Actions artifact response to the normalized {@link GitHubWorkflowRunArtifact} shape.
   * @param a - Raw artifact object from the GitHub API
   * @returns Normalized artifact
   */
  private mapArtifact(a: Record<string, unknown>): GitHubWorkflowRunArtifact {
    const downloadUrl = String(a.archive_download_url || '');
    return {
      id: Number(a.id),
      name: String(a.name || ''),
      size_in_bytes: Number(a.size_in_bytes || 0),
      // Drop any non-https:// URL (see isHttpsUrl).
      archive_download_url: isHttpsUrl(downloadUrl) ? downloadUrl : '',
      expired: Boolean(a.expired),
    };
  }

  /**
   * Maps a raw GitHub PR review response to the normalized {@link GitHubReview} shape.
   * @param r - Raw review object from the GitHub API
   * @returns Normalized review
   */
  private mapReview(r: Record<string, unknown>): GitHubReview {
    const user = (r.user || {}) as Record<string, unknown>;
    return {
      id: Number(r.id),
      user: { login: String(user.login || '') },
      state: String(r.state || ''),
      body: r.body ? String(r.body) : undefined,
      submitted_at: r.submitted_at ? String(r.submitted_at) : undefined,
      html_url: String(r.html_url || ''),
    };
  }

  /**
   * Maps a raw GitHub issue/PR comment response to the normalized {@link GitHubComment} shape.
   * @param c - Raw comment object from the GitHub API
   * @returns Normalized comment
   */
  private mapComment(c: Record<string, unknown>): GitHubComment {
    const user = (c.user || {}) as Record<string, unknown>;
    return {
      id: Number(c.id),
      user: { login: String(user.login || '') },
      body: String(c.body || ''),
      created_at: String(c.created_at || ''),
      html_url: String(c.html_url || ''),
    };
  }

  /**
   * Maps a raw GitHub PR review comment response to the normalized {@link GitHubReviewComment} shape.
   * @param c - Raw review comment object from the GitHub API
   * @returns Normalized review comment
   */
  private mapReviewComment(c: Record<string, unknown>): GitHubReviewComment {
    const user = (c.user || {}) as Record<string, unknown>;
    return {
      id: Number(c.id),
      user: { login: String(user.login || '') },
      body: String(c.body || ''),
      path: String(c.path || ''),
      line: c.line === undefined || c.line === null ? undefined : Number(c.line),
      created_at: String(c.created_at || ''),
      html_url: String(c.html_url || ''),
    };
  }

  /**
   * Maps a raw GitHub tree item to the normalized {@link GitHubTreeItem} shape.
   * @param t - Raw tree entry from the GitHub API
   * @returns Normalized tree item
   */
  private mapTreeItem(t: Record<string, unknown>): GitHubTreeItem {
    return {
      path: String(t.path || ''),
      mode: String(t.mode || ''),
      type: (t.type === 'tree' ? 'tree' : 'blob') as 'blob' | 'tree',
      sha: String(t.sha || ''),
      size: t.size === undefined || t.size === null ? undefined : Number(t.size),
    };
  }

  /**
   * Maps a raw GitHub user response to the normalized {@link GitHubUser} shape.
   * @param u - Raw user object from the GitHub API
   * @returns Normalized user
   */
  private mapUser(u: Record<string, unknown>): GitHubUser {
    return {
      login: String(u.login || ''),
      name: u.name ? String(u.name) : undefined,
      email: u.email ? String(u.email) : undefined,
      html_url: String(u.html_url || ''),
    };
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Error Handling
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Formats GitHub API errors (Octokit `RequestError` shape) into user-friendly
   * messages with actionable recovery guidance. Handles authentication failures,
   * rate limiting, permission denials, not-found, validation errors, server errors,
   * and network failures.
   * @param error - The error object thrown by `@octokit/rest`
   * @returns Human-readable error message with recovery suggestions (uses shared error helpers)
   * @example
   * ```typescript
   * try {
   *   await client.listRepos();
   * } catch (error) {
   *   console.error(GitHubClient.formatError(error));
   *   // Output: "Authentication failed. Check your GitHub token. <setup guidance>"
   * }
   * ```
   */
  static formatError(error: unknown): string {
    // An already-translated teaching error is returned verbatim: its message is the guidance,
    // and message-sniffing on caller-influenced text (a branch name, a path) must not reclassify it.
    if (isExpectedError(error)) {
      return (error as Error).message;
    }
    const err = (error || {}) as OctokitErrorLike;
    const status = typeof err.status === 'number' ? err.status : undefined;
    const message = err.message || '';

    switch (classifyOctokitError(error)) {
      case 'auth':
        return withSetupGuidance('Authentication failed. Check your GitHub token.');
      case 'permission': {
        if (err.response?.headers?.['x-ratelimit-remaining'] === '0') {
          return 'GitHub API rate limit exceeded. Try again later.';
        }
        return 'Permission denied. Your GitHub token is missing a required scope. If you authorized Speedwave via the GitHub OAuth flow, reconnect to re-grant scopes; if you provided a PAT directly, check its repository permissions.';
      }
      case 'not_found':
        return 'Resource not found in GitHub. Check the owner/repo and that your token has access.';
      case 'validation':
        return `GitHub validation error: ${message || 'invalid request'}`;
      case 'server': {
        // `server` ⟹ classifyOctokitError saw a 5xx status, so `status` is a number here.
        const s = status as number;
        const messages: Record<number, string> = {
          500: 'GitHub server error. Please try again later.',
          502: 'GitHub bad gateway. The server may be overloaded.',
          503: 'GitHub service unavailable. The server is temporarily down.',
          504: 'GitHub gateway timeout. The request took too long.',
        };
        return messages[s] ?? `GitHub server error (${s}). Please try again later.`;
      }
      case 'network':
        return withSetupGuidance('Network error reaching GitHub.');
      case 'unknown':
        return message || 'GitHub API error';
    }
  }

  /**
   * Tests GitHub API connectivity by fetching the authenticated user.
   * @returns Connection test result with success status and categorized error details if it failed
   */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      await this.octokit.rest.users.getAuthenticated();
      return { success: true };
    } catch (error) {
      const errorMessage = GitHubClient.formatError(error);
      console.error(`${ts()} GitHub connection test failed:`, errorMessage);

      const category = classifyOctokitError(error);
      // Fold `validation` / `server` into 'unknown' (not in ConnectionTestResult's set).
      const errorType: ConnectionTestResult['errorType'] =
        category === 'validation' || category === 'server' ? 'unknown' : category;

      return { success: false, error: errorMessage, errorType };
    }
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Users
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Gets the GitHub user authenticated by the mounted token — the account every
   * `owner`/`assignee`/`creator`/`author` "me" question resolves against.
   * @returns Normalized authenticated user
   */
  async getCurrentUser(): Promise<GitHubUser> {
    const res = await this.octokit.rest.users.getAuthenticated();
    return this.mapUser(res.data as Record<string, unknown>);
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Repos
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Lists repositories accessible to the authenticated user, or searches public/visible
   * repositories when a `search` term is given.
   * @param options - Filter and pagination options
   * @param options.search - If provided, performs a repository search instead of listing the user's repos
   * @param options.limit - Maximum number of repositories to return (default 100 when omitted; any positive value honored)
   * @param options.affiliation - Comma-separated affiliations passed to GitHub (e.g. "owner,collaborator")
   * @returns Array of normalized repositories
   */
  async listRepos(
    options: { search?: string; limit?: number; affiliation?: string } = {}
  ): Promise<GitHubRepo[]> {
    if (options.search) {
      const res = await this.octokit.rest.search.repos({
        q: options.search,
        per_page: this.perPage(options.limit),
      });
      const items = (res.data?.items || []) as Array<Record<string, unknown>>;
      return this.slice(items, options.limit).map((r) => this.mapRepo(r));
    }
    const repos = await this.paginateUpTo(
      this.octokit.rest.repos.listForAuthenticatedUser,
      { affiliation: options.affiliation },
      options.limit
    );
    return repos.map((r) => this.mapRepo(r));
  }

  /**
   * Retrieves detailed information about a specific repository.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @returns Normalized repository
   */
  async getRepo(owner: string, repo: string): Promise<GitHubRepo> {
    this.validateRequired({ owner, repo });
    const res = await this.octokit.rest.repos.get({ owner, repo });
    return this.mapRepo(res.data as Record<string, unknown>);
  }

  /**
   * Searches code across GitHub, optionally scoped to a single repository.
   * @param query - Code search query (GitHub code-search syntax)
   * @param options - Search scope and pagination options
   * @param options.owner - Repository owner to scope the search to (requires `repo`)
   * @param options.repo - Repository name to scope the search to (requires `owner`)
   * @param options.limit - Maximum number of results to return (default 100 when omitted; any positive value honored)
   * @returns Array of `{ path, repository, html_url }` matches
   */
  async searchCode(
    query: string,
    options: { owner?: string; repo?: string; limit?: number } = {}
  ): Promise<Array<{ path: string; repository: string; html_url: string }>> {
    this.validateRequired({ query });
    const q =
      options.owner && options.repo ? `repo:${options.owner}/${options.repo} ${query}` : query;
    const res = await this.octokit.rest.search.code({
      q,
      per_page: this.perPage(options.limit),
    });
    const items = (res.data?.items || []) as Array<Record<string, unknown>>;
    return this.slice(items, options.limit).map((i) => {
      const repository = (i.repository || {}) as Record<string, unknown>;
      return {
        path: String(i.path || ''),
        repository: String(repository.full_name || ''),
        html_url: String(i.html_url || ''),
      };
    });
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Pull Requests
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Lists pull requests in a repository with optional filters.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param options - Filter and pagination options
   * @param options.state - Filter by state: "open", "closed", or "all" (default "open")
   * @param options.head - Filter by head ref (e.g. "user:branch" or "org:branch")
   * @param options.base - Filter by base branch name
   * @param options.limit - Maximum number of PRs to return (default 100 when omitted; any positive value honored)
   * @returns Array of normalized pull requests
   */
  async listPullRequests(
    owner: string,
    repo: string,
    options: {
      state?: 'open' | 'closed' | 'all';
      head?: string;
      base?: string;
      limit?: number;
    } = {}
  ): Promise<GitHubPullRequest[]> {
    this.validateRequired({ owner, repo });
    const prs = await this.paginateUpTo(
      this.octokit.rest.pulls.list,
      { owner, repo, state: options.state || 'open', head: options.head, base: options.base },
      options.limit
    );
    return prs.map((pr) => this.mapPullRequest(pr));
  }

  /**
   * Gets detailed information about a specific pull request.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param number - Pull request number
   * @returns Normalized pull request
   */
  async getPullRequest(owner: string, repo: string, number: number): Promise<GitHubPullRequest> {
    this.validateRequired({ owner, repo, number });
    const res = await withNotFoundMessage(
      () => this.octokit.rest.pulls.get({ owner, repo, pull_number: number }),
      `PR #${number} not found in ${owner}/${repo}. Check the number with ${TOOL_NAMES.LIST_PULL_REQUESTS}, or the owner/repo with ${TOOL_NAMES.GET_REPO}, or your token may lack access.`
    );
    return this.mapPullRequest(res.data as Record<string, unknown>);
  }

  /**
   * Creates a new pull request.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param params - Pull request creation parameters
   * @param params.title - PR title
   * @param params.head - Head ref (the branch with the changes)
   * @param params.base - Base branch the changes should be merged into
   * @param params.body - Optional PR description (Markdown)
   * @param params.draft - Whether to create the PR as a draft
   * @returns Normalized created pull request
   */
  async createPullRequest(
    owner: string,
    repo: string,
    params: { title: string; head: string; base: string; body?: string; draft?: boolean }
  ): Promise<GitHubPullRequest> {
    this.validateRequired({
      owner,
      repo,
      title: params.title,
      head: params.head,
      base: params.base,
    });
    const res = await this.octokit.rest.pulls.create({
      owner,
      repo,
      title: params.title,
      head: params.head,
      base: params.base,
      body: params.body,
      draft: params.draft,
    });
    return this.mapPullRequest(res.data as Record<string, unknown>);
  }

  /**
   * Merges a pull request.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param number - Pull request number
   * @param options - Merge options
   * @param options.merge_method - Merge strategy: "merge", "squash", or "rebase" (default "merge")
   * @param options.commit_title - Optional commit title for the merge commit
   * @returns Merge result with the merge commit SHA and status message
   */
  async mergePullRequest(
    owner: string,
    repo: string,
    number: number,
    options: { merge_method?: 'merge' | 'squash' | 'rebase'; commit_title?: string } = {}
  ): Promise<{ merged: boolean; sha: string; message: string }> {
    this.validateRequired({ owner, repo, number });
    const res = await this.octokit.rest.pulls.merge({
      owner,
      repo,
      pull_number: number,
      merge_method: options.merge_method || 'merge',
      commit_title: options.commit_title,
    });
    const data = res.data as Record<string, unknown>;
    return {
      merged: Boolean(data.merged),
      sha: String(data.sha || ''),
      message: String(data.message || ''),
    };
  }

  /**
   * Updates properties of an existing pull request.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param number - Pull request number
   * @param params - Update parameters
   * @param params.title - New PR title
   * @param params.body - New PR description (Markdown)
   * @param params.state - New state: "open" or "closed"
   * @param params.base - New base branch
   * @returns Normalized updated pull request
   */
  async updatePullRequest(
    owner: string,
    repo: string,
    number: number,
    params: { title?: string; body?: string; state?: 'open' | 'closed'; base?: string }
  ): Promise<GitHubPullRequest> {
    this.validateRequired({ owner, repo, number });
    const res = await this.octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: number,
      title: params.title,
      body: params.body,
      state: params.state,
      base: params.base,
    });
    return this.mapPullRequest(res.data as Record<string, unknown>);
  }

  /**
   * Retrieves the raw unified diff for a pull request.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param number - Pull request number
   * @returns The PR diff as a raw unified-diff string
   */
  async getPrDiff(owner: string, repo: string, number: number): Promise<string> {
    this.validateRequired({ owner, repo, number });
    const res = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: number,
      mediaType: { format: 'diff' },
    });
    return decodeDiffData(res.data);
  }

  /**
   * Lists the files changed in a pull request with per-file stats and patches.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param number - Pull request number
   * @param options - Pagination options
   * @param options.limit - Maximum number of files to return (default 100 when omitted; any positive value honored)
   * @returns Array of `{ filename, status, additions, deletions, changes, patch? }`
   */
  async getPrFiles(
    owner: string,
    repo: string,
    number: number,
    options: { limit?: number } = {}
  ): Promise<
    Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      changes: number;
      patch?: string;
    }>
  > {
    this.validateRequired({ owner, repo, number });
    const files = await this.paginateUpTo(
      this.octokit.rest.pulls.listFiles,
      { owner, repo, pull_number: number },
      options.limit
    );
    return files.map((f) => ({
      filename: String(f.filename || ''),
      status: String(f.status || ''),
      additions: Number(f.additions || 0),
      deletions: Number(f.deletions || 0),
      changes: Number(f.changes || 0),
      patch: f.patch ? String(f.patch) : undefined,
    }));
  }

  //═════════════════════════════════════════════════════════════════════════════
  // PR Review
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Lists the commits included in a pull request.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param number - Pull request number
   * @param options - Pagination options
   * @param options.limit - Maximum number of commits to return (default 100 when omitted; any positive value honored)
   * @returns Array of normalized commits
   */
  async listPrCommits(
    owner: string,
    repo: string,
    number: number,
    options: { limit?: number } = {}
  ): Promise<GitHubCommit[]> {
    this.validateRequired({ owner, repo, number });
    const commits = await this.paginateUpTo(
      this.octokit.rest.pulls.listCommits,
      { owner, repo, pull_number: number },
      options.limit
    );
    return commits.map((c) => this.mapCommit(c));
  }

  /**
   * Lists the reviews submitted on a pull request.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param number - Pull request number
   * @param options - Pagination options
   * @param options.limit - Maximum number of reviews to return (default 100 when omitted; any positive value honored)
   * @returns Array of normalized reviews
   */
  async listPrReviews(
    owner: string,
    repo: string,
    number: number,
    options: { limit?: number } = {}
  ): Promise<GitHubReview[]> {
    this.validateRequired({ owner, repo, number });
    const reviews = await this.paginateUpTo(
      this.octokit.rest.pulls.listReviews,
      { owner, repo, pull_number: number },
      options.limit
    );
    return reviews.map((r) => this.mapReview(r));
  }

  /**
   * Creates a review on a pull request (approve, request changes, or comment),
   * optionally with inline line comments.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param number - Pull request number
   * @param params - Review parameters
   * @param params.body - Optional review body text
   * @param params.event - Review action: "APPROVE", "REQUEST_CHANGES", or "COMMENT"
   * @param params.comments - Optional inline comments as `{ path, line, body }`
   * @returns Normalized created review
   */
  async createPrReview(
    owner: string,
    repo: string,
    number: number,
    params: {
      body?: string;
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
      comments?: Array<{ path: string; line: number; body: string }>;
    }
  ): Promise<GitHubReview> {
    this.validateRequired({ owner, repo, number, event: params.event });
    const res = await this.octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: number,
      body: params.body,
      event: params.event,
      comments: params.comments,
    });
    return this.mapReview(res.data as Record<string, unknown>);
  }

  /**
   * Lists general (issue-style) comments on a pull request.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param number - Pull request number
   * @param options - Pagination options
   * @param options.limit - Maximum number of comments to return (default 100 when omitted; any positive value honored)
   * @returns Array of normalized comments
   */
  async listPrComments(
    owner: string,
    repo: string,
    number: number,
    options: { limit?: number } = {}
  ): Promise<GitHubComment[]> {
    this.validateRequired({ owner, repo, number });
    const comments = await this.paginateUpTo(
      this.octokit.rest.issues.listComments,
      { owner, repo, issue_number: number },
      options.limit
    );
    return comments.map((c) => this.mapComment(c));
  }

  /**
   * Adds a general (issue-style) comment to a pull request.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param number - Pull request number
   * @param body - Comment text (Markdown)
   * @returns Normalized created comment
   */
  async createPrComment(
    owner: string,
    repo: string,
    number: number,
    body: string
  ): Promise<GitHubComment> {
    this.validateRequired({ owner, repo, number, body });
    const res = await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: number,
      body,
    });
    return this.mapComment(res.data as Record<string, unknown>);
  }

  /**
   * Adds a review comment attached to a specific line of a pull request diff.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param number - Pull request number
   * @param params - Review comment parameters
   * @param params.body - Comment text (Markdown)
   * @param params.commit_id - SHA of the commit to comment on
   * @param params.path - File path the comment is attached to
   * @param params.line - Line number in the file
   * @returns Normalized created review comment
   */
  async createPrReviewComment(
    owner: string,
    repo: string,
    number: number,
    params: { body: string; commit_id: string; path: string; line: number }
  ): Promise<GitHubReviewComment> {
    this.validateRequired({
      owner,
      repo,
      number,
      body: params.body,
      commit_id: params.commit_id,
      path: params.path,
      line: params.line,
    });
    const res = await this.octokit.rest.pulls.createReviewComment({
      owner,
      repo,
      pull_number: number,
      body: params.body,
      commit_id: params.commit_id,
      path: params.path,
      line: params.line,
    });
    return this.mapReviewComment(res.data as Record<string, unknown>);
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Branches
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Lists branches in a repository.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param options - Pagination options
   * @param options.limit - Maximum number of branches to return (default 100 when omitted; any positive value honored)
   * @returns Array of normalized branches
   */
  async listBranches(
    owner: string,
    repo: string,
    options: { limit?: number } = {}
  ): Promise<GitHubBranch[]> {
    this.validateRequired({ owner, repo });
    const branches = await this.paginateUpTo(
      this.octokit.rest.repos.listBranches,
      { owner, repo },
      options.limit
    );
    return branches.map((b) => this.mapBranch(b));
  }

  /**
   * Gets detailed information about a specific branch.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param branch - Branch name
   * @returns Normalized branch
   */
  async getBranch(owner: string, repo: string, branch: string): Promise<GitHubBranch> {
    this.validateRequired({ owner, repo, branch });
    const res = await withNotFoundMessage(
      () => this.octokit.rest.repos.getBranch({ owner, repo, branch }),
      `Branch '${branch}' not found in ${owner}/${repo}. Check the name with ${TOOL_NAMES.LIST_BRANCHES}, or the owner/repo with ${TOOL_NAMES.GET_REPO}, or your token may lack access.`
    );
    return this.mapBranch(res.data as unknown as Record<string, unknown>);
  }

  /**
   * Creates a new branch from a SHA or an existing branch.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param params - Branch creation parameters
   * @param params.branch - Name for the new branch
   * @param params.from_sha - Commit SHA to branch from (takes precedence over `from_branch`)
   * @param params.from_branch - Existing branch to branch from (its head SHA is resolved if `from_sha` is omitted)
   * @returns Normalized created branch
   */
  async createBranch(
    owner: string,
    repo: string,
    params: { branch: string; from_sha?: string; from_branch?: string }
  ): Promise<GitHubBranch> {
    this.validateRequired({ owner, repo, branch: params.branch });
    let sha = params.from_sha;
    if (!sha) {
      if (!params.from_branch) {
        throw new Error('Missing required parameter: from_sha or from_branch');
      }
      const source = await this.getBranch(owner, repo, params.from_branch);
      sha = source.commit.sha;
    }
    await withValidationMessage(
      () =>
        this.octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${params.branch}`,
          sha,
        }),
      `Could not create branch '${params.branch}' in ${owner}/${repo} (it may already exist; check with ${TOOL_NAMES.LIST_BRANCHES})`
    );
    return this.getBranch(owner, repo, params.branch);
  }

  /**
   * Deletes a branch from the repository.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param branch - Branch name to delete
   * @returns `{ deleted: true, branch }` on success
   */
  async deleteBranch(
    owner: string,
    repo: string,
    branch: string
  ): Promise<{ deleted: boolean; branch: string }> {
    this.validateRequired({ owner, repo, branch });
    await this.octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
    return { deleted: true, branch };
  }

  /**
   * Compares two refs (branches or commits) and returns the diff summary.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param base - Base ref
   * @param head - Head ref
   * @returns Normalized commit comparison
   */
  async compareBranches(
    owner: string,
    repo: string,
    base: string,
    head: string
  ): Promise<GitHubCommitComparison> {
    this.validateRequired({ owner, repo, base, head });
    const res = await this.octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${base}...${head}`,
    });
    const data = res.data as Record<string, unknown>;
    const commits = Array.isArray(data.commits) ? (data.commits as Record<string, unknown>[]) : [];
    return {
      ahead_by: Number(data.ahead_by || 0),
      behind_by: Number(data.behind_by || 0),
      total_commits: Number(data.total_commits || 0),
      commits: commits.map((c) => this.mapCommit(c)),
      status: String(data.status || ''),
    };
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Commits
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Lists commits in a repository with optional filters.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param options - Filter and pagination options
   * @param options.sha - SHA or branch to start listing commits from
   * @param options.path - Only commits that touched this path
   * @param options.author - Filter by author (GitHub login or email)
   * @param options.since - ISO 8601 timestamp lower bound
   * @param options.until - ISO 8601 timestamp upper bound
   * @param options.limit - Maximum number of commits to return (default 100 when omitted; any positive value honored)
   * @returns Array of normalized commits
   */
  async listCommits(
    owner: string,
    repo: string,
    options: {
      sha?: string;
      path?: string;
      author?: string;
      since?: string;
      until?: string;
      limit?: number;
    } = {}
  ): Promise<GitHubCommit[]> {
    this.validateRequired({ owner, repo });
    const commits = await this.paginateUpTo(
      this.octokit.rest.repos.listCommits,
      {
        owner,
        repo,
        sha: options.sha,
        path: options.path,
        author: options.author,
        since: options.since,
        until: options.until,
      },
      options.limit
    );
    return commits.map((c) => this.mapCommit(c));
  }

  /**
   * Lists commits on a specific branch.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param branch - Branch name
   * @param options - Pagination options
   * @param options.limit - Maximum number of commits to return (default 100 when omitted; any positive value honored)
   * @returns Array of normalized commits
   */
  async listBranchCommits(
    owner: string,
    repo: string,
    branch: string,
    options: { limit?: number } = {}
  ): Promise<GitHubCommit[]> {
    this.validateRequired({ owner, repo, branch });
    return this.listCommits(owner, repo, { sha: branch, limit: options.limit });
  }

  /**
   * Searches commits across GitHub, optionally scoped to a single repository.
   * @param query - Commit search query (GitHub commit-search syntax)
   * @param options - Search scope and pagination options
   * @param options.owner - Repository owner to scope the search to (requires `repo`)
   * @param options.repo - Repository name to scope the search to (requires `owner`)
   * @param options.limit - Maximum number of results to return (default 100 when omitted; any positive value honored)
   * @returns Array of normalized commits
   */
  async searchCommits(
    query: string,
    options: { owner?: string; repo?: string; limit?: number } = {}
  ): Promise<GitHubCommit[]> {
    this.validateRequired({ query });
    const q =
      options.owner && options.repo ? `repo:${options.owner}/${options.repo} ${query}` : query;
    const res = await this.octokit.rest.search.commits({
      q,
      per_page: this.perPage(options.limit),
    });
    const items = (res.data?.items || []) as Array<Record<string, unknown>>;
    return this.slice(items, options.limit).map((c) => this.mapCommit(c));
  }

  /**
   * Retrieves the raw unified diff introduced by a specific commit.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param ref - Commit SHA or ref
   * @returns The commit diff as a raw unified-diff string
   */
  async getCommitDiff(owner: string, repo: string, ref: string): Promise<string> {
    this.validateRequired({ owner, repo, ref });
    const res = await this.octokit.rest.repos.getCommit({
      owner,
      repo,
      ref,
      mediaType: { format: 'diff' },
    });
    return decodeDiffData(res.data);
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Repository Content
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Retrieves a repository tree (file/directory listing), optionally recursive.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param options - Tree options
   * @param options.ref - Branch, tag, or commit SHA to read the tree from (default: the repo's default branch)
   * @param options.recursive - Include nested directories recursively (default false)
   * @returns Array of normalized tree items
   */
  async getTree(
    owner: string,
    repo: string,
    options: { ref?: string; recursive?: boolean } = {}
  ): Promise<GitHubTreeItem[]> {
    this.validateRequired({ owner, repo });
    let treeRef = options.ref;
    if (!treeRef) {
      const repository = await this.getRepo(owner, repo);
      treeRef = repository.default_branch;
      if (!treeRef) {
        throw new Error(
          `Cannot resolve a tree for ${owner}/${repo}: the repository has no default branch. ` +
            `Pass an explicit 'ref' (branch, tag, or commit SHA).`
        );
      }
    }
    const res = await this.octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: treeRef,
      recursive: options.recursive ? '1' : undefined,
    });
    const tree = Array.isArray((res.data as Record<string, unknown>).tree)
      ? ((res.data as Record<string, unknown>).tree as Record<string, unknown>[])
      : [];
    return tree.map((t) => this.mapTreeItem(t));
  }

  /**
   * Retrieves the content of a file in a repository. Throws if the path is a directory.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param path - File path from the repository root
   * @param options - Read options
   * @param options.ref - Branch, tag, or commit SHA to read from (default: the repo's default branch)
   * @returns Normalized file content: UTF-8 text when the bytes round-trip losslessly, otherwise
   *   the raw base64 string (with `encoding: 'base64'`) so binary files are never corrupted
   * @throws {Error} if the path resolves to a directory rather than a file
   */
  async getFileContents(
    owner: string,
    repo: string,
    path: string,
    options: { ref?: string } = {}
  ): Promise<GitHubFileContent> {
    this.validateRequired({ owner, repo, path });
    const res = await withNotFoundMessage(
      () => this.octokit.rest.repos.getContent({ owner, repo, path, ref: options.ref }),
      `File not found: '${path}' in ${owner}/${repo}${options.ref ? ` at ref '${options.ref}'` : ''}. ` +
        `Check the path with ${TOOL_NAMES.GET_TREE}, or the ref with ${TOOL_NAMES.LIST_BRANCHES}, or your token may lack access.`
    );
    const data = res.data as unknown;
    const file = data as Record<string, unknown>;
    if (Array.isArray(data) || file.type !== 'file' || typeof file.content !== 'string') {
      throw new TeachingError(
        `Path '${path}' is a directory, not a file. Use ${TOOL_NAMES.GET_TREE} to list its contents.`
      );
    }
    const rawEncoding = String(file.encoding || 'base64');
    if (rawEncoding === 'none') {
      throw new TeachingError(
        `File '${path}' in ${owner}/${repo} is 1-100 MB, so GitHub returns no inline content (encoding "none"). ` +
          `Inline content is unavailable at this size; fetch the raw bytes out of band instead of reading it here.`
      );
    }
    const rawContent = String(file.content || '');
    let content = rawContent;
    let encoding = rawEncoding === 'base64' ? 'base64' : 'utf-8';
    if (rawEncoding === 'base64') {
      const decoded = Buffer.from(rawContent, 'base64');
      // Only surface UTF-8 text when the decode round-trips losslessly; otherwise keep base64
      // so binary files (images, archives, ...) are never corrupted by a forced UTF-8 decode.
      if (Buffer.from(decoded.toString('utf-8'), 'utf-8').equals(decoded)) {
        content = decoded.toString('utf-8');
        encoding = 'utf-8';
      }
    }
    return {
      path: String(file.path || path),
      content,
      encoding,
      sha: String(file.sha || ''),
      size: Number(file.size || 0),
    };
  }

  /**
   * Creates or updates a file in a repository (commits the change).
   * If `sha` is not provided, the existing file's SHA is fetched first (ignored if absent).
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param params - File parameters
   * @param params.path - File path from the repository root
   * @param params.content - File content (UTF-8; base64-encoded before sending)
   * @param params.message - Commit message
   * @param params.branch - Branch to commit to (default: the repo's default branch)
   * @param params.sha - Blob SHA of the file being replaced (required by GitHub for updates)
   * @returns `{ commit_sha, path, html_url }` of the resulting commit
   */
  async createOrUpdateFile(
    owner: string,
    repo: string,
    params: { path: string; content: string; message: string; branch?: string; sha?: string }
  ): Promise<{ commit_sha: string; path: string; html_url: string }> {
    this.validateRequired({ owner, repo, path: params.path, message: params.message });
    let sha = params.sha;
    if (!sha) {
      let existingData: unknown;
      try {
        const existing = await this.octokit.rest.repos.getContent({
          owner,
          repo,
          path: params.path,
          ref: params.branch,
        });
        existingData = existing.data;
      } catch (error) {
        // 404 means the file does not exist yet (a normal create); anything else blocks the write.
        const status = (error as OctokitErrorLike)?.status;
        if (status !== 404) {
          throw new TeachingError(
            `Could not check whether '${params.path}' already exists in ${owner}/${repo} before writing: ${GitHubClient.formatError(error)}`,
            status
          );
        }
      }
      if (Array.isArray(existingData)) {
        throw new TeachingError(
          `Path '${params.path}' is a directory, not a file. Use ${TOOL_NAMES.GET_TREE} to list its contents.`
        );
      }
      if (existingData) {
        const file = existingData as Record<string, unknown>;
        sha = typeof file.sha === 'string' ? file.sha : undefined;
      }
    }
    const res = await this.octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: params.path,
      message: params.message,
      content: Buffer.from(params.content, 'utf-8').toString('base64'),
      branch: params.branch,
      sha,
    });
    const data = res.data as Record<string, unknown>;
    const commit = (data.commit || {}) as Record<string, unknown>;
    const contentObj = (data.content || {}) as Record<string, unknown>;
    return {
      commit_sha: String(commit.sha || ''),
      path: String(contentObj.path || params.path),
      html_url: String(contentObj.html_url || ''),
    };
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Actions
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Lists GitHub Actions workflow runs for a repository.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param options - Filter and pagination options
   * @param options.branch - Filter by branch
   * @param options.status - Filter by run status (e.g. "completed", "in_progress")
   * @param options.limit - Maximum number of runs to return (default 100 when omitted; any positive value honored)
   * @returns Array of normalized workflow runs
   */
  async listWorkflowRuns(
    owner: string,
    repo: string,
    options: { branch?: string; status?: string; limit?: number } = {}
  ): Promise<GitHubWorkflowRun[]> {
    this.validateRequired({ owner, repo });
    const runs = await this.paginateUpTo(
      this.octokit.rest.actions.listWorkflowRunsForRepo,
      { owner, repo, branch: options.branch, status: options.status },
      options.limit
    );
    return runs.map((r) => this.mapWorkflowRun(r));
  }

  /**
   * Gets detailed information about a single workflow run.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param run_id - Workflow run ID
   * @returns Normalized workflow run
   */
  async getWorkflowRun(owner: string, repo: string, run_id: number): Promise<GitHubWorkflowRun> {
    this.validateRequired({ owner, repo, run_id });
    const res = await this.octokit.rest.actions.getWorkflowRun({ owner, repo, run_id });
    return this.mapWorkflowRun(res.data as Record<string, unknown>);
  }

  /**
   * Gets the download URL for a workflow run's logs (a ZIP archive). The archive is
   * not downloaded or parsed — only the short-lived redirect URL is returned.
   * `request: { redirect: 'manual' }` stops Octokit from following the 302 (which
   * would buffer the whole archive into memory); we only want the `Location` URL.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param run_id - Workflow run ID
   * @returns `{ download_url, note }` where `download_url` points to the logs ZIP
   */
  async getRunLogs(
    owner: string,
    repo: string,
    run_id: number
  ): Promise<{ download_url: string; note: string }> {
    this.validateRequired({ owner, repo, run_id });
    const res = await this.octokit.rest.actions.downloadWorkflowRunLogs({
      owner,
      repo,
      run_id,
      request: { redirect: 'manual' },
    });
    return {
      download_url: extractRedirectUrl(res, 'workflow run logs'),
      note: 'GitHub returns logs as a ZIP archive at this URL (short-lived; download promptly).',
    };
  }

  /**
   * Re-runs a workflow run.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param run_id - Workflow run ID
   * @returns `{ rerun: true }` on success
   */
  async rerunWorkflow(owner: string, repo: string, run_id: number): Promise<{ rerun: boolean }> {
    this.validateRequired({ owner, repo, run_id });
    await this.octokit.rest.actions.reRunWorkflow({ owner, repo, run_id });
    return { rerun: true };
  }

  /**
   * Triggers a `workflow_dispatch` event for a workflow.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param params - Trigger parameters
   * @param params.workflow_id - Workflow file name (e.g. "ci.yml") or numeric ID
   * @param params.ref - Git ref (branch or tag) to run the workflow on
   * @param params.inputs - Optional inputs map passed to the workflow
   * @returns `{ triggered: true, workflow_id, ref }` on success
   */
  async triggerWorkflow(
    owner: string,
    repo: string,
    params: { workflow_id: string | number; ref: string; inputs?: Record<string, unknown> }
  ): Promise<{ triggered: boolean; workflow_id: string | number; ref: string }> {
    this.validateRequired({ owner, repo, workflow_id: params.workflow_id, ref: params.ref });
    await this.octokit.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: params.workflow_id,
      ref: params.ref,
      inputs: params.inputs as Record<string, string> | undefined,
    });
    return { triggered: true, workflow_id: params.workflow_id, ref: params.ref };
  }

  /**
   * Lists the artifacts produced by a workflow run.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param run_id - Workflow run ID
   * @param options - Pagination options
   * @param options.limit - Maximum number of artifacts to return (default 100 when omitted; any positive value honored)
   * @returns Array of normalized artifacts
   */
  async listWorkflowRunArtifacts(
    owner: string,
    repo: string,
    run_id: number,
    options: { limit?: number } = {}
  ): Promise<GitHubWorkflowRunArtifact[]> {
    this.validateRequired({ owner, repo, run_id });
    const artifacts = await this.paginateUpTo(
      this.octokit.rest.actions.listWorkflowRunArtifacts,
      { owner, repo, run_id },
      options.limit
    );
    return artifacts.map((a) => this.mapArtifact(a));
  }

  /**
   * Gets the download URL for a workflow artifact (a ZIP archive). The archive is
   * not downloaded or parsed — only the short-lived redirect URL is returned.
   * `request: { redirect: 'manual' }` stops Octokit from following the 302 (which
   * would buffer the whole archive into memory); we only want the `Location` URL.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param artifact_id - Artifact ID
   * @returns `{ download_url, note }` where `download_url` points to the artifact ZIP
   */
  async downloadArtifact(
    owner: string,
    repo: string,
    artifact_id: number
  ): Promise<{ download_url: string; note: string }> {
    this.validateRequired({ owner, repo, artifact_id });
    const res = await this.octokit.rest.actions.downloadArtifact({
      owner,
      repo,
      artifact_id,
      archive_format: 'zip',
      request: { redirect: 'manual' },
    });
    return {
      download_url: extractRedirectUrl(res, 'workflow artifact'),
      note: 'GitHub returns the artifact as a ZIP archive at this URL (short-lived; download promptly).',
    };
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Issues
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Lists issues in a repository. GitHub's issues endpoint also returns pull requests;
   * those are filtered out (any item with a `pull_request` key is excluded).
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param options - Filter and pagination options
   * @param options.state - Filter by state: "open", "closed", or "all" (default "open")
   * @param options.labels - Comma-separated label names
   * @param options.assignee - Filter by assignee login (or "none" / "*")
   * @param options.creator - Filter by creator login
   * @param options.limit - Maximum number of issues to return (default 100 when omitted; any positive value honored)
   * @returns Array of normalized issues (pull requests excluded)
   */
  async listIssues(
    owner: string,
    repo: string,
    options: {
      state?: 'open' | 'closed' | 'all';
      labels?: string;
      assignee?: string;
      creator?: string;
      limit?: number;
    } = {}
  ): Promise<GitHubIssue[]> {
    this.validateRequired({ owner, repo });
    const issues = (await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: options.state || 'open',
      labels: options.labels,
      assignee: options.assignee,
      creator: options.creator,
      per_page: this.perPage(options.limit),
    })) as Array<Record<string, unknown>>;
    const issuesOnly = issues.filter((i) => !i.pull_request);
    return this.slice(issuesOnly, options.limit).map((i) => this.mapIssue(i));
  }

  /**
   * Gets detailed information about a specific issue.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param number - Issue number
   * @returns Normalized issue
   */
  async getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
    this.validateRequired({ owner, repo, number });
    const res = await withNotFoundMessage(
      () => this.octokit.rest.issues.get({ owner, repo, issue_number: number }),
      `Issue #${number} not found in ${owner}/${repo}. Check the number with ${TOOL_NAMES.LIST_ISSUES}, or the owner/repo with ${TOOL_NAMES.GET_REPO}, or your token may lack access.`
    );
    return this.mapIssue(res.data as Record<string, unknown>);
  }

  /**
   * Creates a new issue.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param params - Issue creation parameters
   * @param params.title - Issue title
   * @param params.body - Optional issue body (Markdown)
   * @param params.labels - Optional label names to apply
   * @param params.assignees - Optional assignee logins
   * @returns Normalized created issue
   */
  async createIssue(
    owner: string,
    repo: string,
    params: { title: string; body?: string; labels?: string[]; assignees?: string[] }
  ): Promise<GitHubIssue> {
    this.validateRequired({ owner, repo, title: params.title });
    const res = await this.octokit.rest.issues.create({
      owner,
      repo,
      title: params.title,
      body: params.body,
      labels: params.labels,
      assignees: params.assignees,
    });
    return this.mapIssue(res.data as Record<string, unknown>);
  }

  /**
   * Updates an existing issue.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param number - Issue number
   * @param params - Update parameters
   * @param params.title - New issue title
   * @param params.body - New issue body (Markdown)
   * @param params.state - New state: "open" or "closed"
   * @param params.labels - Replacement label names
   * @param params.assignees - Replacement assignee logins
   * @returns Normalized updated issue
   */
  async updateIssue(
    owner: string,
    repo: string,
    number: number,
    params: {
      title?: string;
      body?: string;
      state?: 'open' | 'closed';
      labels?: string[];
      assignees?: string[];
    }
  ): Promise<GitHubIssue> {
    this.validateRequired({ owner, repo, number });
    const res = await this.octokit.rest.issues.update({
      owner,
      repo,
      issue_number: number,
      title: params.title,
      body: params.body,
      state: params.state,
      labels: params.labels,
      assignees: params.assignees,
    });
    return this.mapIssue(res.data as Record<string, unknown>);
  }

  /**
   * Closes an issue (convenience wrapper over {@link updateIssue}).
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param number - Issue number
   * @returns Normalized issue with `state: "closed"`
   */
  async closeIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
    return this.updateIssue(owner, repo, number, { state: 'closed' });
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Labels
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Lists labels defined in a repository.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param options - Pagination options
   * @param options.limit - Maximum number of labels to return (default 100 when omitted; any positive value honored)
   * @returns Array of normalized labels
   */
  async listLabels(
    owner: string,
    repo: string,
    options: { limit?: number } = {}
  ): Promise<GitHubLabel[]> {
    this.validateRequired({ owner, repo });
    const labels = await this.paginateUpTo(
      this.octokit.rest.issues.listLabelsForRepo,
      { owner, repo },
      options.limit
    );
    return labels.map((l) => this.mapLabel(l));
  }

  /**
   * Creates a new label. The `#` prefix on the color is stripped if present
   * (GitHub expects a bare hex value).
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param params - Label creation parameters
   * @param params.name - Label name
   * @param params.color - Hex color (with or without leading `#`)
   * @param params.description - Optional label description
   * @returns Normalized created label
   */
  async createLabel(
    owner: string,
    repo: string,
    params: { name: string; color: string; description?: string }
  ): Promise<GitHubLabel> {
    this.validateRequired({ owner, repo, name: params.name, color: params.color });
    const res = await withValidationMessage(
      () =>
        this.octokit.rest.issues.createLabel({
          owner,
          repo,
          name: params.name,
          color: params.color.replace(/^#/, ''),
          description: params.description,
        }),
      `Could not create label '${params.name}' in ${owner}/${repo} (it may already exist; check with ${TOOL_NAMES.LIST_LABELS})`
    );
    return this.mapLabel(res.data as Record<string, unknown>);
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Tags & Releases
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Creates a Git tag pointing at a commit. If `message` is provided, an annotated
   * tag object is created first and the ref points at it; otherwise the ref points
   * directly at the commit.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param params - Tag creation parameters
   * @param params.tag - Tag name (e.g. "v1.0.0")
   * @param params.sha - Commit SHA the tag should point at
   * @param params.message - Optional message for an annotated tag
   * @returns `{ tag, sha, ref }` of the created tag ref
   */
  async createTag(
    owner: string,
    repo: string,
    params: { tag: string; sha: string; message?: string }
  ): Promise<{ tag: string; sha: string; ref: string }> {
    this.validateRequired({ owner, repo, tag: params.tag, sha: params.sha });
    let targetSha = params.sha;
    const message = params.message;
    if (message) {
      const tagObj = await withNotFoundMessage(
        () =>
          this.octokit.rest.git.createTag({
            owner,
            repo,
            tag: params.tag,
            message,
            object: params.sha,
            type: 'commit',
          }),
        `SHA '${params.sha}' not found in ${owner}/${repo}. Check it with ${TOOL_NAMES.LIST_COMMITS} or ${TOOL_NAMES.GET_BRANCH}. The owner/repo may also be wrong, or your token may lack access.`
      );
      targetSha = String((tagObj.data as Record<string, unknown>).sha || params.sha);
    }
    await withValidationMessage(
      () =>
        this.octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/tags/${params.tag}`,
          sha: targetSha,
        }),
      `Could not create tag '${params.tag}' in ${owner}/${repo} (it may already exist)`
    );
    return { tag: params.tag, sha: targetSha, ref: `refs/tags/${params.tag}` };
  }

  /**
   * Deletes a Git tag.
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param tag - Tag name to delete
   * @returns `{ deleted: true, tag }` on success
   */
  async deleteTag(
    owner: string,
    repo: string,
    tag: string
  ): Promise<{ deleted: boolean; tag: string }> {
    this.validateRequired({ owner, repo, tag });
    await this.octokit.rest.git.deleteRef({ owner, repo, ref: `tags/${tag}` });
    return { deleted: true, tag };
  }

  /**
   * Creates a release associated with a tag (creating the tag if it does not exist).
   * @param owner - Repository owner login
   * @param repo - Repository name
   * @param params - Release creation parameters
   * @param params.tag_name - Tag name for the release (e.g. "v1.0.0")
   * @param params.name - Optional release name (defaults to the tag name)
   * @param params.body - Optional release notes (Markdown)
   * @param params.draft - Whether to create the release as a draft
   * @param params.prerelease - Whether to mark the release as a pre-release
   * @param params.target_commitish - Commitish the tag should point at if it does not exist yet
   * @returns Normalized created release
   */
  async createRelease(
    owner: string,
    repo: string,
    params: {
      tag_name: string;
      name?: string;
      body?: string;
      draft?: boolean;
      prerelease?: boolean;
      target_commitish?: string;
    }
  ): Promise<GitHubRelease> {
    this.validateRequired({ owner, repo, tag_name: params.tag_name });
    const res = await withValidationMessage(
      () =>
        this.octokit.rest.repos.createRelease({
          owner,
          repo,
          tag_name: params.tag_name,
          name: params.name || params.tag_name,
          body: params.body,
          draft: params.draft,
          prerelease: params.prerelease,
          target_commitish: params.target_commitish,
        }),
      `Could not create a release for tag '${params.tag_name}' in ${owner}/${repo} (a release for this tag may already exist)`
    );
    return this.mapRelease(res.data as Record<string, unknown>);
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Initialization
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Initializes the GitHub client with a token from /tokens/token.
 * Returns null (not throws) when token is missing or invalid (graceful degradation).
 * @returns Configured GitHubClient instance, or null if the token is not found / invalid
 */
export async function initializeGitHubClient(): Promise<GitHubClient | null> {
  try {
    console.log(`${ts()} 📖 Loading GitHub token from: ${tokensDir()}/token`);
    const token = await loadTokenFile('token');
    if (!token) {
      console.warn(`${ts()} ${withSetupGuidance('GitHub token is empty or not found.')}`);
      return null;
    }

    const client = new GitHubClient({ token });
    backgroundConnectionTest(
      client.statusTracker,
      async () => {
        const result = await client.testConnection();
        if (!result.success) {
          throw new Error(result.error ?? 'connection test failed');
        }
      },
      'GitHub'
    );

    console.log(`${ts()} ✅ GitHub client initialized, connection test scheduled`);
    return client;
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.warn(`${ts()} Failed to initialize GitHub client: ${detail}`);
    return null;
  }
}
