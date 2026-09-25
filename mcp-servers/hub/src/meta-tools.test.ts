import { describe, it, expect } from 'vitest';
import {
  EXECUTE_CODE_TOOL,
  MAX_META_TOOL_DESCRIPTION_LENGTH,
  META_TOOLS,
  SEARCH_TOOLS_TOOL,
} from './meta-tools.js';

const CLAUDE_CODE_DEFAULT_DESCRIPTION_LENGTH = 2048;

describe('META_TOOLS', () => {
  it('are the two tools the hub registers, each under its own name', () => {
    expect(META_TOOLS).toEqual([SEARCH_TOOLS_TOOL, EXECUTE_CODE_TOOL]);
    expect(SEARCH_TOOLS_TOOL.name).toBe('search_tools');
    expect(EXECUTE_CODE_TOOL.name).toBe('execute_code');
  });

  for (const tool of META_TOOLS) {
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
