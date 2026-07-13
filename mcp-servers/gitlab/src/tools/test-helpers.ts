/**
 * Shared assertions for the two teaching-error shapes {@link GitLabClient.formatError} produces most often.
 * @module test-helpers
 */

import { expect } from 'vitest';
import type { ToolsCallResult } from '@speedwave/mcp-shared';

/**
 * Asserts `result` is the canonical GitLab "resource not found" teaching error.
 * @param result - Tool call result to assert on.
 */
export function expectNotFoundTeachingError(result: ToolsCallResult): void {
  expect(result.isError).toBe(true);
  const text = (result.content[0] as { text: string }).text;
  expect(text).toContain('Resource not found in GitLab.');
  expect(text).toContain('list valid values with the corresponding list* tool first');
}

/**
 * Asserts `result` is the canonical GitLab "permission denied" teaching error.
 * @param result - Tool call result to assert on.
 */
export function expectPermissionTeachingError(result: ToolsCallResult): void {
  expect(result.isError).toBe(true);
  const text = (result.content[0] as { text: string }).text;
  expect(text).toContain('Permission denied performing this GitLab operation.');
  expect(text).toContain('required scope (api or write_repository)');
}
