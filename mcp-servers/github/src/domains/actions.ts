/**
 * GitHub Actions Domain - Handles workflow runs, run logs, re-runs, workflow
 * dispatch, and run artifacts.
 * @module domains/actions
 */

import type { Octokit } from '@octokit/rest';
import type { GitHubWorkflowRun, GitHubWorkflowRunArtifact } from '../types.js';

/** Accepted values for the workflow-run `status` filter (GitHub Actions API). */
type WorkflowRunStatus =
  | 'completed'
  | 'action_required'
  | 'cancelled'
  | 'failure'
  | 'neutral'
  | 'skipped'
  | 'stale'
  | 'success'
  | 'timed_out'
  | 'in_progress'
  | 'queued'
  | 'requested'
  | 'waiting'
  | 'pending';

/**
 * Client interface for GitHub Actions operations.
 * @interface ActionsClient
 */
export interface ActionsClient {
  /**
   * Lists workflow runs for a repository.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {object} [options] - Optional filter and pagination parameters
   * @param {string} [options.branch] - Filter by branch
   * @param {string} [options.status] - Filter by run status (e.g. "completed", "in_progress")
   * @param {number} [options.limit] - Maximum number of runs to return (default 100)
   * @returns {Promise<GitHubWorkflowRun[]>} Array of workflow runs
   */
  listRuns(
    owner: string,
    repo: string,
    options?: { branch?: string; status?: string; limit?: number }
  ): Promise<GitHubWorkflowRun[]>;

  /**
   * Gets detailed information about a single workflow run.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} runId - Workflow run ID
   * @returns {Promise<GitHubWorkflowRun>} Workflow run details
   */
  getRun(owner: string, repo: string, runId: number): Promise<GitHubWorkflowRun>;

  /**
   * Gets the short-lived download URL for a workflow run's log archive (ZIP).
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} runId - Workflow run ID
   * @returns {Promise<string>} URL pointing to the logs ZIP
   */
  getRunLogsUrl(owner: string, repo: string, runId: number): Promise<string>;

  /**
   * Re-runs a workflow run.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} runId - Workflow run ID
   * @returns {Promise<void>}
   */
  rerun(owner: string, repo: string, runId: number): Promise<void>;

  /**
   * Triggers a `workflow_dispatch` event for a workflow.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {object} params - Trigger parameters
   * @param {string | number} params.workflow_id - Workflow file name (e.g. "ci.yml") or numeric ID
   * @param {string} params.ref - Git ref (branch or tag) to run the workflow on
   * @param {Record<string, unknown>} [params.inputs] - Optional inputs map passed to the workflow
   * @returns {Promise<void>}
   */
  triggerDispatch(
    owner: string,
    repo: string,
    params: { workflow_id: string | number; ref: string; inputs?: Record<string, unknown> }
  ): Promise<void>;

  /**
   * Lists the artifacts produced by a workflow run.
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} runId - Workflow run ID
   * @param {object} [options] - Pagination options
   * @param {number} [options.limit] - Maximum number of artifacts to return (default 100)
   * @returns {Promise<GitHubWorkflowRunArtifact[]>} Array of artifacts
   */
  listArtifacts(
    owner: string,
    repo: string,
    runId: number,
    options?: { limit?: number }
  ): Promise<GitHubWorkflowRunArtifact[]>;

  /**
   * Gets the short-lived download URL for a workflow artifact (ZIP archive).
   * @param {string} owner - Repository owner login
   * @param {string} repo - Repository name
   * @param {number} artifactId - Artifact ID
   * @returns {Promise<string>} URL pointing to the artifact ZIP
   */
  getArtifactDownloadUrl(owner: string, repo: string, artifactId: number): Promise<string>;
}

/**
 * Creates an actions client instance.
 * @param {Octokit} octokit - Octokit REST instance
 * @returns {ActionsClient} Configured actions client
 */
