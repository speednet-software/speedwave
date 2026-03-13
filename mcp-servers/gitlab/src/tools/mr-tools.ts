/**
 * Merge Request Tools - 7 tools for GitLab MR operations
 */

import { Tool, ToolDefinition, jsonResult, errorResult } from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { withValidation } from './validation.js';

const listMrIdsTool: Tool = {
  name: 'listMrIds',
  description: 'List merge request IIDs. Use get_mr_full for details.',
  category: 'read',
  keywords: ['gitlab', 'merge', 'request', 'mr', 'list', 'pull', 'ids'],
  example:
    'const { mrs, count } = await gitlab.listMrIds({ project_id: "speedwave/core", state: "opened" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      state: {
        type: 'string',
        enum: ['opened', 'closed', 'merged', 'all'],
        description: 'MR state',
      },
      author_username: { type: 'string', description: 'Filter by author' },
      limit: { type: 'number', description: 'Max results (default 100)' },
    },
    required: ['project_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      merge_requests: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            iid: { type: 'number', description: 'Internal ID within project' },
            title: { type: 'string' },
            state: { type: 'string', enum: ['opened', 'closed', 'merged'] },
            source_branch: { type: 'string' },
            target_branch: { type: 'string' },
            author: { type: 'object', properties: { username: { type: 'string' } } },
            web_url: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: all MRs for project',
      input: { project_id: 'my-group/my-project' },
    },
    {
      description: 'Partial: open MRs only',
      input: { project_id: 'my-group/my-project', state: 'opened' },
    },
    {
      description: 'Full: my open MRs',
      input: {
        project_id: 'my-group/my-project',
        state: 'opened',
        author_username: 'john.doe',
        limit: 50,
      },
    },
  ],
};

const getMrFullTool: Tool = {
  name: 'getMrFull',
  description: 'Get complete merge request data. No truncation.',
  category: 'read',
  keywords: ['gitlab', 'merge', 'request', 'mr', 'show', 'detail', 'full'],
  example: 'const mr = await gitlab.getMrFull({ project_id: "speedwave/core", mr_iid: 123 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'MR internal ID' },
    },
    required: ['project_id', 'mr_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      merge_request: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          iid: { type: 'number' },
          title: { type: 'string' },
          description: { type: 'string' },
          state: { type: 'string' },
          source_branch: { type: 'string' },
          target_branch: { type: 'string' },
          author: { type: 'object', properties: { username: { type: 'string' } } },
          assignees: {
            type: 'array',
            items: { type: 'object', properties: { username: { type: 'string' } } },
          },
          reviewers: {
            type: 'array',
            items: { type: 'object', properties: { username: { type: 'string' } } },
          },
          web_url: { type: 'string' },
          created_at: { type: 'string' },
          updated_at: { type: 'string' },
          changes_count: { type: 'string' },
          has_conflicts: { type: 'boolean', description: 'Whether the MR has merge conflicts' },
          merge_status: {
            type: 'string',
            description: 'Simple merge status (can_be_merged, cannot_be_merged, etc.)',
          },
          detailed_merge_status: {
            type: 'string',
            description: 'Detailed merge status (mergeable, conflict, checking, etc.)',
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Get MR details',
      input: { project_id: 'my-group/my-project', mr_iid: 42 },
    },
  ],
};

