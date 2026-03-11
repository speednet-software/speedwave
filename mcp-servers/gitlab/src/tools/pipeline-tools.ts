/**
 * Pipeline Tools - 5 tools for GitLab CI/CD pipelines
 */

import { Tool, ToolDefinition, jsonResult, textResult, errorResult } from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listPipelineIdsTool: Tool = {
  name: 'listPipelineIds',
  description: 'List pipeline IDs. Use get_pipeline_full for details.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      ref: { type: 'string', description: 'Branch/tag name' },
      status: { type: 'string', description: 'Pipeline status' },
      limit: { type: 'number', description: 'Max results (default 100)' },
    },
    required: ['project_id'],
  },
};

const getPipelineFullTool: Tool = {
  name: 'getPipelineFull',
  description: 'Get complete pipeline data. No truncation.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      pipeline_id: { type: 'number', description: 'Pipeline ID' },
    },
    required: ['project_id', 'pipeline_id'],
  },
};

const getJobLogTool: Tool = {
  name: 'getJobLog',
  description: 'Get log output of a pipeline job',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      job_id: { type: 'number', description: 'Job ID' },
      tail_lines: { type: 'number', description: 'Number of lines from end of log (default 100)' },
    },
    required: ['project_id', 'job_id'],
  },
};

const retryPipelineTool: Tool = {
  name: 'retryPipeline',
  description: 'Retry a failed pipeline',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      pipeline_id: { type: 'number', description: 'Pipeline ID' },
    },
    required: ['project_id', 'pipeline_id'],
  },
};

const triggerPipelineTool: Tool = {
  name: 'triggerPipeline',
  description: 'Trigger a new pipeline with optional variables',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      ref: { type: 'string', description: 'Branch or tag name to run pipeline on' },
      variables: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Variable name' },
            value: { type: 'string', description: 'Variable value' },
          },
          required: ['key', 'value'],
        },
        description: 'Pipeline variables',
      },
    },
    required: ['project_id', 'ref'],
  },
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createPipelineTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('GitLab not configured. Run: speedwave setup gitlab');
  if (!client) {
    return [
      { tool: listPipelineIdsTool, handler: unconfigured },
      { tool: getPipelineFullTool, handler: unconfigured },
      { tool: getJobLogTool, handler: unconfigured },
      { tool: retryPipelineTool, handler: unconfigured },
      { tool: triggerPipelineTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listPipelineIdsTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          status?: string;
          ref?: string;
          limit?: number;
        };
        const result = await c.listPipelines(project_id, options);
        return jsonResult({
          pipelines: result.map((p: { id: number; ref: string; status: string }) => ({
            id: p.id,
            ref: p.ref,
            status: p.status,
          })),
          count: result.length,
        });
      }),
    },
    {
      tool: getPipelineFullTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, pipeline_id } = params as {
          project_id: string | number;
          pipeline_id: number;
        };
        const result = await c.showPipeline(project_id, pipeline_id);
        return jsonResult(result);
      }),
    },
    {
      tool: getJobLogTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, job_id, tail_lines } = params as {
          project_id: string | number;
          job_id: number;
          tail_lines?: number;
        };
        const result = await c.getJobLog(project_id, job_id, tail_lines);
        return textResult(result);
      }),
    },
    {
      tool: retryPipelineTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, pipeline_id } = params as {
          project_id: string | number;
          pipeline_id: number;
        };
        const result = await c.retryPipeline(project_id, pipeline_id);
        return jsonResult(result);
      }),
    },
    {
      tool: triggerPipelineTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ref, variables } = params as {
          project_id: string | number;
          ref: string;
          variables?: Array<{ key: string; value: string }>;
        };
        const result = await c.triggerPipeline(project_id, { ref, variables });
        return jsonResult(result);
      }),
    },
  ];
}
