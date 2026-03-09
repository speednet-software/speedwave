/**
 \* GitLab Merge Requests Domain - Handles all merge request operations
 * including listing, creation, approval, merging, updating, and retrieving changes
 * @module domains/merge-requests
 */

import { Gitlab } from '@gitbeaker/rest';
import type {
  GitLabMergeRequest,
  GitLabNote,
  GitLabDiscussion,
  GitLabCommit,
  GitLabPipeline,
} from '../types.js';

/**
 * Client interface for GitLab merge request operations.
 * Provides comprehensive methods to manage MRs, discussions, and reviews.
 * @interface MergeRequestsClient
 */
export interface MergeRequestsClient {
  /**
   * Lists merge requests with optional filtering.
   * @param {string | number} projectId - Project ID or path
   * @param {Object} [options] - Optional filter parameters
   * @param {string} [options.state] - Filter by state (opened, closed, merged, all)
   * @param {string} [options.author_username] - Filter by author username
   * @param {string} [options.reviewer_username] - Filter by reviewer username
   * @param {string} [options.labels] - Comma-separated list of labels
   * @param {number} [options.limit=20] - Maximum number of results
   * @returns {Promise<GitLabMergeRequest[]>} Array of merge requests
   */
  list(
    projectId: string | number,
    options?: {
      state?: string;
      author_username?: string;
      reviewer_username?: string;
      labels?: string;
      limit?: number;
    }
  ): Promise<GitLabMergeRequest[]>;

  /**
   * Shows detailed information about a specific merge request.
   * @param {string | number} projectId - Project ID or path
   * @param {number} mrIid - Merge request internal ID (not the global ID)
   * @returns {Promise<GitLabMergeRequest>} Merge request details
   */
  show(projectId: string | number, mrIid: number): Promise<GitLabMergeRequest>;

  /**
   * Creates a new merge request.
   * @param {string | number} projectId - Project ID or path
   * @param {Object} options - MR creation options
   * @param {string} options.source_branch - Source branch name
   * @param {string} options.target_branch - Target branch name
   * @param {string} options.title - MR title
   * @param {string} [options.description] - MR description (markdown supported)
   * @param {string} [options.labels] - Comma-separated list of labels
   * @param {boolean} [options.remove_source_branch] - Delete source branch after merge
   * @returns {Promise<GitLabMergeRequest>} Created merge request
   */
  create(
    projectId: string | number,
    options: {
      source_branch: string;
      target_branch: string;
      title: string;
      description?: string;
      labels?: string;
      remove_source_branch?: boolean;
    }
  ): Promise<GitLabMergeRequest>;

  /**
   * Approves a merge request (adds current user's approval).
   * @param {string | number} projectId - Project ID or path
   * @param {number} mrIid - Merge request internal ID
   * @returns {Promise<void>}
   */
  approve(projectId: string | number, mrIid: number): Promise<void>;

  /**
   * Merges a merge request with optional squash and auto-merge.
   * @param {string | number} projectId - Project ID or path
   * @param {number} mrIid - Merge request internal ID
   * @param {Object} [options] - Merge options
   * @param {boolean} [options.squash] - Squash commits into one
   * @param {boolean} [options.should_remove_source_branch] - Delete source branch after merge
   * @param {boolean} [options.auto_merge] - Merge when pipeline succeeds
   * @param {string} [options.sha] - Expected SHA of source branch head (prevents race conditions)
   * @returns {Promise<GitLabMergeRequest>} Updated merge request
   */
  merge(
    projectId: string | number,
    mrIid: number,
    options?: {
      squash?: boolean;
      should_remove_source_branch?: boolean;
      auto_merge?: boolean;
      sha?: string;
    }
  ): Promise<GitLabMergeRequest>;

  /**
   * Updates an existing merge request.
   * @param {string | number} projectId - Project ID or path
   * @param {number} mrIid - Merge request internal ID
   * @param {Object} options - Fields to update
   * @param {string} [options.title] - New title
   * @param {string} [options.description] - New description
   * @param {string} [options.target_branch] - New target branch
   * @param {string} [options.state_event] - State change (close or reopen)
   * @param {string} [options.labels] - New labels (comma-separated)
   * @returns {Promise<GitLabMergeRequest>} Updated merge request
   */
  update(
    projectId: string | number,
    mrIid: number,
    options: {
      title?: string;
      description?: string;
      target_branch?: string;
      state_event?: string;
      labels?: string;
    }
  ): Promise<GitLabMergeRequest>;

