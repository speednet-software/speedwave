import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { createReleasesClient } from './releases.js';

function createMockOctokit() {
  return {
    rest: {
      git: {
        createRef: vi.fn(),
        createTag: vi.fn(),
        deleteRef: vi.fn(),
      },
      repos: {
        createRelease: vi.fn(),
      },
    },
  };
}

describe('ReleasesClient', () => {
  let mock: ReturnType<typeof createMockOctokit>;
  let client: ReturnType<typeof createReleasesClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createMockOctokit();
    client = createReleasesClient(mock as unknown as Octokit);
  });

  describe('createTagRef', () => {
    it('creates a lightweight tag ref', async () => {
      mock.rest.git.createRef.mockResolvedValue({
        data: { ref: 'refs/tags/v1.0.0', object: { sha: 'abc' } },
      });

      const result = await client.createTagRef('octocat', 'hello', 'v1.0.0', 'abc');

      expect(mock.rest.git.createRef).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        ref: 'refs/tags/v1.0.0',
        sha: 'abc',
      });
      expect(result).toEqual({ ref: 'refs/tags/v1.0.0', sha: 'abc' });
    });

    it('defends against a missing object field', async () => {
      mock.rest.git.createRef.mockResolvedValue({ data: { ref: 'refs/tags/v1.0.0' } });

      const result = await client.createTagRef('octocat', 'hello', 'v1.0.0', 'abc');

      expect(result).toEqual({ ref: 'refs/tags/v1.0.0', sha: '' });
    });

    it('defends against a completely empty createRef response', async () => {
      mock.rest.git.createRef.mockResolvedValue({ data: {} });

      const result = await client.createTagRef('octocat', 'hello', 'v1.0.0', 'abc');

      expect(result).toEqual({ ref: '', sha: '' });
    });

    it('propagates API errors', async () => {
      mock.rest.git.createRef.mockRejectedValue(new Error('reference already exists'));

      await expect(client.createTagRef('octocat', 'hello', 'v1.0.0', 'abc')).rejects.toThrow(
        'reference already exists'
      );
    });
  });

  describe('createAnnotatedTag', () => {
    it('creates an annotated tag object then a ref pointing at it', async () => {
      mock.rest.git.createTag.mockResolvedValue({ data: { sha: 'tagsha' } });
      mock.rest.git.createRef.mockResolvedValue({ data: { ref: 'refs/tags/v2.0.0' } });

      const result = await client.createAnnotatedTag('octocat', 'hello', {
        tag: 'v2.0.0',
        sha: 'commitsha',
        message: 'Release 2.0.0',
      });

      expect(mock.rest.git.createTag).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        tag: 'v2.0.0',
        message: 'Release 2.0.0',
        object: 'commitsha',
        type: 'commit',
      });
      expect(mock.rest.git.createRef).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        ref: 'refs/tags/v2.0.0',
        sha: 'tagsha',
      });
      expect(result).toEqual({ tag: 'v2.0.0', sha: 'tagsha' });
    });

    it('falls back to the commit SHA when the tag object omits sha', async () => {
      mock.rest.git.createTag.mockResolvedValue({ data: {} });
      mock.rest.git.createRef.mockResolvedValue({ data: {} });

      const result = await client.createAnnotatedTag('octocat', 'hello', {
        tag: 'v2.0.0',
        sha: 'commitsha',
        message: 'Release 2.0.0',
      });

      expect(mock.rest.git.createRef).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        ref: 'refs/tags/v2.0.0',
        sha: 'commitsha',
      });
      expect(result).toEqual({ tag: 'v2.0.0', sha: 'commitsha' });
    });
  });

  describe('deleteTagRef', () => {
    it('deletes a tag ref', async () => {
      mock.rest.git.deleteRef.mockResolvedValue({});

      await client.deleteTagRef('octocat', 'hello', 'v1.0.0');

      expect(mock.rest.git.deleteRef).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        ref: 'tags/v1.0.0',
      });
    });
  });

  describe('create', () => {
    it('creates a release and maps it', async () => {
      mock.rest.repos.createRelease.mockResolvedValue({
        data: {
          id: 1,
          tag_name: 'v1.0.0',
          name: 'Version 1.0.0',
          body: 'Notes',
          draft: false,
          prerelease: false,
          html_url: 'https://github.com/octocat/hello/releases/tag/v1.0.0',
          created_at: '2024-01-01T00:00:00Z',
        },
      });

      const result = await client.create('octocat', 'hello', {
        tag_name: 'v1.0.0',
        name: 'Version 1.0.0',
        body: 'Notes',
        draft: false,
        prerelease: false,
        target_commitish: 'main',
      });

      expect(mock.rest.repos.createRelease).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        tag_name: 'v1.0.0',
        name: 'Version 1.0.0',
        body: 'Notes',
        draft: false,
        prerelease: false,
        target_commitish: 'main',
      });
      expect(result).toEqual({
        id: 1,
        tag_name: 'v1.0.0',
        name: 'Version 1.0.0',
        body: 'Notes',
        draft: false,
        prerelease: false,
        html_url: 'https://github.com/octocat/hello/releases/tag/v1.0.0',
        created_at: '2024-01-01T00:00:00Z',
      });
    });

    it('defaults the name to the tag name and defends against missing fields', async () => {
      mock.rest.repos.createRelease.mockResolvedValue({ data: { id: 2, tag_name: 'v0.2.0' } });

      const result = await client.create('octocat', 'hello', { tag_name: 'v0.2.0' });

      expect(mock.rest.repos.createRelease).toHaveBeenCalledWith({
        owner: 'octocat',
        repo: 'hello',
        tag_name: 'v0.2.0',
        name: 'v0.2.0',
        body: undefined,
        draft: undefined,
        prerelease: undefined,
        target_commitish: undefined,
      });
      expect(result).toEqual({
        id: 2,
        tag_name: 'v0.2.0',
        name: undefined,
        body: undefined,
        draft: false,
        prerelease: false,
        html_url: '',
        created_at: '',
      });
    });

    it('normalizes a fully sparse release response (mapRelease defaults — no tag_name)', async () => {
      mock.rest.repos.createRelease.mockResolvedValue({ data: { id: 3 } });

      const result = await client.create('octocat', 'hello', { tag_name: 'v0.3.0' });

      expect(result).toEqual({
        id: 3,
        tag_name: '',
        name: undefined,
        body: undefined,
        draft: false,
        prerelease: false,
        html_url: '',
        created_at: '',
      });
    });
  });
});
