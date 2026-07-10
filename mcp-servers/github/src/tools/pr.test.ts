/** Tests for GitHub Pull Request Tools. */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage, META_KEYS } from '@speedwave/mcp-shared';
import { createPrTools } from './pr-tools.js';
import { createToolDefinitions } from './index.js';
import type { GitHubClient } from '../client.js';

type MockClient = {
  listPullRequests: Mock;
  getPullRequest: Mock;
  createPullRequest: Mock;
  mergePullRequest: Mock;
  updatePullRequest: Mock;
  getPrDiff: Mock;
  getPrFiles: Mock;
};

function createMockClient(): MockClient {
  return {
    listPullRequests: vi.fn(),
    getPullRequest: vi.fn(),
    createPullRequest: vi.fn(),
    mergePullRequest: vi.fn(),
    updatePullRequest: vi.fn(),
    getPrDiff: vi.fn(),
    getPrFiles: vi.fn(),
  };
}

const NOT_CONFIGURED = {
  content: [{ type: 'text', text: `Error: ${notConfiguredMessage('GitHub')}` }],
  isError: true,
};

function makePr(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: 'Add feature X',
    body: 'Implements feature X',
    state: 'open' as const,
    merged: false,
    head: { ref: 'feature/x', sha: 'abc123' },
    base: { ref: 'main' },
    user: { login: 'octocat' },
    html_url: 'https://github.com/octocat/hello-world/pull/42',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    draft: false,
    ...overrides,
  };
}

function mappedPr(pr: ReturnType<typeof makePr>) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    head: pr.head.ref,
    base: pr.base.ref,
    user: pr.user.login,
    draft: pr.draft,
    html_url: pr.html_url,
  };
}

const ALL_TOOL_NAMES = [
  'listPullRequests',
  'getPullRequest',
  'createPullRequest',
  'mergePullRequest',
  'updatePullRequest',
  'getPrDiff',
  'getPrFiles',
];

