/**
 * Metadata Tests - Validates that all SharePoint tools have required metadata fields
 */

import { describe, it, expect } from 'vitest';
import { META_KEYS } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './index.js';

describe('SharePoint tool metadata', () => {
  const toolDefs = createToolDefinitions(null);
  const tools = toolDefs.map((td) => td.tool);

  it('should have at least one tool registered', () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  for (const tool of tools) {
    describe(`tool: ${tool.name}`, () => {
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

      it('should have _meta with the prefixed defer-loading key', () => {
        expect(tool._meta, `${tool.name} missing _meta`).toBeDefined();
        expect(
          typeof (tool._meta as Record<string, unknown>)[META_KEYS.DEFER_LOADING],
          `${tool.name} missing ${META_KEYS.DEFER_LOADING}`
        ).toBe('boolean');
      });

      it('should not use the legacy unprefixed deferLoading key', () => {
        expect(
          (tool._meta as Record<string, unknown> | undefined)?.deferLoading,
          `${tool.name} still uses legacy deferLoading`
        ).toBeUndefined();
      });
    });
  }

  it('listItems declares user-scoped identity metadata pointing at getCurrentUser', () => {
    const listItems = tools.find((t) => t.name === 'listItems')!;
    const meta = listItems._meta as Record<string, unknown>;
    expect(meta[META_KEYS.USER_SCOPED]).toBe(true);
    expect(meta[META_KEYS.CURRENT_USER_TOOL]).toBe('getCurrentUser');
  });

  it('no non-user-scoped tool declares USER_SCOPED metadata', () => {
    const userScopedNames = new Set(['listItems']);
    for (const tool of tools) {
      if (userScopedNames.has(tool.name)) continue;
      const meta = tool._meta as Record<string, unknown> | undefined;
      expect(meta?.[META_KEYS.USER_SCOPED], `${tool.name} unexpectedly user-scoped`).toBeFalsy();
    }
  });
});
