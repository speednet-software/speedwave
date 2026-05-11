import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { createIssuesClient } from './issues.js';

function createMockOctokit() {
  return {
    rest: {
      issues: {
        listForRepo: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    },
    paginate: vi.fn(),
  };
}

const rawIssue = (overrides: Record<string, unknown> = {}) => ({
  number: 3,
  title: 'Bug report',
  body: 'It is broken',
  state: 'open',
  user: { login: 'octocat' },
  labels: [{ name: 'bug' }, 'wontfix'],
  assignees: [{ login: 'dev1' }],
  html_url: 'https://github.com/octocat/hello/issues/3',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-02T00:00:00Z',
  ...overrides,
});

const mappedIssue = (overrides: Record<string, unknown> = {}) => ({
  number: 3,
  title: 'Bug report',
  body: 'It is broken',
  state: 'open',
  user: { login: 'octocat' },
  labels: [{ name: 'bug' }, { name: 'wontfix' }],
  assignees: [{ login: 'dev1' }],
  html_url: 'https://github.com/octocat/hello/issues/3',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-02T00:00:00Z',
  ...overrides,
});

describe('IssuesClient', () => {
  let mock: ReturnType<typeof createMockOctokit>;
  let client: ReturnType<typeof createIssuesClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockOctokit();
    client = createIssuesClient(mock as unknown as Octokit);
  });

  describe('list', () => {
    it('lists issues with default state and filters out pull requests', async () => {
      mock.paginate.mockResolvedValue([
        rawIssue(),
        { ...rawIssue({ number: 4 }), pull_request: { url: 'https://api.github.com/.../pulls/4' } },
        rawIssue({ number: 5 }),
      ]);

      const result = await client.list('octocat', 'hello');

      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.issues.listForRepo, {
        owner: 'octocat',
        repo: 'hello',
        state: 'open',
        labels: undefined,
        assignee: undefined,
        creator: undefined,
        per_page: 100,
      });
      expect(result.map((i) => i.number)).toEqual([3, 5]);
      expect(result[0]).toEqual(mappedIssue());
    });

    it('passes all filters and truncates to the limit (after filtering PRs)', async () => {
      mock.paginate.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => rawIssue({ number: i }))
      );

      const result = await client.list('octocat', 'hello', {
        state: 'all',
        labels: 'bug,urgent',
        assignee: 'dev1',
        creator: 'octocat',
        limit: 3,
      });

      expect(result).toHaveLength(3);
      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.issues.listForRepo, {
        owner: 'octocat',
        repo: 'hello',
        state: 'all',
        labels: 'bug,urgent',
        assignee: 'dev1',
        creator: 'octocat',
        per_page: 3,
      });
    });

    it('defends against missing nested fields', async () => {
      mock.paginate.mockResolvedValue([{ number: 1, state: 'closed' }]);

      const result = await client.list('octocat', 'hello');

      expect(result[0]).toEqual({
        number: 1,
        title: '',
        body: undefined,
        state: 'closed',
        user: { login: '' },
        labels: [],
        assignees: [],
        html_url: '',
        created_at: '',
        updated_at: '',
      });
    });

    it('defaults state to "open", and tolerates falsy label/assignee entries', async () => {
      mock.paginate.mockResolvedValue([
        { number: 1, labels: [null, 'plain', { name: 'kept' }], assignees: [null, {}] },
      ]);

      const result = await client.list('octocat', 'hello');

      expect(result[0]).toEqual({
        number: 1,
        title: '',
        body: undefined,
        state: 'open',
        user: { login: '' },
        labels: [{ name: '' }, { name: 'plain' }, { name: 'kept' }],
        assignees: [{ login: '' }, { login: '' }],
        html_url: '',
        created_at: '',
        updated_at: '',
      });
    });
  });

  describe('get', () => {
    it('gets an issue by number', async () => {
      mock.rest.issues.get.mockResolvedValue({ data: rawIssue() });

      const result = await client.get('octocat', 'hello', 3);

      expect(mock.rest.issues.get).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        issue_number: 3,
      });
      expect(result).toEqual(mappedIssue());
    });

    it('propagates API errors', async () => {
      mock.rest.issues.get.mockRejectedValue(new Error('not_found'));

      await expect(client.get('octocat', 'hello', 99)).rejects.toThrow('not_found');
    });
  });

  describe('create', () => {
    it('creates an issue', async () => {
      mock.rest.issues.create.mockResolvedValue({ data: rawIssue({ number: 11 }) });

      const result = await client.create('octocat', 'hello', {
        title: 'New issue',
        body: 'desc',
        labels: ['bug'],
        assignees: ['dev1'],
      });

      expect(mock.rest.issues.create).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        title: 'New issue',
        body: 'desc',
        labels: ['bug'],
        assignees: ['dev1'],
      });
      expect(result.number).toBe(11);
    });
  });

  describe('update', () => {
    it('updates an issue', async () => {
      mock.rest.issues.update.mockResolvedValue({
        data: rawIssue({ title: 'Updated', state: 'closed' }),
      });

      const result = await client.update('octocat', 'hello', 3, {
        title: 'Updated',
        body: 'new body',
        state: 'closed',
        labels: ['triage'],
        assignees: ['dev2'],
      });

      expect(mock.rest.issues.update).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        issue_number: 3,
        title: 'Updated',
        body: 'new body',
        state: 'closed',
        labels: ['triage'],
        assignees: ['dev2'],
      });
      expect(result.title).toBe('Updated');
      expect(result.state).toBe('closed');
    });

    it('defends against label entries with missing names', async () => {
      mock.rest.issues.update.mockResolvedValue({
        data: rawIssue({ labels: [{}, 'plain', { name: 'kept' }] }),
      });

      const result = await client.update('octocat', 'hello', 3, { state: 'open' });

      expect(result.labels).toEqual([{ name: '' }, { name: 'plain' }, { name: 'kept' }]);
    });
  });
});
