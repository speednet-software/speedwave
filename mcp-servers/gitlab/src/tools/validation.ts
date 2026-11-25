/**
 * Validation helpers for GitLab tool parameters; delegates to {@link withClientValidation}.
 */

import {
  withClientValidation,
  describeError,
  ts,
  teachingErrorResult,
  normalizeNumericIdParams,
  type ToolsCallResult,
} from '@speedwave/mcp-shared';
import { GitLabClient, isTeachingError } from '../client.js';

/** Param names that carry a GitLab IID/ID accepted as a number or a '#'/'!'-prefixed string. */
const NUMERIC_ID_PARAMS = [
  'mr_iid',
  'issue_iid',
  'pipeline_id',
  'job_id',
  'note_id',
  'draft_note_id',
] as const;

const DISCUSSION_ID = /^[0-9A-Za-z]+$/;

/**
 * Wrap a tool handler with client-presence, IID/ID forgiveness, and error handling.
 * @param client - GitLab client instance (null when the service is not configured).
 * @param handler - Tool handler function.
 */
export function withValidation<T>(
  client: GitLabClient | null,
  handler: (client: GitLabClient, params: T) => Promise<ToolsCallResult>
): (params: T) => Promise<ToolsCallResult> {
  return withClientValidation(
    client,
    (c, params: T) => {
      const raw = params as Record<string, unknown>;
      if (!raw || typeof raw !== 'object') {
        return handler(c, raw as T);
      }
      const normalized = normalizeNumericIdParams(raw, NUMERIC_ID_PARAMS, {
        prefixes: ['#', '!'],
      });
      if (!normalized.ok) {
        return Promise.resolve(teachingErrorResult(normalized.error));
      }
      const discussionId = normalized.value.discussion_id;
      if (
        discussionId !== undefined &&
        !(typeof discussionId === 'string' && DISCUSSION_ID.test(discussionId))
      ) {
        return Promise.resolve(
          teachingErrorResult({
            paramName: 'discussion_id',
            received: discussionId,
            nextStep: 'Pass the discussion id from listMrDiscussions: letters and digits only.',
          })
        );
      }
      return handler(c, normalized.value as T);
    },
    {
      serviceName: 'GitLab',
      formatError: (error) => GitLabClient.formatError(error),
      onUnexpectedError: (error) => {
        const name = error instanceof Error ? error.name : '';
        if (!name.startsWith('Gitbeaker') && !isTeachingError(error)) {
          console.error(
            `${ts()} Unexpected (non-GitBeaker) error in GitLab tool handler: ${describeError(error)}`
          );
        }
      },
    }
  );
}
