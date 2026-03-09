/**
 * GitLab: Create Label
 *
 * Creates a new label in a project.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'createLabel',
  category: 'write',
  description: 'Create a new label in the project',
  keywords: ['gitlab', 'label', 'create', 'new', 'tag'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['string', 'number'],
        description: 'Project ID or path',
      },
      name: {
        type: 'string',
        description: 'Label name',
      },
      color: {
        type: 'string',
        description: 'Label color (hex format, e.g., #FF0000)',
      },
      description: {
        type: 'string',
        description: 'Label description',
      },
    },
    required: ['project_id', 'name', 'color'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      label: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
          color: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `const label = await gitlab.createLabel({ project_id: "speedwave/core", name: "urgent", color: "#FF0000" })`,
  inputExamples: [
    {
      description: 'Create label',
      input: {
        project_id: 'my-group/my-project',
        name: 'bug',
        color: '#FF0000',
      },
    },
    {
      description: 'Create label with description',
      input: {
        project_id: 'my-group/my-project',
        name: 'feature',
        color: '#00FF00',
        description: 'New feature request',
      },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Execute the createLabel tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.name - Label name
 * @param params.color - Label color in hex format
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.createLabel - Creates a new label
 * @returns Promise resolving to created label or error
 */
export async function execute(
  params: { project_id: number | string; name: string; color: string; [key: string]: unknown },
  context: { gitlab: { createLabel: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; label?: unknown; error?: string }> {
  const { project_id, name, color } = params;

  if (!project_id || !name || !color) {
    return {
      success: false,
      error: 'Missing required fields: project_id, name, color',
    };
  }

  try {
    const result = await context.gitlab.createLabel(params);
    return {
      success: true,
      label: result,
    };
  } catch (error) {
    return handleExecutionError('createLabel', params as Record<string, unknown>, error);
  }
}
