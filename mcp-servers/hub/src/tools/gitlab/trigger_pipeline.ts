/**
 * GitLab: Trigger Pipeline
 *
 * Triggers a new pipeline for a branch or tag with optional variables.
 */

import { ToolMetadata } from '../../hub-types.js';
import { handleExecutionError } from './_error-handler.js';

export const metadata: ToolMetadata = {
  name: 'triggerPipeline',
  category: 'write',
  description:
    'Trigger a new pipeline on a branch/tag with optional CI variables. ' +
    'Note: Some CI variables may only work on specific branches depending on project workflow rules - ' +
    'check .gitlab-ci.yml if pipeline fails or does not run expected jobs.',
  keywords: ['gitlab', 'pipeline', 'trigger', 'create', 'run', 'ci', 'release', 'variables'],
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: ['number', 'string'],
        description: "Project ID (numeric) or path (e.g., 'group/project')",
      },
      ref: { type: 'string', description: 'Branch or tag name to run pipeline on' },
      variables: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Variable name' },
            value: { type: 'string', description: 'Variable value' },
          },
          required: ['key', 'value'],
        },
        description: 'Pipeline variables (optional)',
      },
    },
    required: ['project_id', 'ref'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      pipeline: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          status: { type: 'string' },
          ref: { type: 'string' },
          web_url: { type: 'string' },
        },
      },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  example: `// Trigger pipeline with CI variable
await gitlab.triggerPipeline({
  project_id: "group/project",
  ref: "main",
  variables: [{ key: "DEPLOY_ENV", value: "staging" }]
})`,
  inputExamples: [
    {
      description: 'Minimal: trigger pipeline on branch',
      input: { project_id: 'my-group/my-project', ref: 'main' },
    },
    {
      description: 'With single CI variable',
      input: {
        project_id: 123,
        ref: 'main',
        variables: [{ key: 'DEPLOY_ENV', value: 'production' }],
      },
    },
    {
      description: 'With multiple CI variables',
      input: {
        project_id: 'backend-api',
        ref: 'develop',
        variables: [
          { key: 'DEPLOY_ENV', value: 'staging' },
          { key: 'SKIP_TESTS', value: 'false' },
        ],
      },
    },
  ],
  service: 'gitlab',
  deferLoading: true,
};

/**
 * Execute the triggerPipeline tool.
 * @param params - Tool parameters
 * @param params.project_id - Project ID or path
 * @param params.ref - Branch or tag name
 * @param context - Execution context with GitLab API access
 * @param context.gitlab - GitLab service bridge instance
 * @param context.gitlab.triggerPipeline - Triggers a pipeline
 * @returns Promise resolving to triggered pipeline or error
 */
export async function execute(
  params: { project_id: number | string; ref: string; [key: string]: unknown },
  context: { gitlab: { triggerPipeline: (p: Record<string, unknown>) => Promise<unknown> } }
): Promise<{ success: boolean; pipeline?: unknown; error?: string }> {
  const { project_id, ref } = params;

  if (!project_id || !ref) {
    return {
      success: false,
      error: 'Missing required fields: project_id, ref',
    };
  }

  try {
    const result = await context.gitlab.triggerPipeline(params);
    return {
      success: true,
      pipeline: result,
    };
  } catch (error) {
    return handleExecutionError('triggerPipeline', params as Record<string, unknown>, error);
  }
}
