/**
 * GitLab: Create MR Discussion
 *
 * Creates a new discussion thread on a merge request.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'createMrDiscussion',
  category: 'write',
  service: 'gitlab',
  description: 'Start a new discussion thread on a merge request',
  keywords: ['gitlab', 'merge', 'request', 'discussion', 'thread'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      mr_iid: {
        type: 'number',
        description: 'Merge request IID',
      },
      body: {
        type: 'string',
        description: 'Discussion text (Markdown supported)',
      },
    },
    required: ['project_id', 'mr_iid', 'body'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      discussion: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          notes: { type: 'array' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await gitlab.createMrDiscussion({ project_id: "speedwave/core", mr_iid: 42, body: "What about error handling?" })`,
  inputExamples: [
    {
      description: 'Start discussion',
      input: {
        project_id: 'my-group/my-project',
        mr_iid: 123,
        body: 'Can we refactor this?',
      },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the createMrDiscussion tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.mr_iid - Merge request IID
 * @param params.body - Discussion text
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.createMrDiscussion - Creates a merge request discussion
 * @returns Promise resolving to created discussion or error
 */
export async function execute(
  params: { project_id: number | string; mr_iid: number; body: string },
  context: { gitlab: { createMrDiscussion: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; discussion?: unknown; error?: string }> {
  const { project_id, mr_iid, body } = params;

  if (!project_id || !mr_iid || !body) {
    return {
      success: false,
      error: 'Missing required fields: project_id, mr_iid, body',
    };
  }

  try {
    const result = await context.gitlab.createMrDiscussion(params);
    return {
      success: true,
      discussion: result,
    };
  } catch (error) {
    return handleExecutionError('createMrDiscussion', params as Record<string, unknown>, error);
  }
}
