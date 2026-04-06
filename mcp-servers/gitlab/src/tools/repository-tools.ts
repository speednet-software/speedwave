/**
 * Repository Tools - 3 tools for GitLab repository operations
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

const getTreeTool: Tool = {
  name: 'getTree',
  description: 'Get repository file tree',
  keywords: ['gitlab', 'tree', 'files', 'repository', 'ls'],
  example: 'const tree = await gitlab.getTree({ project_id: "speedwave/core", path: "src" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      path: { type: 'string', description: 'Directory path (optional)' },
      ref: { type: 'string', description: 'Branch or tag name' },
      recursive: { type: 'boolean', description: 'Include subdirectories' },
      limit: { type: 'number', description: 'Max results (default 100)' },
    },
    required: ['project_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      tree: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            type: { type: 'string' },
            path: { type: 'string' },
            mode: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'List root directory',
      input: { project_id: 'my-group/my-project' },
    },
    {
      description: 'List specific path',
      input: { project_id: 'my-group/my-project', path: 'src', ref: 'develop' },
    },
  ],
};

const getFileTool: Tool = {
  name: 'getFile',
  description: 'Get file content from repository',
  keywords: ['gitlab', 'file', 'content', 'read', 'cat'],
  example:
    'const file = await gitlab.getFile({ project_id: "speedwave/core", file_path: "README.md" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      file_path: { type: 'string', description: 'File path' },
      ref: { type: 'string', description: 'Branch or tag name (default: main)' },
    },
    required: ['project_id', 'file_path'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      file: {
        type: 'object',
        properties: {
          file_name: { type: 'string' },
          file_path: { type: 'string' },
          size: { type: 'number' },
          encoding: { type: 'string' },
          content: { type: 'string' },
          ref: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Get file from default branch',
      input: { project_id: 'my-group/my-project', file_path: 'package.json' },
    },
    {
      description: 'Get file from specific branch',
      input: {
        project_id: 'my-group/my-project',
        file_path: 'src/index.ts',
        ref: 'develop',
      },
    },
  ],
};

const getBlameTool: Tool = {
  name: 'getBlame',
  description: 'Get git blame for a file',
  keywords: ['gitlab', 'blame', 'annotate', 'history', 'git'],
  example:
    'const blame = await gitlab.getBlame({ project_id: "speedwave/core", file_path: "src/index.ts" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      file_path: { type: 'string', description: 'File path' },
      ref: { type: 'string', description: 'Branch or tag name (default: main)' },
    },
    required: ['project_id', 'file_path'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      blame: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            commit: { type: 'object' },
            lines: { type: 'array' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Get blame for file',
      input: { project_id: 'my-group/my-project', file_path: 'src/main.js' },
    },
  ],
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createRepositoryTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('GitLab'));
  if (!client) {
    return [
      { tool: getTreeTool, handler: unconfigured },
      { tool: getFileTool, handler: unconfigured },
      { tool: getBlameTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: getTreeTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          path?: string;
          ref?: string;
          recursive?: boolean;
          limit?: number;
        };
        const result = await c.getTree(project_id, options);
        return jsonResult(result);
      }),
    },
    {
      tool: getFileTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, file_path, ref } = params as {
          project_id: string | number;
          file_path: string;
          ref?: string;
        };
        const result = await c.getFile(project_id, file_path, ref);
        return jsonResult(result);
      }),
    },
    {
      tool: getBlameTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, file_path, ref } = params as {
          project_id: string | number;
          file_path: string;
          ref?: string;
        };
        const result = await c.getBlame(project_id, file_path, ref);
        return jsonResult(result);
      }),
    },
  ];
}
