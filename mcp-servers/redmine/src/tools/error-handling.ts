/** Shared tool-handler error wrapping: run a Redmine operation and format any thrown error via RedmineClient.formatError with structured context. */

import { errorResult, teachingErrorResult, type ToolsCallResult } from '@speedwave/mcp-shared';
import { RedmineClient, type ErrorContext } from '../client.js';
import { TOOL_NAMES } from '../tool-names.js';

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

/**
 * Run a handler body against the project a tool call targets: `projectId`, else the configured project; a teaching error when neither exists.
 * @param client - Redmine client holding the configured project scope.
 * @param projectId - The caller's project_id; an empty value counts as omitted.
 * @param fn - Handler body; receives the project to act on.
 */
export async function withTargetProject(
  client: RedmineClient,
  projectId: string | number | undefined,
  fn: (target: string | number) => Promise<ToolsCallResult>
): Promise<ToolsCallResult> {
  const target = projectId || client.getProjectScope();
  if (!target) {
    return teachingErrorResult({
      paramName: 'project_id',
      received: projectId,
      correctValueTool: TOOL_NAMES.LIST_PROJECT_IDS,
      nextStep: 'No default project is configured, so pass project_id explicitly.',
    });
  }
  return withRedmineErrors({ project_id: target }, () => fn(target));
}