  /**
   * Gets all file changes (diffs) in a merge request.
   * @param {string | number} projectId - Project ID or path
   * @param {number} mrIid - Merge request internal ID
   * @returns {Promise<unknown>} Array of file diffs
   */
  getChanges(projectId: string | number, mrIid: number): Promise<unknown>;

  /**
   * Lists all notes (comments) on a merge request.
   * @param {string | number} projectId - Project ID or path
   * @param {number} mrIid - Merge request internal ID
   * @returns {Promise<GitLabNote[]>} Array of notes
   */
  listNotes(projectId: string | number, mrIid: number): Promise<GitLabNote[]>;

  /**
   * Creates a new note (comment) on a merge request.
   * @param {string | number} projectId - Project ID or path
   * @param {number} mrIid - Merge request internal ID
   * @param {string} body - Comment text (markdown supported)
   * @returns {Promise<GitLabNote>} Created note
   */
  createNote(projectId: string | number, mrIid: number, body: string): Promise<GitLabNote>;

  /**
   * Lists all discussion threads on a merge request.
   * @param {string | number} projectId - Project ID or path
   * @param {number} mrIid - Merge request internal ID
   * @returns {Promise<GitLabDiscussion[]>} Array of discussions
   */
  listDiscussions(projectId: string | number, mrIid: number): Promise<GitLabDiscussion[]>;

  /**
   * Creates a new discussion thread on a merge request.
   * @param {string | number} projectId - Project ID or path
   * @param {number} mrIid - Merge request internal ID
   * @param {string} body - Discussion text (markdown supported)
   * @returns {Promise<GitLabDiscussion>} Created discussion
   */
  createDiscussion(
    projectId: string | number,
    mrIid: number,
    body: string
  ): Promise<GitLabDiscussion>;

  /**
   * Lists all commits in a merge request.
   * @param {string | number} projectId - Project ID or path
   * @param {number} mrIid - Merge request internal ID
   * @returns {Promise<GitLabCommit[]>} Array of commits
   */
  listCommits(projectId: string | number, mrIid: number): Promise<GitLabCommit[]>;

  /**
   * Lists all pipelines associated with a merge request.
   * @param {string | number} projectId - Project ID or path
   * @param {number} mrIid - Merge request internal ID
   * @returns {Promise<GitLabPipeline[]>} Array of pipelines
   */
  listPipelines(projectId: string | number, mrIid: number): Promise<GitLabPipeline[]>;
}

/**
 * Creates a merge requests client instance with the given GitLab SDK instance.
 * @param {InstanceType<typeof Gitlab>} gitlab - GitBeaker SDK instance
 * @returns {MergeRequestsClient} Configured merge requests client
 */