export function createActionsClient(octokit: Octokit): ActionsClient {
  return {
    async listRuns(owner, repo, options = {}) {
      const limit = options.limit ?? 100;
      const items = (await octokit.paginate(octokit.rest.actions.listWorkflowRunsForRepo, {
        owner,
        repo,
        branch: options.branch,
        status: options.status as WorkflowRunStatus | undefined,
        per_page: Math.min(limit, 100),
      })) as Array<Record<string, unknown>>;
      return items.slice(0, limit).map(mapWorkflowRun);
    },

    async getRun(owner, repo, runId) {
      const { data } = await octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: runId,
      });
      return mapWorkflowRun(data as Record<string, unknown>);
    },

    async getRunLogsUrl(owner, repo, runId) {
      // `redirect: 'manual'` stops Octokit from following the 302 (which would
      // buffer the whole logs ZIP into memory); we only want the `Location` URL.
      const res = await octokit.rest.actions.downloadWorkflowRunLogs({
        owner,
        repo,
        run_id: runId,
        request: { redirect: 'manual' },
      });
      const r = res as { url?: unknown; headers?: { location?: unknown } };
      return String(r.headers?.location || r.url || '');
    },

    async rerun(owner, repo, runId) {
      await octokit.rest.actions.reRunWorkflow({ owner, repo, run_id: runId });
    },

    async triggerDispatch(owner, repo, params) {
      await octokit.rest.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: params.workflow_id,
        ref: params.ref,
        inputs: params.inputs as Record<string, string> | undefined,
      });
    },

    async listArtifacts(owner, repo, runId, options = {}) {
      const limit = options.limit ?? 100;
      const items = (await octokit.paginate(octokit.rest.actions.listWorkflowRunArtifacts, {
        owner,
        repo,
        run_id: runId,
        per_page: Math.min(limit, 100),
      })) as Array<Record<string, unknown>>;
      return items.slice(0, limit).map(mapArtifact);
    },

    async getArtifactDownloadUrl(owner, repo, artifactId) {
      // `redirect: 'manual'` stops Octokit from following the 302 (which would
      // buffer the whole artifact ZIP into memory); we only want the `Location` URL.
      const res = await octokit.rest.actions.downloadArtifact({
        owner,
        repo,
        artifact_id: artifactId,
        archive_format: 'zip',
        request: { redirect: 'manual' },
      });
      const r = res as { url?: unknown; headers?: { location?: unknown } };
      return String(r.headers?.location || r.url || '');
    },
  };
}

/**
 * Normalizes a raw GitHub workflow run object to the {@link GitHubWorkflowRun} shape.
 * @param {unknown} r - Raw workflow run object from the GitHub API
 * @returns {GitHubWorkflowRun} Normalized workflow run
 */
function mapWorkflowRun(r: unknown): GitHubWorkflowRun {
  const o = r as Record<string, unknown>;
  return {
    id: Number(o.id),
    name: o.name ? String(o.name) : undefined,
    status: String(o.status || ''),
    conclusion: o.conclusion !== undefined && o.conclusion !== null ? String(o.conclusion) : null,
    head_branch: String(o.head_branch || ''),
    head_sha: String(o.head_sha || ''),
    html_url: String(o.html_url || ''),
    created_at: String(o.created_at || ''),
    updated_at: String(o.updated_at || ''),
  };
}

/**
 * Normalizes a raw GitHub workflow run artifact object to the {@link GitHubWorkflowRunArtifact} shape.
 * @param {unknown} a - Raw artifact object from the GitHub API
 * @returns {GitHubWorkflowRunArtifact} Normalized artifact
 */
function mapArtifact(a: unknown): GitHubWorkflowRunArtifact {
  const o = a as Record<string, unknown>;
  return {
    id: Number(o.id),
    name: String(o.name || ''),
    size_in_bytes: Number(o.size_in_bytes || 0),
    archive_download_url: String(o.archive_download_url || ''),
    expired: Boolean(o.expired),
  };
}
