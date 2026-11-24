/** Shared Redmine tool-handler wrappers: error formatting and target-project resolution. */

import { errorResult, teachingErrorResult, type ToolsCallResult } from '@speedwave/mcp-shared';
import { RedmineClient, type ErrorContext } from '../client.js';
import { TOOL_NAMES } from '../tool-names.js';

/**
 * Run a handler against the target project.
 * @param client - Redmine client.
 * @param projectId - The caller's project_id.
 * @param fn - Handler body.
 * @param missingProjectStep - Next step taught when no project is available.
 */
export async function withTargetProject(
  client: RedmineClient,
  projectId: string | number | undefined,
  fn: (target: string | number) => Promise<ToolsCallResult>,
  missingProjectStep = 'No default project is configured, so pass project_id explicitly.'
): Promise<ToolsCallResult> {
  const target = projectId || client.getProjectScope();
  if (!target) {
    return teachingErrorResult({
      paramName: 'project_id',
      received: projectId,
      correctValueTool: TOOL_NAMES.LIST_PROJECT_IDS,
      nextStep: missingProjectStep,
    });
  }
  return withRedmineErrors({ project_id: target }, () => fn(target));
}

/**
 * Run a Redmine tool handler body, converting a thrown error into a formatted errorResult; `context` surfaces the attempted resource identifier(s).
 * @param context - Attempted resource identifier(s) surfaced in the error message.
 * @param fn - Handler body; its resolved value is returned as-is on success.
 */
export async function withRedmineErrors(
  context: ErrorContext | undefined,
  fn: () => Promise<ToolsCallResult>
): Promise<ToolsCallResult> {
  try {
    return await fn();
  } catch (error) {
    return errorResult(RedmineClient.formatError(error, context));
  }
}
