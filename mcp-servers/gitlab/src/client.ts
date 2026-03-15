/**
 * GitLab API Client for MCP Worker
 * Isolated GitLab MCP server with per-service token isolation.
 * ONLY has access to GitLab tokens - no other service tokens.
 * Architecture:
 * - Token mounted RO from /tokens/token
 * - Host URL from /tokens/host_url file or GITLAB_URL env var
 * - Exposes 44 tools via `@gitbeaker`/rest
 * Security:
 * - Blast radius containment: only GitLab tokens if compromised
 * - Token never exposed in responses
 * - Read-only token mount
 */

import { Gitlab } from '@gitbeaker/rest';
import { loadToken, ts } from '@speedwave/mcp-shared';
import fs from 'fs/promises';

//═══════════════════════════════════════════════════════════════════════════════
// Types
//═══════════════════════════════════════════════════════════════════════════════

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
  author: { id: number; name: string; username: string };
  web_url: string;
  created_at: string;
  updated_at: string;
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

/** Result of GitLab API connection test with error categorization */
export interface ConnectionTestResult {
  success: boolean;
  error?: string;
  errorType?: 'auth' | 'network' | 'permission' | 'not_found' | 'unknown';
}

//═══════════════════════════════════════════════════════════════════════════════
// Client Class
//═══════════════════════════════════════════════════════════════════════════════

/**
 * GitLab API client providing methods for projects, merge requests, pipelines, commits, branches, and issues.
 * Wraps `@gitbeaker/rest` library with consistent error handling and type-safe response mapping.
 * Supports all major GitLab operations including CI/CD, code review, and repository management.
 *
 * TODO: Consider splitting GitLabClient into domain-specific clients (MRClient, PipelineClient, etc.)
 * Current monolithic design works but violates Single Responsibility Principle. See PR review for details.
 */
export class GitLabClient {
  private gitlab: InstanceType<typeof Gitlab>;
  private config: GitLabConfig;

