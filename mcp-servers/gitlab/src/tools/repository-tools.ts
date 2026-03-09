/**
 * Repository Tools - 3 tools for GitLab repository operations
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '../../../shared/dist/index.js';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const getTreeTool: Tool = {
  name: 'getTree',
  description: 'Get repository file tree',
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
};

const getFileTool: Tool = {
  name: 'getFile',
  description: 'Get file content from repository',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      file_path: { type: 'string', description: 'File path' },
      ref: { type: 'string', description: 'Branch or tag name (default: main)' },
    },
    required: ['project_id', 'file_path'],
  },
};

const getBlameTool: Tool = {
  name: 'getBlame',
  description: 'Get git blame for a file',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      file_path: { type: 'string', description: 'File path' },
      ref: { type: 'string', description: 'Branch or tag name (default: main)' },
    },
    required: ['project_id', 'file_path'],
  },
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createRepositoryTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('GitLab not configured. Run: speedwave setup gitlab');
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
