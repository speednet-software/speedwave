import { describe, it, expect } from 'vitest';
import type { ToolHandler } from '@speedwave/mcp-shared';
import {
  EXECUTE_CODE_TOOL,
  MAX_META_TOOL_DESCRIPTION_LENGTH,
  SEARCH_TOOLS_TOOL,
  metaToolRegistrations,
} from './meta-tools.js';

const CLAUDE_CODE_DEFAULT_DESCRIPTION_LENGTH = 2048;

const handleSearchTools: ToolHandler = async () => ({ content: [] });
const handleExecuteCode: ToolHandler = async () => ({ content: [] });
const registered = metaToolRegistrations({ handleSearchTools, handleExecuteCode });

describe('metaToolRegistrations', () => {
  it('registers each of the two meta-tools with its own handler', () => {
    expect(registered).toEqual([
      { tool: SEARCH_TOOLS_TOOL, handler: handleSearchTools },
      { tool: EXECUTE_CODE_TOOL, handler: handleExecuteCode },
    ]);
    expect(SEARCH_TOOLS_TOOL.name).toBe('search_tools');
    expect(EXECUTE_CODE_TOOL.name).toBe('execute_code');
  });

  for (const { tool } of registered) {
    it(`${tool.name} has a description that fits MAX_META_TOOL_DESCRIPTION_LENGTH`, () => {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeLessThanOrEqual(MAX_META_TOOL_DESCRIPTION_LENGTH);
    });
  }

  it("execute_code needs more than Claude Code's default description length", () => {
    expect(EXECUTE_CODE_TOOL.description.length).toBeGreaterThan(
      CLAUDE_CODE_DEFAULT_DESCRIPTION_LENGTH
    );
  });
});
