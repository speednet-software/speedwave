import { expect } from 'vitest';
import type { Tool, ToolsCallResult } from '@speedwave/mcp-shared';

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
