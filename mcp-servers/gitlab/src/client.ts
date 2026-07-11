/**
 * GitLab API Client for MCP Worker: isolated, ONLY has GitLab tokens. Token from /tokens/token,
 * host from /tokens/host_url or GITLAB_URL; wraps `@gitbeaker/rest` (tools pinned by metadata).
 */

import { Gitlab } from '@gitbeaker/rest';
import {
  loadTokenFile,
  ts,
  withSetupGuidance,
  ConnectionStatusTracker,
  backgroundConnectionTest,
  tokensDir,
  clampPageSize,
} from '@speedwave/mcp-shared';
import type { ConnectionTestResult, HealthStatus } from '@speedwave/mcp-shared';
import fs from 'fs/promises';
import { basename } from 'node:path';
import { TOOL_NAMES } from './tool-names.js';
import type { IdentityScope } from './identity-scopes.js';

/**
 * Reads `rec[camel] ?? rec[snake]`, the dual camelCase/gitbeaker snake_case response read.
 * @param rec - Raw gitbeaker response object.
 * @param camel - camelCase property name.
 * @param snake - snake_case fallback property name.
 */
function pick(rec: Record<string, unknown>, camel: string, snake: string): unknown {
  return rec[camel] ?? rec[snake];
}

/** Minimal user identity shape shared by an MR's author, assignees, and reviewers. */
export interface GitLabUserSummary {
  id: number;
  name: string;
  username: string;
}

/**
 * Maps a raw gitbeaker user payload to the minimal {@link GitLabUserSummary} shape.
 * @param u - Raw gitbeaker user payload.
 */
function mapUserSummary(u: unknown): GitLabUserSummary {
  const rec = (u || {}) as Record<string, unknown>;
  return {
    id: Number(rec.id) || 0,
    name: String(rec.name || ''),
    username: String(rec.username || ''),
  };
}

/**
 * An Error already translated into a teaching message by this client (e.g. {@link GitLabClient.getIssue}).
 * The class identity is the unforgeable marker so `formatError` returns it verbatim.
 */
class TeachingError extends Error {
  readonly expected = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'TeachingError';
  }
}

/**
 * True when `error` was already translated into a teaching message by this client.
 * @param error - Candidate error to test.
 */
export function isTeachingError(error: unknown): boolean {
  return error instanceof TeachingError;
}

// ── Types ───────────────────────────────────────────────────────────────────────────────────────

/** GitLab API client configuration containing authentication token and host URL */
export interface GitLabConfig {
  token: string;
  host: string;
}

/** GitLab project information including ID, name, path, description, and URLs */
export interface GitLabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  description?: string;
  web_url: string;
  default_branch?: string;
}

/** GitLab merge request details including state, branches, author, and timestamps */
export interface GitLabMergeRequest {
  id: number;
  iid: number;
  title: string;
  description?: string;
  state: string;
  source_branch: string;
  target_branch: string;
  author: GitLabUserSummary;
  assignees?: GitLabUserSummary[];
  reviewers?: GitLabUserSummary[];
  labels?: string[];
  web_url: string;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  changes_count?: string | null;
  has_conflicts?: boolean;
  merge_status?: string;
  detailed_merge_status?: string;
}

/** GitLab CI/CD pipeline information including status, ref, SHA, and timestamps */
export interface GitLabPipeline {
  id: number;
  status: string;
  ref: string;
  sha: string;
  web_url: string;
  created_at: string;
  updated_at: string;
}

/** Authenticated GitLab user identity, as returned by getCurrentUser. */
export interface GitLabCurrentUser {
  id: number;
  username: string;
  name: string;
  email?: string;
  web_url: string;
}

/** GitLab commit information including SHA, message, author details, and timestamp */
export interface GitLabCommit {
  id: string;
  short_id: string;
  title: string;
  message: string;
  author_name: string;
  author_email: string;
  created_at: string;
}

// ── Client Class ────────────────────────────────────────────────────────────────────────────────

/**
 * GitLab API client for projects, merge requests, pipelines, commits, branches, and issues.
 * Wraps `@gitbeaker/rest` with consistent error handling and type-safe response mapping.
 */
export class GitLabClient {
  private gitlab: InstanceType<typeof Gitlab>;
  private config: GitLabConfig;
  /** Connection status tracker. Updated by background test scheduled in init. */
  public readonly statusTracker = new ConnectionStatusTracker();

  /**
   * Creates a GitLab API client, initializing the underlying Gitbeaker client with credentials.
   * @param config - Client configuration containing authentication token and GitLab host URL.
   */
  constructor(config: GitLabConfig) {
    this.config = config;
    this.gitlab = new Gitlab({
      token: config.token,
      host: config.host,
    });
  }

  /** Shared health snapshot. Read by the index.ts healthCheck callback. */
  getHealthStatus(): HealthStatus {
    return this.statusTracker.getHealth();
  }

  // ── Parameter Validation ──────────────────────────────────────────────────────────────────────

  /**
   * Validates that required parameters are provided; throws listing all missing names.
   * @param params - Object mapping parameter names to their values.
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

  // ── Response Mappers ──────────────────────────────────────────────────────────────────────────

  /**
   * Maps a raw gitbeaker MR response to {@link GitLabMergeRequest}, normalizing field casing.
   * @param mr - Raw merge request response object from GitLab API.
   */
  private mapMergeRequestResponse(mr: Record<string, unknown>): GitLabMergeRequest {
    // Warn if critical fields are missing (helps debug API response issues)
    const sourceBranch = pick(mr, 'sourceBranch', 'source_branch');
    const targetBranch = pick(mr, 'targetBranch', 'target_branch');
    const webUrl = pick(mr, 'webUrl', 'web_url');

    if (!sourceBranch && mr.iid) {
      console.warn(`${ts()} MR !${mr.iid} missing source_branch property`);
    }
    if (!targetBranch && mr.iid) {
      console.warn(`${ts()} MR !${mr.iid} missing target_branch property`);
    }
    if (!webUrl && mr.iid) {
      console.warn(`${ts()} MR !${mr.iid} missing web_url property`);
    }

    return {
      id: Number(mr.id),
      iid: Number(mr.iid),
      title: String(mr.title || ''),
      description: mr.description ? String(mr.description) : undefined,
      state: String(mr.state || ''),
      source_branch: String(sourceBranch || ''),
      target_branch: String(targetBranch || ''),
      author: mapUserSummary(mr.author),
      assignees: Array.isArray(mr.assignees) ? mr.assignees.map(mapUserSummary) : undefined,
      reviewers: Array.isArray(mr.reviewers) ? mr.reviewers.map(mapUserSummary) : undefined,
      labels: (mr.labels as string[] | undefined) ?? undefined,
      web_url: String(webUrl || ''),
      created_at: String(pick(mr, 'createdAt', 'created_at') || ''),
      updated_at: String(pick(mr, 'updatedAt', 'updated_at') || ''),
      merged_at: pick(mr, 'mergedAt', 'merged_at') as string | null | undefined,
      merge_commit_sha: pick(mr, 'mergeCommitSha', 'merge_commit_sha') as string | null | undefined,
      changes_count: pick(mr, 'changesCount', 'changes_count') as string | null | undefined,
      has_conflicts: pick(mr, 'hasConflicts', 'has_conflicts') as boolean | undefined,
      merge_status: pick(mr, 'mergeStatus', 'merge_status') as string | undefined,
      detailed_merge_status: pick(mr, 'detailedMergeStatus', 'detailed_merge_status') as
        | string
        | undefined,
    };
  }

