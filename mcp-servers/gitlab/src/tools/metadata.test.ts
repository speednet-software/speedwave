/**
 * Metadata validation test — ensures every GitLab worker tool
 * has the required metadata fields: annotations, keywords, example.
 */

import { describe, it, expect } from 'vitest';
import { META_KEYS } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './index.js';

const ALL_TOOLS = createToolDefinitions(null).map((td) => td.tool);

const EXPECTED_TOOL_COUNT = 48;

describe('GitLab tool metadata', () => {
  it(`should expose exactly ${EXPECTED_TOOL_COUNT} tools`, () => {
    expect(ALL_TOOLS).toHaveLength(EXPECTED_TOOL_COUNT);
  });

  it('should have unique tool names', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('listMrIds is the only eagerly-loaded tool (defer-loading false)', () => {
    const eager = ALL_TOOLS.filter(
      (t) => (t._meta as Record<string, unknown> | undefined)?.[META_KEYS.DEFER_LOADING] === false
    ).map((t) => t.name);
    expect(eager).toEqual(['listMrIds']);
  });

  it('every USER_SCOPED tool declares a currentUserTool or selfParam companion key', () => {
    for (const tool of ALL_TOOLS) {
      const meta = tool._meta as Record<string, unknown> | undefined;
      if (!meta?.[META_KEYS.USER_SCOPED]) continue;
      const hasCompanion = Boolean(meta[META_KEYS.CURRENT_USER_TOOL] || meta[META_KEYS.SELF_PARAM]);
      expect(hasCompanion, `${tool.name} is USER_SCOPED without a companion key`).toBe(true);
    }
  });

  describe.each(ALL_TOOLS.map((t) => [t.name, t]))('%s', (_name, tool) => {
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

    it('has _meta with the prefixed defer-loading key', () => {
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
});
