/**
 * Artifact Tools - 3 tools for GitLab CI/CD artifacts
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '../../../shared/dist/index.js';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listArtifactsTool: Tool = {
  name: 'listArtifacts',
  description: 'List artifacts from a pipeline',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      pipeline_id: { type: 'number', description: 'Pipeline ID' },
    },
    required: ['project_id', 'pipeline_id'],
  },
};

const downloadArtifactTool: Tool = {
  name: 'downloadArtifact',
  description: 'Download job artifacts',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      job_id: { type: 'number', description: 'Job ID' },
    },
    required: ['project_id', 'job_id'],
  },
};

const deleteArtifactsTool: Tool = {
  name: 'deleteArtifacts',
  description: 'Delete job artifacts',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      job_id: { type: 'number', description: 'Job ID' },
    },
    required: ['project_id', 'job_id'],
  },
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createArtifactTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('GitLab not configured. Run: speedwave setup gitlab');
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
