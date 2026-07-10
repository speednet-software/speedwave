/**
 * Release Tools - 4 tools for GitLab tags and releases
 */

import {
  Tool,
  ToolDefinition,
  jsonResult,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
  META_KEYS,
} from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listTagsTool: Tool = {
  name: 'listTags',
  description:
    'List tags in a project, newest first. Use before createRelease to find a valid tag_name.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['gitlab', 'tags', 'list', 'release', 'version', 'git'],
  example: 'const { tags } = await gitlab.listTags({ project_id: "speedwave/core" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      search: { type: 'string', description: 'Filter tags by name pattern' },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['project_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      tags: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            target: { type: 'string', description: 'Commit SHA' },
            message: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'List all tags',
      input: { project_id: 'my-group/my-project' },
    },
    {
      description: 'Search tags by pattern',
      input: { project_id: 'my-group/my-project', search: 'v1.' },
    },
  ],
};

const createTagTool: Tool = {
  name: 'createTag',
  description: 'Create a new Git tag',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
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
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
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
      deleted_tag: {
        type: 'object',
        description:
          'Audit info read just before deletion, when readable. Check-then-act: the tag could ' +
          'change between this read and the delete call, so this reflects the pre-delete state, ' +
          'not necessarily the exact state at the moment of deletion.',
        properties: {
          name: { type: 'string' },
          target: { type: 'string', description: 'Commit SHA' },
          message: { type: 'string' },
        },
      },
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
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['gitlab', 'release', 'create', 'changelog', 'version', 'publish'],
  example:
    'const release = await gitlab.createRelease({ project_id: "speedwave/core", tag_name: "v1.0.0", name: "Initial Release", description: "## Changelog\\n- Feature: Authentication\\n- Feature: MCP integration" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      tag_name: {
        type: 'string',
        description:
          'Tag name (must exist — list existing tags via listTags first, or create one via createTag)',
      },
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
 * Builds the GitLab release tool definitions.
 * @param client - GitLab client instance
 */
export function createReleaseTools(client: GitLabClient | null): ToolDefinition[] {
  return [
    {
      tool: listTagsTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          search?: string;
          limit?: number;
        };
        const result = await c.listTags(project_id, options);
        return jsonResult({ success: true, tags: result });
      }),
    },
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
        const result = await c.deleteTag(project_id, tag_name);
        return jsonResult({
          success: true,
          message: `Tag '${tag_name}' deleted successfully`,
          deleted_tag: result.deleted_tag,
        });
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
