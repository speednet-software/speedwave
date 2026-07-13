/**
 * Repository Content Tools Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage, META_KEYS } from '@speedwave/mcp-shared';
import { createRepositoryTools } from './repository-tools.js';
import type { GitHubClient } from '../client.js';

type MockClient = {
  getTree: Mock;
  getFileContents: Mock;
  createOrUpdateFile: Mock;
};

const createMockClient = (): MockClient => ({
  getTree: vi.fn(),
  getFileContents: vi.fn(),
  createOrUpdateFile: vi.fn(),
});

const findHandler = (tools: ReturnType<typeof createRepositoryTools>, name: string) =>
  tools.find((t) => t.tool.name === name)!.handler;

const json = (data: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

const notConfigured = {
  content: [{ type: 'text', text: `Error: ${notConfiguredMessage('GitHub')}` }],
  isError: true,
};

describe('repository-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes exactly the 3 expected tools, all deferred', () => {
    const tools = createRepositoryTools(null);
    expect(tools.map((t) => t.tool.name)).toEqual([
      'getTree',
      'getFileContents',
      'createOrUpdateFile',
    ]);
    expect(tools.every((t) => t.tool._meta![META_KEYS.DEFER_LOADING] === true)).toBe(true);
  });

  describe('unconfigured client', () => {
    it.each(['getTree', 'getFileContents', 'createOrUpdateFile'])(
      'returns not-configured error for %s',
      async (name) => {
        const handler = findHandler(createRepositoryTools(null), name);
        const result = await handler({
          owner: 'octocat',
          repo: 'hello-world',
          path: 'README.md',
          content: 'x',
          message: 'm',
        });
        expect(result).toEqual(notConfigured);
      }
    );
  });

  describe('getTree', () => {
    it('returns mapped tree entries with count for minimal input', async () => {
      const client = createMockClient();
      client.getTree.mockResolvedValue([
        { path: 'src', mode: '040000', type: 'tree', sha: 't1', size: undefined },
        { path: 'src/index.ts', mode: '100644', type: 'blob', sha: 'b1', size: 123 },
      ]);
      const handler = findHandler(
        createRepositoryTools(client as unknown as GitHubClient),
        'getTree'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world' });

      expect(result).toEqual(
        json({
          tree: [
            { path: 'src', type: 'tree', sha: 't1', size: undefined },
            { path: 'src/index.ts', type: 'blob', sha: 'b1', size: 123 },
          ],
          count: 2,
        })
      );
      expect(client.getTree).toHaveBeenCalledWith('octocat', 'hello-world', {});
    });

    it('forwards ref and recursive options', async () => {
      const client = createMockClient();
      client.getTree.mockResolvedValue([]);
      const handler = findHandler(
        createRepositoryTools(client as unknown as GitHubClient),
        'getTree'
      );

      await handler({ owner: 'octocat', repo: 'hello-world', ref: 'v1.0.0', recursive: true });

      expect(client.getTree).toHaveBeenCalledWith('octocat', 'hello-world', {
        ref: 'v1.0.0',
        recursive: true,
      });
    });

    it('returns an empty tree with count 0', async () => {
      const client = createMockClient();
      client.getTree.mockResolvedValue([]);
      const handler = findHandler(
        createRepositoryTools(client as unknown as GitHubClient),
        'getTree'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world' });

      expect(result).toEqual(json({ tree: [], count: 0 }));
    });

    it('returns an error result when the client throws', async () => {
      const client = createMockClient();
      client.getTree.mockRejectedValue(new Error('tree fail'));
      const handler = findHandler(
        createRepositoryTools(client as unknown as GitHubClient),
        'getTree'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: tree fail' }],
        isError: true,
      });
    });
  });

  describe('getFileContents', () => {
    it('returns the mapped file object for minimal input', async () => {
      const client = createMockClient();
      client.getFileContents.mockResolvedValue({
        path: 'README.md',
        content: '# Hello',
        encoding: 'utf-8',
        sha: 'file-sha',
        size: 7,
      });
      const handler = findHandler(
        createRepositoryTools(client as unknown as GitHubClient),
        'getFileContents'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', path: 'README.md' });

      expect(result).toEqual(
        json({ path: 'README.md', content: '# Hello', encoding: 'utf-8', sha: 'file-sha', size: 7 })
      );
      expect(client.getFileContents).toHaveBeenCalledWith(
        'octocat',
        'hello-world',
        'README.md',
        {}
      );
    });

    it('forwards the ref option', async () => {
      const client = createMockClient();
      client.getFileContents.mockResolvedValue({
        path: 'a',
        content: 'x',
        encoding: 'utf-8',
        sha: 's',
        size: 1,
      });
      const handler = findHandler(
        createRepositoryTools(client as unknown as GitHubClient),
        'getFileContents'
      );

      await handler({ owner: 'octocat', repo: 'hello-world', path: 'src/a.ts', ref: 'develop' });

      expect(client.getFileContents).toHaveBeenCalledWith('octocat', 'hello-world', 'src/a.ts', {
        ref: 'develop',
      });
    });

    it('returns an error result when the path is a directory', async () => {
      const client = createMockClient();
      client.getFileContents.mockRejectedValue(new Error('Path is a directory, not a file'));
      const handler = findHandler(
        createRepositoryTools(client as unknown as GitHubClient),
        'getFileContents'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', path: 'src' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Path is a directory, not a file' }],
        isError: true,
      });
    });
  });

  describe('createOrUpdateFile', () => {
    it('passes required params and returns the commit summary', async () => {
      const client = createMockClient();
      client.createOrUpdateFile.mockResolvedValue({
        commit_sha: 'commit1',
        path: 'NOTES.md',
        html_url: 'https://github.com/octocat/hello-world/blob/main/NOTES.md',
      });
      const handler = findHandler(
        createRepositoryTools(client as unknown as GitHubClient),
        'createOrUpdateFile'
      );

      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        path: 'NOTES.md',
        content: '# Notes',
        message: 'Add notes',
      });

      expect(result).toEqual(
        json({
          commit_sha: 'commit1',
          path: 'NOTES.md',
          html_url: 'https://github.com/octocat/hello-world/blob/main/NOTES.md',
        })
      );
      expect(client.createOrUpdateFile).toHaveBeenCalledWith('octocat', 'hello-world', {
        path: 'NOTES.md',
        content: '# Notes',
        message: 'Add notes',
      });
    });

    it('forwards optional branch and sha', async () => {
      const client = createMockClient();
      client.createOrUpdateFile.mockResolvedValue({
        commit_sha: 'c2',
        path: 'README.md',
        html_url: 'u',
      });
      const handler = findHandler(
        createRepositoryTools(client as unknown as GitHubClient),
        'createOrUpdateFile'
      );

      await handler({
        owner: 'octocat',
        repo: 'hello-world',
        path: 'README.md',
        content: '# Updated',
        message: 'Update README',
        branch: 'main',
        sha: 'a1b2c3',
      });

      expect(client.createOrUpdateFile).toHaveBeenCalledWith('octocat', 'hello-world', {
        path: 'README.md',
        content: '# Updated',
        message: 'Update README',
        branch: 'main',
        sha: 'a1b2c3',
      });
    });

    it('returns an error result on a 422 validation error', async () => {
      const client = createMockClient();
      client.createOrUpdateFile.mockRejectedValue({ status: 422, message: 'sha required' });
      const handler = findHandler(
        createRepositoryTools(client as unknown as GitHubClient),
        'createOrUpdateFile'
      );

      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        path: 'README.md',
        content: 'x',
        message: 'm',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: GitHub validation error: sha required' }],
        isError: true,
      });
    });
  });
});
