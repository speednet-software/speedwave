/**
 * Release Tools Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage } from '@speedwave/mcp-shared';
import { createReleaseTools } from './release-tools.js';
import type { GitHubClient } from '../client.js';

type MockClient = {
  createTag: Mock;
  deleteTag: Mock;
  createRelease: Mock;
};

const createMockClient = (): MockClient => ({
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  createRelease: vi.fn(),
});

const findHandler = (tools: ReturnType<typeof createReleaseTools>, name: string) =>
  tools.find((t) => t.tool.name === name)!.handler;

const json = (data: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

const notConfigured = {
  content: [{ type: 'text', text: `Error: ${notConfiguredMessage('GitHub')}` }],
  isError: true,
};

const ALL_TOOLS = ['createTag', 'deleteTag', 'createRelease'];

describe('release-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes exactly the 3 expected tools, all deferred', () => {
    const tools = createReleaseTools(null);
    expect(tools.map((t) => t.tool.name)).toEqual(ALL_TOOLS);
    expect(tools.every((t) => t.tool._meta!.deferLoading === true)).toBe(true);
  });

  it('marks deleteTag as destructive and createTag/createRelease as non-destructive writes', () => {
    const tools = createReleaseTools(null);
    expect(tools.find((t) => t.tool.name === 'deleteTag')!.tool.annotations).toMatchObject({
      destructiveHint: true,
    });
    expect(tools.find((t) => t.tool.name === 'createTag')!.tool.annotations).toMatchObject({
      destructiveHint: false,
    });
    expect(tools.find((t) => t.tool.name === 'createRelease')!.tool.annotations).toMatchObject({
      destructiveHint: false,
    });
  });

  describe('unconfigured client', () => {
    it.each(ALL_TOOLS)('returns not-configured error for %s', async (name) => {
      const handler = findHandler(createReleaseTools(null), name);
      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        tag: 'v1.0.0',
        sha: 'abc',
        tag_name: 'v1.0.0',
      });
      expect(result).toEqual(notConfigured);
    });
  });

  describe('createTag', () => {
    it('passes required params for a lightweight tag', async () => {
      const client = createMockClient();
      client.createTag.mockResolvedValue({ tag: 'v1.0.0', sha: 'abc123', ref: 'refs/tags/v1.0.0' });
      const handler = findHandler(
        createReleaseTools(client as unknown as GitHubClient),
        'createTag'
      );

      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        tag: 'v1.0.0',
        sha: 'abc123',
      });

      expect(result).toEqual(json({ tag: 'v1.0.0', sha: 'abc123', ref: 'refs/tags/v1.0.0' }));
      expect(client.createTag).toHaveBeenCalledWith('octocat', 'hello-world', {
        tag: 'v1.0.0',
        sha: 'abc123',
      });
    });

    it('forwards an annotation message', async () => {
      const client = createMockClient();
      client.createTag.mockResolvedValue({ tag: 'v1.5.0', sha: 'tagsha', ref: 'refs/tags/v1.5.0' });
      const handler = findHandler(
        createReleaseTools(client as unknown as GitHubClient),
        'createTag'
      );

      await handler({
        owner: 'octocat',
        repo: 'hello-world',
        tag: 'v1.5.0',
        sha: 'abc123',
        message: 'Release v1.5.0',
      });

      expect(client.createTag).toHaveBeenCalledWith('octocat', 'hello-world', {
        tag: 'v1.5.0',
        sha: 'abc123',
        message: 'Release v1.5.0',
      });
    });

    it('returns an error result on a 422 validation error', async () => {
      const client = createMockClient();
      client.createTag.mockRejectedValue({ status: 422, message: 'Reference already exists' });
      const handler = findHandler(
        createReleaseTools(client as unknown as GitHubClient),
        'createTag'
      );

      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        tag: 'v1.0.0',
        sha: 'abc123',
      });

      expect(result).toEqual({
        content: [
          { type: 'text', text: 'Error: GitHub validation error: Reference already exists' },
        ],
        isError: true,
      });
    });
  });

  describe('deleteTag', () => {
    it('passes the tag and returns the deletion confirmation', async () => {
      const client = createMockClient();
      client.deleteTag.mockResolvedValue({ deleted: true, tag: 'v1.0.0' });
      const handler = findHandler(
        createReleaseTools(client as unknown as GitHubClient),
        'deleteTag'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', tag: 'v1.0.0' });

      expect(result).toEqual(json({ deleted: true, tag: 'v1.0.0' }));
      expect(client.deleteTag).toHaveBeenCalledWith('octocat', 'hello-world', 'v1.0.0');
    });

    it('returns an error result on 404', async () => {
      const client = createMockClient();
      client.deleteTag.mockRejectedValue({ status: 404 });
      const handler = findHandler(
        createReleaseTools(client as unknown as GitHubClient),
        'deleteTag'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', tag: 'nope' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Resource not found');
    });
  });

  describe('createRelease', () => {
    it('passes only tag_name for minimal input', async () => {
      const client = createMockClient();
      const release = {
        id: 1,
        tag_name: 'v1.0.0',
        name: 'v1.0.0',
        body: undefined,
        draft: false,
        prerelease: false,
        html_url: 'https://github.com/octocat/hello-world/releases/tag/v1.0.0',
        created_at: '2024-01-01T00:00:00Z',
      };
      client.createRelease.mockResolvedValue(release);
      const handler = findHandler(
        createReleaseTools(client as unknown as GitHubClient),
        'createRelease'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', tag_name: 'v1.0.0' });

      expect(result).toEqual(json(release));
      expect(client.createRelease).toHaveBeenCalledWith('octocat', 'hello-world', {
        tag_name: 'v1.0.0',
      });
    });

    it('forwards name, body, draft, prerelease, and target_commitish', async () => {
      const client = createMockClient();
      client.createRelease.mockResolvedValue({
        id: 2,
        tag_name: 'v1.5.0',
        name: 'Release v1.5.0',
        body: 'notes',
        draft: true,
        prerelease: true,
        html_url: 'u',
        created_at: '2024-02-01T00:00:00Z',
      });
      const handler = findHandler(
        createReleaseTools(client as unknown as GitHubClient),
        'createRelease'
      );

      await handler({
        owner: 'octocat',
        repo: 'hello-world',
        tag_name: 'v1.5.0',
        name: 'Release v1.5.0',
        body: 'notes',
        draft: true,
        prerelease: true,
        target_commitish: 'main',
      });

      expect(client.createRelease).toHaveBeenCalledWith('octocat', 'hello-world', {
        tag_name: 'v1.5.0',
        name: 'Release v1.5.0',
        body: 'notes',
        draft: true,
        prerelease: true,
        target_commitish: 'main',
      });
    });

    it('returns an error result when the client throws', async () => {
      const client = createMockClient();
      client.createRelease.mockRejectedValue(new Error('release fail'));
      const handler = findHandler(
        createReleaseTools(client as unknown as GitHubClient),
        'createRelease'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world', tag_name: 'v1.0.0' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: release fail' }],
        isError: true,
      });
    });
  });
});
