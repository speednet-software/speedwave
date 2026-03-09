/**
 * GitLab Artifacts Domain - Handles job artifacts operations including
 * listing, downloading, and deletion
 * @module domains/artifacts
 */

import { Gitlab } from '@gitbeaker/rest';
import type { GitLabJob } from '../types.js';

/**
 * Client interface for GitLab CI/CD artifacts operations.
 * Provides methods to manage pipeline job artifacts.
 * @interface ArtifactsClient
 */
export interface ArtifactsClient {
  /**
   * Lists all jobs with artifacts from a specific pipeline.
   * @param {string | number} projectId - Project ID or path
   * @param {number} pipelineId - Pipeline ID
   * @returns {Promise<GitLabJob[]>} Array of jobs that have artifacts
   */
  listJobsWithArtifacts(projectId: string | number, pipelineId: number): Promise<GitLabJob[]>;

  /**
   * Downloads job artifacts archive as a Buffer.
   * @param {string | number} projectId - Project ID or path
   * @param {number} jobId - Job ID
   * @returns {Promise<Buffer>} Binary content of artifacts archive (typically ZIP)
   */
  download(projectId: string | number, jobId: number): Promise<Buffer>;

  /**
   * Deletes artifacts for a specific job.
   * @param {string | number} projectId - Project ID or path
   * @param {number} jobId - Job ID
   * @returns {Promise<void>}
   */
  delete(projectId: string | number, jobId: number): Promise<void>;
}

/**
 * Creates an artifacts client instance with the given GitLab SDK instance.
 * @param {InstanceType<typeof Gitlab>} gitlab - GitBeaker SDK instance
 * @returns {ArtifactsClient} Configured artifacts client
 */
export function createArtifactsClient(gitlab: InstanceType<typeof Gitlab>): ArtifactsClient {
  return {
    async listJobsWithArtifacts(projectId, pipelineId) {
      const jobs = await gitlab.Jobs.all(projectId, { pipelineId });

      // Filter jobs that have artifacts and map them
      const jobsWithArtifacts: GitLabJob[] = [];

      for (const j of jobs) {
        // Cast to Record to handle both camelCase and snake_case API responses
        const jobRecord = j as unknown as Record<string, unknown>;
        // Check if job has artifacts (artifacts_file field exists)
        if (j.artifactsFile || jobRecord['artifacts_file']) {
          const artifactsFile = (j.artifactsFile || jobRecord['artifacts_file']) as
            | Record<string, unknown>
            | undefined;

          jobsWithArtifacts.push({
            id: Number(j.id),
            name: String(j.name),
            status: String(j.status),
            stage: String(j.stage),
            artifacts: [
              {
                file_type: 'archive',
                size: Number(artifactsFile?.size || 0),
                filename: String(artifactsFile?.filename || 'artifacts.zip'),
                file_format: undefined,
              },
            ],
            web_url: String(j.webUrl || jobRecord['web_url'] || ''),
          });
        }
      }

      return jobsWithArtifacts;
    },

    async download(projectId, jobId) {
      const artifact = await gitlab.JobArtifacts.downloadArchive(projectId, { jobId });
      // GitBeaker returns Blob, convert to Buffer
      if (artifact instanceof Blob) {
        const arrayBuffer = await artifact.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }
      return artifact as unknown as Buffer;
    },

    async delete(projectId, jobId) {
      await gitlab.JobArtifacts.remove(projectId, { jobId });
    },
  };
}
