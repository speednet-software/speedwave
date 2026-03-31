/**
 * Discussion Tools Tests - 2 tools for GitLab MR discussions
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage, withSetupGuidance } from '@speedwave/mcp-shared';
import { createDiscussionTools } from './discussion-tools.js';
import type { GitLabClient } from '../client.js';

type MockClient = {
  listMrDiscussions: Mock;
  createMrDiscussion: Mock;
};

const createMockClient = (): MockClient => ({
  listMrDiscussions: vi.fn(),
  createMrDiscussion: vi.fn(),
});

describe('discussion-tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  describe('listMrDiscussions', () => {
    it('lists discussions successfully with default limit', async () => {
      const mockDiscussions = [
        {
          id: 'disc1',
          notes: [
            {
              id: 1,
              body: 'Thread comment 1',
              author: { id: 1, username: 'user1', name: 'User One' },
              created_at: '2023-01-01T00:00:00Z',
              system: false,
              resolvable: true,
              resolved: false,
            },
          ],
        },
        {
          id: 'disc2',
          notes: [
            {
              id: 2,
              body: 'Thread comment 2',
              author: { id: 2, username: 'user2', name: 'User Two' },
              created_at: '2023-01-02T00:00:00Z',
              system: false,
              resolvable: true,
              resolved: true,
            },
          ],
        },
      ];

      mockClient.listMrDiscussions.mockResolvedValue(mockDiscussions);

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listMrDiscussions')?.handler;

      const result = await handler!({ project_id: 1, mr_iid: 10 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockDiscussions, null, 2),
          },
        ],
      });
      expect(mockClient.listMrDiscussions).toHaveBeenCalledWith(1, 10, undefined);
    });

    it('lists discussions with custom limit', async () => {
      const mockDiscussions = Array.from({ length: 50 }, (_, i) => ({
        id: `disc${i}`,
        notes: [
          {
            id: i,
            body: `Discussion ${i}`,
            author: { id: 1, username: 'user', name: 'User' },
            created_at: '2023-01-01T00:00:00Z',
            system: false,
            resolvable: false,
          },
        ],
      }));

      mockClient.listMrDiscussions.mockResolvedValue(mockDiscussions);

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listMrDiscussions')?.handler;

      const result = await handler!({ project_id: 1, mr_iid: 10, limit: 50 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockDiscussions, null, 2),
          },
        ],
      });
      expect(mockClient.listMrDiscussions).toHaveBeenCalledWith(1, 10, 50);
    });

    it('lists discussions with project path string', async () => {
      const mockDiscussions = [
        {
          id: 'disc1',
          notes: [
            {
              id: 1,
              body: 'Comment',
              author: { id: 1, username: 'user', name: 'User' },
              created_at: '2023-01-01T00:00:00Z',
              system: false,
              resolvable: false,
            },
          ],
        },
      ];

      mockClient.listMrDiscussions.mockResolvedValue(mockDiscussions);

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listMrDiscussions')?.handler;

      const result = await handler!({ project_id: 'group/project', mr_iid: 10 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockDiscussions, null, 2),
          },
        ],
      });
      expect(mockClient.listMrDiscussions).toHaveBeenCalledWith('group/project', 10, undefined);
    });

    it('returns empty array when no discussions found', async () => {
      mockClient.listMrDiscussions.mockResolvedValue([]);

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listMrDiscussions')?.handler;

      const result = await handler!({ project_id: 1, mr_iid: 10 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify([], null, 2),
          },
        ],
      });
    });

    it('handles discussions with multiple notes in a thread', async () => {
      const mockDiscussions = [
        {
          id: 'disc1',
          notes: [
            {
              id: 1,
              body: 'First comment in thread',
              author: { id: 1, username: 'user1', name: 'User One' },
              created_at: '2023-01-01T00:00:00Z',
              system: false,
              resolvable: true,
              resolved: false,
            },
            {
              id: 2,
              body: 'Reply to first comment',
              author: { id: 2, username: 'user2', name: 'User Two' },
              created_at: '2023-01-02T00:00:00Z',
              system: false,
              resolvable: true,
              resolved: false,
            },
            {
              id: 3,
              body: 'Another reply',
              author: { id: 1, username: 'user1', name: 'User One' },
              created_at: '2023-01-03T00:00:00Z',
              system: false,
              resolvable: true,
              resolved: true,
            },
          ],
        },
      ];

      mockClient.listMrDiscussions.mockResolvedValue(mockDiscussions);

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listMrDiscussions')?.handler;

      const result = await handler!({ project_id: 1, mr_iid: 10 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockDiscussions, null, 2),
          },
        ],
      });
      const resultData = JSON.parse(result.content[0].text);
      expect(resultData[0].notes).toHaveLength(3);
    });

    it('handles system notes in discussions', async () => {
      const mockDiscussions = [
        {
          id: 'disc1',
          notes: [
            {
              id: 1,
              body: 'changed the title',
              author: { id: 1, username: 'user', name: 'User' },
              created_at: '2023-01-01T00:00:00Z',
              system: true,
              resolvable: false,
            },
          ],
        },
      ];

      mockClient.listMrDiscussions.mockResolvedValue(mockDiscussions);

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listMrDiscussions')?.handler;

      const result = await handler!({ project_id: 1, mr_iid: 10 });

      const resultData = JSON.parse(result.content[0].text);
      expect(resultData[0].notes[0].system).toBe(true);
    });

    it('handles API errors gracefully', async () => {
      mockClient.listMrDiscussions.mockRejectedValue(new Error('Merge request not found'));

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listMrDiscussions')?.handler;

      const result = await handler!({ project_id: 1, mr_iid: 9999 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('handles network errors', async () => {
      mockClient.listMrDiscussions.mockRejectedValue(new Error('Network error'));

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listMrDiscussions')?.handler;

      const result = await handler!({ project_id: 1, mr_iid: 10 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${withSetupGuidance('Network error. Check your GitLab URL.')}`,
          },
        ],
        isError: true,
      });
    });

    it('handles permission errors', async () => {
      mockClient.listMrDiscussions.mockRejectedValue(new Error('403 Forbidden'));

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listMrDiscussions')?.handler;

      const result = await handler!({ project_id: 1, mr_iid: 10 });

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
  });

  describe('createMrDiscussion', () => {
    it('creates discussion successfully', async () => {
      const mockDiscussion = {
        id: 'disc1',
        notes: [
          {
            id: 1,
            body: 'Start of discussion',
            author: { id: 1, username: 'johndoe', name: 'John Doe' },
            created_at: '2023-01-01T00:00:00Z',
            system: false,
            resolvable: true,
            resolved: false,
          },
        ],
      };

      mockClient.createMrDiscussion.mockResolvedValue(mockDiscussion);

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createMrDiscussion')?.handler;

      const result = await handler!({
        project_id: 1,
        mr_iid: 10,
        body: 'Start of discussion',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockDiscussion, null, 2),
          },
        ],
      });
      expect(mockClient.createMrDiscussion).toHaveBeenCalledWith(1, 10, 'Start of discussion');
    });

    it('creates discussion with project path string', async () => {
      const mockDiscussion = {
        id: 'disc1',
        notes: [
          {
            id: 1,
            body: 'Discussion comment',
            author: { id: 1, username: 'user', name: 'User' },
            created_at: '2023-01-01T00:00:00Z',
            system: false,
            resolvable: false,
          },
        ],
      };

      mockClient.createMrDiscussion.mockResolvedValue(mockDiscussion);

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createMrDiscussion')?.handler;

      const result = await handler!({
        project_id: 'group/project',
        mr_iid: 10,
        body: 'Discussion comment',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockDiscussion, null, 2),
          },
        ],
      });
      expect(mockClient.createMrDiscussion).toHaveBeenCalledWith(
        'group/project',
        10,
        'Discussion comment'
      );
    });

    it('creates discussion with markdown formatting', async () => {
      const markdownBody = '**Important:** This needs attention\n\n- Point 1\n- Point 2';
      const mockDiscussion = {
        id: 'disc1',
        notes: [
          {
            id: 1,
            body: markdownBody,
            author: { id: 1, username: 'user', name: 'User' },
            created_at: '2023-01-01T00:00:00Z',
            system: false,
            resolvable: true,
            resolved: false,
          },
        ],
      };

      mockClient.createMrDiscussion.mockResolvedValue(mockDiscussion);

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createMrDiscussion')?.handler;

      const result = await handler!({
        project_id: 1,
        mr_iid: 10,
        body: markdownBody,
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockDiscussion, null, 2),
          },
        ],
      });
      expect(mockClient.createMrDiscussion).toHaveBeenCalledWith(1, 10, markdownBody);
    });

    it('creates discussion with numeric project ID', async () => {
      const mockDiscussion = {
        id: 'disc1',
        notes: [
          {
            id: 1,
            body: 'Comment',
            author: { id: 1, username: 'user', name: 'User' },
            created_at: '2023-01-01T00:00:00Z',
            system: false,
            resolvable: false,
          },
        ],
      };

      mockClient.createMrDiscussion.mockResolvedValue(mockDiscussion);

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createMrDiscussion')?.handler;

      const result = await handler!({
        project_id: 42,
        mr_iid: 10,
        body: 'Comment',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockDiscussion, null, 2),
          },
        ],
      });
      expect(mockClient.createMrDiscussion).toHaveBeenCalledWith(42, 10, 'Comment');
    });

    it('handles merge request not found error', async () => {
      mockClient.createMrDiscussion.mockRejectedValue(new Error('404 Not Found'));

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createMrDiscussion')?.handler;

      const result = await handler!({
        project_id: 1,
        mr_iid: 9999,
        body: 'Comment',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('handles permission errors', async () => {
      mockClient.createMrDiscussion.mockRejectedValue(new Error('403 Forbidden'));

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createMrDiscussion')?.handler;

      const result = await handler!({
        project_id: 1,
        mr_iid: 10,
        body: 'Comment',
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

    it('handles validation errors for empty body', async () => {
      mockClient.createMrDiscussion.mockRejectedValue(
        new Error('Validation failed: body cannot be empty')
      );

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createMrDiscussion')?.handler;

      const result = await handler!({
        project_id: 1,
        mr_iid: 10,
        body: '',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Validation failed: body cannot be empty' }],
        isError: true,
      });
    });

    it('handles network errors', async () => {
      mockClient.createMrDiscussion.mockRejectedValue(new Error('ECONNREFUSED'));

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createMrDiscussion')?.handler;

      const result = await handler!({
        project_id: 1,
        mr_iid: 10,
        body: 'Comment',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${withSetupGuidance('Network error. Check your GitLab URL.')}`,
          },
        ],
        isError: true,
      });
    });

    it('handles authentication errors', async () => {
      mockClient.createMrDiscussion.mockRejectedValue(new Error('401 Unauthorized'));

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createMrDiscussion')?.handler;

      const result = await handler!({
        project_id: 1,
        mr_iid: 10,
        body: 'Comment',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${withSetupGuidance('Authentication failed. Check your GitLab token.')}`,
          },
        ],
        isError: true,
      });
    });
  });

  describe('unconfigured client', () => {
    it('returns error for all tools when client is null', async () => {
      const tools = createDiscussionTools(null);

      expect(tools).toHaveLength(2);

      for (const { tool, handler } of tools) {
        const result = await handler({});
        expect(result).toEqual({
          content: [
            {
              type: 'text',
              text: `Error: ${notConfiguredMessage('GitLab')}`,
            },
          ],
          isError: true,
        });
      }
    });

    it('returns error for list_mr_discussions when client is null', async () => {
      const tools = createDiscussionTools(null);
      const handler = tools.find((t) => t.tool.name === 'listMrDiscussions')?.handler;

      const result = await handler!({ project_id: 1, mr_iid: 10 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });

    it('returns error for create_mr_discussion when client is null', async () => {
      const tools = createDiscussionTools(null);
      const handler = tools.find((t) => t.tool.name === 'createMrDiscussion')?.handler;

      const result = await handler!({
        project_id: 1,
        mr_iid: 10,
        body: 'Comment',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: `Error: ${notConfiguredMessage('GitLab')}`,
          },
        ],
        isError: true,
      });
    });
  });
});
