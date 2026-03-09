import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { createReleaseTools } from './release-tools.js';
import type { GitLabClient } from '../client.js';

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

describe('release-tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  describe('createTag', () => {
    it('creates tag successfully', async () => {
      const mockTag = {
        name: 'v1.0.0',
        message: 'Release version 1.0.0',
        target: 'main',
        commit: {
          id: 'abc123',
          short_id: 'abc123',
          title: 'Initial commit',
        },
      };

      mockClient.createTag.mockResolvedValue(mockTag);

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createTag')?.handler;

      const result = await handler!({
        project_id: 'my-project',
        tag_name: 'v1.0.0',
        ref: 'main',
        message: 'Release version 1.0.0',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockTag, null, 2),
          },
        ],
      });
      expect(mockClient.createTag).toHaveBeenCalledWith('my-project', {
        tag_name: 'v1.0.0',
        ref: 'main',
        message: 'Release version 1.0.0',
      });
    });

    it('creates tag with numeric project_id', async () => {
      const mockTag = {
        name: 'v2.0.0',
        message: 'Major release',
        target: 'develop',
        commit: {
          id: 'def456',
          short_id: 'def456',
          title: 'Feature complete',
        },
      };

      mockClient.createTag.mockResolvedValue(mockTag);

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createTag')?.handler;

      const result = await handler!({
        project_id: 123,
        tag_name: 'v2.0.0',
        ref: 'develop',
        message: 'Major release',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockTag, null, 2),
          },
        ],
      });
      expect(mockClient.createTag).toHaveBeenCalledWith(123, {
        tag_name: 'v2.0.0',
        ref: 'develop',
        message: 'Major release',
      });
    });

    it('creates tag without message', async () => {
      const mockTag = {
        name: 'v1.1.0',
        target: 'main',
        commit: {
          id: 'ghi789',
          short_id: 'ghi789',
          title: 'Bug fixes',
        },
      };

      mockClient.createTag.mockResolvedValue(mockTag);

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createTag')?.handler;

      const result = await handler!({
        project_id: 'my-project',
        tag_name: 'v1.1.0',
        ref: 'main',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockTag, null, 2),
          },
        ],
      });
      expect(mockClient.createTag).toHaveBeenCalledWith('my-project', {
        tag_name: 'v1.1.0',
        ref: 'main',
      });
    });

    it('creates tag from specific commit SHA', async () => {
      const mockTag = {
        name: 'v1.0.1',
        message: 'Hotfix release',
        target: 'abc123def456',
        commit: {
          id: 'abc123def456',
          short_id: 'abc123d',
          title: 'Fix critical bug',
        },
      };

      mockClient.createTag.mockResolvedValue(mockTag);

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createTag')?.handler;

      const result = await handler!({
        project_id: 'my-project',
        tag_name: 'v1.0.1',
        ref: 'abc123def456',
        message: 'Hotfix release',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockTag, null, 2),
          },
        ],
      });
      expect(mockClient.createTag).toHaveBeenCalledWith('my-project', {
        tag_name: 'v1.0.1',
        ref: 'abc123def456',
        message: 'Hotfix release',
      });
    });

    it('handles tag already exists error', async () => {
      mockClient.createTag.mockRejectedValue(new Error('Tag already exists'));

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createTag')?.handler;

      const result = await handler!({
        project_id: 'my-project',
        tag_name: 'v1.0.0',
        ref: 'main',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Tag already exists' }],
        isError: true,
      });
    });

    it('handles invalid ref error', async () => {
      mockClient.createTag.mockRejectedValue(new Error('Invalid reference name'));

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createTag')?.handler;

      const result = await handler!({
        project_id: 'my-project',
        tag_name: 'v1.0.0',
        ref: 'non-existent-branch',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Invalid reference name' }],
        isError: true,
      });
    });

    it('handles permission errors', async () => {
      mockClient.createTag.mockRejectedValue(
        new Error('Permission denied. Your GitLab token may not have sufficient permissions.')
      );

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createTag')?.handler;

      const result = await handler!({
        project_id: 'private-project',
        tag_name: 'v1.0.0',
        ref: 'main',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: Permission denied. Your GitLab token may not have sufficient permissions.',
          },
        ],
        isError: true,
      });
    });

    it('handles not found error', async () => {
      mockClient.createTag.mockRejectedValue(new Error('404 not found'));

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createTag')?.handler;

      const result = await handler!({
        project_id: 'non-existent-project',
        tag_name: 'v1.0.0',
        ref: 'main',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });
  });

  describe('deleteTag', () => {
    it('deletes tag successfully', async () => {
      mockClient.deleteTag.mockResolvedValue(undefined);

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteTag')?.handler;

      const result = await handler!({
        project_id: 'my-project',
        tag_name: 'v1.0.0',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: true, message: "Tag 'v1.0.0' deleted successfully" },
              null,
              2
            ),
          },
        ],
      });
      expect(mockClient.deleteTag).toHaveBeenCalledWith('my-project', 'v1.0.0');
    });

    it('deletes tag with numeric project_id', async () => {
      mockClient.deleteTag.mockResolvedValue(undefined);

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteTag')?.handler;

      const result = await handler!({
        project_id: 456,
        tag_name: 'v2.0.0',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: true, message: "Tag 'v2.0.0' deleted successfully" },
              null,
              2
            ),
          },
        ],
      });
      expect(mockClient.deleteTag).toHaveBeenCalledWith(456, 'v2.0.0');
    });

    it('deletes tag with special characters', async () => {
      mockClient.deleteTag.mockResolvedValue(undefined);

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteTag')?.handler;

      const result = await handler!({
        project_id: 'my-project',
        tag_name: 'release/v1.0.0-beta.1',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: true, message: "Tag 'release/v1.0.0-beta.1' deleted successfully" },
              null,
              2
            ),
          },
        ],
      });
      expect(mockClient.deleteTag).toHaveBeenCalledWith('my-project', 'release/v1.0.0-beta.1');
    });

    it('handles tag not found error', async () => {
      mockClient.deleteTag.mockRejectedValue(new Error('Tag not found'));

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteTag')?.handler;

      const result = await handler!({
        project_id: 'my-project',
        tag_name: 'non-existent-tag',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('handles permission errors', async () => {
      mockClient.deleteTag.mockRejectedValue(
        new Error('Permission denied. Your GitLab token may not have sufficient permissions.')
      );

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteTag')?.handler;

      const result = await handler!({
        project_id: 'private-project',
        tag_name: 'v1.0.0',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: Permission denied. Your GitLab token may not have sufficient permissions.',
          },
        ],
        isError: true,
      });
    });

    it('handles protected tag error', async () => {
      mockClient.deleteTag.mockRejectedValue(new Error('Protected tag cannot be deleted'));

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteTag')?.handler;

      const result = await handler!({
        project_id: 'my-project',
        tag_name: 'protected-tag',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Protected tag cannot be deleted' }],
        isError: true,
      });
    });

    it('handles not found error', async () => {
      mockClient.deleteTag.mockRejectedValue(new Error('404 not found'));

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'deleteTag')?.handler;

      const result = await handler!({
        project_id: 'non-existent-project',
        tag_name: 'v1.0.0',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });
  });

  describe('createRelease', () => {
    it('creates release successfully', async () => {
      const mockRelease = {
        tag_name: 'v1.0.0',
        name: 'Version 1.0.0',
        description: 'Initial release with core features',
        created_at: '2024-01-15T10:00:00Z',
        released_at: '2024-01-15T10:00:00Z',
        author: {
          name: 'John Doe',
          username: 'johndoe',
        },
      };

      mockClient.createRelease.mockResolvedValue(mockRelease);

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createRelease')?.handler;

      const result = await handler!({
        project_id: 'my-project',
        tag_name: 'v1.0.0',
        name: 'Version 1.0.0',
        description: 'Initial release with core features',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockRelease, null, 2),
          },
        ],
      });
      expect(mockClient.createRelease).toHaveBeenCalledWith('my-project', {
        tag_name: 'v1.0.0',
        name: 'Version 1.0.0',
        description: 'Initial release with core features',
      });
    });

    it('creates release with numeric project_id', async () => {
      const mockRelease = {
        tag_name: 'v2.0.0',
        name: 'Version 2.0.0',
        description: 'Major update with breaking changes',
        created_at: '2024-02-01T12:00:00Z',
        released_at: '2024-02-01T12:00:00Z',
      };

      mockClient.createRelease.mockResolvedValue(mockRelease);

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createRelease')?.handler;

      const result = await handler!({
        project_id: 789,
        tag_name: 'v2.0.0',
        name: 'Version 2.0.0',
        description: 'Major update with breaking changes',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockRelease, null, 2),
          },
        ],
      });
      expect(mockClient.createRelease).toHaveBeenCalledWith(789, {
        tag_name: 'v2.0.0',
        name: 'Version 2.0.0',
        description: 'Major update with breaking changes',
      });
    });

    it('creates release without optional fields', async () => {
      const mockRelease = {
        tag_name: 'v1.1.0',
        name: 'v1.1.0',
        created_at: '2024-01-20T14:00:00Z',
        released_at: '2024-01-20T14:00:00Z',
      };

      mockClient.createRelease.mockResolvedValue(mockRelease);

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createRelease')?.handler;

      const result = await handler!({
        project_id: 'my-project',
        tag_name: 'v1.1.0',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockRelease, null, 2),
          },
        ],
      });
      expect(mockClient.createRelease).toHaveBeenCalledWith('my-project', {
        tag_name: 'v1.1.0',
      });
    });

    it('creates release with markdown description', async () => {
      const description = `## What's Changed
- Feature A added
- Bug B fixed
- Performance improvements

## Breaking Changes
- API endpoint /old removed

**Full Changelog**: v1.0.0...v2.0.0`;

      const mockRelease = {
        tag_name: 'v2.0.0',
        name: 'Version 2.0.0 - Major Update',
        description,
        created_at: '2024-03-01T09:00:00Z',
        released_at: '2024-03-01T09:00:00Z',
      };

      mockClient.createRelease.mockResolvedValue(mockRelease);

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createRelease')?.handler;

      const result = await handler!({
        project_id: 'my-project',
        tag_name: 'v2.0.0',
        name: 'Version 2.0.0 - Major Update',
        description,
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockRelease, null, 2),
          },
        ],
      });
      expect(mockClient.createRelease).toHaveBeenCalledWith('my-project', {
        tag_name: 'v2.0.0',
        name: 'Version 2.0.0 - Major Update',
        description,
      });
    });

    it('handles tag not found error', async () => {
      mockClient.createRelease.mockRejectedValue(new Error('Tag does not exist'));

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createRelease')?.handler;

      const result = await handler!({
        project_id: 'my-project',
        tag_name: 'non-existent-tag',
        name: 'Release',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Tag does not exist' }],
        isError: true,
      });
    });

    it('handles release already exists error', async () => {
      mockClient.createRelease.mockRejectedValue(new Error('Release already exists'));

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createRelease')?.handler;

      const result = await handler!({
        project_id: 'my-project',
        tag_name: 'v1.0.0',
        name: 'Version 1.0.0',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Release already exists' }],
        isError: true,
      });
    });

    it('handles permission errors', async () => {
      mockClient.createRelease.mockRejectedValue(
        new Error('Permission denied. Your GitLab token may not have sufficient permissions.')
      );

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createRelease')?.handler;

      const result = await handler!({
        project_id: 'private-project',
        tag_name: 'v1.0.0',
        name: 'Release',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: Permission denied. Your GitLab token may not have sufficient permissions.',
          },
        ],
        isError: true,
      });
    });

    it('handles not found error', async () => {
      mockClient.createRelease.mockRejectedValue(new Error('404 not found'));

      const tools = createReleaseTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createRelease')?.handler;

      const result = await handler!({
        project_id: 'non-existent-project',
        tag_name: 'v1.0.0',
        name: 'Release',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });
  });

  describe('unconfigured client', () => {
    it('returns error for all tools when client is null', async () => {
      const tools = createReleaseTools(null);

      expect(tools).toHaveLength(3);

      for (const { tool, handler } of tools) {
        const result = await handler({});
        expect(result).toEqual({
          content: [
            { type: 'text', text: 'Error: GitLab not configured. Run: speedwave setup gitlab' },
          ],
          isError: true,
        });
      }
    });

    it('returns error for create_tag when client is null', async () => {
      const tools = createReleaseTools(null);
      const handler = tools.find((t) => t.tool.name === 'createTag')?.handler;

      const result = await handler!({
        project_id: 'test',
        tag_name: 'v1.0.0',
        ref: 'main',
      });

      expect(result).toEqual({
        content: [
          { type: 'text', text: 'Error: GitLab not configured. Run: speedwave setup gitlab' },
        ],
        isError: true,
      });
    });

    it('returns error for delete_tag when client is null', async () => {
      const tools = createReleaseTools(null);
      const handler = tools.find((t) => t.tool.name === 'deleteTag')?.handler;

      const result = await handler!({
        project_id: 'test',
        tag_name: 'v1.0.0',
      });

      expect(result).toEqual({
        content: [
          { type: 'text', text: 'Error: GitLab not configured. Run: speedwave setup gitlab' },
        ],
        isError: true,
      });
    });

    it('returns error for create_release when client is null', async () => {
      const tools = createReleaseTools(null);
      const handler = tools.find((t) => t.tool.name === 'createRelease')?.handler;

      const result = await handler!({
        project_id: 'test',
        tag_name: 'v1.0.0',
        name: 'Release',
      });

      expect(result).toEqual({
        content: [
          { type: 'text', text: 'Error: GitLab not configured. Run: speedwave setup gitlab' },
        ],
        isError: true,
      });
    });
  });
});
