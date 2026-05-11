/**
 * Issue Tools Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage } from '@speedwave/mcp-shared';
import { createIssueTools } from './issue-tools.js';
import type { GitHubClient } from '../client.js';

type MockClient = {
  listIssues: Mock;
  getIssue: Mock;
  createIssue: Mock;
  updateIssue: Mock;
  closeIssue: Mock;
};

const createMockClient = (): MockClient => ({
  listIssues: vi.fn(),
  getIssue: vi.fn(),
  createIssue: vi.fn(),
  updateIssue: vi.fn(),
  closeIssue: vi.fn(),
});

const findHandler = (tools: ReturnType<typeof createIssueTools>, name: string) =>
  tools.find((t) => t.tool.name === name)!.handler;

const json = (data: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

const notConfigured = {
  content: [{ type: 'text', text: `Error: ${notConfiguredMessage('GitHub')}` }],
  isError: true,
};

const rawIssue = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  body: 'details',
  state: 'open' as const,
  user: { login: 'octocat' },
  labels: [{ name: 'bug' }],
  assignees: [{ login: 'octocat' }],
  html_url: `https://github.com/octocat/hello-world/issues/${number}`,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-02T00:00:00Z',
  ...overrides,
});

const issueSummary = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  state: 'open',
  user: 'octocat',
  labels: ['bug'],
  assignees: ['octocat'],
  html_url: `https://github.com/octocat/hello-world/issues/${number}`,
  ...overrides,
});

const ALL_TOOLS = ['listIssues', 'getIssue', 'createIssue', 'updateIssue', 'closeIssue'];

describe('issue-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes exactly the 5 expected tools', () => {
    expect(createIssueTools(null).map((t) => t.tool.name)).toEqual(ALL_TOOLS);
  });

  it('eagerly loads only listIssues', () => {
    const tools = createIssueTools(null);
    expect(tools.find((t) => t.tool.name === 'listIssues')!.tool._meta).toEqual({
      deferLoading: false,
    });
    expect(
      tools
        .filter((t) => t.tool.name !== 'listIssues')
        .every((t) => t.tool._meta!.deferLoading === true)
    ).toBe(true);
  });

  describe('unconfigured client', () => {
    it.each(ALL_TOOLS)('returns not-configured error for %s', async (name) => {
      const handler = findHandler(createIssueTools(null), name);
      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        number: 1,
        title: 't',
      });
      expect(result).toEqual(notConfigured);
    });
  });

  describe('listIssues', () => {
    it('returns mapped issue summaries with count for minimal input', async () => {
      const client = createMockClient();
      client.listIssues.mockResolvedValue([
        rawIssue(1),
        rawIssue(2, { labels: [], assignees: [] }),
      ]);
      const handler = findHandler(
        createIssueTools(client as unknown as GitHubClient),
        'listIssues'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world' });

      expect(result).toEqual(
        json({
          issues: [issueSummary(1), issueSummary(2, { labels: [], assignees: [] })],
          count: 2,
        })
      );
      expect(client.listIssues).toHaveBeenCalledWith('octocat', 'hello-world', {});
    });

    it('forwards state/labels/assignee/creator/limit filters', async () => {
      const client = createMockClient();
      client.listIssues.mockResolvedValue([]);
      const handler = findHandler(
        createIssueTools(client as unknown as GitHubClient),
        'listIssues'
      );

      await handler({
        owner: 'octocat',
        repo: 'hello-world',
        state: 'closed',
        labels: 'bug,urgent',
        assignee: '*',
        creator: 'octocat',
        limit: 25,
      });

      expect(client.listIssues).toHaveBeenCalledWith('octocat', 'hello-world', {
        state: 'closed',
        labels: 'bug,urgent',
        assignee: '*',
        creator: 'octocat',
        limit: 25,
      });
    });

    it('returns an empty list with count 0', async () => {
      const client = createMockClient();
      client.listIssues.mockResolvedValue([]);
      const handler = findHandler(
        createIssueTools(client as unknown as GitHubClient),
        'listIssues'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world' });

      expect(result).toEqual(json({ issues: [], count: 0 }));
    });

    it('returns an error result when the client throws', async () => {
      const client = createMockClient();
      client.listIssues.mockRejectedValue(new Error('list fail'));
      const handler = findHandler(
        createIssueTools(client as unknown as GitHubClient),
        'listIssues'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: list fail' }],
        isError: true,
      });
    });
  });

  describe('getIssue', () => {
    it('returns the mapped issue and passes the number', async () => {
      const client = createMockClient();
      const issue = rawIssue(7);
      client.getIssue.mockResolvedValue(issue);
      const handler = findHandler(createIssueTools(client as unknown as GitHubClient), 'getIssue');

      const result = await handler({ owner: 'octocat', repo: 'hello-world', number: 7 });

      expect(result).toEqual(json(issue));
      expect(client.getIssue).toHaveBeenCalledWith('octocat', 'hello-world', 7);
    });

    it('returns an error result on 404', async () => {
      const client = createMockClient();
      client.getIssue.mockRejectedValue({ status: 404 });
      const handler = findHandler(createIssueTools(client as unknown as GitHubClient), 'getIssue');

      const result = await handler({ owner: 'octocat', repo: 'hello-world', number: 999 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Resource not found');
    });
  });

  describe('createIssue', () => {
    it('passes only the title for minimal input', async () => {
      const client = createMockClient();
      const created = rawIssue(10, {
        title: 'Add feature X',
        labels: [],
        assignees: [],
        body: undefined,
      });
      client.createIssue.mockResolvedValue(created);
      const handler = findHandler(
        createIssueTools(client as unknown as GitHubClient),
        'createIssue'
      );

      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        title: 'Add feature X',
      });

      expect(result).toEqual(json(created));
      expect(client.createIssue).toHaveBeenCalledWith('octocat', 'hello-world', {
        title: 'Add feature X',
      });
    });

    it('forwards body, labels, and assignees', async () => {
      const client = createMockClient();
      client.createIssue.mockResolvedValue(rawIssue(11));
      const handler = findHandler(
        createIssueTools(client as unknown as GitHubClient),
        'createIssue'
      );

      await handler({
        owner: 'octocat',
        repo: 'hello-world',
        title: 'Improve docs',
        body: 'README is out of date.',
        labels: ['documentation'],
        assignees: ['octocat'],
      });

      expect(client.createIssue).toHaveBeenCalledWith('octocat', 'hello-world', {
        title: 'Improve docs',
        body: 'README is out of date.',
        labels: ['documentation'],
        assignees: ['octocat'],
      });
    });

    it('returns an error result on 422', async () => {
      const client = createMockClient();
      client.createIssue.mockRejectedValue({ status: 422, message: 'title required' });
      const handler = findHandler(
        createIssueTools(client as unknown as GitHubClient),
        'createIssue'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', title: '' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: GitHub validation error: title required' }],
        isError: true,
      });
    });
  });

  describe('updateIssue', () => {
    it('passes the number and forwards all optional fields', async () => {
      const client = createMockClient();
      const updated = rawIssue(5, { title: 'Refined title', state: 'closed' });
      client.updateIssue.mockResolvedValue(updated);
      const handler = findHandler(
        createIssueTools(client as unknown as GitHubClient),
        'updateIssue'
      );

      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        number: 5,
        title: 'Refined title',
        body: 'Updated description.',
        state: 'closed',
        labels: ['bug', 'priority'],
        assignees: ['octocat'],
      });

      expect(result).toEqual(json(updated));
      expect(client.updateIssue).toHaveBeenCalledWith('octocat', 'hello-world', 5, {
        title: 'Refined title',
        body: 'Updated description.',
        state: 'closed',
        labels: ['bug', 'priority'],
        assignees: ['octocat'],
      });
    });

    it('passes an empty options object when only owner/repo/number are given', async () => {
      const client = createMockClient();
      client.updateIssue.mockResolvedValue(rawIssue(5));
      const handler = findHandler(
        createIssueTools(client as unknown as GitHubClient),
        'updateIssue'
      );

      await handler({ owner: 'octocat', repo: 'hello-world', number: 5 });

      expect(client.updateIssue).toHaveBeenCalledWith('octocat', 'hello-world', 5, {});
    });

    it('returns an error result when the client throws', async () => {
      const client = createMockClient();
      client.updateIssue.mockRejectedValue(new Error('update fail'));
      const handler = findHandler(
        createIssueTools(client as unknown as GitHubClient),
        'updateIssue'
      );

      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        number: 5,
        state: 'closed',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: update fail' }],
        isError: true,
      });
    });
  });

  describe('closeIssue', () => {
    it('returns the mapped issue and passes the number', async () => {
      const client = createMockClient();
      const closed = rawIssue(3, { state: 'closed' });
      client.closeIssue.mockResolvedValue(closed);
      const handler = findHandler(
        createIssueTools(client as unknown as GitHubClient),
        'closeIssue'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', number: 3 });

      expect(result).toEqual(json(closed));
      expect(client.closeIssue).toHaveBeenCalledWith('octocat', 'hello-world', 3);
    });

    it('returns an error result on permission denied', async () => {
      const client = createMockClient();
      client.closeIssue.mockRejectedValue({ status: 403, response: { headers: {} } });
      const handler = findHandler(
        createIssueTools(client as unknown as GitHubClient),
        'closeIssue'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', number: 3 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Permission denied');
    });
  });
});
