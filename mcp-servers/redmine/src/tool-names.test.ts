import { describe, it, expect } from 'vitest';
import { TOOL_NAMES } from './tool-names.js';
import { createToolDefinitions } from './tools/index.js';

describe('TOOL_NAMES', () => {
  const registeredNames = new Set(createToolDefinitions(null).map((td) => td.tool.name));

  it('every referenced tool name resolves to a registered tool', () => {
    for (const [key, name] of Object.entries(TOOL_NAMES)) {
      expect(registeredNames.has(name), `${key} ('${name}') is not a registered tool`).toBe(true);
    }
  });

  it('has no duplicate values', () => {
    const values = Object.values(TOOL_NAMES);
    expect(new Set(values).size).toBe(values.length);
  });
});
