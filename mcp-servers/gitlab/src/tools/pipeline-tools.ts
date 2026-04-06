/**
 * Pipeline Tools - 5 tools for GitLab CI/CD pipelines
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  textResult,
  errorResult,
  notConfiguredMessage,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listPipelineIdsTool: Tool = {
  name: 'listPipelineIds',
  description: 'List pipeline IDs. Use get_pipeline_full for details.',
  keywords: ['gitlab', 'pipeline', 'ci', 'cd', 'list', 'build', 'ids'],
  example:
    'const { pipelines, count } = await gitlab.listPipelineIds({ project_id: "speedwave/core", status: "failed" })',
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
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      pipelines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            status: {
              type: 'string',
              enum: ['running', 'pending', 'success', 'failed', 'canceled'],
            },
            ref: { type: 'string', description: 'Branch or tag name' },
            sha: { type: 'string', description: 'Commit SHA' },
            web_url: { type: 'string' },
            created_at: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: recent pipelines',
      input: { project_id: 'my-group/my-project' },
    },
    {
      description: 'Partial: failed pipelines',
      input: { project_id: 'my-group/my-project', status: 'failed' },
    },
    {
      description: 'Full: branch pipelines',
      input: { project_id: 'my-group/my-project', status: 'success', ref: 'main', limit: 20 },
    },
  ],
};

const getPipelineFullTool: Tool = {
  name: 'getPipelineFull',
  description: 'Get complete pipeline data. No truncation.',
  keywords: ['gitlab', 'pipeline', 'ci', 'details', 'jobs', 'status', 'full'],
  example:
    'const pipeline = await gitlab.getPipelineFull({ project_id: "speedwave/core", pipeline_id: 123456 })',
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
      pipeline: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          status: { type: 'string' },
          ref: { type: 'string' },
          sha: { type: 'string' },
          web_url: { type: 'string' },
          created_at: { type: 'string' },
          updated_at: { type: 'string' },
          duration: { type: 'number', description: 'Duration in seconds' },
        },
      },
      jobs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            name: { type: 'string' },
            stage: { type: 'string' },
            status: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: get pipeline details',
      input: { project_id: 'my-group/my-project', pipeline_id: 98765 },
    },
    {
      description: 'Partial: pipeline by path',
      input: { project_id: 'web-app', pipeline_id: 11111 },
    },
    {
      description: 'Full: pipeline by numeric ID',
      input: { project_id: 789, pipeline_id: 54321 },
    },
  ],
};

const getJobLogTool: Tool = {
  name: 'getJobLog',
  description: 'Get log output of a pipeline job',
  keywords: ['gitlab', 'job', 'log', 'ci', 'build', 'debug'],
  example:
    'const log = await gitlab.getJobLog({ project_id: "speedwave/core", job_id: 12345, tail_lines: 50 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      job_id: { type: 'number', description: 'Job ID' },
      tail_lines: { type: 'number', description: 'Number of lines from end of log (default 100)' },
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
};

const retryPipelineTool: Tool = {
  name: 'retryPipeline',
  description: 'Retry a failed pipeline',
  keywords: ['gitlab', 'pipeline', 'retry', 'rerun', 'ci', 'build'],
  example: 'await gitlab.retryPipeline({ project_id: "speedwave/core", pipeline_id: 123456 })',
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
      pipeline: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          status: { type: 'string' },
          web_url: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: retry failed pipeline',
      input: { project_id: 'my-group/my-project', pipeline_id: 98765 },
    },
    {
      description: 'Partial: retry by path',
      input: { project_id: 'web-app', pipeline_id: 11111 },
    },
    {
      description: 'Full: retry by numeric ID',
      input: { project_id: 789, pipeline_id: 54321 },
    },
  ],
};

const triggerPipelineTool: Tool = {
  name: 'triggerPipeline',
  description: 'Trigger a new pipeline with optional variables',
  keywords: ['gitlab', 'pipeline', 'trigger', 'create', 'run', 'ci', 'release', 'variables'],
  example: `// Trigger pipeline with CI variable
await gitlab.triggerPipeline({
  project_id: "group/project",
  ref: "main",
  variables: [{ key: "DEPLOY_ENV", value: "staging" }]
})`,
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
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      pipeline: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          status: { type: 'string' },
          ref: { type: 'string' },
          web_url: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: trigger pipeline on branch',
      input: { project_id: 'my-group/my-project', ref: 'main' },
    },
    {
      description: 'With single CI variable',
      input: {
        project_id: 123,
        ref: 'main',
        variables: [{ key: 'DEPLOY_ENV', value: 'production' }],
      },
    },
    {
      description: 'With multiple CI variables',
      input: {
        project_id: 'backend-api',
        ref: 'develop',
        variables: [
          { key: 'DEPLOY_ENV', value: 'staging' },
          { key: 'SKIP_TESTS', value: 'false' },
        ],
      },
    },
  ],
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createPipelineTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('GitLab'));
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