const createMergeRequestTool: Tool = {
  name: 'createMergeRequest',
  description: 'Create a new merge request',
  category: 'write',
  keywords: ['gitlab', 'merge', 'request', 'mr', 'create', 'new', 'pull'],
  example:
    'const mr = await gitlab.createMergeRequest({ project_id: "speedwave/core", source_branch: "feature/x", target_branch: "main", title: "Add feature X" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      source_branch: { type: 'string', description: 'Source branch name' },
      target_branch: { type: 'string', description: 'Target branch name' },
      title: { type: 'string', description: 'Merge request title' },
      description: { type: 'string', description: 'Merge request description' },
      labels: { type: 'string', description: 'Comma-separated labels' },
      remove_source_branch: { type: 'boolean', description: 'Remove source branch after merge' },
    },
    required: ['project_id', 'source_branch', 'target_branch', 'title'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      merge_request: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          iid: { type: 'number' },
          title: { type: 'string' },
          web_url: { type: 'string' },
          source_branch: { type: 'string' },
          target_branch: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: create MR with required fields',
      input: {
        project_id: 'my-group/my-project',
        source_branch: 'feature/user-auth',
        target_branch: 'main',
        title: 'Add user authentication',
      },
    },
    {
      description: 'Full: create MR with description',
      input: {
        project_id: 'my-group/my-project',
        source_branch: 'feature/user-auth',
        target_branch: 'develop',
        title: 'feat: Add JWT authentication',
        description:
          '## Summary\n\n- Implemented JWT token validation\n- Added refresh token endpoint\n\n## Test Plan\n\n- [x] Unit tests\n- [x] Integration tests',
      },
    },
  ],
};

const approveMergeRequestTool: Tool = {
  name: 'approveMergeRequest',
  description: 'Approve a merge request',
  category: 'write',
  keywords: ['gitlab', 'merge', 'request', 'approve', 'review', 'accept'],
  example: 'await gitlab.approveMergeRequest({ project_id: "speedwave/core", mr_iid: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
    },
    required: ['project_id', 'mr_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      approved: { type: 'boolean' },
      merge_request_iid: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: approve MR',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
    {
      description: 'Partial: approve by project path',
      input: { project_id: 'web-app', mr_iid: 456 },
    },
    {
      description: 'Full: approve by numeric ID',
      input: { project_id: 789, mr_iid: 42 },
    },
  ],
};

const mergeMergeRequestTool: Tool = {
  name: 'mergeMergeRequest',
  description: 'Merge a merge request',
  category: 'write',
  keywords: ['gitlab', 'merge', 'request', 'accept', 'complete', 'finish'],
  example:
    'await gitlab.mergeMergeRequest({ project_id: "speedwave/core", mr_iid: 42, auto_merge: true })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
      squash: { type: 'boolean', description: 'Squash commits on merge' },
      should_remove_source_branch: {
        type: 'boolean',
        description: 'Remove source branch after merge',
      },
      auto_merge: { type: 'boolean', description: 'Merge when pipeline succeeds' },
      sha: { type: 'string', description: 'Expected SHA of source branch head' },
    },
    required: ['project_id', 'mr_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      merge_request: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          iid: { type: 'number' },
          state: { type: 'string' },
          merged_at: { type: 'string' },
          merge_commit_sha: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: merge immediately',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
    {
      description: 'Partial: auto-merge when pipeline passes',
      input: { project_id: 'web-app', mr_iid: 456, auto_merge: true },
    },
    {
      description: 'Full: squash and remove branch',
      input: {
        project_id: 'backend-api',
        mr_iid: 42,
        auto_merge: true,
        squash: true,
        should_remove_source_branch: true,
      },
    },
  ],
};

const updateMergeRequestTool: Tool = {
  name: 'updateMergeRequest',
  description: 'Update an existing merge request',
  category: 'write',
  keywords: ['gitlab', 'merge', 'request', 'update', 'edit', 'modify'],
  example:
    'await gitlab.updateMergeRequest({ project_id: "speedwave/core", mr_iid: 42, title: "Updated: Add authentication flow", state_event: "close" })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
      title: { type: 'string', description: 'New title' },
      description: { type: 'string', description: 'New description' },
      target_branch: { type: 'string', description: 'New target branch' },
      state_event: { type: 'string', description: 'State event: close or reopen' },
      labels: { type: 'string', description: 'Comma-separated labels' },
    },
    required: ['project_id', 'mr_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      merge_request: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          iid: { type: 'number' },
          title: { type: 'string' },
          state: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: update MR title',
      input: {
        project_id: 'my-group/my-project',
        mr_iid: 123,
        title: 'feat: Updated authentication',
      },
    },
    {
      description: 'Partial: close MR',
      input: { project_id: 'web-app', mr_iid: 456, state_event: 'close' },
    },
    {
      description: 'Full: update all fields',
      input: {
        project_id: 'backend-api',
        mr_iid: 42,
        title: 'fix: Security patch for auth',
        description: '## Changes\\n- Fixed JWT validation\\n- Added rate limiting',
        labels: 'security,bugfix',
        target_branch: 'main',
      },
    },
  ],
};

