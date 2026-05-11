import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { createLabelsClient } from './labels.js';

function createMockOctokit() {
  return {
    rest: {
      issues: {
        listLabelsForRepo: vi.fn(),
        createLabel: vi.fn(),
      },
    },
    paginate: vi.fn(),
  };
}

describe('LabelsClient', () => {
  let mock: ReturnType<typeof createMockOctokit>;
  let client: ReturnType<typeof createLabelsClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockOctokit();
    client = createLabelsClient(mock as unknown as Octokit);
  });

  describe('list', () => {
    it('lists labels and maps them', async () => {
      mock.paginate.mockResolvedValue([
        { id: 1, name: 'bug', color: 'ff0000', description: 'Bug reports' },
        { id: 2, name: 'feature', color: '00ff00' },
      ]);

      const result = await client.list('octocat', 'hello');

      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.issues.listLabelsForRepo, {
        owner: 'octocat',
        repo: 'hello',
        per_page: 100,
      });
      expect(result).toEqual([
        { id: 1, name: 'bug', color: 'ff0000', description: 'Bug reports' },
        { id: 2, name: 'feature', color: '00ff00', description: undefined },
      ]);
    });

    it('truncates to the requested limit', async () => {
      mock.paginate.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({ id: i, name: `l${i}`, color: 'ffffff' }))
      );

      const result = await client.list('octocat', 'hello', { limit: 3 });

      expect(result).toHaveLength(3);
      expect(mock.paginate).toHaveBeenCalledWith(mock.rest.issues.listLabelsForRepo, {
        owner: 'octocat',
        repo: 'hello',
        per_page: 3,
      });
    });

    it('returns an empty array when there are no labels', async () => {
      mock.paginate.mockResolvedValue([]);

      const result = await client.list('octocat', 'hello');

      expect(result).toEqual([]);
    });

    it('defends against missing fields', async () => {
      mock.paginate.mockResolvedValue([{}]);

      const result = await client.list('octocat', 'hello');

      expect(result[0]).toEqual({ id: NaN, name: '', color: '', description: undefined });
    });
  });

  describe('create', () => {
    it('creates a label and strips a leading "#" from the color', async () => {
      mock.rest.issues.createLabel.mockResolvedValue({
        data: { id: 5, name: 'docs', color: 'cccccc', description: 'Docs' },
      });

      const result = await client.create('octocat', 'hello', {
        name: 'docs',
        color: '#cccccc',
        description: 'Docs',
      });

      expect(mock.rest.issues.createLabel).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        name: 'docs',
        color: 'cccccc',
        description: 'Docs',
      });
      expect(result).toEqual({ id: 5, name: 'docs', color: 'cccccc', description: 'Docs' });
    });

    it('passes the color through when there is no leading "#"', async () => {
      mock.rest.issues.createLabel.mockResolvedValue({
        data: { id: 6, name: 'urgent', color: 'ff9900' },
      });

      const result = await client.create('octocat', 'hello', { name: 'urgent', color: 'ff9900' });

      expect(mock.rest.issues.createLabel).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        name: 'urgent',
        color: 'ff9900',
        description: undefined,
      });
      expect(result.description).toBeUndefined();
    });

    it('propagates API errors', async () => {
      mock.rest.issues.createLabel.mockRejectedValue(new Error('already_exists'));

      await expect(
        client.create('octocat', 'hello', { name: 'bug', color: 'ff0000' })
      ).rejects.toThrow('already_exists');
    });
  });
});
