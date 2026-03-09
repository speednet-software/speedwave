/**
 * GitLab: Get Job Log
 *
 * Get CI job log for debugging failed builds.
 * @param {number|string} project_id - Project ID or path
 * @param {number} job_id - Job ID
 * @param {number} [tail_lines=100] - Show only last N lines (max: 1000)
 * @returns {object} Job log output
 * @example
 * // Get job log
 * const log = await gitlab.getJobLog({
 *   project_id: "speedwave/core",
 *   job_id: 789
 * });
 *
 * // Get last 50 lines
 * const tailLog = await gitlab.getJobLog({
 *   project_id: "speedwave/core",
 *   job_id: 789,
 *   tail_lines: 50
 * });
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'getJobLog',
  category: 'read',
  description: 'Get CI job log for debugging failed builds',
  keywords: ['gitlab', 'job', 'log', 'ci', 'build', 'debug'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['number', 'string'], description: 'Project ID or path' },
      job_id: { type: 'number', description: 'Job ID' },
      tail_lines: {
        type: 'number',
        description: 'Show only last N lines (default: 100, max: 1000)',
      },
    },
    required: ['project_id', 'job_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      log: { type: 'string', description: 'Job log content (plain text)' },
      job: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
          status: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const log = await gitlab.getJobLog({ project_id: "speedwave/core", job_id: 12345, tail_lines: 50 })`,
  inputExamples: [
    {
      description: 'Minimal: get full job log',
      input: { project_id: 'my-group/my-project', job_id: 98765 },
    },
    {
      description: 'Full: get last 50 lines',
      input: { project_id: 'my-group/my-project', job_id: 98765, tail_lines: 50 },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Executes the get_job_log tool to retrieve CI job log output for debugging.
 * @param params - Tool parameters containing project_id, job_id, and optional tail_lines
 * @param params.project_id - Project ID or path
 * @param params.job_id - Job ID
 * @param params.tail_lines - Number of lines to tail from end of log
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.getJobLog - Function to get job logs
 * @returns Promise resolving to job log output or error
 */
export async function execute(
  params: { project_id: number | string; job_id: number; tail_lines?: number },
  context: { gitlab: { getJobLog: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; log?: string; error?: string }> {
  const { project_id, job_id } = params;

  if (!project_id || !job_id) {
    return {
      success: false,
      error: 'Missing required fields: project_id, job_id',
    };
  }

  try {
    const result = await context.gitlab.getJobLog(params);

    return {
      success: true,
      log: typeof result === 'string' ? result : JSON.stringify(result),
    };
  } catch (error) {
    return handleExecutionError('getJobLog', params as Record<string, unknown>, error);
  }
}