const getMrChangesTool: Tool = {
  name: 'getMrChanges',
  description: 'Get diff/changes of a merge request',
  category: 'read',
  keywords: ['gitlab', 'merge', 'request', 'diff', 'changes', 'files'],
  example:
    'const changes = await gitlab.getMrChanges({ project_id: "speedwave/core", mr_iid: 42 })',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: ['string', 'number'], description: 'Project ID or path' },
      mr_iid: { type: 'number', description: 'Merge request IID' },
    },
    required: ['project_id', 'mr_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            old_path: { type: 'string' },
            new_path: { type: 'string' },
            new_file: { type: 'boolean' },
            renamed_file: { type: 'boolean' },
            deleted_file: { type: 'boolean' },
            diff: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Minimal: get MR changes',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
    {
      description: 'Partial: changes by path',
      input: { project_id: 'web-app', mr_iid: 456 },
    },
    {
      description: 'Full: changes by numeric ID',
      input: { project_id: 789, mr_iid: 42 },
    },
  ],
};

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createMrTools(client: GitLabClient | null): ToolDefinition[] {
  const unconfigured = async () =>
    errorResult('GitLab not configured. Run: speedwave setup gitlab');
  if (!client) {
    return [
      { tool: listMrIdsTool, handler: unconfigured },
      { tool: getMrFullTool, handler: unconfigured },
      { tool: createMergeRequestTool, handler: unconfigured },
      { tool: approveMergeRequestTool, handler: unconfigured },
      { tool: mergeMergeRequestTool, handler: unconfigured },
      { tool: updateMergeRequestTool, handler: unconfigured },
      { tool: getMrChangesTool, handler: unconfigured },
    ];
  }

  return [
    {
      tool: listMrIdsTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          state?: string;
          author_username?: string;
          limit?: number;
        };
        const result = await c.listMergeRequests(project_id, options);
        return jsonResult({
          mrs: result.map((mr: { iid: number; title: string }) => ({
            iid: mr.iid,
            title: mr.title,
          })),
          count: result.length,
        });
      }),
    },
    {
      tool: getMrFullTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid } = params as { project_id: string | number; mr_iid: number };
        const result = await c.showMergeRequest(project_id, mr_iid);
        return jsonResult(result);
      }),
    },
    {
      tool: createMergeRequestTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, ...options } = params as {
          project_id: string | number;
          source_branch: string;
          target_branch: string;
          title: string;
          description?: string;
          labels?: string;
          remove_source_branch?: boolean;
        };
        const result = await c.createMergeRequest(project_id, options);
        return jsonResult(result);
      }),
    },
    {
      tool: approveMergeRequestTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid } = params as { project_id: string | number; mr_iid: number };
        await c.approveMergeRequest(project_id, mr_iid);
        return jsonResult({ success: true, message: 'Merge request approved' });
      }),
    },
    {
      tool: mergeMergeRequestTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, ...options } = params as {
          project_id: string | number;
          mr_iid: number;
          squash?: boolean;
          should_remove_source_branch?: boolean;
          auto_merge?: boolean;
          sha?: string;
        };
        const result = await c.mergeMergeRequest(project_id, mr_iid, options);
        return jsonResult(result);
      }),
    },
    {
      tool: updateMergeRequestTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid, ...options } = params as {
          project_id: string | number;
          mr_iid: number;
          title?: string;
          description?: string;
          target_branch?: string;
          state_event?: string;
          labels?: string;
        };
        const result = await c.updateMergeRequest(project_id, mr_iid, options);
        return jsonResult(result);
      }),
    },
    {
      tool: getMrChangesTool,
      handler: withValidation(client, async (c, params) => {
        const { project_id, mr_iid } = params as { project_id: string | number; mr_iid: number };
        const result = await c.getMrChanges(project_id, mr_iid);
        return jsonResult(result);
      }),
    },
  ];
}
