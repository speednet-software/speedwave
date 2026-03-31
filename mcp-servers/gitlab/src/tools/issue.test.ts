import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { createIssueTools } from './issue-tools.js';
import type { GitLabClient } from '../client.js';

type MockClient = {
  listIssues: Mock;
  getIssue: Mock;
  createIssue: Mock;
  updateIssue: Mock;
  closeIssue: Mock;
};

const createMockClient = (): MockClient => ({
  listIssues: vi.fn(),
  getIssue: vi.fn(),
  createIssue: vi.fn(),
  updateIssue: vi.fn(),
  closeIssue: vi.fn(),
});

describe('issue-tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  describe('listIssues', () => {
    it('lists issues successfully', async () => {
      const mockIssues = [
        {
          id: 1,
          iid: 1,
          title: 'First Issue',
          state: 'opened',
          created_at: '2025-01-01T00:00:00Z',
        },
        {
          id: 2,
          iid: 2,
          title: 'Second Issue',
          state: 'opened',
          created_at: '2025-01-02T00:00:00Z',
        },
      ];

      mockClient.listIssues.mockResolvedValue(mockIssues);

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listIssues')?.handler;

      const result = await handler!({ project_id: 'test/project' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockIssues, null, 2),
          },
        ],
      });
      expect(mockClient.listIssues).toHaveBeenCalledWith('test/project', {});
    });

    it('filters issues by state', async () => {
      mockClient.listIssues.mockResolvedValue([]);

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listIssues')?.handler;

      await handler!({ project_id: 123, state: 'closed' });

      expect(mockClient.listIssues).toHaveBeenCalledWith(123, {
        state: 'closed',
      });
    });

    it('filters issues by labels', async () => {
      mockClient.listIssues.mockResolvedValue([]);

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listIssues')?.handler;

      await handler!({
        project_id: 'test/project',
        labels: 'bug,urgent',
      });

      expect(mockClient.listIssues).toHaveBeenCalledWith('test/project', {
        labels: 'bug,urgent',
      });
    });

    it('filters issues by assignee_username', async () => {
      mockClient.listIssues.mockResolvedValue([]);

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listIssues')?.handler;

      await handler!({
        project_id: 'test/project',
        assignee_username: 'john.doe',
      });

      expect(mockClient.listIssues).toHaveBeenCalledWith('test/project', {
        assignee_username: 'john.doe',
      });
    });

    it('applies limit parameter', async () => {
      mockClient.listIssues.mockResolvedValue([]);

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listIssues')?.handler;

      await handler!({
        project_id: 'test/project',
        limit: 50,
      });

      expect(mockClient.listIssues).toHaveBeenCalledWith('test/project', {
        limit: 50,
      });
    });

    it('combines multiple filters', async () => {
      mockClient.listIssues.mockResolvedValue([]);

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listIssues')?.handler;

      await handler!({
        project_id: 'test/project',
        state: 'opened',
        labels: 'bug,priority:high',
        assignee_username: 'jane.doe',
        limit: 10,
      });

      expect(mockClient.listIssues).toHaveBeenCalledWith('test/project', {
        state: 'opened',
        labels: 'bug,priority:high',
        assignee_username: 'jane.doe',
        limit: 10,
      });
    });

    it('handles empty results', async () => {
      mockClient.listIssues.mockResolvedValue([]);

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listIssues')?.handler;

      const result = await handler!({ project_id: 'test/project' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify([], null, 2),
          },
        ],
      });
    });

    it('handles API errors gracefully', async () => {
      mockClient.listIssues.mockRejectedValue(new Error('Network error'));

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listIssues')?.handler;

      const result = await handler!({ project_id: 'test/project' });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: Network error. Check your GitLab URL. Configure this integration in the Speedwave Desktop app (Integrations tab).',
          },
        ],
        isError: true,
      });
    });

    it('handles project not found error', async () => {
      mockClient.listIssues.mockRejectedValue(new Error('404 Project Not Found'));

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'listIssues')?.handler;

      const result = await handler!({ project_id: 'nonexistent/project' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });
  });

  describe('getIssue', () => {
    it('retrieves issue details successfully', async () => {
      const mockIssue = {
        id: 1,
        iid: 42,
        title: 'Test Issue',
        description: 'This is a test issue',
        state: 'opened',
        labels: ['bug', 'urgent'],
        author: {
          id: 1,
          name: 'John Doe',
          username: 'john.doe',
        },
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-02T00:00:00Z',
      };

      mockClient.getIssue.mockResolvedValue(mockIssue);

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getIssue')?.handler;

      const result = await handler!({
        project_id: 'test/project',
        issue_iid: 42,
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockIssue, null, 2),
          },
        ],
      });
      expect(mockClient.getIssue).toHaveBeenCalledWith('test/project', 42);
    });

    it('works with numeric project_id', async () => {
      const mockIssue = { id: 1, iid: 10, title: 'Issue' };

      mockClient.getIssue.mockResolvedValue(mockIssue);

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getIssue')?.handler;

      const result = await handler!({
        project_id: 123,
        issue_iid: 10,
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockIssue, null, 2),
          },
        ],
      });
      expect(mockClient.getIssue).toHaveBeenCalledWith(123, 10);
    });

    it('handles non-existent issue', async () => {
      mockClient.getIssue.mockRejectedValue(new Error('404 Issue Not Found'));

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getIssue')?.handler;

      const result = await handler!({
        project_id: 'test/project',
        issue_iid: 9999,
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('handles permission errors', async () => {
      mockClient.getIssue.mockRejectedValue(new Error('403 Forbidden'));

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getIssue')?.handler;

      const result = await handler!({
        project_id: 'private/project',
        issue_iid: 1,
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
  });

  describe('createIssue', () => {
    it('creates issue successfully with required fields only', async () => {
      const mockCreatedIssue = {
        id: 1,
        iid: 1,
        title: 'New Issue',
        state: 'opened',
        author: { id: 1, name: 'Test User' },
        created_at: '2025-01-01T00:00:00Z',
      };

      mockClient.createIssue.mockResolvedValue(mockCreatedIssue);

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      const result = await handler!({
        project_id: 'test/project',
        title: 'New Issue',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockCreatedIssue, null, 2),
          },
        ],
      });
      expect(mockClient.createIssue).toHaveBeenCalledWith('test/project', {
        title: 'New Issue',
      });
    });

    it('creates issue with all optional fields', async () => {
      const mockCreatedIssue = {
        id: 1,
        iid: 1,
        title: 'Feature Request',
        description: 'Detailed description',
        labels: ['feature', 'enhancement'],
        assignees: [{ id: 42 }, { id: 43 }],
        milestone: { id: 5 },
        state: 'opened',
        created_at: '2025-01-01T00:00:00Z',
      };

      mockClient.createIssue.mockResolvedValue(mockCreatedIssue);

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      const result = await handler!({
        project_id: 'test/project',
        title: 'Feature Request',
        description: 'Detailed description',
        labels: 'feature,enhancement',
        assignee_ids: [42, 43],
        milestone_id: 5,
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockCreatedIssue, null, 2),
          },
        ],
      });
      expect(mockClient.createIssue).toHaveBeenCalledWith('test/project', {
        title: 'Feature Request',
        description: 'Detailed description',
        labels: 'feature,enhancement',
        assignee_ids: [42, 43],
        milestone_id: 5,
      });
    });

    it('creates issue with numeric project_id', async () => {
      mockClient.createIssue.mockResolvedValue({ id: 1, iid: 1, title: 'Issue' });

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      await handler!({
        project_id: 123,
        title: 'Issue',
      });

      expect(mockClient.createIssue).toHaveBeenCalledWith(123, {
        title: 'Issue',
      });
    });

    it('creates issue with description only', async () => {
      mockClient.createIssue.mockResolvedValue({ id: 1, iid: 1, title: 'Bug Fix' });

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      await handler!({
        project_id: 'test/project',
        title: 'Bug Fix',
        description: 'Fix the login bug',
      });

      expect(mockClient.createIssue).toHaveBeenCalledWith('test/project', {
        title: 'Bug Fix',
        description: 'Fix the login bug',
      });
    });

    it('creates issue with labels only', async () => {
      mockClient.createIssue.mockResolvedValue({ id: 1, iid: 1, title: 'Issue' });

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      await handler!({
        project_id: 'test/project',
        title: 'Issue',
        labels: 'bug,high-priority',
      });

      expect(mockClient.createIssue).toHaveBeenCalledWith('test/project', {
        title: 'Issue',
        labels: 'bug,high-priority',
      });
    });

    it('creates issue with assignee_ids array', async () => {
      mockClient.createIssue.mockResolvedValue({ id: 1, iid: 1, title: 'Task' });

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      await handler!({
        project_id: 'test/project',
        title: 'Task',
        assignee_ids: [10, 20, 30],
      });

      expect(mockClient.createIssue).toHaveBeenCalledWith('test/project', {
        title: 'Task',
        assignee_ids: [10, 20, 30],
      });
    });

    it('handles validation errors', async () => {
      mockClient.createIssue.mockRejectedValue(
        new Error('Validation failed: Title cannot be blank')
      );

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      const result = await handler!({
        project_id: 'test/project',
        title: '',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Validation failed: Title cannot be blank' }],
        isError: true,
      });
    });

    it('handles permission errors', async () => {
      mockClient.createIssue.mockRejectedValue(new Error('403 Forbidden'));

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'createIssue')?.handler;

      const result = await handler!({
        project_id: 'test/project',
        title: 'Issue',
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
  });

  describe('updateIssue', () => {
    it('updates issue title successfully', async () => {
      const mockUpdatedIssue = {
        id: 1,
        iid: 42,
        title: 'Updated Title',
        state: 'opened',
        updated_at: '2025-01-02T00:00:00Z',
      };

      mockClient.updateIssue.mockResolvedValue(mockUpdatedIssue);

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      const result = await handler!({
        project_id: 'test/project',
        issue_iid: 42,
        title: 'Updated Title',
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockUpdatedIssue, null, 2),
          },
        ],
      });
      expect(mockClient.updateIssue).toHaveBeenCalledWith('test/project', 42, {
        title: 'Updated Title',
      });
    });

    it('updates issue description', async () => {
      mockClient.updateIssue.mockResolvedValue({ id: 1, iid: 10 });

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      await handler!({
        project_id: 'test/project',
        issue_iid: 10,
        description: 'Updated description',
      });

      expect(mockClient.updateIssue).toHaveBeenCalledWith('test/project', 10, {
        description: 'Updated description',
      });
    });

    it('updates issue labels', async () => {
      mockClient.updateIssue.mockResolvedValue({ id: 1, iid: 10 });

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      await handler!({
        project_id: 'test/project',
        issue_iid: 10,
        labels: 'fixed,verified',
      });

      expect(mockClient.updateIssue).toHaveBeenCalledWith('test/project', 10, {
        labels: 'fixed,verified',
      });
    });

    it('updates issue state to close', async () => {
      mockClient.updateIssue.mockResolvedValue({
        id: 1,
        iid: 10,
        state: 'closed',
      });

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      await handler!({
        project_id: 'test/project',
        issue_iid: 10,
        state_event: 'close',
      });

      expect(mockClient.updateIssue).toHaveBeenCalledWith('test/project', 10, {
        state_event: 'close',
      });
    });

    it('updates issue state to reopen', async () => {
      mockClient.updateIssue.mockResolvedValue({
        id: 1,
        iid: 10,
        state: 'opened',
      });

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      await handler!({
        project_id: 'test/project',
        issue_iid: 10,
        state_event: 'reopen',
      });

      expect(mockClient.updateIssue).toHaveBeenCalledWith('test/project', 10, {
        state_event: 'reopen',
      });
    });

    it('updates multiple fields at once', async () => {
      mockClient.updateIssue.mockResolvedValue({
        id: 1,
        iid: 10,
        title: 'New Title',
        description: 'New Description',
        labels: ['bug', 'fixed'],
      });

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      await handler!({
        project_id: 'test/project',
        issue_iid: 10,
        title: 'New Title',
        description: 'New Description',
        labels: 'bug,fixed',
      });

      expect(mockClient.updateIssue).toHaveBeenCalledWith('test/project', 10, {
        title: 'New Title',
        description: 'New Description',
        labels: 'bug,fixed',
      });
    });

    it('works with numeric project_id', async () => {
      mockClient.updateIssue.mockResolvedValue({ id: 1, iid: 5 });

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      await handler!({
        project_id: 123,
        issue_iid: 5,
        title: 'Updated',
      });

      expect(mockClient.updateIssue).toHaveBeenCalledWith(123, 5, {
        title: 'Updated',
      });
    });

    it('handles non-existent issue', async () => {
      mockClient.updateIssue.mockRejectedValue(new Error('404 Issue Not Found'));

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      const result = await handler!({
        project_id: 'test/project',
        issue_iid: 9999,
        title: 'Updated',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('handles permission errors', async () => {
      mockClient.updateIssue.mockRejectedValue(new Error('403 Forbidden'));

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      const result = await handler!({
        project_id: 'test/project',
        issue_iid: 1,
        title: 'Updated',
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

    it('handles validation errors', async () => {
      mockClient.updateIssue.mockRejectedValue(new Error('Validation failed: Invalid state_event'));

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'updateIssue')?.handler;

      const result = await handler!({
        project_id: 'test/project',
        issue_iid: 1,
        state_event: 'invalid',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Validation failed: Invalid state_event' }],
        isError: true,
      });
    });
  });

  describe('closeIssue', () => {
    it('closes issue successfully', async () => {
      const mockClosedIssue = {
        id: 1,
        iid: 42,
        title: 'Issue to close',
        state: 'closed',
        closed_at: '2025-01-02T00:00:00Z',
        updated_at: '2025-01-02T00:00:00Z',
      };

      mockClient.closeIssue.mockResolvedValue(mockClosedIssue);

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'closeIssue')?.handler;

      const result = await handler!({
        project_id: 'test/project',
        issue_iid: 42,
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockClosedIssue, null, 2),
          },
        ],
      });
      expect(mockClient.closeIssue).toHaveBeenCalledWith('test/project', 42);
    });

    it('works with numeric project_id', async () => {
      const mockClosedIssue = {
        id: 1,
        iid: 10,
        state: 'closed',
      };

      mockClient.closeIssue.mockResolvedValue(mockClosedIssue);

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'closeIssue')?.handler;

      const result = await handler!({
        project_id: 123,
        issue_iid: 10,
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockClosedIssue, null, 2),
          },
        ],
      });
      expect(mockClient.closeIssue).toHaveBeenCalledWith(123, 10);
    });

    it('handles non-existent issue', async () => {
      mockClient.closeIssue.mockRejectedValue(new Error('404 Issue Not Found'));

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'closeIssue')?.handler;

      const result = await handler!({
        project_id: 'test/project',
        issue_iid: 9999,
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });

    it('handles permission errors', async () => {
      mockClient.closeIssue.mockRejectedValue(new Error('403 Forbidden'));

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'closeIssue')?.handler;

      const result = await handler!({
        project_id: 'test/project',
        issue_iid: 1,
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

    it('handles already closed issue', async () => {
      mockClient.closeIssue.mockResolvedValue({
        id: 1,
        iid: 42,
        state: 'closed',
      });

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'closeIssue')?.handler;

      const result = await handler!({
        project_id: 'test/project',
        issue_iid: 42,
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ id: 1, iid: 42, state: 'closed' }, null, 2),
          },
        ],
      });
      expect(mockClient.closeIssue).toHaveBeenCalledWith('test/project', 42);
    });

    it('handles network errors', async () => {
      mockClient.closeIssue.mockRejectedValue(new Error('Network timeout'));

      const tools = createIssueTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'closeIssue')?.handler;

      const result = await handler!({
        project_id: 'test/project',
        issue_iid: 1,
      });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error: Network error. Check your GitLab URL. Configure this integration in the Speedwave Desktop app (Integrations tab).',
          },
        ],
        isError: true,
      });
    });
  });

  describe('unconfigured client', () => {
    it('returns error for all tools when client is null', async () => {
      const tools = createIssueTools(null);

      expect(tools).toHaveLength(5);

      const expectedError = {
        content: [
          {
            type: 'text',
            text: 'Error: GitLab not configured. Configure this integration in the Speedwave Desktop app (Integrations tab).',
          },
        ],
        isError: true,
      };

      for (const { tool, handler } of tools) {
        const result = await handler({});
        expect(result).toEqual(expectedError);
      }
    });

    it('returns correct tool names when unconfigured', () => {
      const tools = createIssueTools(null);

      const toolNames = tools.map((t) => t.tool.name);

      expect(toolNames).toEqual([
        'listIssues',
        'getIssue',
        'createIssue',
        'updateIssue',
        'closeIssue',
      ]);
    });

    it('does not call client methods when unconfigured', async () => {
      const tools = createIssueTools(null);

      for (const { handler } of tools) {
        await handler({ project_id: 'test', issue_iid: 1 });
      }

      // Ensure no mock client methods were called
      expect(mockClient.listIssues).not.toHaveBeenCalled();
      expect(mockClient.getIssue).not.toHaveBeenCalled();
      expect(mockClient.createIssue).not.toHaveBeenCalled();
      expect(mockClient.updateIssue).not.toHaveBeenCalled();
      expect(mockClient.closeIssue).not.toHaveBeenCalled();
    });
  });
});
