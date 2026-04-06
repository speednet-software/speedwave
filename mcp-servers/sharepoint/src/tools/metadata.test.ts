/**
 * Metadata Tests - Validates that all SharePoint tools have required metadata fields
 */

import { describe, it, expect } from 'vitest';
import { createToolDefinitions } from './index.js';

describe('SharePoint tool metadata', () => {
  const toolDefs = createToolDefinitions(null);
  const tools = toolDefs.map((td) => td.tool);

  it('should have at least one tool registered', () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  for (const tool of tools) {
    describe(`tool: ${tool.name}`, () => {
      it('should have category defined', () => {
        expect(tool.category).toBeDefined();
        expect(['read', 'write', 'delete']).toContain(tool.category);
      });

      it('should have annotations with readOnlyHint and destructiveHint', () => {
        expect(tool.annotations).toBeDefined();
        expect(typeof tool.annotations!.readOnlyHint).toBe('boolean');
        expect(typeof tool.annotations!.destructiveHint).toBe('boolean');
      });

      it('should have keywords with at least 1 entry', () => {
        expect(tool.keywords).toBeDefined();
        expect(Array.isArray(tool.keywords)).toBe(true);
        expect(tool.keywords!.length).toBeGreaterThanOrEqual(1);
        for (const kw of tool.keywords!) {
          expect(typeof kw).toBe('string');
          expect(kw.length).toBeGreaterThan(0);
        }
      });

      it('should have example as a non-empty string', () => {
        expect(tool.example).toBeDefined();
        expect(typeof tool.example).toBe('string');
        expect(tool.example!.trim().length).toBeGreaterThan(0);
      });
    });
  }
});
