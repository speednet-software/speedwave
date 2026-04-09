/**
 * Metadata Tests - validates that all 23 Redmine tools have required metadata fields
 */

import { describe, it, expect } from 'vitest';
import { createToolDefinitions } from './index.js';
import { Tool } from '@speedwave/mcp-shared';

const ALL_TOOLS: Tool[] = createToolDefinitions(null).map((td) => td.tool);

const EXPECTED_TOOL_NAMES = [
  'listIssueIds',
  'getIssueFull',
  'searchIssueIds',
  'createIssue',
  'updateIssue',
  'commentIssue',
  'listTimeEntries',
  'createTimeEntry',
  'updateTimeEntry',
  'listJournals',
  'updateJournal',
  'deleteJournal',
  'listUsers',
  'resolveUser',
  'getCurrentUser',
  'listProjectIds',
  'getProjectFull',
  'searchProjectIds',
  'listRelations',
  'createRelation',
  'deleteRelation',
  'getMappings',
  'getConfig',
];

describe('Redmine tool metadata', () => {
  it('exports exactly 23 tools', () => {
    expect(ALL_TOOLS).toHaveLength(23);
  });

  it('exports all expected tool names', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });

  describe.each(ALL_TOOLS.map((t) => [t.name, t] as const))('%s', (_name, tool) => {
    it('has annotations with readOnlyHint and destructiveHint', () => {
      expect(tool.annotations).toBeDefined();
      expect(typeof tool.annotations!.readOnlyHint).toBe('boolean');
      expect(typeof tool.annotations!.destructiveHint).toBe('boolean');
    });

    it('has keywords with at least 1 entry', () => {
      expect(tool.keywords).toBeDefined();
      expect(Array.isArray(tool.keywords)).toBe(true);
      expect(tool.keywords!.length).toBeGreaterThanOrEqual(1);
      for (const kw of tool.keywords!) {
        expect(typeof kw).toBe('string');
        expect(kw.length).toBeGreaterThan(0);
      }
    });

    it('has example (non-empty string)', () => {
      expect(tool.example).toBeDefined();
      expect(typeof tool.example).toBe('string');
      expect(tool.example!.trim().length).toBeGreaterThan(0);
    });

    it('has _meta with deferLoading', () => {
      expect(tool._meta, `${tool.name} missing _meta`).toBeDefined();
      expect(
        typeof (tool._meta as Record<string, unknown>).deferLoading,
        `${tool.name} missing deferLoading`
      ).toBe('boolean');
    });
  });
});
