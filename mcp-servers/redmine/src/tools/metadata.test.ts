/**
 * Metadata Tests - validates that all 23 Redmine tools have required metadata fields
 */

import { describe, it, expect } from 'vitest';
import { createToolDefinitions } from './index.js';
import { Tool, META_KEYS, metaValue } from '@speedwave/mcp-shared';

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

    it('has _meta with a prefixed defer-loading key', () => {
      expect(tool._meta, `${tool.name} missing _meta`).toBeDefined();
      const meta = tool._meta as Record<string, unknown>;
      expect(META_KEYS.DEFER_LOADING in meta, `${tool.name} uses legacy deferLoading key`).toBe(
        true
      );
      expect(
        typeof metaValue(meta, META_KEYS.DEFER_LOADING, 'deferLoading'),
        `${tool.name} missing deferLoading`
      ).toBe('boolean');
    });

    it('does not use the legacy unprefixed deferLoading key', () => {
      expect(
        (tool._meta as Record<string, unknown> | undefined)?.deferLoading,
        `${tool.name} still uses legacy deferLoading`
      ).toBeUndefined();
    });

    it('does not use legacy unprefixed identity keys', () => {
      const meta = tool._meta as Record<string, unknown> | undefined;
      expect(meta?.userScoped, `${tool.name} uses legacy userScoped`).toBeUndefined();
      expect(meta?.currentUserTool, `${tool.name} uses legacy currentUserTool`).toBeUndefined();
      expect(meta?.selfParam, `${tool.name} uses legacy selfParam`).toBeUndefined();
    });
  });

  describe('identity metadata', () => {
    const byName = (name: string): Tool =>
      ALL_TOOLS.find((t) => t.name === name) as unknown as Tool;

    it('every tool declaring speedwave.pl/user-scoped also declares a current-user-tool or self-param', () => {
      for (const tool of ALL_TOOLS) {
        const meta = tool._meta as Record<string, unknown> | undefined;
        if (metaValue(meta, META_KEYS.USER_SCOPED, 'userScoped') !== true) continue;
        const currentUserTool = metaValue(meta, META_KEYS.CURRENT_USER_TOOL, 'currentUserTool');
        const selfParam = metaValue(meta, META_KEYS.SELF_PARAM, 'selfParam');
        expect(
          currentUserTool !== undefined || selfParam !== undefined,
          `${tool.name} is user-scoped but declares neither a current-user-tool nor a self-param`
        ).toBe(true);
      }
    });

    it('is user-scoped on exactly the expected tools', () => {
      const expectedUserScoped = new Set([
        'listIssueIds',
        'createIssue',
        'updateIssue',
        'listTimeEntries',
        'createTimeEntry',
        'resolveUser',
        'getCurrentUser',
      ]);
      for (const tool of ALL_TOOLS) {
        const meta = tool._meta as Record<string, unknown> | undefined;
        const isUserScoped = metaValue(meta, META_KEYS.USER_SCOPED, 'userScoped') === true;
        expect(isUserScoped, `${tool.name} user-scoped mismatch`).toBe(
          expectedUserScoped.has(tool.name)
        );
      }
    });

    it('listTimeEntries points to getCurrentUser as its current-user-tool', () => {
      const meta = byName('listTimeEntries')._meta as Record<string, unknown>;
      expect(metaValue(meta, META_KEYS.CURRENT_USER_TOOL, 'currentUserTool')).toBe(
        'getCurrentUser'
      );
    });

    it.each(['listIssueIds', 'createIssue', 'updateIssue'])(
      "%s declares a self-param for assigned_to: 'me'",
      (name) => {
        const meta = byName(name)._meta as Record<string, unknown>;
        expect(metaValue(meta, META_KEYS.SELF_PARAM, 'selfParam')).toBe("assigned_to: 'me'");
      }
    );

    it("listTimeEntries declares a self-param for user_id: 'me'", () => {
      const meta = byName('listTimeEntries')._meta as Record<string, unknown>;
      expect(metaValue(meta, META_KEYS.SELF_PARAM, 'selfParam')).toBe("user_id: 'me'");
    });
  });
});
