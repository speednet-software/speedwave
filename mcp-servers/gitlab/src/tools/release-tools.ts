/**
 * Release Tools - 3 tools for GitLab tags and releases
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

const createTagTool: Tool = {
  name: 'createTag',
  description: 'Create a new Git tag',
  category: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  keywords: ['gitlab', 'tag', 'create', 'release', 'version', 'git'],
  example:
    'const tag = await gitlab.createTag({ project_id: "speedwave/core", tag_name: "v1.0.0", ref: "main", message: "Release v1.0.0 - Initial stable release" })',
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
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      tag: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          message: { type: 'string' },
          target: { type: 'string', description: 'Commit SHA' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: lightweight tag from main',
      input: { project_id: 'my-group/my-project', tag_name: 'v1.0.0', ref: 'main' },
    },
    {
      description: 'Partial: tag from specific branch',
      input: { project_id: 'web-app', tag_name: 'v2.1.0', ref: 'develop' },
    },
    {
      description: 'Full: annotated tag with message',
      input: {
        project_id: 'backend-api',
        tag_name: 'v1.5.0',
        ref: 'feature/user-auth',
        message: 'Release v1.5.0 - New authentication system',
      },
    },
  ],
};

const deleteTagTool: Tool = {
  name: 'deleteTag',
  description: 'Delete a Git tag from the repository',
  category: 'delete',
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  keywords: ['gitlab', 'tag', 'delete', 'remove', 'git', 'version', 'release'],
  example: 'await gitlab.deleteTag({ project_id: "speedwave/core", tag_name: "v1.0.0" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      tag_name: { type: 'string', description: 'Tag name to delete' },
    },
    required: ['project_id', 'tag_name'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      message: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Delete tag by project path',
      input: { project_id: 'my-group/my-project', tag_name: 'v1.0.0' },
    },
    {
      description: 'Delete tag by project ID',
      input: { project_id: 123, tag_name: 'v0.0.1-test' },
    },
  ],
};

const createReleaseTool: Tool = {
  name: 'createRelease',
  description: 'Create a new release from a tag',
  category: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  keywords: ['gitlab', 'release', 'create', 'changelog', 'version', 'publish'],
  example:
    'const release = await gitlab.createRelease({ project_id: "speedwave/core", tag_name: "v1.0.0", name: "Initial Release", description: "## Changelog\\n- Feature: Authentication\\n- Feature: MCP integration" })',
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
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      release: {
        type: 'object',
        properties: {
          tag_name: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          created_at: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: create release with tag only',
      input: { project_id: 'my-group/my-project', tag_name: 'v1.0.0' },
    },
    {
      description: 'Partial: release with custom name',
      input: { project_id: 'web-app', tag_name: 'v2.1.3', name: 'Security Update v2.1.3' },
    },
    {
      description: 'Full: release with changelog',
      input: {
        project_id: 'backend-api',
        tag_name: 'v1.5.0',
        name: 'Release v1.5.0',
        description:
          '## Features\\n- New authentication flow\\n- API rate limiting\\n\\n## Bug Fixes\\n- Fixed memory leak in worker process',
      },
    },
  ],
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createReleaseTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () => errorResult(notConfiguredMessage('GitLab'));
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
