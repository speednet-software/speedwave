/**
 * Release Tools - 3 tools for GitLab tags and releases
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '../../../shared/dist/index.js';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const createTagTool: Tool = {
  name: 'createTag',
  description: 'Create a new Git tag',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      tag_name: { type: 'string', description: 'Tag name' },
      ref: { type: 'string', description: 'Branch name or commit SHA to tag' },
      message: { type: 'string', description: 'Tag message (optional)' },
    },
    required: ['project_id', 'tag_name', 'ref'],
  },
};

const deleteTagTool: Tool = {
  name: 'deleteTag',
  description: 'Delete a Git tag from the repository',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      tag_name: { type: 'string', description: 'Tag name to delete' },
    },
    required: ['project_id', 'tag_name'],
  },
};

const createReleaseTool: Tool = {
  name: 'createRelease',
  description: 'Create a new release from a tag',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      tag_name: { type: 'string', description: 'Tag name (must exist)' },
      name: { type: 'string', description: 'Release name (optional, defaults to tag name)' },
      description: { type: 'string', description: 'Release description/notes (optional)' },
    },
    required: ['project_id', 'tag_name'],
  },
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createReleaseTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('GitLab not configured. Run: speedwave setup gitlab');
  if (!client) {
    return [
      { tool: createTagTool, handler: unconfigured },
      { tool: deleteTagTool, handler: unconfigured },
      { tool: createReleaseTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: createTagTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          tag_name: string;
          ref: string;
          message?: string;
        };
        const result = await c.createTag(project_id, options);
        return jsonResult(result);
      }),
    },
    {
      tool: deleteTagTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, tag_name } = params as {
          project_id: string | number;
          tag_name: string;
        };
        await c.deleteTag(project_id, tag_name);
        return jsonResult({ success: true, message: `Tag '${tag_name}' deleted successfully` });
      }),
    },
    {
      tool: createReleaseTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          tag_name: string;
          name?: string;
          description?: string;
        };
        const result = await c.createRelease(project_id, options);
        return jsonResult(result);
      }),
    },
  ];
}
