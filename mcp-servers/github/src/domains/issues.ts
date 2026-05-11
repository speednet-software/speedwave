/**
 * GitHub Issues Domain - Handles issue listing, retrieval, creation, and updates.
 * @module domains/issues
 */

import type { Octokit } from '@octokit/rest';
import type { GitHubIssue } from '../types.js';

/**
 * Client interface for GitHub issue operations.
 * @interface IssuesClient
 */
export interface IssuesClient {
  /**
   * Lists issues in a repository. Pull requests returned by GitHub's issues endpoint are excluded.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {object} [options] - Optional filter and pagination parameters
   * @param {'open' | 'closed' | 'all'} [options.state] - Filter by state (default "open")
   * @param {string} [options.labels] - Comma-separated label names
   * @param {string} [options.assignee] - Filter by assignee login (or "none" / "*")
   * @param {string} [options.creator] - Filter by creator login
   * @param {number} [options.limit] - Maximum number of issues to return (default 100)
   * @returns {Promise<GitHubIssue[]>} Array of issues
   */
  list(
    owner: string,
    repo: string,
    options?: {
      state?: 'open' | 'closed' | 'all';
      labels?: string;
      assignee?: string;
      creator?: string;
      limit?: number;
    }
  ): Promise<GitHubIssue[]>;

  /**
   * Gets detailed information about a specific issue.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} number - Issue number
   * @returns {Promise<GitHubIssue>} Issue details
   */
  get(owner: string, repo: string, number: number): Promise<GitHubIssue>;

  /**
   * Creates a new issue.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {object} params - Issue creation parameters
   * @param {string} params.title - Issue title
   * @param {string} [params.body] - Optional issue body (Markdown)
   * @param {string[]} [params.labels] - Optional label names to apply
   * @param {string[]} [params.assignees] - Optional assignee logins
   * @returns {Promise<GitHubIssue>} Created issue
   */
  create(
    owner: string,
    repo: string,
    params: { title: string; body?: string; labels?: string[]; assignees?: string[] }
  ): Promise<GitHubIssue>;

  /**
   * Updates an existing issue.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} number - Issue number
   * @param {object} params - Update parameters
   * @param {string} [params.title] - New issue title
   * @param {string} [params.body] - New issue body (Markdown)
   * @param {'open' | 'closed'} [params.state] - New state
   * @param {string[]} [params.labels] - Replacement label names
   * @param {string[]} [params.assignees] - Replacement assignee logins
   * @returns {Promise<GitHubIssue>} Updated issue
   */
  update(
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
  ): Promise<GitHubIssue>;
}

/**
 * Creates an issues client instance.
 * @param {Octokit} octokit - Octokit REST instance
 * @returns {IssuesClient} Configured issues client
 */
export function createIssuesClient(octokit: Octokit): IssuesClient {
  return {
    async list(owner, repo, options = {}) {
      const limit = options.limit ?? 100;
      const items = (await octokit.paginate(octokit.rest.issues.listForRepo, {
        owner,
        repo,
        state: options.state || 'open',
        labels: options.labels,
        assignee: options.assignee,
        creator: options.creator,
        per_page: Math.min(limit, 100),
      })) as Array<Record<string, unknown>>;
      return items
        .filter((i) => !i.pull_request)
        .slice(0, limit)
        .map(mapIssue);
    },

    async get(owner, repo, number) {
      const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: number });
      return mapIssue(data as Record<string, unknown>);
    },

    async create(owner, repo, params) {
      const { data } = await octokit.rest.issues.create({
        owner,
        repo,
        title: params.title,
        body: params.body,
        labels: params.labels,
        assignees: params.assignees,
      });
      return mapIssue(data as Record<string, unknown>);
    },

    async update(owner, repo, number, params) {
      const { data } = await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: number,
        title: params.title,
        body: params.body,
        state: params.state,
        labels: params.labels,
        assignees: params.assignees,
      });
      return mapIssue(data as Record<string, unknown>);
    },
  };
}

/**
 * Normalizes a raw GitHub issue object to the {@link GitHubIssue} shape.
 * @param {unknown} i - Raw issue object from the GitHub API
 * @returns {GitHubIssue} Normalized issue
 */
function mapIssue(i: unknown): GitHubIssue {
  const o = i as Record<string, unknown>;
  const user = (o.user || {}) as Record<string, unknown>;
  const labels = Array.isArray(o.labels) ? (o.labels as unknown[]) : [];
  const assignees = Array.isArray(o.assignees) ? (o.assignees as unknown[]) : [];
  return {
    number: Number(o.number),
    title: String(o.title || ''),
    body: o.body ? String(o.body) : undefined,
    state: String(o.state || 'open') as 'open' | 'closed',
    user: { login: String(user.login || '') },
    labels: labels.map((l) => {
      if (typeof l === 'string') return { name: l };
      const label = (l || {}) as Record<string, unknown>;
      return { name: String(label.name || '') };
    }),
    assignees: assignees.map((a) => {
      const assignee = (a || {}) as Record<string, unknown>;
      return { login: String(assignee.login || '') };
    }),
    html_url: String(o.html_url || ''),
    created_at: String(o.created_at || ''),
    updated_at: String(o.updated_at || ''),
  };
}
