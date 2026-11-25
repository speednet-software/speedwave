/**
 * Discussion Tools Tests - 2 tools for GitLab MR discussions
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { META_KEYS, notConfiguredMessage, withSetupGuidance } from '@speedwave/mcp-shared';
import { createDiscussionTools } from './discussion-tools.js';
import {
  expectEmittedKeysDeclared,
  expectNotFoundTeachingError,
  expectPermissionTeachingError,
} from './test-helpers.js';
import type { GitLabClient } from '../client.js';

const CLIENT_METHODS = [
  'listMrDiscussions',
  'createMrDiscussion',
  'createMrDiscussionNote',
  'updateMrDiscussionNote',
  'deleteMrDiscussionNote',
  'resolveMrDiscussion',
  'createMrDraftNote',
  'updateMrDraftNote',
  'deleteMrDraftNote',
  'listMrDraftNotes',
  'publishMrDraftNote',
  'publishMrDraftNotes',
] as const;

type MockClient = Record<(typeof CLIENT_METHODS)[number], Mock>;

const createMockClient = (): MockClient =>
  Object.fromEntries(CLIENT_METHODS.map((m) => [m, vi.fn()])) as MockClient;

const WRITE_TOOLS = [
  'createMrDiscussion',
  'createMrDiscussionNote',
  'updateMrDiscussionNote',
  'deleteMrDiscussionNote',
  'resolveMrDiscussion',
  'createMrDraftNote',
  'updateMrDraftNote',
  'deleteMrDraftNote',
  'publishMrDraftNote',
  'publishMrDraftNotes',
];

const READ_TOOLS = ['listMrDiscussions', 'listMrDraftNotes'];

const DELETE_TOOLS = ['deleteMrDiscussionNote', 'deleteMrDraftNote'];

const ORPHAN_ANCHORS = [
  ['createMrDiscussion', { body: 'b' }],
  ['createMrDraftNote', { note: 'n' }],
  ['updateMrDraftNote', { draft_note_id: 3 }],
] as const;

const run = async (client: MockClient, name: string, params: Record<string, unknown>) => {
  const tools = createDiscussionTools(client as unknown as GitLabClient);
  return tools.find((t) => t.tool.name === name)!.handler(params);
};

const parse = (result: Awaited<ReturnType<typeof run>>) =>
  JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;

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

      expectNotFoundTeachingError(result);
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

      expectPermissionTeachingError(result);
    });

    it('accepts a numeric-string mr_iid', async () => {
      mockClient.listMrDiscussions.mockResolvedValue([]);

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listMrDiscussions')?.handler;

      await handler!({ project_id: 1, mr_iid: '10' });

      expect(mockClient.listMrDiscussions).toHaveBeenCalledWith(1, 10, undefined);
    });

    it('returns a teaching error for a non-numeric mr_iid without calling the client', async () => {
      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listMrDiscussions')?.handler;

      const result = await handler!({ project_id: 1, mr_iid: 'invalid' });

      expect(result.isError).toBe(true);
      expect(mockClient.listMrDiscussions).not.toHaveBeenCalled();
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
      expect(mockClient.createMrDiscussion).toHaveBeenCalledWith(1, 10, 'Start of discussion', {});
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
        'Discussion comment',
        {}
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
      expect(mockClient.createMrDiscussion).toHaveBeenCalledWith(1, 10, markdownBody, {});
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
      expect(mockClient.createMrDiscussion).toHaveBeenCalledWith(42, 10, 'Comment', {});
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

      expectNotFoundTeachingError(result);
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

      expectPermissionTeachingError(result);
    });

    it('accepts a "#"-prefixed mr_iid', async () => {
      mockClient.createMrDiscussion.mockResolvedValue({ id: 'disc1', notes: [] });

      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createMrDiscussion')?.handler;

      await handler!({ project_id: 1, mr_iid: '#10', body: 'Comment' });

      expect(mockClient.createMrDiscussion).toHaveBeenCalledWith(1, 10, 'Comment', {});
    });

    it('states in its description that the discussion is posted as the authenticated user', () => {
      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'createMrDiscussion')?.tool;

      expect(tool?.description).toContain('authenticated GitLab user');
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

    it('returns a teaching error and skips the client call for an invalid mr_iid', async () => {
      const tools = createDiscussionTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createMrDiscussion')?.handler;

      const result = await handler!({ project_id: 1, mr_iid: 'abc', body: 'Comment' });

      expect(result.isError).toBe(true);
      expect(mockClient.createMrDiscussion).not.toHaveBeenCalled();
    });
  });

  describe('createMrDiscussion with an anchor', () => {
    it('passes path, line, end_line and side to the client', async () => {
      mockClient.createMrDiscussion.mockResolvedValue({ id: 'd1', notes: [] });

      await run(mockClient, 'createMrDiscussion', {
        project_id: 'g/p',
        mr_iid: 10,
        body: 'Null check',
        path: 'src/a.ts',
        line: 42,
        end_line: 45,
        side: 'old',
      });

      expect(mockClient.createMrDiscussion).toHaveBeenCalledWith('g/p', 10, 'Null check', {
        path: 'src/a.ts',
        line: 42,
        end_line: 45,
        side: 'old',
      });
    });

    it('returns GitLab error text for an out-of-diff line', async () => {
      mockClient.createMrDiscussion.mockRejectedValue(
        new Error('400 Bad request - Position is invalid')
      );

      const result = await run(mockClient, 'createMrDiscussion', {
        project_id: 1,
        mr_iid: 10,
        body: 'x',
        path: 'a.ts',
        line: 9999,
      });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('Position is invalid');
    });
  });

  describe('discussion note tools', () => {
    it('creates a reply and returns the note', async () => {
      mockClient.createMrDiscussionNote.mockResolvedValue({ id: 1202, body: 'Done' });

      const result = await run(mockClient, 'createMrDiscussionNote', {
        project_id: 1,
        mr_iid: '#10',
        discussion_id: 'abc',
        body: 'Done',
      });

      expect(mockClient.createMrDiscussionNote).toHaveBeenCalledWith(1, 10, 'abc', 'Done');
      expect(parse(result)).toEqual({ success: true, note: { id: 1202, body: 'Done' } });
    });

    it('updates a note and returns it', async () => {
      mockClient.updateMrDiscussionNote.mockResolvedValue({ id: 1202 });

      const result = await run(mockClient, 'updateMrDiscussionNote', {
        project_id: 1,
        mr_iid: 10,
        discussion_id: 'abc',
        note_id: 1202,
        body: 'Edited',
      });

      expect(mockClient.updateMrDiscussionNote).toHaveBeenCalledWith(1, 10, 'abc', 1202, 'Edited');
      expect(parse(result)).toEqual({ success: true, note: { id: 1202 } });
    });

    it('deletes a note', async () => {
      mockClient.deleteMrDiscussionNote.mockResolvedValue(undefined);

      const result = await run(mockClient, 'deleteMrDiscussionNote', {
        project_id: 1,
        mr_iid: 10,
        discussion_id: 'abc',
        note_id: 1202,
      });

      expect(mockClient.deleteMrDiscussionNote).toHaveBeenCalledWith(1, 10, 'abc', 1202);
      expect(parse(result)).toEqual({ success: true });
    });

    it.each([true, false])('resolves a discussion with resolved %s', async (resolved) => {
      mockClient.resolveMrDiscussion.mockResolvedValue({ id: 'abc', notes: [] });
      const tool = createDiscussionTools(null).find(
        (t) => t.tool.name === 'resolveMrDiscussion'
      )!.tool;

      const result = await run(mockClient, 'resolveMrDiscussion', {
        project_id: 1,
        mr_iid: 10,
        discussion_id: 'abc',
        resolved,
      });

      expect(mockClient.resolveMrDiscussion).toHaveBeenCalledWith(1, 10, 'abc', resolved);
      expectEmittedKeysDeclared(tool, result);
      expect(parse(result)).toEqual({ success: true, discussion: { id: 'abc', notes: [] } });
    });

    it('reports a GitLab failure for a missing discussion', async () => {
      mockClient.createMrDiscussionNote.mockRejectedValue(new Error('404 Not Found'));

      const result = await run(mockClient, 'createMrDiscussionNote', {
        project_id: 1,
        mr_iid: 10,
        discussion_id: 'nope',
        body: 'x',
      });

      expectNotFoundTeachingError(result);
    });

    it('reports a permission failure on delete', async () => {
      mockClient.deleteMrDiscussionNote.mockRejectedValue(new Error('403 Forbidden'));

      const result = await run(mockClient, 'deleteMrDiscussionNote', {
        project_id: 1,
        mr_iid: 10,
        discussion_id: 'abc',
        note_id: 1,
      });

      expectPermissionTeachingError(result);
    });
  });

  describe('draft note tools', () => {
    it('creates an anchored draft note', async () => {
      mockClient.createMrDraftNote.mockResolvedValue({ id: 88, note: 'nit' });

      const result = await run(mockClient, 'createMrDraftNote', {
        project_id: 1,
        mr_iid: 10,
        note: 'nit',
        path: 'a.ts',
        line: 7,
        end_line: 9,
        side: 'new',
      });

      expect(mockClient.createMrDraftNote).toHaveBeenCalledWith(1, 10, {
        note: 'nit',
        path: 'a.ts',
        line: 7,
        end_line: 9,
        side: 'new',
      });
      expect(parse(result)).toEqual({ success: true, draft_note: { id: 88, note: 'nit' } });
    });

    it('creates a draft reply that resolves the discussion', async () => {
      mockClient.createMrDraftNote.mockResolvedValue({ id: 89 });

      await run(mockClient, 'createMrDraftNote', {
        project_id: 1,
        mr_iid: 10,
        note: 'done',
        in_reply_to_discussion_id: 'abc',
        resolve_discussion: true,
      });

      expect(mockClient.createMrDraftNote).toHaveBeenCalledWith(1, 10, {
        note: 'done',
        in_reply_to_discussion_id: 'abc',
        resolve_discussion: true,
      });
    });

    it('updates a draft note', async () => {
      mockClient.updateMrDraftNote.mockResolvedValue({ id: 88 });

      const result = await run(mockClient, 'updateMrDraftNote', {
        project_id: 1,
        mr_iid: 10,
        draft_note_id: 88,
        note: 'reworded',
      });

      expect(mockClient.updateMrDraftNote).toHaveBeenCalledWith(1, 10, 88, { note: 'reworded' });
      expect(parse(result)).toEqual({ success: true, draft_note: { id: 88 } });
    });

    it('deletes a draft note', async () => {
      mockClient.deleteMrDraftNote.mockResolvedValue(undefined);

      const result = await run(mockClient, 'deleteMrDraftNote', {
        project_id: 1,
        mr_iid: 10,
        draft_note_id: 88,
      });

      expect(mockClient.deleteMrDraftNote).toHaveBeenCalledWith(1, 10, 88);
      expect(parse(result)).toEqual({ success: true });
    });

    it('lists draft notes with a count', async () => {
      mockClient.listMrDraftNotes.mockResolvedValue([{ id: 88 }, { id: 89 }]);
      const tool = createDiscussionTools(null).find(
        (t) => t.tool.name === 'listMrDraftNotes'
      )!.tool;

      const result = await run(mockClient, 'listMrDraftNotes', { project_id: 1, mr_iid: 10 });

      expect(mockClient.listMrDraftNotes).toHaveBeenCalledWith(1, 10);
      expect(expectEmittedKeysDeclared(tool, result)).toEqual({
        success: true,
        draft_notes: [{ id: 88 }, { id: 89 }],
        count: 2,
      });
    });

    it('lists no draft notes', async () => {
      mockClient.listMrDraftNotes.mockResolvedValue([]);

      const result = await run(mockClient, 'listMrDraftNotes', { project_id: 1, mr_iid: 10 });

      expect(parse(result)).toEqual({ success: true, draft_notes: [], count: 0 });
    });

    it('publishes one draft note', async () => {
      mockClient.publishMrDraftNote.mockResolvedValue(undefined);

      const result = await run(mockClient, 'publishMrDraftNote', {
        project_id: 1,
        mr_iid: 10,
        draft_note_id: 88,
      });

      expect(mockClient.publishMrDraftNote).toHaveBeenCalledWith(1, 10, 88);
      expect(parse(result)).toEqual({ success: true });
    });

    it('publishes all draft notes with a summary and reviewer state', async () => {
      mockClient.publishMrDraftNotes.mockResolvedValue(undefined);

      const result = await run(mockClient, 'publishMrDraftNotes', {
        project_id: 1,
        mr_iid: 10,
        note: 'Summary',
        internal: false,
        reviewer_state: 'requested_changes',
      });

      expect(mockClient.publishMrDraftNotes).toHaveBeenCalledWith(1, 10, {
        note: 'Summary',
        internal: false,
        reviewer_state: 'requested_changes',
      });
      expect(parse(result)).toEqual({ success: true });
    });

    it('publishes all draft notes without options', async () => {
      mockClient.publishMrDraftNotes.mockResolvedValue(undefined);

      await run(mockClient, 'publishMrDraftNotes', { project_id: 1, mr_iid: 10 });

      expect(mockClient.publishMrDraftNotes).toHaveBeenCalledWith(1, 10, {});
    });

    it('returns the GitLab error when publishing fails', async () => {
      mockClient.publishMrDraftNotes.mockRejectedValue(new Error('403 Forbidden'));

      const result = await run(mockClient, 'publishMrDraftNotes', { project_id: 1, mr_iid: 10 });

      expectPermissionTeachingError(result);
    });
  });

  describe('anchor fields without path', () => {
    it.each(
      ORPHAN_ANCHORS.flatMap(([name, base]) =>
        (['line', 'end_line', 'side'] as const).map((field) => [name, base, field] as const)
      )
    )('%s rejects %s without path and calls no GitLab method', async (name, base, field) => {
      const value = field === 'side' ? 'new' : 5;
      const result = await run(mockClient, name, {
        project_id: 1,
        mr_iid: 10,
        ...base,
        [field]: value,
      });

      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain(field);
      expect((result.content[0] as { text: string }).text).toContain('path');
      expect(mockClient[name].mock.calls).toHaveLength(0);
    });

    it('names every anchor field that was given', async () => {
      const result = await run(mockClient, 'createMrDraftNote', {
        project_id: 1,
        mr_iid: 10,
        note: 'n',
        line: 3,
        end_line: 4,
        side: 'old',
      });

      expect((result.content[0] as { text: string }).text).toContain('line, end_line, side');
    });
  });

  describe('tool classification', () => {
    const toolsByName = new Map(createDiscussionTools(null).map((d) => [d.tool.name, d.tool]));

    it.each(WRITE_TOOLS)('%s changes GitLab state and acts as the current user', (name) => {
      const tool = toolsByName.get(name)!;
      const meta = tool._meta as Record<string, unknown>;

      expect(tool.annotations?.readOnlyHint).toBe(false);
      expect(meta[META_KEYS.USER_SCOPED]).toBe(true);
      expect(meta[META_KEYS.CURRENT_USER_TOOL]).toBe('getCurrentUser');
    });

    it.each(READ_TOOLS)('%s only reads', (name) => {
      const tool = toolsByName.get(name)!;

      expect(tool.annotations?.readOnlyHint).toBe(true);
    });

    it('scopes the draft list to the current user because GitLab keeps drafts per author', () => {
      const meta = toolsByName.get('listMrDraftNotes')!._meta as Record<string, unknown>;

      expect(meta[META_KEYS.USER_SCOPED]).toBe(true);
      expect(meta[META_KEYS.CURRENT_USER_TOOL]).toBe('getCurrentUser');
    });

    it('does not scope the discussion list to a user', () => {
      const meta = toolsByName.get('listMrDiscussions')!._meta as Record<string, unknown>;

      expect(meta[META_KEYS.USER_SCOPED]).toBeUndefined();
    });

    it.each(DELETE_TOOLS)('%s is marked destructive', (name) => {
      expect(toolsByName.get(name)!.annotations?.destructiveHint).toBe(true);
    });

    it.each(WRITE_TOOLS.filter((n) => !DELETE_TOOLS.includes(n)))(
      '%s is not marked destructive',
      (name) => {
        expect(toolsByName.get(name)!.annotations?.destructiveHint).toBeFalsy();
      }
    );

    it('classifies every tool of the module', () => {
      expect([...toolsByName.keys()].sort()).toEqual([...WRITE_TOOLS, ...READ_TOOLS].sort());
    });
  });

  describe('unconfigured client', () => {
    it('returns error for all tools when client is null', async () => {
      const tools = createDiscussionTools(null);

      expect(tools).toHaveLength(12);

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
