/**
 * GitLab: Create MR Note
 *
 * Creates a new note (comment) on a merge request.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'createMrNote',
  category: 'write',
  service: 'gitlab',
  description: 'Add a comment to a merge request',
  keywords: ['gitlab', 'merge', 'request', 'comment', 'note'],
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
        description: 'Comment text (Markdown supported)',
      },
    },
    required: ['project_id', 'mr_iid', 'body'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      note: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          body: { type: 'string' },
          author: { type: 'object' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `await gitlab.createMrNote({ project_id: "speedwave/core", mr_iid: 42, body: "LGTM!" })`,
  inputExamples: [
    {
      description: 'Add comment to MR',
      input: {
        project_id: 'my-group/my-project',
        mr_iid: 123,
        body: 'Looks good!',
      },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the createMrNote tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.mr_iid - Merge request IID
 * @param params.body - Comment text
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.createMrNote - Creates a merge request note
 * @returns Promise resolving to created note or error
 */
export async function execute(
  params: { project_id: number | string; mr_iid: number; body: string },
  context: { gitlab: { createMrNote: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; note?: unknown; error?: string }> {
  const { project_id, mr_iid, body } = params;

  if (!project_id || !mr_iid || !body) {
    return {
      success: false,
      error: 'Missing required fields: project_id, mr_iid, body',
    };
  }

  try {
    const result = await context.gitlab.createMrNote(params);
    return {
      success: true,
      note: result,
    };
  } catch (error) {
    return handleExecutionError('createMrNote', params as Record<string, unknown>, error);
  }
}
