/**
 * Artifact Tools - 3 tools for GitLab CI/CD artifacts
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  READ_ONLY_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
  META_KEYS,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation, normalizeIid } from './validation.js';

const listArtifactsTool: Tool = {
  name: 'listArtifacts',
  description:
    'List artifacts from a pipeline, grouped by the job that produced them. Use getPipelineFull to resolve pipeline_id from a jobs list.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['gitlab', 'artifacts', 'pipeline', 'ci', 'build'],
  example:
    'const artifacts = await gitlab.listArtifacts({ project_id: "speedwave/core", pipeline_id: 12345 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      pipeline_id: {
        type: ['number', 'string'],
        description: 'Pipeline ID as a number or string, e.g. 12345 or "#12345"',
      },
    },
    required: ['project_id', 'pipeline_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      artifacts: {
        type: 'array',
        description: 'One entry per job in the pipeline that has artifacts',
        items: {
          type: 'object',
          properties: {
            job_id: { type: 'number' },
            job_name: { type: 'string' },
            artifacts: {
              type: 'array',
              description: "The job's raw artifacts array (file_type, size, filename, file_format)",
              items: { type: 'object' },
            },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'List pipeline artifacts',
      input: { project_id: 'my-group/my-project', pipeline_id: 98765 },
    },
  ],
};

const downloadArtifactTool: Tool = {
  name: 'downloadArtifact',
  description:
    "Get a job log as a downloadable text file (this client cannot fetch raw CI artifact zip contents, only the job log/trace). Job IDs come from getPipelineFull's jobs array.",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['gitlab', 'artifact', 'download', 'ci', 'build'],
  example:
    'const artifact = await gitlab.downloadArtifact({ project_id: "speedwave/core", job_id: 54321 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      job_id: {
        type: ['number', 'string'],
        description:
          'Job ID as a number or string, e.g. 42 or "#42" (from the jobs array returned by getPipelineFull)',
      },
    },
    required: ['project_id', 'job_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      filename: { type: 'string', description: 'Suggested filename for the job log' },
      size: { type: 'number', description: 'Size of the job log in bytes' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Download job artifact',
      input: { project_id: 'my-group/my-project', job_id: 11111 },
    },
  ],
};

const deleteArtifactsTool: Tool = {
  name: 'deleteArtifacts',
  description:
    "Delete job artifacts AND the job log (GitLab erase is irreversible and removes both). Job IDs come from getPipelineFull's jobs array.",
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['gitlab', 'artifacts', 'delete', 'remove', 'ci'],
  example: 'await gitlab.deleteArtifacts({ project_id: "speedwave/core", job_id: 54321 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      job_id: {
        type: ['number', 'string'],
        description:
          'Job ID as a number or string, e.g. 42 or "#42" (from the jobs array returned by getPipelineFull)',
      },
    },
    required: ['project_id', 'job_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Delete job artifacts',
      input: { project_id: 'my-group/my-project', job_id: 11111 },
    },
  ],
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createArtifactTools(client: GitLabClient | null): ToolDefinition[] {
  return [
    {
      tool: listArtifactsTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, pipeline_id } = params as {
          project_id: string | number;
          pipeline_id: unknown;
        };
        const iid = normalizeIid(pipeline_id, 'pipeline_id');
        if (!iid.ok) return iid.error;
        const result = await c.listArtifacts(project_id, iid.value);
        return jsonResult(result);
      }),
    },
    {
      tool: downloadArtifactTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, job_id } = params as { project_id: string | number; job_id: unknown };
        const iid = normalizeIid(job_id, 'job_id');
        if (!iid.ok) return iid.error;
        const result = await c.downloadArtifact(project_id, iid.value);
        return jsonResult({ filename: result.filename, size: result.data.length });
      }),
    },
    {
      tool: deleteArtifactsTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, job_id } = params as { project_id: string | number; job_id: unknown };
        const iid = normalizeIid(job_id, 'job_id');
        if (!iid.ok) return iid.error;
        await c.deleteArtifacts(project_id, iid.value);
        return jsonResult({ success: true, message: 'Artifacts deleted' });
      }),
    },
  ];
}
