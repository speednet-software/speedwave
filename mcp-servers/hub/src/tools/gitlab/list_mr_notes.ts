/**
 * GitLab: List MR Notes
 *
 * Lists all notes (comments) on a merge request.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'listMrNotes',
  category: 'read',
  service: 'gitlab',
  description: 'List all notes (comments) on a merge request',
  keywords: ['gitlab', 'merge', 'request', 'notes', 'comments'],
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
    },
    required: ['project_id', 'mr_iid'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      notes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            body: { type: 'string' },
            author: { type: 'object' },
            created_at: { type: 'string' },
          },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const notes = await gitlab.listMrNotes({ project_id: "speedwave/core", mr_iid: 42 })`,
  inputExamples: [
    {
      description: 'List MR notes',
      input: { project_id: 'my-group/my-project', mr_iid: 123 },
    },
  ],
  deferLoading: true,
};

/**
 * Execute the listMrNotes tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.mr_iid - Merge request IID
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.listMrNotes - Lists merge request notes
 * @returns Promise resolving to notes list or error
 */
export async function execute(
  params: { project_id: number | string; mr_iid: number },
  context: { gitlab: { listMrNotes: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; notes?: unknown[]; error?: string }> {
  const { project_id, mr_iid } = params;

  if (!project_id || !mr_iid) {
    return {
      success: false,
      error: 'Missing required fields: project_id, mr_iid',
    };
  }

  try {
    const result = await context.gitlab.listMrNotes(params);
    return {
      success: true,
      notes: Array.isArray(result) ? result : [],
    };
  } catch (error) {
    return handleExecutionError('listMrNotes', params as Record<string, unknown>, error);
  }
}
