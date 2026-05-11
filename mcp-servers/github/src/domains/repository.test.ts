import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { createRepositoryClient } from './repository.js';

function createMockOctokit() {
  return {
    rest: {
      git: {
        getTree: vi.fn(),
      },
      repos: {
        getContent: vi.fn(),
        createOrUpdateFileContents: vi.fn(),
      },
    },
  };
}

describe('RepositoryClient', () => {
  let mock: ReturnType<typeof createMockOctokit>;
  let client: ReturnType<typeof createRepositoryClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockOctokit();
    client = createRepositoryClient(mock as unknown as Octokit);
  });

  describe('getTree', () => {
    it('gets a non-recursive tree and maps the entries', async () => {
      mock.rest.git.getTree.mockResolvedValue({
        data: {
          tree: [
            { path: 'src', mode: '040000', type: 'tree', sha: 't1' },
            { path: 'README.md', mode: '100644', type: 'blob', sha: 'b1', size: 42 },
          ],
        },
      });

      const result = await client.getTree('octocat', 'hello', 'main');

      expect(mock.rest.git.getTree).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        tree_sha: 'main',
        recursive: undefined,
      });
      expect(result).toEqual([
        { path: 'src', mode: '040000', type: 'tree', sha: 't1', size: undefined },
        { path: 'README.md', mode: '100644', type: 'blob', sha: 'b1', size: 42 },
      ]);
    });

    it('passes recursive="1" when requested', async () => {
      mock.rest.git.getTree.mockResolvedValue({ data: { tree: [] } });

      await client.getTree('octocat', 'hello', 'main', { recursive: true });

      expect(mock.rest.git.getTree).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        tree_sha: 'main',
        recursive: '1',
      });
    });

    it('returns an empty array when the tree field is missing', async () => {
      mock.rest.git.getTree.mockResolvedValue({ data: {} });

      const result = await client.getTree('octocat', 'hello', 'main');

      expect(result).toEqual([]);
    });

    it('defends against missing entry fields', async () => {
      mock.rest.git.getTree.mockResolvedValue({ data: { tree: [{}] } });

      const result = await client.getTree('octocat', 'hello', 'main');

      expect(result[0]).toEqual({ path: '', mode: '', type: 'blob', sha: '', size: undefined });
    });
  });

  describe('getContent', () => {
    it('decodes a file to UTF-8', async () => {
      const content = 'Hello World!';
      mock.rest.repos.getContent.mockResolvedValue({
        data: {
          type: 'file',
          path: 'README.md',
          content: Buffer.from(content, 'utf-8').toString('base64'),
          encoding: 'base64',
          sha: 'b1',
          size: content.length,
        },
      });

      const result = await client.getContent('octocat', 'hello', 'README.md', { ref: 'main' });

      expect(mock.rest.repos.getContent).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        path: 'README.md',
        ref: 'main',
      });
      expect(result).toEqual({
        path: 'README.md',
        content,
        encoding: 'utf-8',
        sha: 'b1',
        size: content.length,
      });
    });

    it('throws when the path is a directory (array response)', async () => {
      mock.rest.repos.getContent.mockResolvedValue({ data: [{ type: 'file', path: 'a' }] });

      await expect(client.getContent('octocat', 'hello', 'src')).rejects.toThrow(
        'Path is not a file'
      );
    });

    it('throws when the entry is not of type "file"', async () => {
      mock.rest.repos.getContent.mockResolvedValue({ data: { type: 'dir', path: 'src' } });

      await expect(client.getContent('octocat', 'hello', 'src')).rejects.toThrow(
        'Path is not a file'
      );
    });

    it('throws when content is not a string (e.g. submodule)', async () => {
      mock.rest.repos.getContent.mockResolvedValue({ data: { type: 'file', path: 'x', sha: 's' } });

      await expect(client.getContent('octocat', 'hello', 'x')).rejects.toThrow(
        'Path is not a file'
      );
    });

    it('falls back to the path argument when the response omits path', async () => {
      mock.rest.repos.getContent.mockResolvedValue({
        data: { type: 'file', content: '', encoding: 'base64' },
      });

      const result = await client.getContent('octocat', 'hello', 'docs/x.md');

      expect(result.path).toBe('docs/x.md');
      expect(result.content).toBe('');
      expect(result.size).toBe(0);
    });
  });

  describe('createOrUpdateFile', () => {
    it('base64-encodes the content and returns commit info', async () => {
      mock.rest.repos.createOrUpdateFileContents.mockResolvedValue({
        data: {
          commit: { sha: 'commit1' },
          content: { html_url: 'https://github.com/octocat/hello/blob/main/x.md' },
        },
      });

      const result = await client.createOrUpdateFile('octocat', 'hello', {
        path: 'x.md',
        content: 'new content',
        message: 'Add x.md',
        branch: 'main',
        sha: 'oldsha',
      });

      expect(mock.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        path: 'x.md',
        message: 'Add x.md',
        content: Buffer.from('new content', 'utf-8').toString('base64'),
        branch: 'main',
        sha: 'oldsha',
      });
      expect(result).toEqual({
        commit_sha: 'commit1',
        path: 'x.md',
        html_url: 'https://github.com/octocat/hello/blob/main/x.md',
      });
    });

    it('defends against missing commit/content fields', async () => {
      mock.rest.repos.createOrUpdateFileContents.mockResolvedValue({ data: {} });

      const result = await client.createOrUpdateFile('octocat', 'hello', {
        path: 'x.md',
        content: 'c',
        message: 'm',
      });

      expect(result).toEqual({ commit_sha: '', path: 'x.md', html_url: '' });
    });

    it('propagates API errors', async () => {
      mock.rest.repos.createOrUpdateFileContents.mockRejectedValue(new Error('conflict'));

      await expect(
        client.createOrUpdateFile('octocat', 'hello', { path: 'x.md', content: 'c', message: 'm' })
      ).rejects.toThrow('conflict');
    });
  });
});
