import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { createIssueTools } from './issue-tools.js';
import type { RedmineClient } from '../client.js';

type MockClient = {
  listIssues: Mock;
  showIssue: Mock;
  searchIssues: Mock;
  createIssue: Mock;
  updateIssue: Mock;
  commentIssue: Mock;
  resolveUser: Mock;
  getMappings: Mock;
};

const createMockClient = (): MockClient => ({
  listIssues: vi.fn(),
  showIssue: vi.fn(),
  searchIssues: vi.fn(),
  createIssue: vi.fn(),
  updateIssue: vi.fn(),
  commentIssue: vi.fn(),
  resolveUser: vi.fn(),
  getMappings: vi.fn(),
});

describe('issue-tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
    mockClient.getMappings.mockReturnValue({
      status_new: 1,
      status_in_progress: 2,
      status_resolved: 3,
      priority_low: 1,
      priority_normal: 2,
      priority_high: 3,
      tracker_bug: 1,
      tracker_feature: 2,
      activity_development: 1,
    });
  });

  describe('listIssueIds', () => {
    it('lists issues successfully', async () => {
      mockClient.listIssues.mockResolvedValue({
        issues: [{ id: 1 }, { id: 2 }, { id: 3 }],
        total_count: 3,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      const result = await handler!({});

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ids: [1, 2, 3], total_count: 3 }, null, 2),
          },
        ],
      });
      expect(mockClient.listIssues).toHaveBeenCalledWith({});
    });

    it('handles filters with project_id', async () => {
      mockClient.listIssues.mockResolvedValue({
        issues: [{ id: 1 }],
        total_count: 1,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ project_id: 'test-project' });

      expect(mockClient.listIssues).toHaveBeenCalledWith({
        project_id: 'test-project',
      });
    });

    it('handles special status values (open, closed, *)', async () => {
      mockClient.listIssues.mockResolvedValue({
        issues: [],
        total_count: 0,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ status: 'open' });

      expect(mockClient.listIssues).toHaveBeenCalledWith({
        status_id: 'open',
      });
    });

    it('resolves status name to status_id using mappings', async () => {
      mockClient.listIssues.mockResolvedValue({
        issues: [],
        total_count: 0,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ status: 'new' });

      expect(mockClient.listIssues).toHaveBeenCalledWith({
        status_id: 1,
      });
    });

    it('handles limit and offset parameters', async () => {
      mockClient.listIssues.mockResolvedValue({
        issues: [],
        total_count: 0,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ limit: 50, offset: 100 });

      expect(mockClient.listIssues).toHaveBeenCalledWith({
        limit: 50,
        offset: 100,
      });
    });

    it('handles API errors gracefully', async () => {
      mockClient.listIssues.mockRejectedValue(new Error('Network error'));

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      const result = await handler!({});

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Network error' }],
        isError: true,
      });
    });

    it('handles empty results', async () => {
      mockClient.listIssues.mockResolvedValue({
        issues: [],
        total_count: 0,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      const result = await handler!({});

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ids: [], total_count: 0 }, null, 2),
          },
        ],
      });
    });

    it('resolves assigned_to "me" to assigned_to_id', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [{ id: 1 }], total_count: 1 });
      mockClient.resolveUser.mockResolvedValue(496);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to: 'me' });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('me');
      expect(mockClient.listIssues).toHaveBeenCalledWith({ assigned_to_id: 496 });
    });

    it('resolves assigned_to username to assigned_to_id', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [{ id: 1 }], total_count: 1 });
      mockClient.resolveUser.mockResolvedValue(42);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to: 'john.doe' });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('john.doe');
      expect(mockClient.listIssues).toHaveBeenCalledWith({ assigned_to_id: 42 });
    });

    it('resolves assigned_to with special status open', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [], total_count: 0 });
      mockClient.resolveUser.mockResolvedValue(496);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ status: 'open', assigned_to: 'me' });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('me');
      expect(mockClient.listIssues).toHaveBeenCalledWith({
        status_id: 'open',
        assigned_to_id: 496,
      });
    });

    it('resolves assigned_to with non-special status', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [], total_count: 0 });
      mockClient.resolveUser.mockResolvedValue(496);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ status: 'new', assigned_to: 'me' });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('me');
      expect(mockClient.listIssues).toHaveBeenCalledWith({
        status_id: 1,
        assigned_to_id: 496,
      });
    });

    it('skips resolution when resolveUser returns null', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [], total_count: 0 });
      mockClient.resolveUser.mockResolvedValue(null);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to: 'nonexistent' });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('nonexistent');
      expect(mockClient.listIssues).toHaveBeenCalledWith({});
    });

    it('preserves assigned_to_id when already provided', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [{ id: 1 }], total_count: 1 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to_id: 42 });

      expect(mockClient.resolveUser).not.toHaveBeenCalled();
      expect(mockClient.listIssues).toHaveBeenCalledWith({ assigned_to_id: 42 });
    });

    it('skips resolution when both assigned_to and assigned_to_id are provided', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [{ id: 1 }], total_count: 1 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to: 'john.doe', assigned_to_id: 42 });

      expect(mockClient.resolveUser).not.toHaveBeenCalled();
      expect(mockClient.listIssues).toHaveBeenCalledWith({
        assigned_to: 'john.doe',
        assigned_to_id: 42,
      });
    });

    it('resolves assigned_to numeric string to assigned_to_id', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [{ id: 1 }], total_count: 1 });
      mockClient.resolveUser.mockResolvedValue(123);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to: '123' });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('123');
      expect(mockClient.listIssues).toHaveBeenCalledWith({ assigned_to_id: 123 });
    });

    it('skips resolution when assigned_to is empty string', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [], total_count: 0 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to: '' });

      expect(mockClient.resolveUser).not.toHaveBeenCalled();
      expect(mockClient.listIssues).toHaveBeenCalledWith({ assigned_to: '' });
    });

    it('skips resolution when assigned_to is null', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [], total_count: 0 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to: null });

      expect(mockClient.resolveUser).not.toHaveBeenCalled();
      expect(mockClient.listIssues).toHaveBeenCalledWith({ assigned_to: null });
    });

    it('skips resolution when assigned_to is undefined', async () => {
      mockClient.listIssues.mockResolvedValue({ issues: [], total_count: 0 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      await handler!({ assigned_to: undefined });

      expect(mockClient.resolveUser).not.toHaveBeenCalled();
      expect(mockClient.listIssues).toHaveBeenCalledWith({});
    });

    it('handles resolveUser error gracefully', async () => {
      mockClient.resolveUser.mockRejectedValue(new Error('User API error'));

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'listIssueIds')?.handler;

      const result = await handler!({ assigned_to: 'me' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: User API error' }],
        isError: true,
      });
    });
  });

  describe('getIssueFull', () => {
    it('retrieves full issue data successfully', async () => {
      const mockIssue = {
        id: 1,
        subject: 'Test Issue',
        description: 'Test description',
        status: { id: 1, name: 'New' },
        priority: { id: 2, name: 'Normal' },
        tracker: { id: 1, name: 'Bug' },
        project: { id: 1, name: 'Test Project' },
        author: { id: 1, name: 'Test User' },
        created_on: '2025-01-01T00:00:00Z',
        updated_on: '2025-01-01T00:00:00Z',
      };

      mockClient.showIssue.mockResolvedValue(mockIssue);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'getIssueFull')?.handler;

      const result = await handler!({ issue_id: 1 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockIssue, null, 2),
          },
        ],
      });
      expect(mockClient.showIssue).toHaveBeenCalledWith(1, { include: [] });
    });

    it('includes additional data when requested', async () => {
      mockClient.showIssue.mockResolvedValue({ id: 1 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'getIssueFull')?.handler;

      await handler!({ issue_id: 1, include: ['journals', 'attachments'] });

      expect(mockClient.showIssue).toHaveBeenCalledWith(1, {
        include: ['journals', 'attachments'],
      });
    });

    it('handles non-existent issue', async () => {
      mockClient.showIssue.mockRejectedValue(new Error('Resource not found in Redmine.'));

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'getIssueFull')?.handler;

      const result = await handler!({ issue_id: 9999 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in Redmine.' }],
        isError: true,
      });
    });
  });

  describe('searchIssueIds', () => {
    it('searches issues successfully', async () => {
      mockClient.searchIssues.mockResolvedValue({
        results: [
          { id: 1, type: 'issue', title: 'Test Issue 1' },
          { id: 2, type: 'issue', title: 'Test Issue 2' },
        ],
        total_count: 2,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'searchIssueIds')?.handler;

      const result = await handler!({ query: 'test' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ids: [1, 2], total_count: 2 }, null, 2),
          },
        ],
      });
      expect(mockClient.searchIssues).toHaveBeenCalledWith('test', {});
    });

    it('searches with project_id filter', async () => {
      mockClient.searchIssues.mockResolvedValue({
        results: [],
        total_count: 0,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'searchIssueIds')?.handler;

      await handler!({ query: 'test', project_id: 'my-project', limit: 10 });

      expect(mockClient.searchIssues).toHaveBeenCalledWith('test', {
        project_id: 'my-project',
        limit: 10,
      });
    });

    it('handles empty search results', async () => {
      mockClient.searchIssues.mockResolvedValue({
        results: [],
        total_count: 0,
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'searchIssueIds')?.handler;

      const result = await handler!({ query: 'nonexistent' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ids: [], total_count: 0 }, null, 2),
          },
        ],
      });
    });
  });

  describe('createIssue', () => {
    it('creates issue successfully', async () => {
      const mockCreatedIssue = {
        id: 1,
        subject: 'New Issue',
        status: { id: 1, name: 'New' },
        priority: { id: 2, name: 'Normal' },
        tracker: { id: 1, name: 'Bug' },
        project: { id: 1, name: 'Test Project' },
        author: { id: 1, name: 'Test User' },
        created_on: '2025-01-01T00:00:00Z',
        updated_on: '2025-01-01T00:00:00Z',
      };

      mockClient.createIssue.mockResolvedValue(mockCreatedIssue);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      const result = await handler!({
        project_id: 'test-project',
        subject: 'New Issue',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockCreatedIssue, null, 2),
          },
        ],
      });
      expect(mockClient.createIssue).toHaveBeenCalledWith({
        project_id: 'test-project',
        subject: 'New Issue',
      });
    });

    it('resolves tracker name to tracker_id', async () => {
      mockClient.createIssue.mockResolvedValue({ id: 1 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      await handler!({
        project_id: 'test-project',
        subject: 'Bug Fix',
        tracker: 'bug',
      });

      expect(mockClient.createIssue).toHaveBeenCalledWith({
        project_id: 'test-project',
        subject: 'Bug Fix',
        tracker_id: 1,
      });
    });

    it('resolves assigned_to username to user ID', async () => {
      mockClient.createIssue.mockResolvedValue({ id: 1 });
      mockClient.resolveUser.mockResolvedValue(42);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      await handler!({
        project_id: 'test-project',
        subject: 'Assigned Issue',
        assigned_to: 'john.doe',
      });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('john.doe');
      expect(mockClient.createIssue).toHaveBeenCalledWith({
        project_id: 'test-project',
        subject: 'Assigned Issue',
        assigned_to_id: 42,
      });
    });

    it('handles parent_id to parent_issue_id conversion', async () => {
      mockClient.createIssue.mockResolvedValue({ id: 1 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      await handler!({
        project_id: 'test-project',
        subject: 'Sub-task',
        parent_id: 10,
      });

      expect(mockClient.createIssue).toHaveBeenCalledWith({
        project_id: 'test-project',
        subject: 'Sub-task',
        parent_issue_id: 10,
      });
    });

    it('resolves multiple mappings', async () => {
      mockClient.createIssue.mockResolvedValue({ id: 1 });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      await handler!({
        project_id: 'test-project',
        subject: 'Complex Issue',
        tracker: 'feature',
        priority: 'high',
        status: 'in_progress',
      });

      expect(mockClient.createIssue).toHaveBeenCalledWith({
        project_id: 'test-project',
        subject: 'Complex Issue',
        tracker_id: 2,
        priority_id: 3,
        status_id: 2,
      });
    });

    it('handles creation errors', async () => {
      mockClient.createIssue.mockRejectedValue(
        new Error('Validation error: {"subject":["cannot be blank"]}')
      );

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      const result = await handler!({
        project_id: 'test-project',
        subject: '',
      });

      expect(result).toEqual({
        content: [
          { type: 'text', text: 'Error: Validation error: {"subject":["cannot be blank"]}' },
        ],
        isError: true,
      });
    });
  });

  describe('updateIssue', () => {
    it('updates issue successfully', async () => {
      const mockUpdatedIssue = {
        id: 1,
        subject: 'Updated Subject',
        status: { id: 2, name: 'In Progress' },
        priority: { id: 2, name: 'Normal' },
        tracker: { id: 1, name: 'Bug' },
        project: { id: 1, name: 'Test Project' },
        author: { id: 1, name: 'Test User' },
        created_on: '2025-01-01T00:00:00Z',
        updated_on: '2025-01-02T00:00:00Z',
      };

      mockClient.updateIssue.mockResolvedValue(mockUpdatedIssue);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      const result = await handler!({
        issue_id: 1,
        subject: 'Updated Subject',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                id: 1,
                subject: 'Updated Subject',
                status: { id: 2, name: 'In Progress' },
              },
              null,
              2
            ),
          },
        ],
      });
      expect(mockClient.updateIssue).toHaveBeenCalledWith(1, {
        issue_id: 1,
        subject: 'Updated Subject',
      });
    });

    it('updates status using name mapping', async () => {
      mockClient.updateIssue.mockResolvedValue({
        id: 1,
        subject: 'Test',
        status: { id: 3, name: 'Resolved' },
      });

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      await handler!({
        issue_id: 1,
        status: 'resolved',
      });

      expect(mockClient.updateIssue).toHaveBeenCalledWith(1, {
        issue_id: 1,
        status_id: 3,
      });
    });

    it('resolves assigned_to username', async () => {
      mockClient.updateIssue.mockResolvedValue({
        id: 1,
        subject: 'Test',
        status: { id: 1, name: 'New' },
      });
      mockClient.resolveUser.mockResolvedValue(99);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      await handler!({
        issue_id: 1,
        assigned_to: 'jane.doe',
      });

      expect(mockClient.resolveUser).toHaveBeenCalledWith('jane.doe');
      expect(mockClient.updateIssue).toHaveBeenCalledWith(1, {
        issue_id: 1,
        assigned_to_id: 99,
      });
    });

    it('handles non-existent issue', async () => {
      mockClient.updateIssue.mockRejectedValue(new Error('Resource not found in Redmine.'));

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      const result = await handler!({
        issue_id: 9999,
        subject: 'Updated',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in Redmine.' }],
        isError: true,
      });
    });
  });

  describe('commentIssue', () => {
    it('adds comment successfully', async () => {
      mockClient.commentIssue.mockResolvedValue(undefined);

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'commentIssue')?.handler;

      const result = await handler!({
        issue_id: 1,
        notes: 'This is a comment',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true }, null, 2),
          },
        ],
      });
      expect(mockClient.commentIssue).toHaveBeenCalledWith(1, 'This is a comment');
    });

    it('handles comment errors', async () => {
      mockClient.commentIssue.mockRejectedValue(new Error('Permission denied'));

      const tools = createIssueTools(mockClient as unknown as RedmineClient);
      const handler = tools.find((t) => t.tool.name === 'commentIssue')?.handler;

      const result = await handler!({
        issue_id: 1,
        notes: 'Comment',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Permission denied' }],
        isError: true,
      });
    });
  });

  describe('unconfigured client', () => {
    it('returns error for all tools when client is null', async () => {
      const tools = createIssueTools(null);

      expect(tools).toHaveLength(6);

      for (const { tool, handler } of tools) {
        const result = await handler({});
        expect(result).toEqual({
          content: [
            {
              type: 'text',
              text: 'Error: Redmine not configured. Configure this integration in the Speedwave Desktop app (Integrations tab).',
            },
          ],
          isError: true,
        });
      }
    });
  });
});
