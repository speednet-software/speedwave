import { describe, it, expect } from 'vitest';
import { MAX_META_TOOL_DESCRIPTION_LENGTH } from '@speedwave/mcp-shared';
import { META_TOOLS } from './meta-tools.js';

const CLAUDE_CODE_DEFAULT_DESCRIPTION_LENGTH = 2048;

describe('META_TOOLS', () => {
  it('are the two tools the hub registers, in registration order', () => {
    expect(META_TOOLS.map((tool) => tool.name)).toEqual(['search_tools', 'execute_code']);
  });

  for (const tool of META_TOOLS) {
    it(`${tool.name} has a description that fits MAX_META_TOOL_DESCRIPTION_LENGTH`, () => {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeLessThanOrEqual(MAX_META_TOOL_DESCRIPTION_LENGTH);
    });
  }

  it("execute_code needs more than Claude Code's default description length", () => {
    const executeCode = META_TOOLS.find((tool) => tool.name === 'execute_code');
    expect(executeCode?.description.length).toBeGreaterThan(CLAUDE_CODE_DEFAULT_DESCRIPTION_LENGTH);
  });

  it('keeps the parts of execute_code that sit past the default cut', () => {
    const executeCode = META_TOOLS.find((tool) => tool.name === 'execute_code');
    const tail = executeCode?.description.slice(CLAUDE_CODE_DEFAULT_DESCRIPTION_LENGTH) ?? '';
    expect(tail).toContain('paginate(fetcher, config)');
    expect(tail).toContain('camelCased into its global');
    expect(tail).toContain('Cross-service workflow');
  });
});