  // ── Error Handling ────────────────────────────────────────────────────────────────────────────

  /**
   * Formats a GitLab API error (typically from `@gitbeaker/rest`) into a user-friendly message
   * with actionable recovery guidance (auth/permission/not-found/5xx/network cases).
   * @param error - The error object from GitLab API (typically from `@gitbeaker/rest`).
   */
  static formatError(error: unknown): string {
    // An already-translated teaching error is returned verbatim: its message is the guidance,
    // and message-sniffing below (e.g. on "not found") must not reclassify it.
    if (isTeachingError(error)) {
      return (error as Error).message;
    }
    // Handle ``@gitbeaker``/rest error responses
    const err = error as {
      response?: { status?: number };
      cause?: { response?: { status?: number }; description?: unknown };
      message?: string;
    };
    const status = err.response?.status || err.cause?.response?.status;
    const message = err.message || '';

    if (status === 401 || message.includes('401') || message.includes('Unauthorized')) {
      return withSetupGuidance('Authentication failed. Check your GitLab token.');
    }

    if (status === 403 || message.includes('403') || message.includes('Forbidden')) {
      return (
        'Permission denied performing this GitLab operation. Your token likely lacks the ' +
        'required scope (api or write_repository) or you lack sufficient project role ' +
        '(e.g. Maintainer for merge/approve/delete-branch). Check the integration setup in the ' +
        'Speedwave Desktop app.'
      );
    }

    if (status === 404 || message.includes('404') || message.includes('not found')) {
      return (
        'Resource not found in GitLab. Verify the project_id/path and the ID/name argument are ' +
        `correct, then list valid values with the corresponding list* tool first (${TOOL_NAMES.LIST_PROJECT_IDS}, ` +
        `${TOOL_NAMES.LIST_MR_IDS}, ${TOOL_NAMES.LIST_ISSUES}, ${TOOL_NAMES.LIST_BRANCHES}, etc.) before retrying.`
      );
    }

    // 5xx - Server errors
    if (status && status >= 500 && status < 600) {
      if (status === 500) return 'GitLab server error. Please try again later.';
      if (status === 502) return 'GitLab bad gateway. The server may be overloaded.';
      if (status === 503) return 'GitLab service unavailable. The server is temporarily down.';
      if (status === 504) return 'GitLab gateway timeout. The request took too long.';
      return `GitLab server error (${status}). Please try again later.`;
    }

    if (status === 422) {
      const detail = typeof err.cause?.description === 'string' ? err.cause.description : message;
      return (
        `GitLab rejected the request (422 Unprocessable): ${detail}. Check that the ` +
        'referenced branch/tag/state value is valid and not already in a terminal or protected state.'
      );
    }

    if (
      message.includes('getaddrinfo') ||
      message.includes('ECONNREFUSED') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ENOTFOUND') ||
      /network\s+(error|failed|timeout)/i.test(message)
    ) {
      return withSetupGuidance('Network error. Check your GitLab URL.');
    }

    // Extract meaningful part from gitbeaker errors
    if (typeof err.cause?.description === 'string') {
      return `GitLab API error: ${err.cause.description}`;
    }

    return message || 'GitLab API error';
  }