export function createMergeRequestsClient(
  gitlab: InstanceType<typeof Gitlab>
): MergeRequestsClient {
  return {
    async list(projectId, options = {}) {
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

      const mrs = (await gitlab.MergeRequests.all(
        queryOptions as Parameters<typeof gitlab.MergeRequests.all>[0]
      )) as unknown as Array<Record<string, unknown>>;

      // Take only first page
      const limited = mrs.slice(0, options.limit || 20);

      return limited.map((mr: Record<string, unknown>) => ({
        id: Number(mr.id),
        iid: Number(mr.iid),
        title: String(mr.title || ''),
        description: mr.description ? String(mr.description) : undefined,
        state: String(mr.state || ''),
        source_branch: String(mr.sourceBranch || mr.source_branch || ''),
        target_branch: String(mr.targetBranch || mr.target_branch || ''),
        author: (mr.author || { id: 0, name: '', username: '' }) as {
          id: number;
          name: string;
          username: string;
        },
        web_url: String(mr.webUrl || mr.web_url || ''),
        created_at: String(mr.createdAt || mr.created_at || ''),
        updated_at: String(mr.updatedAt || mr.updated_at || ''),
        has_conflicts: (mr.hasConflicts ?? mr.has_conflicts) as boolean | undefined,
        merge_status:
          mr.mergeStatus || mr.merge_status ? String(mr.mergeStatus || mr.merge_status) : undefined,
        detailed_merge_status:
          mr.detailedMergeStatus || mr.detailed_merge_status
            ? String(mr.detailedMergeStatus || mr.detailed_merge_status)
            : undefined,
      }));
    },

    async show(projectId, mrIid) {
      const mr = await gitlab.MergeRequests.show(projectId, mrIid);
      return {
        id: mr.id as number,
        iid: mr.iid as number,
        title: String(mr.title),
        description: mr.description ? String(mr.description) : undefined,
        state: String(mr.state),
        source_branch: String(mr.sourceBranch || ''),
        target_branch: String(mr.targetBranch || ''),
        author: mr.author as { id: number; name: string; username: string },
        web_url: String(mr.webUrl || ''),
        created_at: String(mr.createdAt || ''),
        updated_at: String(mr.updatedAt || ''),
        has_conflicts: mr.hasConflicts as boolean | undefined,
        merge_status: mr.mergeStatus ? String(mr.mergeStatus) : undefined,
        detailed_merge_status: mr.detailedMergeStatus ? String(mr.detailedMergeStatus) : undefined,
      };
    },

    async create(projectId, options) {
      const mr = await gitlab.MergeRequests.create(
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

      return {
        id: mr.id as number,
        iid: mr.iid as number,
        title: String(mr.title),
        description: mr.description ? String(mr.description) : undefined,
        state: String(mr.state),
        source_branch: String(mr.sourceBranch || ''),
        target_branch: String(mr.targetBranch || ''),
        author: mr.author as { id: number; name: string; username: string },
        web_url: String(mr.webUrl || ''),
        created_at: String(mr.createdAt || ''),
        updated_at: String(mr.updatedAt || ''),
        has_conflicts: mr.hasConflicts as boolean | undefined,
        merge_status: mr.mergeStatus ? String(mr.mergeStatus) : undefined,
        detailed_merge_status: mr.detailedMergeStatus ? String(mr.detailedMergeStatus) : undefined,
      };
    },

    async approve(projectId, mrIid) {
      await gitlab.MergeRequestApprovals.approve(projectId, mrIid);
    },

    async merge(projectId, mrIid, options = {}) {
      // For auto_merge, use accept with mergeWhenPipelineSucceeds option
      const mr = await gitlab.MergeRequests.accept(projectId, mrIid, {
        squash: options.squash,
        shouldRemoveSourceBranch: options.should_remove_source_branch,
        sha: options.sha,
        mergeWhenPipelineSucceeds: options.auto_merge,
      });

      return {
        id: mr.id as number,
        iid: mr.iid as number,
        title: String(mr.title),
        description: mr.description ? String(mr.description) : undefined,
        state: String(mr.state),
        source_branch: String(mr.sourceBranch || ''),
        target_branch: String(mr.targetBranch || ''),
        author: mr.author as { id: number; name: string; username: string },
        web_url: String(mr.webUrl || ''),
        created_at: String(mr.createdAt || ''),
        updated_at: String(mr.updatedAt || ''),
        has_conflicts: mr.hasConflicts as boolean | undefined,
        merge_status: mr.mergeStatus ? String(mr.mergeStatus) : undefined,
        detailed_merge_status: mr.detailedMergeStatus ? String(mr.detailedMergeStatus) : undefined,
      };
    },

    async update(projectId, mrIid, options) {
      const mr = await gitlab.MergeRequests.edit(projectId, mrIid, {
        title: options.title,
        description: options.description,
        targetBranch: options.target_branch,
        stateEvent: options.state_event as 'close' | 'reopen' | undefined,
        labels: options.labels,
      });

      return {
        id: mr.id as number,
        iid: mr.iid as number,
        title: String(mr.title),
        description: mr.description ? String(mr.description) : undefined,
        state: String(mr.state),
        source_branch: String(mr.sourceBranch || ''),
        target_branch: String(mr.targetBranch || ''),
        author: mr.author as { id: number; name: string; username: string },
        web_url: String(mr.webUrl || ''),
        created_at: String(mr.createdAt || ''),
        updated_at: String(mr.updatedAt || ''),
        has_conflicts: mr.hasConflicts as boolean | undefined,
        merge_status: mr.mergeStatus ? String(mr.mergeStatus) : undefined,
        detailed_merge_status: mr.detailedMergeStatus ? String(mr.detailedMergeStatus) : undefined,
      };
    },

    async getChanges(projectId, mrIid) {
      return await gitlab.MergeRequests.allDiffs(projectId, mrIid);
    },

    async listNotes(projectId, mrIid) {
      const notes = await gitlab.MergeRequestNotes.all(projectId, mrIid);
      return (notes as unknown as Array<Record<string, unknown>>).map(mapNote);
    },

    async createNote(projectId, mrIid, body) {
      const note = await gitlab.MergeRequestNotes.create(projectId, mrIid, body);
      return mapNote(note as unknown as Record<string, unknown>);
    },

    async listDiscussions(projectId, mrIid) {
      const discussions = await gitlab.MergeRequestDiscussions.all(projectId, mrIid);
      return (discussions as unknown as Array<Record<string, unknown>>).map((d) => ({
        id: String(d.id),
        notes: ((d.notes || []) as Array<Record<string, unknown>>).map(mapNote),
      }));
    },

    async createDiscussion(projectId, mrIid, body) {
      const discussion = await gitlab.MergeRequestDiscussions.create(projectId, mrIid, body);
      const d = discussion as unknown as Record<string, unknown>;
      return {
        id: String(d.id),
        notes: ((d.notes || []) as Array<Record<string, unknown>>).map(mapNote),
      };
    },

    async listCommits(projectId, mrIid) {
      const commits = await gitlab.MergeRequests.allCommits(projectId, mrIid);
      return (commits as unknown as Array<Record<string, unknown>>).map(mapCommit);
    },

    async listPipelines(projectId, mrIid) {
      const pipelines = await gitlab.MergeRequests.allPipelines(projectId, mrIid);
      return (pipelines as unknown as Array<Record<string, unknown>>).map(mapPipeline);
    },
  };
}

/**
 * Maps GitLab API note response to standardized GitLabNote type.
 * @param {Record<string, unknown>} n - Raw note object from GitLab API
 * @returns {GitLabNote} Normalized note object
 */
function mapNote(n: Record<string, unknown>): GitLabNote {
  const author = (n.author || {}) as Record<string, unknown>;
  return {
    id: Number(n.id),
    body: String(n.body),
    author: {
      id: Number(author.id || 0),
      username: String(author.username || ''),
      name: String(author.name || ''),
    },
    created_at: String(n.createdAt || n.created_at || ''),
    system: Boolean(n.system),
    resolvable: Boolean(n.resolvable),
    resolved: n.resolved !== undefined ? Boolean(n.resolved) : undefined,
  };
}

/**
 * Maps GitLab API commit response to standardized GitLabCommit type.
 * @param {Record<string, unknown>} c - Raw commit object from GitLab API
 * @returns {GitLabCommit} Normalized commit object
 */
function mapCommit(c: Record<string, unknown>): GitLabCommit {
  return {
    id: String(c.id),
    short_id: String(c.shortId || c.short_id || c.id?.toString().substring(0, 8) || ''),
    title: String(c.title || (c.message as string)?.split('\n')[0] || ''),
    message: String(c.message || ''),
    author_name: String(c.authorName || c.author_name || ''),
    author_email: String(c.authorEmail || c.author_email || ''),
    created_at: String(c.createdAt || c.created_at || c.committedDate || ''),
  };
}

/**
 * Maps GitLab API pipeline response to standardized GitLabPipeline type.
 * @param {Record<string, unknown>} p - Raw pipeline object from GitLab API
 * @returns {GitLabPipeline} Normalized pipeline object
 */
function mapPipeline(p: Record<string, unknown>): GitLabPipeline {
  return {
    id: Number(p.id),
    status: String(p.status),
    ref: String(p.ref),
    sha: String(p.sha),
    web_url: String(p.webUrl || p.web_url || ''),
    created_at: String(p.createdAt || p.created_at || ''),
    updated_at: String(p.updatedAt || p.updated_at || ''),
  };
}
