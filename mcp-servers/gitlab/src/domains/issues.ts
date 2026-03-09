/**
 \* GitLab Issues Domain - Handles all issue operations including listing,
 * creation, updating, and closing issues
 * @module domains/issues
 */

import { Gitlab } from '@gitbeaker/rest';
import type { GitLabIssue } from '../types.js';

/**
 * Client interface for GitLab issue operations.
 * Provides methods to manage project issues.
 * @interface IssuesClient
 */
export interface IssuesClient {
  /**
   * Lists issues in a project with optional filtering.
   * @param {string | number} projectId - Project ID or path
   * @param {Object} [options] - Optional filter parameters
   * @param {string} [options.state='opened'] - Issue state (opened, closed, all)
   * @param {string} [options.labels] - Comma-separated list of labels
   * @param {string} [options.assignee_username] - Filter by assignee username
   * @param {number} [options.limit=20] - Maximum number of results
   * @returns {Promise<GitLabIssue[]>} Array of issues
   */
  list(
    projectId: string | number,
    options?: {
      state?: string;
      labels?: string;
      assignee_username?: string;
      limit?: number;
    }
  ): Promise<GitLabIssue[]>;

  /**
   * Gets detailed information about a specific issue.
   * @param {string | number} projectId - Project ID or path
   * @param {number} issueIid - Issue internal ID
   * @returns {Promise<GitLabIssue>} Issue details
   */
  get(projectId: string | number, issueIid: number): Promise<GitLabIssue>;

  /**
   * Creates a new issue in a project.
   * @param {string | number} projectId - Project ID or path
   * @param {string} title - Issue title
   * @param {Object} [options] - Optional issue parameters
   * @param {string} [options.description] - Issue description (markdown supported)
   * @param {string} [options.labels] - Comma-separated list of labels
   * @param {number[]} [options.assignee_ids] - Array of user IDs to assign
   * @param {number} [options.milestone_id] - Milestone ID
   * @returns {Promise<GitLabIssue>} Created issue
   */
  create(
    projectId: string | number,
    title: string,
    options?: {
      description?: string;
      labels?: string;
      assignee_ids?: number[];
      milestone_id?: number;
    }
  ): Promise<GitLabIssue>;

  /**
   * Updates an existing issue.
   * @param {string | number} projectId - Project ID or path
   * @param {number} issueIid - Issue internal ID
   * @param {Object} options - Fields to update
   * @param {string} [options.title] - New title
   * @param {string} [options.description] - New description
   * @param {string} [options.labels] - New labels (comma-separated)
   * @param {string} [options.state_event] - State change (close or reopen)
   * @returns {Promise<GitLabIssue>} Updated issue
   */
  update(
    projectId: string | number,
    issueIid: number,
    options: {
      title?: string;
      description?: string;
      labels?: string;
      state_event?: string;
    }
  ): Promise<GitLabIssue>;

  /**
   * Closes an issue.
   * @param {string | number} projectId - Project ID or path
   * @param {number} issueIid - Issue internal ID
   * @returns {Promise<GitLabIssue>} Closed issue
   */
  close(projectId: string | number, issueIid: number): Promise<GitLabIssue>;
}

/**
 * Creates an issues client instance with the given GitLab SDK instance.
 * @param {InstanceType<typeof Gitlab>} gitlab - GitBeaker SDK instance
 * @returns {IssuesClient} Configured issues client
 */
export function createIssuesClient(gitlab: InstanceType<typeof Gitlab>): IssuesClient {
  return {
    async list(projectId, options = {}) {
      const queryOptions: Record<string, unknown> = {
        projectId,
        perPage: options.limit || 20,
      };

      if (options.state) {
        queryOptions.state = options.state;
      }
      if (options.labels) {
        queryOptions.labels = options.labels;
      }
      if (options.assignee_username) {
        queryOptions.assigneeUsername = options.assignee_username;
      }

      const issues = (await gitlab.Issues.all(
        queryOptions as Parameters<typeof gitlab.Issues.all>[0]
      )) as unknown as Array<Record<string, unknown>>;

      // Take only first page
      const limited = issues.slice(0, options.limit || 20);

      return limited.map(mapIssue);
    },

    async get(projectId, issueIid) {
      // GitBeaker types are strict - use type assertion for compatibility
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const issue = await gitlab.Issues.show(projectId as any, issueIid as any);
      return mapIssue(issue);
    },

    async create(projectId, title, options = {}) {
      // GitBeaker expects string title as second param, but we pass object
      const issue = await gitlab.Issues.create(projectId, {
        title,
        description: options.description,
        labels: options.labels,
        assigneeIds: options.assignee_ids,
        milestoneId: options.milestone_id,
      } as unknown as string);
      return mapIssue(issue);
    },

    async update(projectId, issueIid, options) {
      const issue = await gitlab.Issues.edit(projectId, issueIid, {
        title: options.title,
        description: options.description,
        labels: options.labels,
        stateEvent: options.state_event as 'close' | 'reopen' | undefined,
      });
      return mapIssue(issue);
    },

    async close(projectId, issueIid) {
      const issue = await gitlab.Issues.edit(projectId, issueIid, {
        stateEvent: 'close',
      });
      return mapIssue(issue);
    },
  };
}

/**
 * Maps GitLab API response to standardized GitLabIssue type.
 * Handles both camelCase and snake_case field names from API.
 * @param {unknown} i - Raw issue object from GitLab API
 * @returns {GitLabIssue} Normalized issue object
 */
function mapIssue(i: unknown): GitLabIssue {
  const issue = i as Record<string, unknown>;

  return {
    id: Number(issue.id),
    iid: Number(issue.iid),
    title: String(issue.title || ''),
    description: issue.description ? String(issue.description) : undefined,
    state: (issue.state as 'opened' | 'closed') || 'opened',
    labels: Array.isArray(issue.labels) ? issue.labels.map(String) : [],
    assignees: (Array.isArray(issue.assignees) ? issue.assignees : []).map((a: unknown) => {
      const assignee = a as Record<string, unknown>;
      return {
        id: Number(assignee.id),
        username: String(assignee.username || ''),
        name: String(assignee.name || ''),
      };
    }),
    author: {
      id: Number((issue.author as Record<string, unknown>)?.id || 0),
      username: String((issue.author as Record<string, unknown>)?.username || ''),
      name: String((issue.author as Record<string, unknown>)?.name || ''),
    },
    milestone: issue.milestone
      ? {
          id: Number((issue.milestone as Record<string, unknown>).id),
          title: String((issue.milestone as Record<string, unknown>).title),
        }
      : undefined,
    web_url: String(issue.webUrl || issue.web_url || ''),
    created_at: String(issue.createdAt || issue.created_at || ''),
    updated_at: String(issue.updatedAt || issue.updated_at || ''),
    closed_at:
      issue.closedAt || issue.closed_at ? String(issue.closedAt || issue.closed_at) : undefined,
  };
}
