/**
 * Tests for MR Notes Tools
 *
 * Tests 4 tools:
 * - list_mr_commits: List commits in a merge request
 * - list_mr_pipelines: List pipelines associated with a merge request
 * - list_mr_notes: List notes/comments on a merge request
 * - create_mr_note: Add a comment/note to a merge request
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage, withSetupGuidance } from '@speedwave/mcp-shared';
import { createMrNotesTools } from './mr-notes-tools.js';
import type { GitLabClient } from '../client.js';

type MockClient = {
  listMrCommits: Mock;
  listMrPipelines: Mock;
  listMrNotes: Mock;
  createMrNote: Mock;
};

describe('createMrNotesTools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = {
      listMrCommits: vi.fn(),
      listMrPipelines: vi.fn(),
      listMrNotes: vi.fn(),
      createMrNote: vi.fn(),
    };
  });

  describe('listMrCommits', () => {
    it('should list commits with required parameters', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          short_id: 'abc123',
          title: 'feat: add new feature',
          message: 'feat: add new feature\n\nDetailed description',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2023-01-01T00:00:00Z',
        },
        {
          id: 'def456',
          short_id: 'def456',
          title: 'fix: bug fix',
          message: 'fix: bug fix',
          author_name: 'Jane Doe',
          author_email: 'jane@example.com',
          created_at: '2023-01-02T00:00:00Z',
        },
      ];

      mockClient.listMrCommits.mockResolvedValue(mockCommits);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrCommits');
      const result = await tool!.handler({ project_id: 'group/project', mr_iid: 10 });

      expect(mockClient.listMrCommits).toHaveBeenCalledWith('group/project', 10, undefined);
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockCommits, null, 2) }],
      });
    });

    it('should list commits with limit parameter', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          short_id: 'abc123',
          title: 'commit 1',
          message: 'commit 1',
          author_name: 'Author',
          author_email: 'author@example.com',
          created_at: '2023-01-01T00:00:00Z',
        },
      ];

      mockClient.listMrCommits.mockResolvedValue(mockCommits);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrCommits');
      const result = await tool!.handler({ project_id: 123, mr_iid: 5, limit: 10 });

      expect(mockClient.listMrCommits).toHaveBeenCalledWith(123, 5, 10);
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockCommits, null, 2) }],
      });
    });

    it('should handle numeric project_id', async () => {
      mockClient.listMrCommits.mockResolvedValue([]);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrCommits');
      await tool!.handler({ project_id: 456, mr_iid: 20 });

      expect(mockClient.listMrCommits).toHaveBeenCalledWith(456, 20, undefined);
    });

    it('should handle string project_id', async () => {
      mockClient.listMrCommits.mockResolvedValue([]);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrCommits');
      await tool!.handler({ project_id: 'namespace/repo', mr_iid: 15 });

      expect(mockClient.listMrCommits).toHaveBeenCalledWith('namespace/repo', 15, undefined);
    });

    it('should handle empty commits array', async () => {
      mockClient.listMrCommits.mockResolvedValue([]);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrCommits');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify([], null, 2) }],
      });
    });

    it('should handle client errors with 404', async () => {
      mockClient.listMrCommits.mockRejectedValue(new Error('404: Not found'));

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrCommits');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('should handle authentication errors', async () => {
      mockClient.listMrCommits.mockRejectedValue(new Error('401: Unauthorized'));

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrCommits');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1 });

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

  describe('listMrPipelines', () => {
    it('should list pipelines with required parameters', async () => {
      const mockPipelines = [
        {
          id: 1,
          status: 'success',
          ref: 'main',
          sha: 'abc123',
          web_url: 'https://gitlab.example.com/pipeline/1',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T01:00:00Z',
        },
        {
          id: 2,
          status: 'running',
          ref: 'feature-branch',
          sha: 'def456',
          web_url: 'https://gitlab.example.com/pipeline/2',
          created_at: '2023-01-02T00:00:00Z',
          updated_at: '2023-01-02T00:30:00Z',
        },
      ];

      mockClient.listMrPipelines.mockResolvedValue(mockPipelines);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrPipelines');
      const result = await tool!.handler({ project_id: 'group/project', mr_iid: 10 });

      expect(mockClient.listMrPipelines).toHaveBeenCalledWith('group/project', 10, undefined);
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockPipelines, null, 2) }],
      });
    });

    it('should list pipelines with limit parameter', async () => {
      const mockPipelines = [
        {
          id: 1,
          status: 'failed',
          ref: 'develop',
          sha: 'abc123',
          web_url: 'https://gitlab.example.com/pipeline/1',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T01:00:00Z',
        },
      ];

      mockClient.listMrPipelines.mockResolvedValue(mockPipelines);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrPipelines');
      const result = await tool!.handler({ project_id: 789, mr_iid: 3, limit: 5 });

      expect(mockClient.listMrPipelines).toHaveBeenCalledWith(789, 3, 5);
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockPipelines, null, 2) }],
      });
    });

    it('should handle numeric project_id', async () => {
      mockClient.listMrPipelines.mockResolvedValue([]);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrPipelines');
      await tool!.handler({ project_id: 100, mr_iid: 50 });

      expect(mockClient.listMrPipelines).toHaveBeenCalledWith(100, 50, undefined);
    });

    it('should handle string project_id', async () => {
      mockClient.listMrPipelines.mockResolvedValue([]);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrPipelines');
      await tool!.handler({ project_id: 'org/repo', mr_iid: 25 });

      expect(mockClient.listMrPipelines).toHaveBeenCalledWith('org/repo', 25, undefined);
    });

    it('should handle empty pipelines array', async () => {
      mockClient.listMrPipelines.mockResolvedValue([]);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrPipelines');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify([], null, 2) }],
      });
    });

    it('should handle network errors', async () => {
      mockClient.listMrPipelines.mockRejectedValue(new Error('Network error'));

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrPipelines');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1 });

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

    it('should handle permission errors', async () => {
      mockClient.listMrPipelines.mockRejectedValue(new Error('403: Forbidden'));

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrPipelines');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1 });

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

  describe('listMrNotes', () => {
    it('should list notes with required parameters', async () => {
      const mockNotes = [
        {
          id: 1,
          body: 'Great work!',
          author: { id: 1, username: 'johndoe', name: 'John Doe' },
          created_at: '2023-01-01T00:00:00Z',
          system: false,
          resolvable: false,
        },
        {
          id: 2,
          body: 'Please address the comments',
          author: { id: 2, username: 'janedoe', name: 'Jane Doe' },
          created_at: '2023-01-02T00:00:00Z',
          system: false,
          resolvable: true,
          resolved: false,
        },
      ];

      mockClient.listMrNotes.mockResolvedValue(mockNotes);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrNotes');
      const result = await tool!.handler({ project_id: 'group/project', mr_iid: 10 });

      expect(mockClient.listMrNotes).toHaveBeenCalledWith('group/project', 10, undefined);
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockNotes, null, 2) }],
      });
    });

    it('should list notes with limit parameter', async () => {
      const mockNotes = [
        {
          id: 1,
          body: 'LGTM',
          author: { id: 1, username: 'user1', name: 'User One' },
          created_at: '2023-01-01T00:00:00Z',
          system: false,
          resolvable: false,
        },
      ];

      mockClient.listMrNotes.mockResolvedValue(mockNotes);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrNotes');
      const result = await tool!.handler({ project_id: 123, mr_iid: 7, limit: 15 });

      expect(mockClient.listMrNotes).toHaveBeenCalledWith(123, 7, 15);
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockNotes, null, 2) }],
      });
    });

    it('should handle system notes', async () => {
      const mockNotes = [
        {
          id: 1,
          body: 'approved this merge request',
          author: { id: 1, username: 'admin', name: 'Admin' },
          created_at: '2023-01-01T00:00:00Z',
          system: true,
          resolvable: false,
        },
      ];

      mockClient.listMrNotes.mockResolvedValue(mockNotes);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrNotes');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockNotes, null, 2) }],
      });
    });

    it('should handle numeric project_id', async () => {
      mockClient.listMrNotes.mockResolvedValue([]);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrNotes');
      await tool!.handler({ project_id: 200, mr_iid: 30 });

      expect(mockClient.listMrNotes).toHaveBeenCalledWith(200, 30, undefined);
    });

    it('should handle string project_id', async () => {
      mockClient.listMrNotes.mockResolvedValue([]);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrNotes');
      await tool!.handler({ project_id: 'team/app', mr_iid: 40 });

      expect(mockClient.listMrNotes).toHaveBeenCalledWith('team/app', 40, undefined);
    });

    it('should handle empty notes array', async () => {
      mockClient.listMrNotes.mockResolvedValue([]);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrNotes');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify([], null, 2) }],
      });
    });

    it('should handle generic errors', async () => {
      mockClient.listMrNotes.mockRejectedValue(new Error('Something went wrong'));

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrNotes');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Something went wrong' }],
        isError: true,
      });
    });

    it('should handle server errors', async () => {
      const error = new Error('Server error');
      Object.assign(error, { response: { status: 500 } });
      mockClient.listMrNotes.mockRejectedValue(error);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrNotes');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: GitLab server error. Please try again later.' }],
        isError: true,
      });
    });
  });

  describe('createMrNote', () => {
    it('should create note with required parameters', async () => {
      const mockNote = {
        id: 1,
        body: 'This looks good to me!',
        author: { id: 1, username: 'johndoe', name: 'John Doe' },
        created_at: '2023-01-01T00:00:00Z',
        system: false,
        resolvable: false,
      };

      mockClient.createMrNote.mockResolvedValue(mockNote);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'createMrNote');
      const result = await tool!.handler({
        project_id: 'group/project',
        mr_iid: 10,
        body: 'This looks good to me!',
      });

      expect(mockClient.createMrNote).toHaveBeenCalledWith(
        'group/project',
        10,
        'This looks good to me!'
      );
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockNote, null, 2) }],
      });
    });

    it('should create note with markdown formatting', async () => {
      const mockNote = {
        id: 2,
        body: '**Important**: Please fix the typo in line 42',
        author: { id: 2, username: 'reviewer', name: 'Reviewer' },
        created_at: '2023-01-01T00:00:00Z',
        system: false,
        resolvable: true,
      };

      mockClient.createMrNote.mockResolvedValue(mockNote);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'createMrNote');
      const result = await tool!.handler({
        project_id: 456,
        mr_iid: 20,
        body: '**Important**: Please fix the typo in line 42',
      });

      expect(mockClient.createMrNote).toHaveBeenCalledWith(
        456,
        20,
        '**Important**: Please fix the typo in line 42'
      );
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockNote, null, 2) }],
      });
    });

    it('should create note with multiline text', async () => {
      const noteBody = 'First line\nSecond line\nThird line';
      const mockNote = {
        id: 3,
        body: noteBody,
        author: { id: 3, username: 'user3', name: 'User Three' },
        created_at: '2023-01-01T00:00:00Z',
        system: false,
        resolvable: false,
      };

      mockClient.createMrNote.mockResolvedValue(mockNote);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'createMrNote');
      await tool!.handler({
        project_id: 'org/repo',
        mr_iid: 5,
        body: noteBody,
      });

      expect(mockClient.createMrNote).toHaveBeenCalledWith('org/repo', 5, noteBody);
    });

    it('should handle numeric project_id', async () => {
      const mockNote = {
        id: 1,
        body: 'Comment',
        author: { id: 1, username: 'user', name: 'User' },
        created_at: '2023-01-01T00:00:00Z',
        system: false,
        resolvable: false,
      };

      mockClient.createMrNote.mockResolvedValue(mockNote);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'createMrNote');
      await tool!.handler({ project_id: 789, mr_iid: 15, body: 'Comment' });

      expect(mockClient.createMrNote).toHaveBeenCalledWith(789, 15, 'Comment');
    });

    it('should handle string project_id', async () => {
      const mockNote = {
        id: 1,
        body: 'Note',
        author: { id: 1, username: 'user', name: 'User' },
        created_at: '2023-01-01T00:00:00Z',
        system: false,
        resolvable: false,
      };

      mockClient.createMrNote.mockResolvedValue(mockNote);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'createMrNote');
      await tool!.handler({ project_id: 'team/service', mr_iid: 25, body: 'Note' });

      expect(mockClient.createMrNote).toHaveBeenCalledWith('team/service', 25, 'Note');
    });

    it('should handle empty note body', async () => {
      const mockNote = {
        id: 1,
        body: '',
        author: { id: 1, username: 'user', name: 'User' },
        created_at: '2023-01-01T00:00:00Z',
        system: false,
        resolvable: false,
      };

      mockClient.createMrNote.mockResolvedValue(mockNote);

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'createMrNote');
      await tool!.handler({ project_id: 1, mr_iid: 1, body: '' });

      expect(mockClient.createMrNote).toHaveBeenCalledWith(1, 1, '');
    });

    it('should handle generic errors', async () => {
      mockClient.createMrNote.mockRejectedValue(new Error('Validation failed'));

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'createMrNote');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1, body: 'test' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Validation failed' }],
        isError: true,
      });
    });

    it('should handle connection errors', async () => {
      mockClient.createMrNote.mockRejectedValue(new Error('ECONNREFUSED'));

      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'createMrNote');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1, body: 'test' });

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
  });

  describe('unconfigured client', () => {
    it('should return error for list_mr_commits when client is null', async () => {
      const tools = createMrNotesTools(null);
      const tool = tools.find((t) => t.tool.name === 'listMrCommits');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1 });

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

    it('should return error for list_mr_pipelines when client is null', async () => {
      const tools = createMrNotesTools(null);
      const tool = tools.find((t) => t.tool.name === 'listMrPipelines');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1 });

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

    it('should return error for list_mr_notes when client is null', async () => {
      const tools = createMrNotesTools(null);
      const tool = tools.find((t) => t.tool.name === 'listMrNotes');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1 });

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

    it('should return error for create_mr_note when client is null', async () => {
      const tools = createMrNotesTools(null);
      const tool = tools.find((t) => t.tool.name === 'createMrNote');
      const result = await tool!.handler({ project_id: 1, mr_iid: 1, body: 'test' });

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

    it('should return 4 tool definitions when client is null', () => {
      const tools = createMrNotesTools(null);

      expect(tools).toHaveLength(4);
      expect(tools.map((t) => t.tool.name)).toEqual([
        'listMrCommits',
        'listMrPipelines',
        'listMrNotes',
        'createMrNote',
      ]);
    });
  });

  describe('tool definitions', () => {
    it('should return 4 tool definitions when client is configured', () => {
      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);

      expect(tools).toHaveLength(4);
      expect(tools.map((t) => t.tool.name)).toEqual([
        'listMrCommits',
        'listMrPipelines',
        'listMrNotes',
        'createMrNote',
      ]);
    });

    it('should have correct schema for list_mr_commits', () => {
      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrCommits');

      expect(tool!.tool.inputSchema).toEqual({
        type: 'object',
        properties: {
          project_id: { type: ['string', 'number'], description: 'Project ID or path' },
          mr_iid: { type: 'number', description: 'Merge request IID' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
        required: ['project_id', 'mr_iid'],
      });
    });

    it('should have correct schema for list_mr_pipelines', () => {
      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrPipelines');

      expect(tool!.tool.inputSchema).toEqual({
        type: 'object',
        properties: {
          project_id: { type: ['string', 'number'], description: 'Project ID or path' },
          mr_iid: { type: 'number', description: 'Merge request IID' },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
        required: ['project_id', 'mr_iid'],
      });
    });

    it('should have correct schema for list_mr_notes', () => {
      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'listMrNotes');

      expect(tool!.tool.inputSchema).toEqual({
        type: 'object',
        properties: {
          project_id: { type: ['string', 'number'], description: 'Project ID or path' },
          mr_iid: { type: 'number', description: 'Merge request IID' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
        required: ['project_id', 'mr_iid'],
      });
    });

    it('should have correct schema for create_mr_note', () => {
      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'createMrNote');

      expect(tool!.tool.inputSchema).toEqual({
        type: 'object',
        properties: {
          project_id: { type: ['string', 'number'], description: 'Project ID or path' },
          mr_iid: { type: 'number', description: 'Merge request IID' },
          body: { type: 'string', description: 'Comment body' },
        },
        required: ['project_id', 'mr_iid', 'body'],
      });
    });

    it('should have correct descriptions', () => {
      const tools = createMrNotesTools(mockClient as unknown as GitLabClient);

      expect(tools[0].tool.description).toBe('List commits in a merge request');
      expect(tools[1].tool.description).toBe('List pipelines associated with a merge request');
      expect(tools[2].tool.description).toBe('List notes/comments on a merge request');
      expect(tools[3].tool.description).toBe('Add a comment/note to a merge request');
    });
  });
});