  /** Tests GitLab API connectivity by fetching the current authenticated user. */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      await this.gitlab.Users.showCurrentUser();
      return { success: true };
    } catch (error) {
      const errorMessage = GitLabClient.formatError(error);
      console.error(`${ts()} GitLab connection test failed:`, errorMessage);

      const err = error as {
        response?: { status?: number };
        cause?: { response?: { status?: number } };
        message?: string;
      };
      const status = err.response?.status || err.cause?.response?.status;
      const message = err.message || '';

      let errorType: ConnectionTestResult['errorType'] = 'unknown';
      if (status === 401 || message.includes('401')) errorType = 'auth';
      else if (status === 403 || message.includes('403')) errorType = 'permission';
      else if (status === 404 || message.includes('404')) errorType = 'not_found';
      else if (message.includes('getaddrinfo') || message.includes('ECONNREFUSED'))
        errorType = 'network';

      return { success: false, error: errorMessage, errorType };
    }
  }

  /**
   * Gets the identity of the currently authenticated GitLab user (the configured token owner);
   * resolves 'me'/'my' style queries (my MRs, my issues, my projects) without asking the user.
   */
  async getCurrentUser(): Promise<GitLabCurrentUser> {
    const user = (await this.gitlab.Users.showCurrentUser()) as Record<string, unknown>;
    return {
      id: Number(user.id),
      username: String(user.username || ''),
      name: String(user.name || ''),
      email: user.email ? String(user.email) : undefined,
      web_url: String(pick(user, 'webUrl', 'web_url') || ''),
    };
  }

  // ── Projects ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Lists GitLab projects accessible to the authenticated user, sorted by last activity
   * (most recent first). Only the first page is returned, capped by `options.limit` (default 20).
   * @param options - Filter and pagination options.
   * @param options.search - Filter projects by name or path (case-insensitive partial match).
   * @param options.limit - Maximum number of projects to return (default 20, max 100).
   * @param options.page - Page number for pagination (default 1).
   * @param options.owned - If true, only return projects owned by the current user.
   * @param options.membership - If true, only return projects the authenticated user is a member of.
   * @param options.archived - If true, include archived projects (default false).
   */
  async listProjects(
    options: {
      search?: string;
      limit?: number;
      page?: number;
      owned?: boolean;
      membership?: boolean;
      archived?: boolean;
    } = {}
  ): Promise<GitLabProject[]> {
    const limit = clampPageSize(options.limit, 20, 100);
    const projects = await this.gitlab.Projects.all({
      search: options.search,
      perPage: limit,
      page: options.page || 1,
      pagination: 'offset' as const,
      owned: options.owned,
      membership: options.membership,
      archived: options.archived,
    });

    // Take only first page (limit results)
    const limited = projects.slice(0, limit);

    return limited.map((p: Record<string, unknown>) => ({
      id: p.id as number,
      name: String(p.name),
      path_with_namespace: String(p.pathWithNamespace || p.path_with_namespace || ''),
      description: p.description ? String(p.description) : undefined,
      web_url: String(p.webUrl || p.web_url || ''),
      default_branch: p.defaultBranch ? String(p.defaultBranch) : undefined,
    }));
  }

  /**
   * Retrieves detailed information about a specific GitLab project, by numeric ID or
   * "namespace/path"; optionally includes license and statistics data.
   * @param projectId - Project ID (numeric) or path with namespace (e.g. "acme/my-project").
   * @param options - Additional data to include in the response.
   * @param options.license - If true, includes license information.
   * @param options.statistics - If true, includes project statistics.
   */
  async showProject(
    projectId: string | number,
    options: { license?: boolean; statistics?: boolean } = {}
  ): Promise<GitLabProject & { license?: unknown; statistics?: unknown }> {
    this.validateRequired({ project_id: projectId });
    const p = await this.gitlab.Projects.show(projectId, {
      license: options.license,
      statistics: options.statistics,
    });
    return {
      id: p.id as number,
      name: String(p.name),
      path_with_namespace: String(p.pathWithNamespace || p.path_with_namespace || ''),
      description: p.description ? String(p.description) : undefined,
      web_url: String(p.webUrl || p.web_url || ''),
      default_branch:
        p.defaultBranch || p.default_branch
          ? String(p.defaultBranch || p.default_branch)
          : undefined,
      ...(options.license && p.license ? { license: p.license } : {}),
      ...(options.statistics && p.statistics ? { statistics: p.statistics } : {}),
    };
  }

  /**
   * Searches for code (literal text, not regex) via GitLab blob search, globally or scoped to
   * `options.project_id`; results contain file paths, matching lines, and context.
   * @param query - Search query string (literal text, not regex).
   * @param options - Search scope options.
   * @param options.project_id - If provided, limits search to this project ID or path.
   */
  async searchCode(
    query: string,
    options: {
      project_id?: string | number;
    } = {}
  ): Promise<unknown[]> {
    this.validateRequired({ query });
    // Search within project or globally
    if (options.project_id) {
      const results = await this.gitlab.Search.all('blobs' as const, query, {
        projectId: options.project_id,
        perPage: 100,
        maxPages: 1,
      });
      return results as unknown[];
    }
    const results = await this.gitlab.Search.all('blobs' as const, query, {
      perPage: 100,
      maxPages: 1,
    });
    return results as unknown[];
  }

  // ── Merge Requests ────────────────────────────────────────────────────────────────────────────

  /**
   * Lists merge requests in a project, filterable by state, author/reviewer username,
   * comma-separated labels, and identity scope (`assigned_to_me` = assignee, not reviewer).
   * @param projectId - Project ID or path (e.g. "my-group/my-project" or 123).
   * @param options - Filter options.
   * @param options.state - Filter by state: "opened", "closed", "merged", or "all".
   * @param options.author_username - Filter by author's username.
   * @param options.reviewer_username - Filter by reviewer's username.
   * @param options.labels - Filter by comma-separated labels (e.g. "bug,feature").
   * @param options.scope - Filter by identity scope.
   * @param options.limit - Maximum number of results to return (default 20).
   */
  async listMergeRequests(
    projectId: string | number,
    options: {
      state?: string;
      author_username?: string;
      reviewer_username?: string;
      labels?: string;
      scope?: IdentityScope;
      limit?: number;
    } = {}
  ): Promise<GitLabMergeRequest[]> {
    this.validateRequired({ project_id: projectId });
    const limit = clampPageSize(options.limit, 20, 100);
    // Use type assertion to handle state parameter
    const queryOptions: Record<string, unknown> = {
      projectId,
      perPage: limit,
      maxPages: 1,
    };

    if (options.state) {
      queryOptions.state = options.state;
    }
    if (options.author_username) {
      queryOptions.authorUsername = options.author_username;
    }
    if (options.reviewer_username) {
      queryOptions.reviewerUsername = options.reviewer_username;
    }
    if (options.labels) {
      queryOptions.labels = options.labels;
    }
    if (options.scope) {
      queryOptions.scope = options.scope;
    }

    const mrs = (await this.gitlab.MergeRequests.all(
      queryOptions as Parameters<typeof this.gitlab.MergeRequests.all>[0]
    )) as unknown as Array<Record<string, unknown>>;

    // Take only first page
    const limited = mrs.slice(0, limit);

    return limited.map((mr) => this.mapMergeRequestResponse(mr));
  }

  /**
   * Gets detailed information about a specific merge request by project and MR IID.
   * @param projectId - Project ID or path (e.g. "my-group/my-project" or 123).
   * @param mrIid - Merge request IID (internal ID within the project).
   */
  async showMergeRequest(projectId: string | number, mrIid: number): Promise<GitLabMergeRequest> {
    this.validateRequired({ project_id: projectId, mr_iid: mrIid });
    const mr = await this.gitlab.MergeRequests.show(projectId, mrIid);
    return this.mapMergeRequestResponse(mr as unknown as Record<string, unknown>);
  }

  /**
   * Creates a new merge request; `description` supports Markdown, `labels` is comma-separated.
   * @param projectId - Project ID or path (e.g. "my-group/my-project" or 123).
   * @param options - Merge request options.
   * @param options.source_branch - Source branch name (branch to merge from).
   * @param options.target_branch - Target branch name (branch to merge into).
   * @param options.title - Title of the merge request.
   * @param options.description - Description/body of the merge request (Markdown).
   * @param options.labels - Comma-separated labels to apply.
   * @param options.remove_source_branch - Whether to remove source branch after merge.
   */
  async createMergeRequest(
    projectId: string | number,
    options: {
      source_branch: string;
      target_branch: string;
      title: string;
      description?: string;
      labels?: string;
      remove_source_branch?: boolean;
    }
  ): Promise<GitLabMergeRequest> {
    this.validateRequired({
      project_id: projectId,
      source_branch: options.source_branch,
      target_branch: options.target_branch,
      title: options.title,
    });
    const mr = await this.gitlab.MergeRequests.create(
      projectId,
      options.source_branch,
      options.target_branch,
      options.title,
      {
        description: options.description,
        labels: options.labels,
        removeSourceBranch: options.remove_source_branch,
      }
    );

    return this.mapMergeRequestResponse(mr as unknown as Record<string, unknown>);
  }

  /**
   * Approves a merge request.
   * @param projectId - Project ID or path (e.g. "my-group/my-project" or 123).
   * @param mrIid - Merge request IID (internal ID within the project).
   */
  async approveMergeRequest(projectId: string | number, mrIid: number): Promise<void> {
    this.validateRequired({ project_id: projectId, mr_iid: mrIid });
    await this.gitlab.MergeRequestApprovals.approve(projectId, mrIid);
  }

  /**
   * Merges an approved merge request; `sha` (source branch head) guards against conflicts.
   * @param projectId - Project ID or path (e.g. "my-group/my-project" or 123).
   * @param mrIid - Merge request IID (internal ID within the project).
   * @param options - Merge options.
   * @param options.squash - Whether to squash commits into a single commit.
   * @param options.should_remove_source_branch - Whether to remove source branch after merge.
   * @param options.auto_merge - Whether to merge when pipeline succeeds.
   * @param options.sha - Expected SHA of source branch head (for conflict detection).
   */
  async mergeMergeRequest(
    projectId: string | number,
    mrIid: number,
    options: {
      squash?: boolean;
      should_remove_source_branch?: boolean;
      auto_merge?: boolean;
      sha?: string;
    } = {}
  ): Promise<GitLabMergeRequest> {
    this.validateRequired({ project_id: projectId, mr_iid: mrIid });
    // For auto_merge, use accept with mergeWhenPipelineSucceeds option
    const mr = await this.gitlab.MergeRequests.accept(projectId, mrIid, {
      squash: options.squash,
      shouldRemoveSourceBranch: options.should_remove_source_branch,
      sha: options.sha,
      mergeWhenPipelineSucceeds: options.auto_merge,
    });

    return this.mapMergeRequestResponse(mr as unknown as Record<string, unknown>);
  }

  /**
   * Updates properties of an existing merge request; `labels` replaces the existing set.
   * @param projectId - Project ID or path (e.g. "my-group/my-project" or 123).
   * @param mrIid - Merge request IID (internal ID within the project).
   * @param options - Update options.
   * @param options.title - New title for the merge request.
   * @param options.description - New description/body (Markdown).
   * @param options.target_branch - New target branch name.
   * @param options.state_event - State change action: "close" or "reopen".
   * @param options.labels - Comma-separated labels (replaces existing labels).
   */
  async updateMergeRequest(
    projectId: string | number,
    mrIid: number,
    options: {
      title?: string;
      description?: string;
      target_branch?: string;
      state_event?: string;
      labels?: string;
    }
  ): Promise<GitLabMergeRequest> {
    this.validateRequired({ project_id: projectId, mr_iid: mrIid });
    const mr = await this.gitlab.MergeRequests.edit(projectId, mrIid, {
      title: options.title,
      description: options.description,
      targetBranch: options.target_branch,
      stateEvent: options.state_event as 'close' | 'reopen' | undefined,
      labels: options.labels,
    });

    return this.mapMergeRequestResponse(mr as unknown as Record<string, unknown>);
  }

  /**
   * Gets file changes (diffs) in a merge request.
   * @param projectId - Project ID or path (e.g. "my-group/my-project" or 123).
   * @param mrIid - Merge request IID (internal ID within the project).
   */
  async getMrChanges(projectId: string | number, mrIid: number): Promise<unknown> {
    this.validateRequired({ project_id: projectId, mr_iid: mrIid });
    return await this.gitlab.MergeRequests.allDiffs(projectId, mrIid);
  }

  /**
   * Lists all commits in a merge request (default limit 20).
   * @param projectId - Project ID or path (e.g. "my-group/my-project" or 123).
   * @param mrIid - Merge request IID (internal ID within the project).
   * @param limit - Maximum number of commits to return.
   */
  async listMrCommits(
    projectId: string | number,
    mrIid: number,
    limit: number = 20
  ): Promise<GitLabCommit[]> {
    const clamped = clampPageSize(limit, 20, 100);
    const commits = await this.gitlab.MergeRequests.allCommits(projectId, mrIid, {
      perPage: clamped,
      maxPages: 1,
    });
    return commits.slice(0, clamped).map((c: Record<string, unknown>) => ({
      id: String(c.id),
      short_id: String(c.shortId || c.short_id || ''),
      title: String(c.title),
      message: String(c.message),
      author_name: String(c.authorName || c.author_name || ''),
      author_email: String(c.authorEmail || c.author_email || ''),
      created_at: String(c.createdAt || c.created_at || ''),
    }));
  }

  /**
   * Lists all CI/CD pipelines associated with a merge request (default limit 10).
   * @param projectId - Project ID or path (e.g. "my-group/my-project" or 123).
   * @param mrIid - Merge request IID (internal ID within the project).
   * @param limit - Maximum number of pipelines to return.
   */
  async listMrPipelines(
    projectId: string | number,
    mrIid: number,
    limit: number = 10
  ): Promise<GitLabPipeline[]> {
    const clamped = clampPageSize(limit, 10, 100);
    const pipelines = await this.gitlab.MergeRequests.allPipelines(projectId, mrIid, {
      perPage: clamped,
      maxPages: 1,
    });
    return pipelines.slice(0, clamped).map((p: Record<string, unknown>) => {
      return {
        id: p.id as number,
        status: String(p.status),
        ref: String(p.ref),
        sha: String(p.sha),
        web_url: String(p.webUrl || p.web_url || ''),
        created_at: String(p.createdAt || p.created_at || ''),
        updated_at: String(p.updatedAt || p.updated_at || ''),
      };
    });
  }

  /**
   * Lists comments/notes on a merge request (default limit 20).
   * @param projectId - Project ID or path (e.g. "my-group/my-project" or 123).
   * @param mrIid - Merge request IID (internal ID within the project).
   * @param limit - Maximum number of notes to return.
   */
  async listMrNotes(
    projectId: string | number,
    mrIid: number,
    limit: number = 20
  ): Promise<unknown[]> {
    const clamped = clampPageSize(limit, 20, 100);
    const notes = await this.gitlab.MergeRequestNotes.all(projectId, mrIid, {
      perPage: clamped,
      maxPages: 1,
    });
    return notes.slice(0, clamped);
  }

  /**
   * Adds a comment/note (Markdown supported) to a merge request.
   * @param projectId - Project ID or path (e.g. "my-group/my-project" or 123).
   * @param mrIid - Merge request IID (internal ID within the project).
   * @param body - Comment text (supports Markdown).
   */
  async createMrNote(projectId: string | number, mrIid: number, body: string): Promise<unknown> {
    return await this.gitlab.MergeRequestNotes.create(projectId, mrIid, body);
  }

  // ── Discussions ───────────────────────────────────────────────────────────────────────────────

  /**
   * Retrieves all discussion threads (comments, review notes, resolved status) on an MR.
   * @param projectId - Project ID or path (e.g. "group/project" or 123).
   * @param mrIid - Merge request internal ID (IID, not ID).
   * @param limit - Maximum number of discussion threads to return.
   */
  async listMrDiscussions(
    projectId: string | number,
    mrIid: number,
    limit: number = 20
  ): Promise<unknown[]> {
    const clamped = clampPageSize(limit, 20, 100);
    const discussions = await this.gitlab.MergeRequestDiscussions.all(projectId, mrIid, {
      perPage: clamped,
      maxPages: 1,
    });
    return discussions.slice(0, clamped);
  }

  /**
   * Creates a new discussion thread (Markdown body) on a merge request.
   * @param projectId - Project ID or path (e.g. "group/project" or 123).
   * @param mrIid - Merge request internal ID (IID, not ID).
   * @param body - Discussion comment text (Markdown).
   */
  async createMrDiscussion(
    projectId: string | number,
    mrIid: number,
    body: string
  ): Promise<unknown> {
    return await this.gitlab.MergeRequestDiscussions.create(projectId, mrIid, body);
  }

  // ── Branches ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Lists branches with commit details and protection status; `search` supports wildcards.
   * @param projectId - Project ID or path (e.g. "group/project" or 123).
   * @param options - Search and pagination options.
   * @param options.search - Filter branches by name pattern.
   * @param options.limit - Maximum number of branches to return.
   */
  async listBranches(
    projectId: string | number,
    options: { search?: string; limit?: number } = {}
  ): Promise<unknown[]> {
    const limit = clampPageSize(options.limit, 20, 100);
    const branches = await this.gitlab.Branches.all(projectId, {
      search: options.search,
      perPage: limit,
      maxPages: 1,
    });
    return branches.slice(0, limit);
  }

  /**
   * Retrieves branch details: commit history, protection rules, and can_push permission.
   * @param projectId - Project ID or path (e.g. "group/project" or 123).
   * @param branchName - Name of the branch to retrieve.
   */
  async getBranch(projectId: string | number, branchName: string): Promise<unknown> {
    return await this.gitlab.Branches.show(projectId, branchName);
  }

  /**
   * Creates a new branch from an existing branch name or commit SHA (`ref`).
   * @param projectId - Project ID or path (e.g. "group/project" or 123).
   * @param branchName - Name for the new branch.
   * @param ref - Source branch name or commit SHA to branch from.
   */
  async createBranch(
    projectId: string | number,
    branchName: string,
    ref: string
  ): Promise<unknown> {
    return await this.gitlab.Branches.create(projectId, branchName, ref);
  }

  /**
   * Permanently deletes a branch; throws if it is protected or does not exist.
   * @param projectId - Project ID or path (e.g. "group/project" or 123).
   * @param branchName - Name of the branch to delete.
   */
  async deleteBranch(projectId: string | number, branchName: string): Promise<void> {
    this.validateRequired({ project_id: projectId, branch_name: branchName });
    await this.gitlab.Branches.remove(projectId, branchName);
  }

  /**
   * Compares two branches or commits: commit list, diffs, and file change statistics.
   * @param projectId - Project ID or path (e.g. "group/project" or 123).
   * @param from - Source branch name or commit SHA.
   * @param to - Target branch name or commit SHA to compare against.
   */
  async compareBranches(projectId: string | number, from: string, to: string): Promise<unknown> {
    return await this.gitlab.Repositories.compare(projectId, from, to);
  }

  // ── Commits ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Retrieves chronological commit history for a specific branch (default limit 20).
   * @param projectId - Project ID or path (e.g. "group/project" or 123).
   * @param branch - Branch name to fetch commits from.
   * @param limit - Maximum number of commits to return.
   */
  async listBranchCommits(
    projectId: string | number,
    branch: string,
    limit: number = 20
  ): Promise<GitLabCommit[]> {
    this.validateRequired({ project_id: projectId, branch });
    const clamped = clampPageSize(limit, 20, 100);
    const commits = await this.gitlab.Commits.all(projectId, {
      refName: branch,
      perPage: clamped,
      maxPages: 1,
    });

    // Take only first page
    const limited = commits.slice(0, clamped);

    return limited.map((c: Record<string, unknown>) => ({
      id: String(c.id),
      short_id: String(c.shortId || c.short_id || ''),
      title: String(c.title),
      message: String(c.message),
      author_name: String(c.authorName || c.author_name || ''),
      author_email: String(c.authorEmail || c.author_email || ''),
      created_at: String(c.createdAt || c.created_at || ''),
    }));
  }

  /**
   * Retrieves the complete unified diff of all file changes introduced by a specific commit.
   * @param projectId - Project ID or path (e.g. "group/project" or 123).
   * @param commitSha - Full or short commit SHA.
   */
  async getCommitDiff(projectId: string | number, commitSha: string): Promise<unknown> {
    this.validateRequired({ project_id: projectId, commit_sha: commitSha });
    return await this.gitlab.Commits.showDiff(projectId, commitSha);
  }

  /**
   * Retrieves commits filtered by branch/tag (`ref`), ISO 8601 date range, and file path.
   * @param projectId - Project ID or path (e.g. "group/project" or 123).
   * @param options - Filter options for commit history.
   * @param options.ref - Branch or tag name to filter commits.
   * @param options.since - ISO 8601 date string to show commits after.
   * @param options.until - ISO 8601 date string to show commits before.
   * @param options.path - File or directory path to filter commits that modified it.
   * @param options.limit - Maximum number of commits to return.
   */
  async listCommits(
    projectId: string | number,
    options: {
      ref?: string;
      since?: string;
      until?: string;
      path?: string;
      limit?: number;
    } = {}
  ): Promise<GitLabCommit[]> {
    const limit = clampPageSize(options.limit, 20, 100);
    const commits = await this.gitlab.Commits.all(projectId, {
      refName: options.ref,
      since: options.since,
      until: options.until,
      path: options.path,
      perPage: limit,
      maxPages: 1,
    });
    return commits.slice(0, limit).map((c: Record<string, unknown>) => ({
      id: String(c.id),
      short_id: String(c.shortId || c.short_id || ''),
      title: String(c.title),
      message: String(c.message),
      author_name: String(c.authorName || c.author_name || ''),
      author_email: String(c.authorEmail || c.author_email || ''),
      created_at: String(c.createdAt || c.created_at || ''),
    }));
  }

  /**
   * Searches commit title/message, case-insensitive (GitLab has no native commit search).
   * @param projectId - Project ID or path (e.g. "group/project" or 123).
   * @param query - Search text to match in commit title or message.
   * @param options - Optional search filters.
   * @param options.ref - Branch or tag name to search within.
   * @param options.limit - Maximum number of matching commits to return.
   */
  async searchCommits(
    projectId: string | number,
    query: string,
    options: { ref?: string; limit?: number } = {}
  ): Promise<GitLabCommit[]> {
    // GitLab doesn't have direct commit search, so we filter by message
    const commits = await this.gitlab.Commits.all(projectId, {
      refName: options.ref,
      perPage: 100, // Get more to filter
      maxPages: 1,
    });
    const filtered = commits
      .filter(
        (c: Record<string, unknown>) =>
          String(c.message).toLowerCase().includes(query.toLowerCase()) ||
          String(c.title).toLowerCase().includes(query.toLowerCase())
      )
      .slice(0, clampPageSize(options.limit, 20, 100));
    return filtered.map((c: Record<string, unknown>) => ({
      id: String(c.id),
      short_id: String(c.shortId || c.short_id || ''),
      title: String(c.title),
      message: String(c.message),
      author_name: String(c.authorName || c.author_name || ''),
      author_email: String(c.authorEmail || c.author_email || ''),
      created_at: String(c.createdAt || c.created_at || ''),
    }));
  }

  // ── Repository ────────────────────────────────────────────────────────────────────────────────

  /**
   * Gets the repository file tree, optionally recursive and path-filtered (default limit 100).
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param options - Tree listing options.
   * @param options.path - Directory path to list.
   * @param options.ref - Branch, tag, or commit SHA to list from.
   * @param options.recursive - Include subdirectories recursively.
   * @param options.limit - Maximum entries to return.
   */
  async getTree(
    projectId: string | number,
    options: { path?: string; ref?: string; recursive?: boolean; limit?: number } = {}
  ): Promise<unknown[]> {
    const limit = clampPageSize(options.limit, 100, 100);
    const tree = await this.gitlab.Repositories.allRepositoryTrees(projectId, {
      path: options.path,
      ref: options.ref,
      recursive: options.recursive,
      perPage: limit,
      maxPages: 1,
    });
    return tree.slice(0, limit);
  }

  /**
   * Retrieves file content (base64-encoded) plus size/name/path metadata from the repository.
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param filePath - Full path to file in repository.
   * @param ref - Branch, tag, or commit SHA to read from.
   */
  async getFile(
    projectId: string | number,
    filePath: string,
    ref: string = 'main'
  ): Promise<{
    content: string;
    encoding: string;
    size: number;
    file_name: string;
    file_path: string;
    ref: string;
  }> {
    const file = (await this.gitlab.RepositoryFiles.show(
      projectId,
      filePath,
      ref
    )) as unknown as Record<string, unknown>;
    return {
      content: String(file.content),
      encoding: String(file.encoding),
      size: Number(file.size),
      file_name: String(pick(file, 'fileName', 'file_name') || basename(filePath)),
      file_path: String(pick(file, 'filePath', 'file_path') || filePath),
      ref: String(file.ref || ref),
    };
  }

  /**
   * Gets git blame ranges (commit SHA, author, line ranges) for a file.
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param filePath - Full path to file in repository.
   * @param ref - Branch, tag, or commit SHA to blame from.
   */
  async getBlame(
    projectId: string | number,
    filePath: string,
    ref: string = 'main'
  ): Promise<unknown[]> {
    const blame = await this.gitlab.RepositoryFiles.allFileBlames(projectId, filePath, ref);
    return blame;
  }

  // ── Artifacts ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Lists all artifacts from jobs in a pipeline.
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param pipelineId - Pipeline ID to list artifacts from.
   */
  async listArtifacts(projectId: string | number, pipelineId: number): Promise<unknown[]> {
    const jobs = await this.gitlab.Jobs.all(projectId, { pipelineId, perPage: 100, maxPages: 1 });
    // Filter jobs that have artifacts
    return jobs
      .filter((j: Record<string, unknown>) => j.artifacts && (j.artifacts as unknown[]).length > 0)
      .map((j: Record<string, unknown>) => ({
        job_id: j.id,
        job_name: j.name,
        artifacts: j.artifacts,
      }));
  }

  /**
   * Gets a job's log as text, capped to its last N lines like {@link getJobLog} (direct CI
   * artifact-zip download is not available through this client).
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param jobId - Job ID to fetch the log from.
   * @param tailLines - Number of last lines to return (0 = all lines).
   */
  async downloadArtifact(
    projectId: string | number,
    jobId: number,
    tailLines: number = 500
  ): Promise<{ content: string; size: number; filename: string }> {
    const trace = await this.gitlab.Jobs.showLog(projectId, jobId);
    const full = String(trace);
    const lines = full.split('\n');
    const content =
      tailLines && lines.length > tailLines ? lines.slice(-tailLines).join('\n') : full;
    return {
      content,
      size: Buffer.byteLength(full, 'utf-8'),
      filename: `job-${jobId}-log.txt`,
    };
  }

  /**
   * Deletes all artifacts and logs for a specific job.
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param jobId - Job ID to erase artifacts from.
   */
  async deleteArtifacts(projectId: string | number, jobId: number): Promise<void> {
    // Erase removes the job log and artifacts
    await this.gitlab.Jobs.erase(projectId, jobId);
  }

  // ── Issues ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Lists issues, filterable by state, comma-separated labels, assignee, and identity scope.
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param options - Issue filtering options.
   * @param options.state - Filter by state: "opened", "closed", or "all".
   * @param options.labels - Comma-separated label names to filter by.
   * @param options.assignee_username - Filter by assignee username.
   * @param options.scope - Filter by identity scope.
   * @param options.limit - Maximum issues to return.
   */
  async listIssues(
    projectId: string | number,
    options: {
      state?: string;
      labels?: string;
      assignee_username?: string;
      scope?: IdentityScope;
      limit?: number;
    } = {}
  ): Promise<unknown[]> {
    const limit = clampPageSize(options.limit, 20, 100);
    const result = await this.gitlab.Issues.all({
      projectId,
      state: options.state as 'opened' | 'closed' | 'all' | undefined,
      labels: options.labels,
      assigneeUsername: options.assignee_username,
      scope: options.scope,
      perPage: limit,
      maxPages: 1,
    } as Parameters<typeof this.gitlab.Issues.all>[0]);
    // Handle both array and paginated response
    const issues = Array.isArray(result) ? result : (result as { data: unknown[] }).data || [];
    return issues.slice(0, limit);
  }

  /**
   * Gets a single issue by its internal ID (IID); throws {@link TeachingError} if not found.
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param issueIid - Issue internal ID (IID) shown in the UI.
   */
  async getIssue(projectId: string | number, issueIid: number): Promise<unknown> {
    // Use Issues.all with specific project and iid filter
    const issues = await this.gitlab.Issues.all({
      projectId,
      iids: [issueIid],
    } as Parameters<typeof this.gitlab.Issues.all>[0]);
    const result = Array.isArray(issues) ? issues : (issues as { data: unknown[] }).data || [];
    if (!result[0]) {
      throw new TeachingError(
        `Issue #${issueIid} not found in project '${projectId}'. List valid issue IIDs first via ${TOOL_NAMES.LIST_ISSUES}.`
      );
    }
    return result[0];
  }

  /**
   * Creates a new issue; `description` is Markdown, `labels` comma-separated.
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param options - Issue creation options.
   * @param options.title - Issue title.
   * @param options.description - Issue description in markdown format.
   * @param options.labels - Comma-separated label names to apply.
   * @param options.assignee_ids - Array of user IDs to assign the issue to.
   * @param options.milestone_id - Milestone ID to associate with.
   */
  async createIssue(
    projectId: string | number,
    options: {
      title: string;
      description?: string;
      labels?: string;
      assignee_ids?: number[];
      milestone_id?: number;
    }
  ): Promise<unknown> {
    return await this.gitlab.Issues.create(projectId, options.title, {
      description: options.description,
      labels: options.labels,
      assigneeIds: options.assignee_ids,
      milestoneId: options.milestone_id,
    });
  }

  /**
   * Updates an existing issue; `labels` replaces the existing set.
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param issueIid - Issue internal ID (IID) to update.
   * @param options - Issue update options.
   * @param options.title - New issue title.
   * @param options.description - New issue description in markdown.
   * @param options.labels - Comma-separated label names to apply (replaces existing).
   * @param options.state_event - State transition: "close" or "reopen".
   */
  async updateIssue(
    projectId: string | number,
    issueIid: number,
    options: {
      title?: string;
      description?: string;
      labels?: string;
      state_event?: string;
    }
  ): Promise<unknown> {
    return await this.gitlab.Issues.edit(projectId, issueIid, {
      title: options.title,
      description: options.description,
      labels: options.labels,
      stateEvent: options.state_event as 'close' | 'reopen' | undefined,
    });
  }

  /**
   * Closes an issue (convenience wrapper for `updateIssue` with `state_event: 'close'`).
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param issueIid - Issue internal ID (IID) to close.
   */
  async closeIssue(projectId: string | number, issueIid: number): Promise<unknown> {
    return await this.gitlab.Issues.edit(projectId, issueIid, {
      stateEvent: 'close',
    });
  }

  // ── Labels ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Lists all labels in a project, optionally filtered by name (default limit 50).
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param options - Label filtering options.
   * @param options.search - Search term to filter label names.
   * @param options.limit - Maximum labels to return.
   */
  async listLabels(
    projectId: string | number,
    options: { search?: string; limit?: number } = {}
  ): Promise<unknown[]> {
    const limit = clampPageSize(options.limit, 50, 100);
    const labels = await this.gitlab.ProjectLabels.all(projectId, {
      search: options.search,
      perPage: limit,
      maxPages: 1,
    });
    return labels.slice(0, limit);
  }

  /**
   * Creates a new label; `color` is hex format (e.g. "#FF0000").
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param options - Label creation options.
   * @param options.name - Label name.
   * @param options.color - Label color in hex format.
   * @param options.description - Label description for documentation.
   */
  async createLabel(
    projectId: string | number,
    options: {
      name: string;
      color: string;
      description?: string;
    }
  ): Promise<unknown> {
    return await this.gitlab.ProjectLabels.create(projectId, options.name, options.color, {
      description: options.description,
    });
  }

  // ── Pipelines ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Lists CI/CD pipelines, filterable by status and branch/tag ref (default limit 5).
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param options - Pipeline filtering options.
   * @param options.status - Filter by pipeline status.
   * @param options.ref - Filter by branch or tag name.
   * @param options.limit - Maximum pipelines to return.
   * @param options.page - Page number for pagination.
   */
  async listPipelines(
    projectId: string | number,
    options: {
      status?: string;
      ref?: string;
      limit?: number;
      page?: number;
    } = {}
  ): Promise<GitLabPipeline[]> {
    this.validateRequired({ project_id: projectId });
    const limit = clampPageSize(options.limit, 5, 100);
    const pipelines = await this.gitlab.Pipelines.all(projectId, {
      status: options.status as
        | 'created'
        | 'waiting_for_resource'
        | 'preparing'
        | 'pending'
        | 'running'
        | 'success'
        | 'failed'
        | 'canceled'
        | 'skipped'
        | 'manual'
        | 'scheduled'
        | undefined,
      ref: options.ref,
      perPage: limit,
      page: options.page || 1,
      maxPages: 1,
    });

    return pipelines.slice(0, limit).map((p: Record<string, unknown>) => ({
      id: p.id as number,
      status: String(p.status),
      ref: String(p.ref),
      sha: String(p.sha),
      web_url: String(p.webUrl || p.web_url || ''),
      created_at: String(p.createdAt || p.created_at || ''),
      updated_at: String(p.updatedAt || p.updated_at || ''),
    }));
  }

  /**
   * Gets detailed pipeline information including all its jobs.
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param pipelineId - Pipeline ID to retrieve.
   */
  async showPipeline(projectId: string | number, pipelineId: number): Promise<unknown> {
    this.validateRequired({ project_id: projectId, pipeline_id: pipelineId });
    const pipeline = await this.gitlab.Pipelines.show(projectId, pipelineId);
    const jobs = await this.gitlab.Jobs.all(projectId, { pipelineId, perPage: 100, maxPages: 1 });
    return { pipeline, jobs };
  }

  /**
   * Retrieves CI/CD job log, capped to the last `tailLines` lines (default 100, 0 = all).
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param jobId - Job ID to get logs from.
   * @param tailLines - Number of last lines to return (0 = all lines).
   */
  async getJobLog(
    projectId: string | number,
    jobId: number,
    tailLines: number = 100
  ): Promise<string> {
    this.validateRequired({ project_id: projectId, job_id: jobId });
    const log = await this.gitlab.Jobs.showLog(projectId, jobId);
    const logStr = String(log);
    const lines = logStr.split('\n');
    if (tailLines && lines.length > tailLines) {
      return lines.slice(-tailLines).join('\n');
    }
    return logStr;
  }

  /**
   * Retries a failed pipeline and all its failed jobs.
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param pipelineId - Pipeline ID to retry.
   */
  async retryPipeline(projectId: string | number, pipelineId: number): Promise<GitLabPipeline> {
    this.validateRequired({ project_id: projectId, pipeline_id: pipelineId });
    const p = await this.gitlab.Pipelines.retry(projectId, pipelineId);
    return {
      id: p.id as number,
      status: String(p.status),
      ref: String(p.ref),
      sha: String(p.sha),
      web_url: String(p.webUrl || ''),
      created_at: String(p.createdAt || ''),
      updated_at: String(p.updatedAt || ''),
    };
  }

  /**
   * Manually triggers a new pipeline for a branch/tag `ref`, with optional CI/CD variables.
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param options - Pipeline trigger options.
   * @param options.ref - Branch or tag name to run pipeline on.
   * @param options.variables - Array of CI/CD variables as key/value pairs.
   */
  async triggerPipeline(
    projectId: string | number,
    options: {
      ref: string;
      variables?: Array<{ key: string; value: string }>;
    }
  ): Promise<GitLabPipeline> {
    const p = await this.gitlab.Pipelines.create(projectId, options.ref, {
      variables: options.variables,
    });
    return {
      id: p.id as number,
      status: String(p.status),
      ref: String(p.ref),
      sha: String(p.sha),
      web_url: String(p.webUrl || ''),
      created_at: String(p.createdAt || ''),
      updated_at: String(p.updatedAt || ''),
    };
  }

  // ── Tags & Releases ───────────────────────────────────────────────────────────────────────────

  /**
   * Lists tags in a project, newest first, optionally filtered by name (default limit 20).
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param options - Tag listing options.
   * @param options.search - Filter tags by name pattern.
   * @param options.limit - Maximum tags to return.
   */
  async listTags(
    projectId: string | number,
    options: { search?: string; limit?: number } = {}
  ): Promise<unknown[]> {
    this.validateRequired({ project_id: projectId });
    const limit = clampPageSize(options.limit, 20, 100);
    const tags = await this.gitlab.Tags.all(projectId, {
      search: options.search,
      perPage: limit,
      maxPages: 1,
    });
    return tags.slice(0, limit);
  }

  /**
   * Creates a new git tag (`tag_name`) pointing at `ref` (branch, commit SHA, or another tag).
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param options - Tag creation options.
   * @param options.tag_name - Tag name (e.g. "v1.0.0").
   * @param options.ref - Branch name, commit SHA, or another tag to create tag from.
   * @param options.message - Optional tag message for annotated tags.
   */
  async createTag(
    projectId: string | number,
    options: {
      tag_name: string;
      ref: string;
      message?: string;
    }
  ): Promise<unknown> {
    this.validateRequired({ project_id: projectId, tag_name: options.tag_name, ref: options.ref });
    return await this.gitlab.Tags.create(projectId, options.tag_name, options.ref, {
      message: options.message,
    });
  }

  /**
   * Gets information (name, target commit, message) about a specific tag.
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param tagName - Tag name (e.g. "v1.0.0").
   */
  async getTag(projectId: string | number, tagName: string): Promise<unknown> {
    this.validateRequired({ project_id: projectId, tag_name: tagName });
    return await this.gitlab.Tags.show(projectId, tagName);
  }

  /**
   * Deletes a git tag; returns the deleted tag's info as an audit trail.
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param tagName - Tag name to delete.
   */
  async deleteTag(
    projectId: string | number,
    tagName: string
  ): Promise<{ deleted_tag?: { name: string; target: string; message?: string } }> {
    this.validateRequired({ project_id: projectId, tag_name: tagName });

    // Audit: capture tag info before deletion
    let tagInfo: { name: string; target: string; message?: string } | undefined;
    try {
      const tag = (await this.gitlab.Tags.show(projectId, tagName)) as {
        name: string;
        target: string;
        message?: string;
      };
      tagInfo = { name: tag.name, target: tag.target, message: tag.message };
    } catch (error) {
      // Tag might not exist or we lack permissions - proceed with deletion attempt
      console.warn(`${ts()} [GitLabClient] Failed to get tag info before deletion:`, {
        project: projectId,
        tag: tagName,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await this.gitlab.Tags.remove(projectId, tagName);
    return { deleted_tag: tagInfo };
  }

  /**
   * Creates a release from an existing `tag_name`; `name` defaults to the tag name.
   * @param projectId - Project ID or path (e.g. 123 or "group/project").
   * @param options - Release creation options.
   * @param options.tag_name - Existing tag name to create release from.
   * @param options.name - Release name (defaults to tag name if not provided).
   * @param options.description - Release notes in markdown format.
   */
  async createRelease(
    projectId: string | number,
    options: {
      tag_name: string;
      name?: string;
      description?: string;
    }
  ): Promise<unknown> {
    this.validateRequired({ project_id: projectId, tag_name: options.tag_name });
    return await this.gitlab.ProjectReleases.create(projectId, {
      tagName: options.tag_name,
      name: options.name || options.tag_name,
      description: options.description,
    });
  }
}

// ── Initialization ──────────────────────────────────────────────────────────────────────────────

/**
 * Initializes GitLab client from /tokens/token and /tokens/host_url (or GITLAB_URL, then https://gitlab.com).
 * @returns Configured GitLabClient instance, or null if token not found/invalid
 */
export async function initializeGitLabClient(): Promise<GitLabClient | null> {
  try {
    // Load token from RO mount
    console.log(`${ts()} 📖 Loading GitLab token from: ${tokensDir()}/token`);
    const token = await loadTokenFile('token');

    if (!token) {
      // Graceful degradation: return null, let server start
      console.warn(`${ts()} ${withSetupGuidance('GitLab token is empty or not found.')}`);
      return null;
    }

    // Load host URL from /tokens/host_url or env var
    let host = 'https://gitlab.com';

    try {
      const hostUrl = await fs.readFile(`${tokensDir()}/host_url`, 'utf-8');
      const trimmed = hostUrl.trim();
      if (trimmed) {
        host = trimmed;
        console.log(`${ts()} ✅ GitLab host from /tokens/host_url: ${host}`);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        console.warn(`${ts()} ⚠️ Failed to read /tokens/host_url: ${err}`);
      }
      if (process.env.GITLAB_URL) {
        host = process.env.GITLAB_URL;
        console.log(`${ts()} ✅ GitLab host from GITLAB_URL env: ${host}`);
      } else {
        console.log(`${ts()} ⚠️  No host_url file or GITLAB_URL env, using default: ${host}`);
      }
    }

    // Connection test runs async; see backgroundConnectionTest
    const client = new GitLabClient({ token, host });
    backgroundConnectionTest(
      client.statusTracker,
      async () => {
        const result = await client.testConnection();
        if (!result.success) {
          throw new Error(result.error ?? 'connection test failed');
        }
      },
      'GitLab'
    );

    console.log(`${ts()} ✅ GitLab client initialized (host: ${host}), connection test scheduled`);
    return client;
  } catch (error) {
    // Graceful degradation: log warning, return null, let server start
    // DO NOT throw here - see JSDoc above for rationale
    console.warn(`${ts()} Failed to initialize GitLab client: ${error}`);
    return null;
  }
}
