/**
 * Metadata validation test — ensures every GitLab worker tool
 * has the required metadata fields: category, keywords, example.
 */

import { describe, it, expect } from 'vitest';
import { createToolDefinitions } from './index.js';

const ALL_TOOLS = createToolDefinitions(null).map((td) => td.tool);

const EXPECTED_TOOL_COUNT = 46;

describe('GitLab tool metadata', () => {
  it(`should expose exactly ${EXPECTED_TOOL_COUNT} tools`, () => {
    expect(ALL_TOOLS).toHaveLength(EXPECTED_TOOL_COUNT);
  });

  it('should have unique tool names', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  describe.each(ALL_TOOLS.map((t) => [t.name, t]))('%s', (_name, tool) => {
    it('has category (read | write | delete)', () => {
      expect(tool.category).toBeDefined();
      expect(['read', 'write', 'delete']).toContain(tool.category);
    });

    it('has annotations with readOnlyHint and destructiveHint', () => {
      expect(tool.annotations).toBeDefined();
      expect(typeof tool.annotations!.readOnlyHint).toBe('boolean');
      expect(typeof tool.annotations!.destructiveHint).toBe('boolean');
    });

    it('has non-empty keywords array', () => {
      expect(tool.keywords).toBeDefined();
      expect(Array.isArray(tool.keywords)).toBe(true);
      expect(tool.keywords!.length).toBeGreaterThan(0);
      for (const kw of tool.keywords!) {
        expect(typeof kw).toBe('string');
        expect(kw.length).toBeGreaterThan(0);
      }
    });

    it('has non-empty example string', () => {
      expect(tool.example).toBeDefined();
      expect(typeof tool.example).toBe('string');
      expect(tool.example!.length).toBeGreaterThan(0);
    });

    it('has outputSchema with success property', () => {
      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema!.type).toBe('object');
      const props = tool.outputSchema!.properties as Record<string, unknown>;
      expect(props.success).toBeDefined();
    });

    it('has inputExamples array with at least one entry', () => {
      expect(tool.inputExamples).toBeDefined();
      expect(Array.isArray(tool.inputExamples)).toBe(true);
      expect(tool.inputExamples!.length).toBeGreaterThan(0);
      for (const ex of tool.inputExamples!) {
        expect(typeof ex.description).toBe('string');
        expect(ex.description.length).toBeGreaterThan(0);
        expect(typeof ex.input).toBe('object');
      }
    });
  });
});