  /**
   * Creates a new GitLab API client instance with authentication and host configuration.
   * Initializes the underlying Gitbeaker client with provided credentials.
   * @param config - Client configuration containing authentication token and GitLab host URL
   */
  constructor(config: GitLabConfig) {
    this.config = config;
    this.gitlab = new Gitlab({
      token: config.token,
      host: config.host,
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

  //═════════════════════════════════════════════════════════════════════════════
  // Response Mappers
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Maps GitLab API merge request response to standardized GitLabMergeRequest type.
   * Normalizes field names from camelCase/snake_case variations and ensures type safety.
   * @param mr - Raw merge request response object from GitLab API
   * @returns Normalized merge request with consistent field names and types
   */
  private mapMergeRequestResponse(mr: Record<string, unknown>): GitLabMergeRequest {
    // Warn if critical fields are missing (helps debug API response issues)
    const sourceBranch = mr.sourceBranch || mr.source_branch;
    const targetBranch = mr.targetBranch || mr.target_branch;
    const webUrl = mr.webUrl || mr.web_url;

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
      author: (mr.author || { id: 0, name: '', username: '' }) as {
        id: number;
        name: string;
        username: string;
      },
      web_url: String(webUrl || ''),
      created_at: String(mr.createdAt || mr.created_at || ''),
      updated_at: String(mr.updatedAt || mr.updated_at || ''),
    };
  }

  /**
   * Maps GitLab API commit response to standardized GitLabCommit type.
   * Handles both camelCase and snake_case field name variations from the API.
   * @param c - Raw commit response object from GitLab API
   * @returns Normalized commit with consistent field names and types
   */
  private mapCommitResponse(c: Record<string, unknown>): GitLabCommit {
    return {
      id: String(c.id),
      short_id: String(c.shortId || c.short_id || ''),
      title: String(c.title),
      message: String(c.message),
      author_name: String(c.authorName || c.author_name || ''),
      author_email: String(c.authorEmail || c.author_email || ''),
      created_at: String(c.createdAt || c.created_at || ''),
    };
  }

  /**
   * Maps GitLab API pipeline response to standardized GitLabPipeline type.
   * Normalizes pipeline status, timing, and reference information.
   * @param p - Raw pipeline response object from GitLab API
   * @returns Normalized pipeline with consistent field names and types
   */
  private mapPipelineResponse(p: Record<string, unknown>): GitLabPipeline {
    return {
      id: p.id as number,
      status: String(p.status),
      ref: String(p.ref),
      sha: String(p.sha),
      web_url: String(p.webUrl || p.web_url || ''),
      created_at: String(p.createdAt || p.created_at || ''),
      updated_at: String(p.updatedAt || p.updated_at || ''),
    };
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Error Handling
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Formats GitLab API errors into user-friendly messages with actionable recovery guidance.
   * Handles various error types including authentication failures, permission denials,
   * network errors, and provides specific instructions for remediation.
   * @param error - The error object from GitLab API (typically from `@gitbeaker/rest`)
   * @returns Human-readable error message with recovery suggestions (e.g., "Run: speedwave setup gitlab")
   * @example
   * ```typescript
   * try {
   *   await client.listProjects();
   * } catch (error) {
   *   console.error(GitLabClient.formatError(error));
   *   // Output: "Authentication failed. Check your GitLab token. Run: speedwave setup gitlab"
   * }
   * ```
   */
  static formatError(error: unknown): string {
    // Handle ``@gitbeaker``/rest error responses
    const err = error as {
      response?: { status?: number };
      cause?: { response?: { status?: number }; description?: string };
      message?: string;
    };
    const status = err.response?.status || err.cause?.response?.status;
    const message = err.message || '';

    if (status === 401 || message.includes('401') || message.includes('Unauthorized')) {
      return 'Authentication failed. Check your GitLab token. Run: speedwave setup gitlab';
    }

    if (status === 403 || message.includes('403') || message.includes('Forbidden')) {
      return 'Permission denied. Your GitLab token may not have sufficient permissions.';
    }

    if (status === 404 || message.includes('404') || message.includes('not found')) {
      return 'Resource not found in GitLab.';
    }

    // 5xx - Server errors
    if (status && status >= 500 && status < 600) {
      if (status === 500) return 'GitLab server error. Please try again later.';
      if (status === 502) return 'GitLab bad gateway. The server may be overloaded.';
      if (status === 503) return 'GitLab service unavailable. The server is temporarily down.';
      if (status === 504) return 'GitLab gateway timeout. The request took too long.';
      return `GitLab server error (${status}). Please try again later.`;
    }

    if (
      message.includes('getaddrinfo') ||
      message.includes('ECONNREFUSED') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ENOTFOUND') ||
      /network\s+(error|failed|timeout)/i.test(message)
    ) {
      return 'Network error. Check your GitLab URL. Run: speedwave setup gitlab';
    }

    // Extract meaningful part from gitbeaker errors
    if (err.cause?.description) {
      return `GitLab API error: ${err.cause.description}`;
    }

    return message || 'GitLab API error';
  }

  /**
   * Tests GitLab API connectivity by fetching the current authenticated user
   * @returns Connection test result with success status and error details if failed
   */
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

  //═════════════════════════════════════════════════════════════════════════════
  // Projects
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Lists GitLab projects accessible to the authenticated user with optional filtering.
   * Returns projects sorted by last activity (most recent first). Only the first page
   * of results is returned, limited by the `limit` parameter.
   * @param options - Filter and pagination options
   * @param options.search - Filter projects by name or path (case-insensitive partial match)
   * @param options.limit - Maximum number of projects to return (default: 20, max: 20)
   * @param options.page - Page number for pagination (default: 1)
   * @param options.owned - If `true`, only return projects owned by the current user (excludes shared/member projects)
   * @returns Array of project objects with basic metadata (id, name, path, description, URL, default branch)
   * @example
   * ```typescript
   * // Get all accessible projects
   * const allProjects = await client.listProjects();
   *
   * // Search for projects by name
   * const filtered = await client.listProjects({ search: 'speedwave' });
   *
   * // Get only owned projects
   * const owned = await client.listProjects({ owned: true, limit: 10 });
   * ```
   */
  async listProjects(
    options: {
      search?: string;
      limit?: number;
      page?: number;
      owned?: boolean;
    } = {}
  ): Promise<GitLabProject[]> {
    const projects = await this.gitlab.Projects.all({
      search: options.search,
      perPage: options.limit || 20,
      page: options.page || 1,
      pagination: 'offset' as const,
      owned: options.owned,
    });

    // Take only first page (limit results)
    const limited = projects.slice(0, options.limit || 20);

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
   * Retrieves detailed information about a specific GitLab project.
   * Optionally includes license and statistics data if requested.
   * @param projectId - Project ID (numeric) or path with namespace (e.g., "acme/my-project")
   * @param options - Additional data to include in the response
   * @param options.license - If `true`, includes license information (name, URL, source URL)
   * @param options.statistics - If `true`, includes project statistics (commit count, storage size, repository size, etc.)
   * @returns Project object with full details, plus optional license/statistics if requested
   * @example
   * ```typescript
   * // Get basic project info
   * const project = await client.showProject('acme/my-project');
   *
   * // Get project with statistics
   * const detailed = await client.showProject(123, { statistics: true });
   * console.log(detailed.statistics.commit_count);
   * ```
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
   * Searches for code snippets across GitLab repositories using blob search.
   * Can search globally across all accessible projects or within a specific project.
   * Returns file paths, line numbers, and matching code snippets.
   * @param query - Search query string (supports literal text, not regex)
   * @param options - Search scope options
   * @param options.project_id - If provided, limits search to this project ID or path. If omitted, searches across all accessible projects
   * @param options.scope - Reserved for future use (currently not implemented by GitLab API)
   * @returns Array of search results containing file paths, matching lines, and context
   * @example
   * ```typescript
   * // Search globally across all projects
   * const results = await client.searchCode('formatError');
   *
   * // Search within specific project
   * const projectResults = await client.searchCode('async function', {
   *   project_id: 'acme/my-project'
   * });
   *
   * // Results contain: { basename, data, path, filename, id, ref, startline }
   * ```
   */
  async searchCode(
    query: string,
    options: {
      project_id?: string | number;
      scope?: string;
    } = {}
  ): Promise<unknown[]> {
    this.validateRequired({ query });
    // Search within project or globally
    if (options.project_id) {
      const results = await this.gitlab.Search.all('blobs' as const, query, {
        projectId: options.project_id,
      });
      return results as unknown[];
    }
    const results = await this.gitlab.Search.all('blobs' as const, query);
    return results as unknown[];
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Merge Requests
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Lists merge requests in a project with optional filtering
   * @param projectId - Project ID or path (e.g., "my-group/my-project" or 123)
   * @param options - Filter options
   * @param options.state - Filter by state: "opened", "closed", "merged", or "all"
   * @param options.author_username - Filter by author's username
   * @param options.reviewer_username - Filter by reviewer's username
   * @param options.labels - Filter by comma-separated labels (e.g., "bug,feature")
   * @param options.limit - Maximum number of results to return (default: 20)
   */
  async listMergeRequests(
    projectId: string | number,
    options: {
      state?: string;
      author_username?: string;
      reviewer_username?: string;
      labels?: string;
      limit?: number;
    } = {}
  ): Promise<GitLabMergeRequest[]> {
    this.validateRequired({ project_id: projectId });
    // Use type assertion to handle state parameter
    const queryOptions: Record<string, unknown> = {
      projectId,
      perPage: options.limit || 20,
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

    const mrs = (await this.gitlab.MergeRequests.all(
      queryOptions as Parameters<typeof this.gitlab.MergeRequests.all>[0]
    )) as unknown as Array<Record<string, unknown>>;

    // Take only first page
    const limited = mrs.slice(0, options.limit || 20);

    return limited.map((mr) => this.mapMergeRequestResponse(mr));
  }

  /**
   * Gets detailed information about a specific merge request
   * @param projectId - Project ID or path (e.g., "my-group/my-project" or 123)
   * @param mrIid - Merge request IID (internal ID within the project)
   */
  async showMergeRequest(projectId: string | number, mrIid: number): Promise<GitLabMergeRequest> {
    this.validateRequired({ project_id: projectId, mr_iid: mrIid });
    const mr = await this.gitlab.MergeRequests.show(projectId, mrIid);
    return this.mapMergeRequestResponse(mr as unknown as Record<string, unknown>);
  }

  /**
   * Creates a new merge request in a project
   * @param projectId - Project ID or path (e.g., "my-group/my-project" or 123)
   * @param options - Merge request options
   * @param options.source_branch - Source branch name (branch to merge from)
   * @param options.target_branch - Target branch name (branch to merge into)
   * @param options.title - Title of the merge request
   * @param options.description - Description/body of the merge request (supports Markdown)
   * @param options.labels - Comma-separated labels to apply (e.g., "bug,priority::high")
   * @param options.remove_source_branch - Whether to remove source branch after merge (default: false)
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
   * Approves a merge request
   * @param projectId - Project ID or path (e.g., "my-group/my-project" or 123)
   * @param mrIid - Merge request IID (internal ID within the project)
   */
  async approveMergeRequest(projectId: string | number, mrIid: number): Promise<void> {
    this.validateRequired({ project_id: projectId, mr_iid: mrIid });
    await this.gitlab.MergeRequestApprovals.approve(projectId, mrIid);
  }

  /**
   * Merges an approved merge request
   * @param projectId - Project ID or path (e.g., "my-group/my-project" or 123)
   * @param mrIid - Merge request IID (internal ID within the project)
   * @param options - Merge options
   * @param options.squash - Whether to squash commits into a single commit (default: false)
   * @param options.should_remove_source_branch - Whether to remove source branch after merge (default: false)
   * @param options.auto_merge - Whether to merge when pipeline succeeds (default: false)
   * @param options.sha - Expected SHA of source branch head (for conflict detection)
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
   * Updates properties of an existing merge request
   * @param projectId - Project ID or path (e.g., "my-group/my-project" or 123)
   * @param mrIid - Merge request IID (internal ID within the project)
   * @param options - Update options
   * @param options.title - New title for the merge request
   * @param options.description - New description/body (supports Markdown)
   * @param options.target_branch - New target branch name
   * @param options.state_event - State change action: "close" or "reopen"
   * @param options.labels - Comma-separated labels (replaces existing labels)
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
   * Gets file changes (diffs) in a merge request
   * @param projectId - Project ID or path (e.g., "my-group/my-project" or 123)
   * @param mrIid - Merge request IID (internal ID within the project)
   */
  async getMrChanges(projectId: string | number, mrIid: number): Promise<unknown> {
    this.validateRequired({ project_id: projectId, mr_iid: mrIid });
    return await this.gitlab.MergeRequests.allDiffs(projectId, mrIid);
  }

  /**
   * Lists all commits in a merge request
   * @param projectId - Project ID or path (e.g., "my-group/my-project" or 123)
   * @param mrIid - Merge request IID (internal ID within the project)
   * @param limit - Maximum number of commits to return (default: 20)
   */
  async listMrCommits(
    projectId: string | number,
    mrIid: number,
    limit: number = 20
  ): Promise<GitLabCommit[]> {
    const commits = await this.gitlab.MergeRequests.allCommits(projectId, mrIid, {
      perPage: limit,
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
   * Lists all CI/CD pipelines associated with a merge request
   * @param projectId - Project ID or path (e.g., "my-group/my-project" or 123)
   * @param mrIid - Merge request IID (internal ID within the project)
   * @param limit - Maximum number of pipelines to return (default: 10)
   */
  async listMrPipelines(
    projectId: string | number,
    mrIid: number,
    limit: number = 10
  ): Promise<GitLabPipeline[]> {
    const pipelines = await this.gitlab.MergeRequests.allPipelines(projectId, mrIid);
    return pipelines.slice(0, limit).map((p: Record<string, unknown>) => {
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
   * Lists comments/notes on a merge request
   * @param projectId - Project ID or path (e.g., "my-group/my-project" or 123)
   * @param mrIid - Merge request IID (internal ID within the project)
   * @param limit - Maximum number of notes to return (default: 20)
   */
  async listMrNotes(
    projectId: string | number,
    mrIid: number,
    limit: number = 20
  ): Promise<unknown[]> {
    const notes = await this.gitlab.MergeRequestNotes.all(projectId, mrIid, {
      perPage: limit,
    });
    return notes.slice(0, limit);
  }

  /**
   * Adds a comment/note to a merge request
   * @param projectId - Project ID or path (e.g., "my-group/my-project" or 123)
   * @param mrIid - Merge request IID (internal ID within the project)
   * @param body - Comment text (supports Markdown)
   */
  async createMrNote(projectId: string | number, mrIid: number, body: string): Promise<unknown> {
    return await this.gitlab.MergeRequestNotes.create(projectId, mrIid, body);
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Discussions
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Retrieves all discussion threads on a merge request including comments, code review notes, and resolvable threads
   * @param projectId - Project ID or path (e.g., "group/project" or 123)
   * @param mrIid - Merge request internal ID (IID, not ID)
   * @param limit - Maximum number of discussion threads to return (default: 20)
   * @returns Array of discussion objects with notes, resolved status, and thread metadata
   */
  async listMrDiscussions(
    projectId: string | number,
    mrIid: number,
    limit: number = 20
  ): Promise<unknown[]> {
    const discussions = await this.gitlab.MergeRequestDiscussions.all(projectId, mrIid, {
      perPage: limit,
    });
    return discussions.slice(0, limit);
  }

  /**
   * Creates a new discussion thread on a merge request for code review comments or general discussions
   * @param projectId - Project ID or path (e.g., "group/project" or 123)
   * @param mrIid - Merge request internal ID (IID, not ID)
   * @param body - Discussion comment text supporting markdown formatting
   * @returns Created discussion object with thread ID and initial note
   */
  async createMrDiscussion(
    projectId: string | number,
    mrIid: number,
    body: string
  ): Promise<unknown> {
    return await this.gitlab.MergeRequestDiscussions.create(projectId, mrIid, body);
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Branches
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Retrieves list of branches in a project with commit details and protection status
   * @param projectId - Project ID or path (e.g., "group/project" or 123)
   * @param options - Search and pagination options
   * @param options.search - Filter branches by name pattern (supports wildcards)
   * @param options.limit - Maximum number of branches to return (default: 20)
   * @returns Array of branch objects with name, commit SHA, protection status, and merge status
   */
  async listBranches(
    projectId: string | number,
    options: { search?: string; limit?: number } = {}
  ): Promise<unknown[]> {
    const branches = await this.gitlab.Branches.all(projectId, {
      search: options.search,
      perPage: options.limit || 20,
    });
    return branches.slice(0, options.limit || 20);
  }

  /**
   * Retrieves detailed information about a specific branch including commit history and protection rules
   * @param projectId - Project ID or path (e.g., "group/project" or 123)
   * @param branchName - Name of the branch to retrieve (e.g., "main", "feature/new-feature")
   * @returns Branch object with commit details, protection status, and can_push permission
   */
  async getBranch(projectId: string | number, branchName: string): Promise<unknown> {
    return await this.gitlab.Branches.show(projectId, branchName);
  }

  /**
   * Creates a new branch from an existing branch or commit reference
   * @param projectId - Project ID or path (e.g., "group/project" or 123)
   * @param branchName - Name for the new branch (e.g., "feature/new-feature")
   * @param ref - Source branch name or commit SHA to branch from (e.g., "main", "a1b2c3d4")
   * @returns Created branch object with initial commit details
   */
  async createBranch(
    projectId: string | number,
    branchName: string,
    ref: string
  ): Promise<unknown> {
    return await this.gitlab.Branches.create(projectId, branchName, ref);
  }

  /**
   * Permanently deletes a branch from the repository (cannot delete protected branches)
   * @param projectId - Project ID or path (e.g., "group/project" or 123)
   * @param branchName - Name of the branch to delete (e.g., "feature/old-feature")
   * @throws {Error} if branch is protected or does not exist
   */
  async deleteBranch(projectId: string | number, branchName: string): Promise<void> {
    this.validateRequired({ project_id: projectId, branch_name: branchName });
    await this.gitlab.Branches.remove(projectId, branchName);
  }

  /**
   * Compares two branches or commits showing file differences and commit list between them
   * @param projectId - Project ID or path (e.g., "group/project" or 123)
   * @param from - Source branch name or commit SHA (e.g., "main", "a1b2c3d4")
   * @param to - Target branch name or commit SHA to compare against (e.g., "develop", "e5f6g7h8")
   * @returns Comparison object with commits list, diffs array, and file change statistics
   */
  async compareBranches(projectId: string | number, from: string, to: string): Promise<unknown> {
    return await this.gitlab.Repositories.compare(projectId, from, to);
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Commits
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Retrieves chronological commit history for a specific branch
   * @param projectId - Project ID or path (e.g., "group/project" or 123)
   * @param branch - Branch name to fetch commits from (e.g., "main", "develop")
   * @param limit - Maximum number of commits to return (default: 20)
   * @returns Array of commit objects with SHA, message, author, and timestamp
   */
  async listBranchCommits(
    projectId: string | number,
    branch: string,
    limit: number = 20
  ): Promise<GitLabCommit[]> {
    this.validateRequired({ project_id: projectId, branch });
    const commits = await this.gitlab.Commits.all(projectId, {
      refName: branch,
      perPage: limit,
    });

    // Take only first page
    const limited = commits.slice(0, limit);

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
   * Retrieves complete unified diff showing all file changes introduced by a specific commit
   * @param projectId - Project ID or path (e.g., "group/project" or 123)
   * @param commitSha - Full or short commit SHA (e.g., "a1b2c3d4e5f6" or "a1b2c3d")
   * @returns Array of diff objects with old/new paths, diff content, and change statistics
   */
  async getCommitDiff(projectId: string | number, commitSha: string): Promise<unknown> {
    this.validateRequired({ project_id: projectId, commit_sha: commitSha });
    return await this.gitlab.Commits.showDiff(projectId, commitSha);
  }

  /**
   * Retrieves commits with advanced filtering by branch, time range, and file path
   * @param projectId - Project ID or path (e.g., "group/project" or 123)
   * @param options - Filter options for commit history
   * @param options.ref - Branch or tag name to filter commits (default: default branch)
   * @param options.since - ISO 8601 date string to show commits after (e.g., "2024-01-01T00:00:00Z")
   * @param options.until - ISO 8601 date string to show commits before (e.g., "2024-12-31T23:59:59Z")
   * @param options.path - File or directory path to filter commits that modified it (e.g., "src/app.ts")
   * @param options.limit - Maximum number of commits to return (default: 20)
   * @returns Array of commit objects matching the specified filters
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
    const commits = await this.gitlab.Commits.all(projectId, {
      refName: options.ref,
      since: options.since,
      until: options.until,
      path: options.path,
      perPage: options.limit || 20,
    });
    return commits.slice(0, options.limit || 20).map((c: Record<string, unknown>) => ({
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
   * Searches commit history by message or title using case-insensitive text matching
   * @param projectId - Project ID or path (e.g., "group/project" or 123)
   * @param query - Search text to match in commit title or message (case-insensitive)
   * @param options - Optional search filters
   * @param options.ref - Branch or tag name to search within (default: default branch)
   * @param options.limit - Maximum number of matching commits to return (default: 20)
   * @returns Array of commit objects with messages matching the search query
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
    });
    const filtered = commits
      .filter(
        (c: Record<string, unknown>) =>
          String(c.message).toLowerCase().includes(query.toLowerCase()) ||
          String(c.title).toLowerCase().includes(query.toLowerCase())
      )
      .slice(0, options.limit || 20);
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

  //═════════════════════════════════════════════════════════════════════════════
  // Repository
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Gets repository file tree with optional recursion and path filtering
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param options - Tree listing options
   * @param options.path - Directory path to list (default: root directory)
   * @param options.ref - Branch, tag, or commit SHA to list from (default: default branch)
   * @param options.recursive - Include subdirectories recursively (default: false)
   * @param options.limit - Maximum entries to return (default: 100)
   * @returns Array of tree entries with path, type, mode, and ID
   */
  async getTree(
    projectId: string | number,
    options: { path?: string; ref?: string; recursive?: boolean; limit?: number } = {}
  ): Promise<unknown[]> {
    const tree = await this.gitlab.Repositories.allRepositoryTrees(projectId, {
      path: options.path,
      ref: options.ref,
      recursive: options.recursive,
      perPage: options.limit || 100,
    });
    return tree.slice(0, options.limit || 100);
  }

  /**
   * Retrieves file content from repository with metadata
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param filePath - Full path to file in repository (e.g., "src/index.ts")
   * @param ref - Branch, tag, or commit SHA to read from (default: "main")
   * @returns File content (base64 encoded), encoding type, and size in bytes
   */
  async getFile(
    projectId: string | number,
    filePath: string,
    ref: string = 'main'
  ): Promise<{ content: string; encoding: string; size: number }> {
    const file = await this.gitlab.RepositoryFiles.show(projectId, filePath, ref);
    return {
      content: String(file.content),
      encoding: String(file.encoding),
      size: Number(file.size),
    };
  }

  /**
   * Gets git blame information for a file showing commit and author per line
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param filePath - Full path to file in repository (e.g., "src/index.ts")
   * @param ref - Branch, tag, or commit SHA to blame from (default: "main")
   * @returns Array of blame ranges with commit SHA, author, and line ranges
   */
  async getBlame(
    projectId: string | number,
    filePath: string,
    ref: string = 'main'
  ): Promise<unknown[]> {
    const blame = await this.gitlab.RepositoryFiles.allFileBlames(projectId, filePath, ref);
    return blame;
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Artifacts
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Lists all artifacts from jobs in a pipeline
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param pipelineId - Pipeline ID to list artifacts from
   * @returns Array of jobs with artifacts including job ID, name, and artifact details
   */
  async listArtifacts(projectId: string | number, pipelineId: number): Promise<unknown[]> {
    const jobs = await this.gitlab.Jobs.all(projectId, { pipelineId });
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
   * Downloads job log as artifact (note: direct artifact download not fully supported)
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param jobId - Job ID to download artifact from
   * @returns Buffer containing job log and suggested filename
   */
  async downloadArtifact(
    projectId: string | number,
    jobId: number
  ): Promise<{ data: Buffer; filename: string }> {
    // Get job trace (log) as artifact download isn't directly available
    const trace = await this.gitlab.Jobs.showLog(projectId, jobId);
    return {
      data: Buffer.from(String(trace)),
      filename: `job-${jobId}-log.txt`,
    };
  }

  /**
   * Deletes all artifacts and logs for a specific job
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param jobId - Job ID to erase artifacts from
   */
  async deleteArtifacts(projectId: string | number, jobId: number): Promise<void> {
    // Erase removes the job log and artifacts
    await this.gitlab.Jobs.erase(projectId, jobId);
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Issues
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Lists issues in a project with optional filtering
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param options - Issue filtering options
   * @param options.state - Filter by state: "opened", "closed", or "all" (default: "all")
   * @param options.labels - Comma-separated label names to filter by
   * @param options.assignee_username - Filter by assignee username
   * @param options.limit - Maximum issues to return (default: 20)
   * @returns Array of issues matching the filter criteria
   */
  async listIssues(
    projectId: string | number,
    options: {
      state?: string;
      labels?: string;
      assignee_username?: string;
      limit?: number;
    } = {}
  ): Promise<unknown[]> {
    const result = await this.gitlab.Issues.all({
      projectId,
      state: options.state as 'opened' | 'closed' | 'all' | undefined,
      labels: options.labels,
      assigneeUsername: options.assignee_username,
      perPage: options.limit || 20,
    } as Parameters<typeof this.gitlab.Issues.all>[0]);
    // Handle both array and paginated response
    const issues = Array.isArray(result) ? result : (result as { data: unknown[] }).data || [];
    return issues.slice(0, options.limit || 20);
  }

  /**
   * Gets a single issue by its internal ID (IID)
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param issueIid - Issue internal ID (IID) shown in the UI (e.g., #42)
   * @returns Issue details or null if not found
   */
  async getIssue(projectId: string | number, issueIid: number): Promise<unknown> {
    // Use Issues.all with specific project and iid filter
    const issues = await this.gitlab.Issues.all({
      projectId,
      iids: [issueIid],
    } as Parameters<typeof this.gitlab.Issues.all>[0]);
    const result = Array.isArray(issues) ? issues : (issues as { data: unknown[] }).data || [];
    return result[0] || null;
  }

  /**
   * Creates a new issue in the project
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param options - Issue creation options
   * @param options.title - Issue title (required)
   * @param options.description - Issue description in markdown format
   * @param options.labels - Comma-separated label names to apply
   * @param options.assignee_ids - Array of user IDs to assign the issue to
   * @param options.milestone_id - Milestone ID to associate with
   * @returns Created issue details
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
   * Updates an existing issue
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param issueIid - Issue internal ID (IID) to update
   * @param options - Issue update options
   * @param options.title - New issue title
   * @param options.description - New issue description in markdown
   * @param options.labels - Comma-separated label names to apply (replaces existing)
   * @param options.state_event - State transition: "close" or "reopen"
   * @returns Updated issue details
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
   * Closes an issue (convenience method for updating state)
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param issueIid - Issue internal ID (IID) to close
   * @returns Updated issue details with closed state
   */
  async closeIssue(projectId: string | number, issueIid: number): Promise<unknown> {
    return await this.gitlab.Issues.edit(projectId, issueIid, {
      stateEvent: 'close',
    });
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Labels
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Lists all labels in a project with optional search
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param options - Label filtering options
   * @param options.search - Search term to filter label names
   * @param options.limit - Maximum labels to return (default: 50)
   * @returns Array of label objects with name, color, and description
   */
  async listLabels(
    projectId: string | number,
    options: { search?: string; limit?: number } = {}
  ): Promise<unknown[]> {
    const labels = await this.gitlab.ProjectLabels.all(projectId, {
      search: options.search,
      perPage: options.limit || 50,
    });
    return labels.slice(0, options.limit || 50);
  }

  /**
   * Creates a new label in the project
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param options - Label creation options
   * @param options.name - Label name (required)
   * @param options.color - Label color in hex format (e.g., "#FF0000") (required)
   * @param options.description - Label description for documentation
   * @returns Created label details
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

  //═════════════════════════════════════════════════════════════════════════════
  // Pipelines
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Lists CI/CD pipelines for a project with optional filtering
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param options - Pipeline filtering options
   * @param options.status - Filter by status: "running", "pending", "success", "failed", "canceled", "skipped"
   * @param options.ref - Filter by branch or tag name
   * @param options.limit - Maximum pipelines to return (default: 5)
   * @param options.page - Page number for pagination (default: 1)
   * @returns Array of pipeline objects with status, ref, SHA, and timestamps
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
    const pipelines = await this.gitlab.Pipelines.all(projectId, {
      status: options.status as
        | 'running'
        | 'pending'
        | 'success'
        | 'failed'
        | 'canceled'
        | 'skipped'
        | undefined,
      ref: options.ref,
      perPage: options.limit || 5,
      page: options.page || 1,
    });

    return pipelines.map((p: Record<string, unknown>) => ({
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
   * Gets detailed pipeline information including all jobs
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param pipelineId - Pipeline ID to retrieve
   * @returns Object containing pipeline details and array of associated jobs
   */
  async showPipeline(projectId: string | number, pipelineId: number): Promise<unknown> {
    this.validateRequired({ project_id: projectId, pipeline_id: pipelineId });
    const pipeline = await this.gitlab.Pipelines.show(projectId, pipelineId);
    const jobs = await this.gitlab.Jobs.all(projectId, { pipelineId });
    return { pipeline, jobs };
  }

  /**
   * Retrieves CI/CD job log output with optional tail limiting
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param jobId - Job ID to get logs from
   * @param tailLines - Number of last lines to return (default: 100, 0 = all lines)
   * @returns Job log as string (last N lines if tailLines specified)
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
   * Retries a failed pipeline and all its failed jobs
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param pipelineId - Pipeline ID to retry
   * @returns Updated pipeline details with new status
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
   * Manually triggers a new pipeline for a branch or tag
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param options - Pipeline trigger options
   * @param options.ref - Branch or tag name to run pipeline on (required)
   * @param options.variables - Array of CI/CD variables as {key, value} pairs
   * @returns Newly created pipeline details
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

  //═════════════════════════════════════════════════════════════════════════════
  // Tags & Releases
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Creates a new git tag pointing to a specific commit
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param options - Tag creation options
   * @param options.tag_name - Tag name (e.g., "v1.0.0") (required)
   * @param options.ref - Branch name, commit SHA, or another tag to create tag from (required)
   * @param options.message - Optional tag message for annotated tags
   * @returns Created tag details
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
   * Gets information about a specific tag
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param tagName - Tag name (e.g., "v1.0.0")
   * @returns Tag information including name, target commit, and message
   */
  async getTag(projectId: string | number, tagName: string): Promise<unknown> {
    this.validateRequired({ project_id: projectId, tag_name: tagName });
    return await this.gitlab.Tags.show(projectId, tagName);
  }

  /**
   * Deletes a git tag from the repository with audit trail
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param tagName - Tag name to delete (e.g., "v1.0.0")
   * @returns Audit information about the deleted tag
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
   * Creates a release associated with a git tag
   * @param projectId - Project ID or path (e.g., 123 or "group/project")
   * @param options - Release creation options
   * @param options.tag_name - Existing tag name to create release from (required)
   * @param options.name - Release name (defaults to tag name if not provided)
   * @param options.description - Release notes in markdown format
   * @returns Created release details
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

//═══════════════════════════════════════════════════════════════════════════════
// Initialization
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Initializes GitLab client with token from mounted path and host from /tokens/host_url.
 * Reads authentication token from /tokens/token (or TOKENS_DIR env var) and GitLab host URL
 * from /tokens/host_url file. Falls back to GITLAB_URL env var, then https://gitlab.com.
 * Tests connection before returning client instance.
 *
 * IMPORTANT: Returns null (not throws) when tokens are missing or invalid.
 * This enables "graceful degradation" - server starts even without config:
 * - User can run `speedwave up` without configuring all integrations
 * - Healthcheck reports `configured: false` for unconfigured services
 * - Tools return clear "not configured" error when called
 *
 * DO NOT change this to throw - it breaks container startup for unconfigured services.
 * @returns Configured GitLabClient instance, or null if token not found/invalid
 */
export async function initializeGitLabClient(): Promise<GitLabClient | null> {
  try {
    // Load token from RO mount
    const tokenPath = process.env.TOKENS_DIR ? `${process.env.TOKENS_DIR}/token` : '/tokens/token';

    console.log(`${ts()} 📖 Loading GitLab token from: ${tokenPath}`);
    const token = await loadToken(tokenPath);

    if (!token) {
      // Graceful degradation: log warning, return null, let server start
      // DO NOT throw here - see JSDoc above for rationale
      console.warn(`${ts()} GitLab token is empty or not found. Run: speedwave setup gitlab`);
      return null;
    }

    // Load host URL from /tokens/host_url or env var
    const tokensDir = process.env.TOKENS_DIR || '/tokens';
    let host = 'https://gitlab.com';

    try {
      const hostUrl = await fs.readFile(`${tokensDir}/host_url`, 'utf-8');
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

    // Create client
    const client = new GitLabClient({ token, host });

    // Test connection
    const connectionResult = await client.testConnection();
    if (!connectionResult.success) {
      // Graceful degradation: log warning, return null, let server start
      // DO NOT throw here - see JSDoc above for rationale
      console.warn(`${ts()} GitLab connection test failed: ${connectionResult.error}`);
      return null;
    }

    console.log(`${ts()} ✅ GitLab client initialized (host: ${host})`);
    return client;
  } catch (error) {
    // Graceful degradation: log warning, return null, let server start
    // DO NOT throw here - see JSDoc above for rationale
    console.warn(`${ts()} Failed to initialize GitLab client: ${error}`);
    return null;
  }
}