describe('Pull Request Tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  describe('unconfigured client', () => {
    it('returns 7 tools when client is null', () => {
      const tools = createPrTools(null);
      expect(tools).toHaveLength(7);
      expect(tools.map((t) => t.tool.name)).toEqual(ALL_TOOL_NAMES);
    });

    it.each([
      ['listPullRequests', { owner: 'o', repo: 'r' }],
      ['getPullRequest', { owner: 'o', repo: 'r', number: 1 }],
      ['createPullRequest', { owner: 'o', repo: 'r', title: 't', head: 'h', base: 'b' }],
      ['mergePullRequest', { owner: 'o', repo: 'r', number: 1 }],
      ['updatePullRequest', { owner: 'o', repo: 'r', number: 1 }],
      ['getPrDiff', { owner: 'o', repo: 'r', number: 1 }],
      ['getPrFiles', { owner: 'o', repo: 'r', number: 1 }],
    ])('returns error for %s when client is null', async (name, args) => {
      const tools = createPrTools(null);
      const handler = tools.find((t) => t.tool.name === name)?.handler;
      expect(handler).toBeDefined();
      expect(await handler!(args)).toEqual(NOT_CONFIGURED);
    });
  });

  describe('tool definitions', () => {
    it('returns 7 tools when configured, listPullRequests is eager-loaded', () => {
      const tools = createPrTools(mockClient as unknown as GitHubClient);
      expect(tools.map((t) => t.tool.name)).toEqual(ALL_TOOL_NAMES);
      expect(
        tools.find((t) => t.tool.name === 'listPullRequests')?.tool._meta?.[META_KEYS.DEFER_LOADING]
      ).toBe(false);
      for (const name of ALL_TOOL_NAMES.filter((n) => n !== 'listPullRequests')) {
        expect(tools.find((t) => t.tool.name === name)?.tool._meta?.[META_KEYS.DEFER_LOADING]).toBe(
          true
        );
      }
    });

    it('mergePullRequest is destructive, createPullRequest is a write, getPrDiff is read-only', () => {
      const tools = createPrTools(mockClient as unknown as GitHubClient);
      expect(tools.find((t) => t.tool.name === 'mergePullRequest')?.tool.annotations).toMatchObject(
        {
          destructiveHint: true,
        }
      );
      expect(
        tools.find((t) => t.tool.name === 'createPullRequest')?.tool.annotations
      ).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(tools.find((t) => t.tool.name === 'getPrDiff')?.tool.annotations).toMatchObject({
        readOnlyHint: true,
      });
    });
  });

  describe('listPullRequests', () => {
    it('lists PRs with just owner and repo (empty options)', async () => {
      const prs = [
        makePr(),
        makePr({ number: 43, title: 'Another', head: { ref: 'feat/y', sha: 'd' } }),
      ];
      mockClient.listPullRequests.mockResolvedValue(prs);

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listPullRequests')?.handler;
      const result = await handler!({ owner: 'octocat', repo: 'hello-world' });

      const expected = { prs: prs.map(mappedPr), count: 2 };
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(expected, null, 2) }],
      });
      expect(mockClient.listPullRequests).toHaveBeenCalledWith('octocat', 'hello-world', {});
    });

    it('passes state and limit through', async () => {
      mockClient.listPullRequests.mockResolvedValue([]);

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listPullRequests')?.handler;
      await handler!({ owner: 'o', repo: 'r', state: 'closed', limit: 5 });

      expect(mockClient.listPullRequests).toHaveBeenCalledWith('o', 'r', {
        state: 'closed',
        limit: 5,
      });
    });

    it('passes head and base filters through', async () => {
      mockClient.listPullRequests.mockResolvedValue([]);

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listPullRequests')?.handler;
      await handler!({ owner: 'o', repo: 'r', head: 'user:branch', base: 'main' });

      expect(mockClient.listPullRequests).toHaveBeenCalledWith('o', 'r', {
        head: 'user:branch',
        base: 'main',
      });
    });

    it('returns empty list with count 0', async () => {
      mockClient.listPullRequests.mockResolvedValue([]);

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listPullRequests')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r' });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ prs: [], count: 0 }, null, 2) }],
      });
    });

    it('returns error on failure', async () => {
      mockClient.listPullRequests.mockRejectedValue(new Error('Not Found'));

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'listPullRequests')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r' });

      expect(result).toMatchObject({ isError: true });
    });
  });

  describe('getPullRequest', () => {
    it('returns the mapped PR', async () => {
      const pr = makePr({ number: 7, draft: true });
      mockClient.getPullRequest.mockResolvedValue(pr);

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getPullRequest')?.handler;
      const result = await handler!({ owner: 'octocat', repo: 'hello-world', number: 7 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mappedPr(pr), null, 2) }],
      });
      expect(mockClient.getPullRequest).toHaveBeenCalledWith('octocat', 'hello-world', 7);
    });

    it('returns error on 404', async () => {
      mockClient.getPullRequest.mockRejectedValue(new Error('Not Found'));

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getPullRequest')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 99 });

      expect(result).toMatchObject({ isError: true });
    });

    it('tolerates a "#42" style PR number (numeric forgiveness applied at registration)', async () => {
      mockClient.getPullRequest.mockResolvedValue(makePr({ number: 42 }));

      const tools = createToolDefinitions(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getPullRequest')?.handler;
      await handler!({ owner: 'octocat', repo: 'hello-world', number: '#42' });

      expect(mockClient.getPullRequest).toHaveBeenCalledWith('octocat', 'hello-world', 42);
    });

    it('splits a combined owner/repo string passed in repo', async () => {
      mockClient.getPullRequest.mockResolvedValue(makePr({ number: 7 }));

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getPullRequest')?.handler;
      await handler!({ repo: 'octocat/hello-world', number: 7 });

      expect(mockClient.getPullRequest).toHaveBeenCalledWith('octocat', 'hello-world', 7);
    });
  });

  describe('createPullRequest', () => {
    it('creates a PR with required fields only', async () => {
      const pr = makePr({ number: 100, title: 'Add docs', head: { ref: 'docs', sha: 's' } });
      mockClient.createPullRequest.mockResolvedValue(pr);

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createPullRequest')?.handler;
      const result = await handler!({
        owner: 'octocat',
        repo: 'hello-world',
        title: 'Add docs',
        head: 'docs',
        base: 'main',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mappedPr(pr), null, 2) }],
      });
      expect(mockClient.createPullRequest).toHaveBeenCalledWith('octocat', 'hello-world', {
        title: 'Add docs',
        head: 'docs',
        base: 'main',
      });
    });

    it('forwards body and draft', async () => {
      mockClient.createPullRequest.mockResolvedValue(makePr());

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createPullRequest')?.handler;
      await handler!({
        owner: 'o',
        repo: 'r',
        title: 't',
        head: 'h',
        base: 'b',
        body: 'desc',
        draft: true,
      });

      expect(mockClient.createPullRequest).toHaveBeenCalledWith('o', 'r', {
        title: 't',
        head: 'h',
        base: 'b',
        body: 'desc',
        draft: true,
      });
    });

    it('returns error when validation fails', async () => {
      mockClient.createPullRequest.mockRejectedValue(new Error('Validation Failed'));

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'createPullRequest')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', title: 't', head: 'h', base: 'b' });

      expect(result).toMatchObject({ isError: true });
    });
  });

  describe('mergePullRequest', () => {
    it('merges with no options and returns the merge result', async () => {
      const mergeResult = {
        merged: true,
        sha: 'deadbeef',
        message: 'Pull Request successfully merged',
      };
      mockClient.mergePullRequest.mockResolvedValue(mergeResult);

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'mergePullRequest')?.handler;
      const result = await handler!({ owner: 'octocat', repo: 'hello-world', number: 42 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mergeResult, null, 2) }],
      });
      expect(mockClient.mergePullRequest).toHaveBeenCalledWith('octocat', 'hello-world', 42, {});
    });

    it('forwards merge_method and commit_title', async () => {
      mockClient.mergePullRequest.mockResolvedValue({ merged: true, sha: 'x', message: 'ok' });

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'mergePullRequest')?.handler;
      await handler!({
        owner: 'o',
        repo: 'r',
        number: 1,
        merge_method: 'squash',
        commit_title: 'feat: x',
      });

      expect(mockClient.mergePullRequest).toHaveBeenCalledWith('o', 'r', 1, {
        merge_method: 'squash',
        commit_title: 'feat: x',
      });
    });

    it('returns error when the PR is not mergeable', async () => {
      mockClient.mergePullRequest.mockRejectedValue(new Error('Pull Request is not mergeable'));

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'mergePullRequest')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 1 });

      expect(result).toMatchObject({ isError: true });
    });
  });

  describe('updatePullRequest', () => {
    it('updates with only owner+repo+number (empty rest)', async () => {
      const pr = makePr();
      mockClient.updatePullRequest.mockResolvedValue(pr);

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'updatePullRequest')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 42 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mappedPr(pr), null, 2) }],
      });
      expect(mockClient.updatePullRequest).toHaveBeenCalledWith('o', 'r', 42, {});
    });

    it('forwards title, body, state and base', async () => {
      mockClient.updatePullRequest.mockResolvedValue(makePr({ state: 'closed' }));

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'updatePullRequest')?.handler;
      await handler!({
        owner: 'o',
        repo: 'r',
        number: 1,
        title: 'new',
        body: 'b',
        state: 'closed',
        base: 'dev',
      });

      expect(mockClient.updatePullRequest).toHaveBeenCalledWith('o', 'r', 1, {
        title: 'new',
        body: 'b',
        state: 'closed',
        base: 'dev',
      });
    });

    it('returns error on failure', async () => {
      mockClient.updatePullRequest.mockRejectedValue(new Error('Not Found'));

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'updatePullRequest')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 1 });

      expect(result).toMatchObject({ isError: true });
    });
  });

  describe('getPrDiff', () => {
    it('returns the diff under a `diff` field (object-typed result)', async () => {
      const diff =
        'diff --git a/file.txt b/file.txt\nindex e69de29..0d08373 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -0,0 +1 @@\n+hello\n';
      mockClient.getPrDiff.mockResolvedValue(diff);

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getPrDiff')?.handler;
      const result = await handler!({ owner: 'octocat', repo: 'hello-world', number: 42 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ diff }, null, 2) }],
      });
      expect(mockClient.getPrDiff).toHaveBeenCalledWith('octocat', 'hello-world', 42);
    });

    it('returns an empty diff for a PR with no changes', async () => {
      mockClient.getPrDiff.mockResolvedValue('');

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getPrDiff')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 1 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ diff: '' }, null, 2) }],
      });
    });

    it('returns error on failure', async () => {
      mockClient.getPrDiff.mockRejectedValue(new Error('Not Found'));

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getPrDiff')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 1 });

      expect(result).toMatchObject({ isError: true });
    });
  });

  describe('getPrFiles', () => {
    it('lists changed files with no limit', async () => {
      const files = [
        {
          filename: 'a.ts',
          status: 'modified',
          additions: 3,
          deletions: 1,
          changes: 4,
          patch: '@@ -1 +1 @@',
        },
        { filename: 'b.ts', status: 'added', additions: 10, deletions: 0, changes: 10 },
      ];
      mockClient.getPrFiles.mockResolvedValue(files);

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getPrFiles')?.handler;
      const result = await handler!({ owner: 'octocat', repo: 'hello-world', number: 42 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ files, count: 2 }, null, 2) }],
      });
      expect(mockClient.getPrFiles).toHaveBeenCalledWith('octocat', 'hello-world', 42, {});
    });

    it('forwards limit', async () => {
      mockClient.getPrFiles.mockResolvedValue([]);

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getPrFiles')?.handler;
      await handler!({ owner: 'o', repo: 'r', number: 1, limit: 10 });

      expect(mockClient.getPrFiles).toHaveBeenCalledWith('o', 'r', 1, { limit: 10 });
    });

    it('returns an empty file list', async () => {
      mockClient.getPrFiles.mockResolvedValue([]);

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getPrFiles')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 1 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ files: [], count: 0 }, null, 2) }],
      });
    });

    it('returns error on failure', async () => {
      mockClient.getPrFiles.mockRejectedValue(new Error('Not Found'));

      const tools = createPrTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getPrFiles')?.handler;
      const result = await handler!({ owner: 'o', repo: 'r', number: 1 });

      expect(result).toMatchObject({ isError: true });
    });
  });
});
