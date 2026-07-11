/**
 * Metadata Tests - validates that all 46 GitHub tools have required metadata fields
 */

import { describe, it, expect } from 'vitest';
import { META_KEYS } from '@speedwave/mcp-shared';
import { createToolDefinitions } from './index.js';
import { Tool } from '@speedwave/mcp-shared';
import { TOOL_NAMES } from '../tool-names.js';

const ALL_TOOLS: Tool[] = createToolDefinitions(null).map((td) => td.tool);

const EXPECTED_TOOL_NAMES = [
  'getCurrentUser',
  'listRepos',
  'getRepo',
  'searchCode',
  'listPullRequests',
  'getPullRequest',
  'createPullRequest',
  'mergePullRequest',
  'updatePullRequest',
  'getPrDiff',
  'getPrFiles',
  'listPrCommits',
  'listPrReviews',
  'createPrReview',
  'listPrComments',
  'createPrComment',
  'createPrReviewComment',
  'listBranches',
  'getBranch',
  'createBranch',
  'deleteBranch',
  'compareBranches',
  'listCommits',
  'listBranchCommits',
  'searchCommits',
  'getCommitDiff',
  'getTree',
  'getFileContents',
  'createOrUpdateFile',
  'listWorkflowRuns',
  'getWorkflowRun',
  'getRunLogs',
  'rerunWorkflow',
  'triggerWorkflow',
  'listWorkflowRunArtifacts',
  'downloadArtifact',
  'listIssues',
  'getIssue',
  'createIssue',
  'updateIssue',
  'closeIssue',
  'listLabels',
  'createLabel',
  'createTag',
  'deleteTag',
  'createRelease',
];

/** Tools whose results/effects depend on which account owns the mounted token. */
const USER_SCOPED_TOOL_NAMES = [
  'listRepos',
  'listCommits',
  'searchCommits',
  'listIssues',
  'createIssue',
  'updateIssue',
];

describe('GitHub tool metadata', () => {
  it('exports exactly 46 tools', () => {
    expect(ALL_TOOLS).toHaveLength(46);
  });

  it('exports all expected tool names with no extras', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names)).toEqual(new Set(EXPECTED_TOOL_NAMES));
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

    it('has _meta with the prefixed defer-loading key (no legacy key)', () => {
      const meta = tool._meta as Record<string, unknown>;
      expect(meta, `${tool.name} missing _meta`).toBeDefined();
      expect(
        typeof meta[META_KEYS.DEFER_LOADING],
        `${tool.name} missing prefixed defer-loading`
      ).toBe('boolean');
      expect(
        meta.deferLoading,
        `${tool.name} must not carry the legacy unprefixed key`
      ).toBeUndefined();
    });
  });

  describe('identity-scoped tools', () => {
    it.each(USER_SCOPED_TOOL_NAMES)('%s declares user-scoped identity _meta', (name) => {
      const tool = ALL_TOOLS.find((t) => t.name === name);
      const meta = tool?._meta as Record<string, unknown>;
      expect(meta[META_KEYS.USER_SCOPED], `${name} missing user-scoped _meta`).toBe(true);
      expect(meta[META_KEYS.CURRENT_USER_TOOL], `${name} missing current-user-tool _meta`).toBe(
        TOOL_NAMES.GET_CURRENT_USER
      );
    });

    it('non-identity tools do not declare user-scoped _meta', () => {
      const nonScoped = ALL_TOOLS.filter((t) => !USER_SCOPED_TOOL_NAMES.includes(t.name));
      for (const tool of nonScoped) {
        const meta = tool._meta as Record<string, unknown> | undefined;
        expect(
          meta?.[META_KEYS.USER_SCOPED],
          `${tool.name} should not be user-scoped`
        ).toBeUndefined();
      }
    });
  });
});
