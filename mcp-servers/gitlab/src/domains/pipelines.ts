/**
 \* GitLab Pipelines Domain - Handles pipeline operations including listing,
 * showing details, getting job logs, retrying, and triggering pipelines
 * @module domains/pipelines
 */

import { Gitlab } from '@gitbeaker/rest';
import type { GitLabPipeline } from '../types.js';

/**
 * Client interface for GitLab pipeline operations.
 * Provides methods to manage CI/CD pipelines, jobs, and logs.
 * @interface PipelinesClient
 */
export interface PipelinesClient {
  /**
   * Lists pipelines in a project with optional filtering.
   * @param {string | number} projectId - Project ID or path
   * @param {Object} [options] - Optional filter parameters
   * @param {string} [options.status] - Filter by pipeline status (running, pending, success, failed, canceled, skipped)
   * @param {string} [options.ref] - Filter by branch or tag name
   * @param {number} [options.limit] - Maximum number of results (default: 5)
   * @param {number} [options.page] - Page number for pagination (default: 1)
   * @returns {Promise<GitLabPipeline[]>} Array of pipeline objects
   */
  list(
    projectId: string | number,
    options?: {
      status?: string;
      ref?: string;
      limit?: number;
      page?: number;
    }
  ): Promise<GitLabPipeline[]>;

  /**
   * Shows detailed information about a specific pipeline including all jobs.
   * @param {string | number} projectId - Project ID or path
   * @param {number} pipelineId - Pipeline ID
   * @returns {Promise<unknown>} Pipeline details with jobs array
   */
  show(projectId: string | number, pipelineId: number): Promise<unknown>;

  /**
   * Gets log output from a specific job, optionally limited to last N lines.
   * @param {string | number} projectId - Project ID or path
   * @param {number} jobId - Job ID
   * @param {number} [tailLines=100] - Number of lines from end of log
   * @returns {Promise<string>} Job log content
   */
  getJobLog(projectId: string | number, jobId: number, tailLines?: number): Promise<string>;

  /**
   * Retries a failed pipeline by rerunning failed jobs.
   * @param {string | number} projectId - Project ID or path
   * @param {number} pipelineId - Pipeline ID to retry
   * @returns {Promise<GitLabPipeline>} Updated pipeline object
   */
  retry(projectId: string | number, pipelineId: number): Promise<GitLabPipeline>;

  /**
   * Triggers a new pipeline on a branch or tag with optional variables.
   * @param {string | number} projectId - Project ID or path
   * @param {Object} options - Trigger options
   * @param {string} options.ref - Branch or tag name to run pipeline on
   * @param {Array<{key: string, value: string}>} [options.variables] - Optional pipeline variables
   * @returns {Promise<GitLabPipeline>} Created pipeline object
   */
  trigger(
    projectId: string | number,
    options: {
      ref: string;
      variables?: Array<{ key: string; value: string }>;
    }
  ): Promise<GitLabPipeline>;
}

/**
 * Creates a pipelines client instance with the given GitLab SDK instance.
 * @param {InstanceType<typeof Gitlab>} gitlab - GitBeaker SDK instance
 * @returns {PipelinesClient} Configured pipelines client
 */
export function createPipelinesClient(gitlab: InstanceType<typeof Gitlab>): PipelinesClient {
  return {
    async list(projectId, options = {}) {
      const pipelines = await gitlab.Pipelines.all(projectId, {
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

      return pipelines.map((p) => ({
        id: p.id as number,
        status: String(p.status),
        ref: String(p.ref),
        sha: String(p.sha),
        web_url: String(p.webUrl || p.web_url || ''),
        created_at: String(p.createdAt || p.created_at || ''),
        updated_at: String(p.updatedAt || p.updated_at || ''),
      }));
    },

    async show(projectId, pipelineId) {
      const pipeline = await gitlab.Pipelines.show(projectId, pipelineId);
      const jobs = await gitlab.Jobs.all(projectId, { pipelineId });
      return { pipeline, jobs };
    },

    async getJobLog(projectId, jobId, tailLines = 100) {
      const log = await gitlab.Jobs.showLog(projectId, jobId);
      const logStr = String(log);
      const lines = logStr.split('\n');
      if (tailLines && lines.length > tailLines) {
        return lines.slice(-tailLines).join('\n');
      }
      return logStr;
    },

    async retry(projectId, pipelineId) {
      const p = await gitlab.Pipelines.retry(projectId, pipelineId);
      return {
        id: p.id as number,
        status: String(p.status),
        ref: String(p.ref),
        sha: String(p.sha),
        web_url: String(p.webUrl || ''),
        created_at: String(p.createdAt || ''),
        updated_at: String(p.updatedAt || ''),
      };
    },

    async trigger(projectId, options) {
      const p = await gitlab.Pipelines.create(projectId, options.ref, {
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
    },
  };
}
