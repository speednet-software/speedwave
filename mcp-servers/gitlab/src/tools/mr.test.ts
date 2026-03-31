/**
 * Tests for GitLab MR Tools
 *
 * Coverage: list_mr_ids, get_mr_full, create_merge_request, approve_merge_request,
 *           merge_merge_request, update_merge_request, get_mr_changes (7 tools)
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage } from '@speedwave/mcp-shared';
import { createMrTools } from './mr-tools.js';
import { GitLabClient } from '../client.js';

type MockClient = {
  listMergeRequests: Mock;
  showMergeRequest: Mock;
  createMergeRequest: Mock;
  approveMergeRequest: Mock;
  mergeMergeRequest: Mock;
  updateMergeRequest: Mock;
  getMrChanges: Mock;
};

function createMockClient(): MockClient {
  return {
    listMergeRequests: vi.fn(),
    showMergeRequest: vi.fn(),
    createMergeRequest: vi.fn(),
    approveMergeRequest: vi.fn(),
    mergeMergeRequest: vi.fn(),
    updateMergeRequest: vi.fn(),
    getMrChanges: vi.fn(),
  };
}

describe('MR Tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  describe('listMrIds', () => {
    it('should list merge request IDs with basic parameters', async () => {
      const mockMRs = [
        { iid: 1, title: 'First MR' },
        { iid: 2, title: 'Second MR' },
      ];
      mockClient.listMergeRequests.mockResolvedValue(mockMRs);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const listTool = tools.find((t) => t.tool.name === 'listMrIds');
      const result = await listTool!.handler({ project_id: 123 });

      expect(mockClient.listMergeRequests).toHaveBeenCalledWith(123, {});
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                mrs: [
                  { iid: 1, title: 'First MR' },
                  { iid: 2, title: 'Second MR' },
                ],
                count: 2,
              },
              null,
              2
            ),
          },
        ],
      });
    });

    it('should filter merge requests by state', async () => {
      mockClient.listMergeRequests.mockResolvedValue([]);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const listTool = tools.find((t) => t.tool.name === 'listMrIds');
      await listTool!.handler({ project_id: 123, state: 'opened' });

      expect(mockClient.listMergeRequests).toHaveBeenCalledWith(123, { state: 'opened' });
    });

    it('should filter merge requests by author username', async () => {
      mockClient.listMergeRequests.mockResolvedValue([]);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const listTool = tools.find((t) => t.tool.name === 'listMrIds');
      await listTool!.handler({ project_id: 'group/project', author_username: 'johndoe' });

      expect(mockClient.listMergeRequests).toHaveBeenCalledWith('group/project', {
        author_username: 'johndoe',
      });
    });

    it('should limit merge request results', async () => {
      const mockMRs = [
        { iid: 1, title: 'MR 1' },
        { iid: 2, title: 'MR 2' },
        { iid: 3, title: 'MR 3' },
      ];
      mockClient.listMergeRequests.mockResolvedValue(mockMRs);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const listTool = tools.find((t) => t.tool.name === 'listMrIds');
      await listTool!.handler({ project_id: 123, limit: 10 });

      expect(mockClient.listMergeRequests).toHaveBeenCalledWith(123, { limit: 10 });
    });

    it('should combine multiple filter options', async () => {
      mockClient.listMergeRequests.mockResolvedValue([]);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const listTool = tools.find((t) => t.tool.name === 'listMrIds');
      await listTool!.handler({
        project_id: 123,
        state: 'merged',
        author_username: 'alice',
        limit: 50,
      });

      expect(mockClient.listMergeRequests).toHaveBeenCalledWith(123, {
        state: 'merged',
        author_username: 'alice',
        limit: 50,
      });
    });

    it('should work with project path string', async () => {
      mockClient.listMergeRequests.mockResolvedValue([]);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const listTool = tools.find((t) => t.tool.name === 'listMrIds');
      await listTool!.handler({ project_id: 'my-group/my-project' });

      expect(mockClient.listMergeRequests).toHaveBeenCalledWith('my-group/my-project', {});
    });

    it('should handle empty result set', async () => {
      mockClient.listMergeRequests.mockResolvedValue([]);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const listTool = tools.find((t) => t.tool.name === 'listMrIds');
      const result = await listTool!.handler({ project_id: 123 });

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ mrs: [], count: 0 }, null, 2),
          },
        ],
      });
    });

    it('should handle API errors', async () => {
      mockClient.listMergeRequests.mockRejectedValue(new Error('API error'));
      vi.spyOn(GitLabClient, 'formatError').mockReturnValue('Formatted error message');

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const listTool = tools.find((t) => t.tool.name === 'listMrIds');
      const result = await listTool!.handler({ project_id: 123 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Formatted error message' }],
        isError: true,
      });
    });
  });

  describe('getMrFull', () => {
    it('should get full merge request details', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Test MR',
        description: 'Test description',
        state: 'opened',
        source_branch: 'feature',
        target_branch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        web_url: 'https://gitlab.example.com/mr/10',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
      };
      mockClient.showMergeRequest.mockResolvedValue(mockMR);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const getTool = tools.find((t) => t.tool.name === 'getMrFull');
      const result = await getTool!.handler({ project_id: 123, mr_iid: 10 });

      expect(mockClient.showMergeRequest).toHaveBeenCalledWith(123, 10);
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockMR, null, 2) }],
      });
    });

    it('should work with project path string', async () => {
      const mockMR = { id: 1, iid: 10, title: 'Test' };
      mockClient.showMergeRequest.mockResolvedValue(mockMR);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const getTool = tools.find((t) => t.tool.name === 'getMrFull');
      await getTool!.handler({ project_id: 'group/project', mr_iid: 10 });

      expect(mockClient.showMergeRequest).toHaveBeenCalledWith('group/project', 10);
    });

    it('should handle API errors', async () => {
      mockClient.showMergeRequest.mockRejectedValue(new Error('Not found'));
      vi.spyOn(GitLabClient, 'formatError').mockReturnValue('Resource not found in GitLab.');

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const getTool = tools.find((t) => t.tool.name === 'getMrFull');
      const result = await getTool!.handler({ project_id: 123, mr_iid: 999 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });
  });

  describe('createMergeRequest', () => {
    it('should create merge request with required fields', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'New Feature',
        state: 'opened',
        source_branch: 'feature-branch',
        target_branch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        web_url: 'https://gitlab.example.com/mr/10',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-01T00:00:00Z',
      };
      mockClient.createMergeRequest.mockResolvedValue(mockMR);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const createTool = tools.find((t) => t.tool.name === 'createMergeRequest');
      const result = await createTool!.handler({
        project_id: 123,
        source_branch: 'feature-branch',
        target_branch: 'main',
        title: 'New Feature',
      });

      expect(mockClient.createMergeRequest).toHaveBeenCalledWith(123, {
        source_branch: 'feature-branch',
        target_branch: 'main',
        title: 'New Feature',
      });
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockMR, null, 2) }],
      });
    });

    it('should create merge request with all optional fields', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'New Feature',
        description: 'Feature description',
        state: 'opened',
        source_branch: 'feature-branch',
        target_branch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        web_url: 'https://gitlab.example.com/mr/10',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-01T00:00:00Z',
      };
      mockClient.createMergeRequest.mockResolvedValue(mockMR);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const createTool = tools.find((t) => t.tool.name === 'createMergeRequest');
      await createTool!.handler({
        project_id: 123,
        source_branch: 'feature-branch',
        target_branch: 'main',
        title: 'New Feature',
        description: 'Feature description',
        labels: 'feature,enhancement',
        remove_source_branch: true,
      });

      expect(mockClient.createMergeRequest).toHaveBeenCalledWith(123, {
        source_branch: 'feature-branch',
        target_branch: 'main',
        title: 'New Feature',
        description: 'Feature description',
        labels: 'feature,enhancement',
        remove_source_branch: true,
      });
    });

    it('should work with project path string', async () => {
      const mockMR = { id: 1, iid: 10, title: 'Test' };
      mockClient.createMergeRequest.mockResolvedValue(mockMR);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const createTool = tools.find((t) => t.tool.name === 'createMergeRequest');
      await createTool!.handler({
        project_id: 'group/project',
        source_branch: 'feature',
        target_branch: 'main',
        title: 'Test',
      });

      expect(mockClient.createMergeRequest).toHaveBeenCalledWith('group/project', {
        source_branch: 'feature',
        target_branch: 'main',
        title: 'Test',
      });
    });

    it('should handle API errors', async () => {
      mockClient.createMergeRequest.mockRejectedValue(new Error('Branch not found'));
      vi.spyOn(GitLabClient, 'formatError').mockReturnValue('Resource not found in GitLab.');

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const createTool = tools.find((t) => t.tool.name === 'createMergeRequest');
      const result = await createTool!.handler({
        project_id: 123,
        source_branch: 'nonexistent',
        target_branch: 'main',
        title: 'Test',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Resource not found in GitLab.' }],
        isError: true,
      });
    });
  });

  describe('approveMergeRequest', () => {
    it('should approve a merge request', async () => {
      mockClient.approveMergeRequest.mockResolvedValue(undefined);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const approveTool = tools.find((t) => t.tool.name === 'approveMergeRequest');
      const result = await approveTool!.handler({ project_id: 123, mr_iid: 10 });

      expect(mockClient.approveMergeRequest).toHaveBeenCalledWith(123, 10);
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, message: 'Merge request approved' }, null, 2),
          },
        ],
      });
    });

    it('should work with project path string', async () => {
      mockClient.approveMergeRequest.mockResolvedValue(undefined);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const approveTool = tools.find((t) => t.tool.name === 'approveMergeRequest');
      await approveTool!.handler({ project_id: 'group/project', mr_iid: 10 });

      expect(mockClient.approveMergeRequest).toHaveBeenCalledWith('group/project', 10);
    });

    it('should handle API errors', async () => {
      mockClient.approveMergeRequest.mockRejectedValue(new Error('Permission denied'));
      vi.spyOn(GitLabClient, 'formatError').mockReturnValue(
        'Permission denied. Your GitLab token may not have sufficient permissions.'
      );

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const approveTool = tools.find((t) => t.tool.name === 'approveMergeRequest');
      const result = await approveTool!.handler({ project_id: 123, mr_iid: 10 });

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

  describe('mergeMergeRequest', () => {
    it('should merge a merge request with default options', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Merged MR',
        state: 'merged',
        source_branch: 'feature',
        target_branch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        web_url: 'https://gitlab.example.com/mr/10',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
      };
      mockClient.mergeMergeRequest.mockResolvedValue(mockMR);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const mergeTool = tools.find((t) => t.tool.name === 'mergeMergeRequest');
      const result = await mergeTool!.handler({ project_id: 123, mr_iid: 10 });

      expect(mockClient.mergeMergeRequest).toHaveBeenCalledWith(123, 10, {});
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockMR, null, 2) }],
      });
    });

    it('should merge with all options', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Merged MR',
        state: 'merged',
        source_branch: 'feature',
        target_branch: 'main',
      };
      mockClient.mergeMergeRequest.mockResolvedValue(mockMR);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const mergeTool = tools.find((t) => t.tool.name === 'mergeMergeRequest');
      await mergeTool!.handler({
        project_id: 123,
        mr_iid: 10,
        squash: true,
        should_remove_source_branch: true,
        auto_merge: true,
        sha: 'abc123',
      });

      expect(mockClient.mergeMergeRequest).toHaveBeenCalledWith(123, 10, {
        squash: true,
        should_remove_source_branch: true,
        auto_merge: true,
        sha: 'abc123',
      });
    });

    it('should work with project path string', async () => {
      const mockMR = { id: 1, iid: 10, state: 'merged' };
      mockClient.mergeMergeRequest.mockResolvedValue(mockMR);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const mergeTool = tools.find((t) => t.tool.name === 'mergeMergeRequest');
      await mergeTool!.handler({ project_id: 'group/project', mr_iid: 10 });

      expect(mockClient.mergeMergeRequest).toHaveBeenCalledWith('group/project', 10, {});
    });

    it('should handle squash option', async () => {
      const mockMR = { id: 1, iid: 10, state: 'merged' };
      mockClient.mergeMergeRequest.mockResolvedValue(mockMR);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const mergeTool = tools.find((t) => t.tool.name === 'mergeMergeRequest');
      await mergeTool!.handler({ project_id: 123, mr_iid: 10, squash: true });

      expect(mockClient.mergeMergeRequest).toHaveBeenCalledWith(123, 10, { squash: true });
    });

    it('should handle API errors', async () => {
      mockClient.mergeMergeRequest.mockRejectedValue(new Error('Cannot merge'));
      vi.spyOn(GitLabClient, 'formatError').mockReturnValue('GitLab API error');

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const mergeTool = tools.find((t) => t.tool.name === 'mergeMergeRequest');
      const result = await mergeTool!.handler({ project_id: 123, mr_iid: 10 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: GitLab API error' }],
        isError: true,
      });
    });
  });

  describe('updateMergeRequest', () => {
    it('should update merge request title', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Updated Title',
        state: 'opened',
        source_branch: 'feature',
        target_branch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        web_url: 'https://gitlab.example.com/mr/10',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
      };
      mockClient.updateMergeRequest.mockResolvedValue(mockMR);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const updateTool = tools.find((t) => t.tool.name === 'updateMergeRequest');
      const result = await updateTool!.handler({
        project_id: 123,
        mr_iid: 10,
        title: 'Updated Title',
      });

      expect(mockClient.updateMergeRequest).toHaveBeenCalledWith(123, 10, {
        title: 'Updated Title',
      });
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockMR, null, 2) }],
      });
    });

    it('should update merge request with all fields', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Updated Title',
        description: 'Updated description',
        state: 'closed',
        source_branch: 'feature',
        target_branch: 'develop',
      };
      mockClient.updateMergeRequest.mockResolvedValue(mockMR);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const updateTool = tools.find((t) => t.tool.name === 'updateMergeRequest');
      await updateTool!.handler({
        project_id: 123,
        mr_iid: 10,
        title: 'Updated Title',
        description: 'Updated description',
        target_branch: 'develop',
        state_event: 'close',
        labels: 'bug,critical',
      });

      expect(mockClient.updateMergeRequest).toHaveBeenCalledWith(123, 10, {
        title: 'Updated Title',
        description: 'Updated description',
        target_branch: 'develop',
        state_event: 'close',
        labels: 'bug,critical',
      });
    });

    it('should work with project path string', async () => {
      const mockMR = { id: 1, iid: 10, title: 'Updated' };
      mockClient.updateMergeRequest.mockResolvedValue(mockMR);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const updateTool = tools.find((t) => t.tool.name === 'updateMergeRequest');
      await updateTool!.handler({
        project_id: 'group/project',
        mr_iid: 10,
        title: 'Updated',
      });

      expect(mockClient.updateMergeRequest).toHaveBeenCalledWith('group/project', 10, {
        title: 'Updated',
      });
    });

    it('should update only description', async () => {
      const mockMR = { id: 1, iid: 10, description: 'New description' };
      mockClient.updateMergeRequest.mockResolvedValue(mockMR);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const updateTool = tools.find((t) => t.tool.name === 'updateMergeRequest');
      await updateTool!.handler({
        project_id: 123,
        mr_iid: 10,
        description: 'New description',
      });

      expect(mockClient.updateMergeRequest).toHaveBeenCalledWith(123, 10, {
        description: 'New description',
      });
    });

    it('should handle state_event', async () => {
      const mockMR = { id: 1, iid: 10, state: 'closed' };
      mockClient.updateMergeRequest.mockResolvedValue(mockMR);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const updateTool = tools.find((t) => t.tool.name === 'updateMergeRequest');
      await updateTool!.handler({
        project_id: 123,
        mr_iid: 10,
        state_event: 'close',
      });

      expect(mockClient.updateMergeRequest).toHaveBeenCalledWith(123, 10, {
        state_event: 'close',
      });
    });

    it('should handle API errors', async () => {
      mockClient.updateMergeRequest.mockRejectedValue(new Error('Update failed'));
      vi.spyOn(GitLabClient, 'formatError').mockReturnValue('GitLab API error');

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const updateTool = tools.find((t) => t.tool.name === 'updateMergeRequest');
      const result = await updateTool!.handler({
        project_id: 123,
        mr_iid: 10,
        title: 'New Title',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: GitLab API error' }],
        isError: true,
      });
    });
  });

  describe('getMrChanges', () => {
    it('should get merge request changes', async () => {
      const mockDiffs = [
        {
          diff: 'diff content',
          new_path: 'file.js',
          old_path: 'file.js',
          a_mode: '100644',
          b_mode: '100644',
        },
        {
          diff: 'another diff',
          new_path: 'test.js',
          old_path: 'test.js',
          a_mode: '100644',
          b_mode: '100644',
        },
      ];
      mockClient.getMrChanges.mockResolvedValue(mockDiffs);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const changesTool = tools.find((t) => t.tool.name === 'getMrChanges');
      const result = await changesTool!.handler({ project_id: 123, mr_iid: 10 });

      expect(mockClient.getMrChanges).toHaveBeenCalledWith(123, 10);
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockDiffs, null, 2) }],
      });
    });

    it('should work with project path string', async () => {
      const mockDiffs = [];
      mockClient.getMrChanges.mockResolvedValue(mockDiffs);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const changesTool = tools.find((t) => t.tool.name === 'getMrChanges');
      await changesTool!.handler({ project_id: 'group/project', mr_iid: 10 });

      expect(mockClient.getMrChanges).toHaveBeenCalledWith('group/project', 10);
    });

    it('should handle empty changes', async () => {
      mockClient.getMrChanges.mockResolvedValue([]);

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const changesTool = tools.find((t) => t.tool.name === 'getMrChanges');
      const result = await changesTool!.handler({ project_id: 123, mr_iid: 10 });

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify([], null, 2) }],
      });
    });

    it('should handle API errors', async () => {
      mockClient.getMrChanges.mockRejectedValue(new Error('Changes not available'));
      vi.spyOn(GitLabClient, 'formatError').mockReturnValue('GitLab API error');

      const tools = createMrTools(mockClient as unknown as GitLabClient);
      const changesTool = tools.find((t) => t.tool.name === 'getMrChanges');
      const result = await changesTool!.handler({ project_id: 123, mr_iid: 10 });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: GitLab API error' }],
        isError: true,
      });
    });
  });

  describe('unconfigured client', () => {
    it('should return error for list_mr_ids when client is null', async () => {
      const tools = createMrTools(null);
      const listTool = tools.find((t) => t.tool.name === 'listMrIds');
      const result = await listTool!.handler({ project_id: 123 });

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

    it('should return error for get_mr_full when client is null', async () => {
      const tools = createMrTools(null);
      const getTool = tools.find((t) => t.tool.name === 'getMrFull');
      const result = await getTool!.handler({ project_id: 123, mr_iid: 10 });

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

    it('should return error for create_merge_request when client is null', async () => {
      const tools = createMrTools(null);
      const createTool = tools.find((t) => t.tool.name === 'createMergeRequest');
      const result = await createTool!.handler({
        project_id: 123,
        source_branch: 'feature',
        target_branch: 'main',
        title: 'Test',
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

    it('should return error for approve_merge_request when client is null', async () => {
      const tools = createMrTools(null);
      const approveTool = tools.find((t) => t.tool.name === 'approveMergeRequest');
      const result = await approveTool!.handler({ project_id: 123, mr_iid: 10 });

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

    it('should return error for merge_merge_request when client is null', async () => {
      const tools = createMrTools(null);
      const mergeTool = tools.find((t) => t.tool.name === 'mergeMergeRequest');
      const result = await mergeTool!.handler({ project_id: 123, mr_iid: 10 });

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

    it('should return error for update_merge_request when client is null', async () => {
      const tools = createMrTools(null);
      const updateTool = tools.find((t) => t.tool.name === 'updateMergeRequest');
      const result = await updateTool!.handler({
        project_id: 123,
        mr_iid: 10,
        title: 'Updated',
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

    it('should return error for get_mr_changes when client is null', async () => {
      const tools = createMrTools(null);
      const changesTool = tools.find((t) => t.tool.name === 'getMrChanges');
      const result = await changesTool!.handler({ project_id: 123, mr_iid: 10 });

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

    it('should have all 7 tools when client is null', () => {
      const tools = createMrTools(null);
      expect(tools).toHaveLength(7);
      expect(tools.map((t) => t.tool.name)).toEqual([
        'listMrIds',
        'getMrFull',
        'createMergeRequest',
        'approveMergeRequest',
        'mergeMergeRequest',
        'updateMergeRequest',
        'getMrChanges',
      ]);
    });

    it('should have all 7 tools when client is configured', () => {
      const tools = createMrTools(mockClient as unknown as GitLabClient);
      expect(tools).toHaveLength(7);
      expect(tools.map((t) => t.tool.name)).toEqual([
        'listMrIds',
        'getMrFull',
        'createMergeRequest',
        'approveMergeRequest',
        'mergeMergeRequest',
        'updateMergeRequest',
        'getMrChanges',
      ]);
    });
  });
});
