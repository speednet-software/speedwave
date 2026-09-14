/**
 * Shared assertions for GitLab tool results: the two teaching-error shapes
 * {@link GitLabClient.formatError} produces most often, and outputSchema alignment.
 * @module test-helpers
 */

import { expect } from 'vitest';
import type { Tool, ToolsCallResult } from '@speedwave/mcp-shared';

/** Minimal JSON Schema node shape for navigating a tool's outputSchema in tests. */
export type SchemaNode = {
  type: string;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
};

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

/**
 * Parses a JSON tool result and asserts every emitted top-level key is declared in `tool.outputSchema`.
 * @param tool - Tool whose outputSchema is the result contract.
 * @param result - Successful tool call result carrying a JSON text payload.
 * @returns The parsed payload for further assertions.
 */
export function expectEmittedKeysDeclared(
  tool: Tool,
  result: ToolsCallResult
): Record<string, unknown> {
  expect(result.isError).toBeUndefined();
  const text = (result.content[0] as { text: string }).text;
  const emitted = JSON.parse(text) as Record<string, unknown>;
  const declared = Object.keys(tool.outputSchema!.properties as Record<string, unknown>);
  expect(declared).toEqual(expect.arrayContaining(Object.keys(emitted)));
  return emitted;
}
