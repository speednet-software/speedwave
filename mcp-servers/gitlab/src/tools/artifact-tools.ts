/**
 * Artifact Tools - 3 tools for GitLab CI/CD artifacts
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listArtifactsTool: Tool = {
  name: 'listArtifacts',
  description: 'List artifacts from a pipeline',
  category: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  keywords: ['gitlab', 'artifacts', 'pipeline', 'ci', 'build'],
  example:
    'const artifacts = await gitlab.listArtifacts({ project_id: "speedwave/core", pipeline_id: 12345 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      pipeline_id: { type: 'number', description: 'Pipeline ID' },
    },
    required: ['project_id', 'pipeline_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      artifacts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file_type: { type: 'string' },
            size: { type: 'number' },
            filename: { type: 'string' },
            file_format: { type: 'string' },
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
  description: 'Download job artifacts',
  category: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  keywords: ['gitlab', 'artifact', 'download', 'ci', 'build'],
  example:
    'const artifact = await gitlab.downloadArtifact({ project_id: "speedwave/core", job_id: 54321 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      job_id: { type: 'number', description: 'Job ID' },
    },
    required: ['project_id', 'job_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      artifact: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          size: { type: 'number' },
        },
      },
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
  description: 'Delete job artifacts',
  category: 'delete',
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  keywords: ['gitlab', 'artifacts', 'delete', 'remove', 'ci'],
  example: 'await gitlab.deleteArtifacts({ project_id: "speedwave/core", job_id: 54321 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      job_id: { type: 'number', description: 'Job ID' },
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
  const unconfigured = async () => errorResult(notConfiguredMessage('GitLab'));
  if (!client) {
    return [
      { tool: listArtifactsTool, handler: unconfigured },
      { tool: downloadArtifactTool, handler: unconfigured },
      { tool: deleteArtifactsTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listArtifactsTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, pipeline_id } = params as {
          project_id: string | number;
          pipeline_id: number;
        };
        const result = await c.listArtifacts(project_id, pipeline_id);
        return jsonResult(result);
      }),
    },
    {
      tool: downloadArtifactTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, job_id } = params as { project_id: string | number; job_id: number };
        const result = await c.downloadArtifact(project_id, job_id);
        return jsonResult({ filename: result.filename, size: result.data.length });
      }),
    },
    {
      tool: deleteArtifactsTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, job_id } = params as { project_id: string | number; job_id: number };
        await c.deleteArtifacts(project_id, job_id);
        return jsonResult({ success: true, message: 'Artifacts deleted' });
      }),
    },
  ];
}
