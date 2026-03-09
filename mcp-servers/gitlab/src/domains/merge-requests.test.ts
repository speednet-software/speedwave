/**
 * Tests for GitLab Merge Requests Domain
 *
 * Coverage: list, show, create, update, approve, merge, getChanges,
 *           listCommits, listPipelines, listNotes, createNote,
 *           listDiscussions, createDiscussion (13 methods)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMergeRequestsClient, type MergeRequestsClient } from './merge-requests.js';

function createMockGitlab() {
  return {
    MergeRequests: {
      all: vi.fn(),
      show: vi.fn(),
      create: vi.fn(),
      edit: vi.fn(),
      accept: vi.fn(),
      allDiffs: vi.fn(),
      allCommits: vi.fn(),
      allPipelines: vi.fn(),
    },
    MergeRequestApprovals: {
      approve: vi.fn(),
    },
    MergeRequestNotes: {
      all: vi.fn(),
      create: vi.fn(),
    },
    MergeRequestDiscussions: {
      all: vi.fn(),
      create: vi.fn(),
    },
  };
}

describe('MergeRequestsClient', () => {
  let mockGitlab: ReturnType<typeof createMockGitlab>;
  let client: MergeRequestsClient;

  beforeEach(() => {
    mockGitlab = createMockGitlab();
    client = createMergeRequestsClient(mockGitlab as any);
  });

  describe('list', () => {
    it('should list merge requests with default options', async () => {
      const mockMRs = [
        {
          id: 1,
          iid: 10,
          title: 'Test MR',
          description: 'Test description',
          state: 'opened',
          sourceBranch: 'feature',
          targetBranch: 'main',
          author: { id: 1, name: 'John Doe', username: 'johndoe' },
          webUrl: 'https://gitlab.example.com/group/project/-/merge_requests/10',
          createdAt: '2023-01-01T00:00:00Z',
          updatedAt: '2023-01-02T00:00:00Z',
        },
      ];

      mockGitlab.MergeRequests.all.mockResolvedValue(mockMRs);

      const result = await client.list(1);

      expect(mockGitlab.MergeRequests.all).toHaveBeenCalledWith({
        projectId: 1,
        perPage: 20,
      });

      expect(result).toEqual([
        {
          id: 1,
          iid: 10,
          title: 'Test MR',
          description: 'Test description',
          state: 'opened',
          source_branch: 'feature',
          target_branch: 'main',
          author: { id: 1, name: 'John Doe', username: 'johndoe' },
          web_url: 'https://gitlab.example.com/group/project/-/merge_requests/10',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-02T00:00:00Z',
        },
      ]);
    });

    it('should filter merge requests by state', async () => {
      mockGitlab.MergeRequests.all.mockResolvedValue([]);

      await client.list(1, { state: 'merged' });

      expect(mockGitlab.MergeRequests.all).toHaveBeenCalledWith({
        projectId: 1,
        perPage: 20,
        state: 'merged',
      });
    });

    it('should filter merge requests by author', async () => {
      mockGitlab.MergeRequests.all.mockResolvedValue([]);

      await client.list(1, { author_username: 'johndoe' });

      expect(mockGitlab.MergeRequests.all).toHaveBeenCalledWith({
        projectId: 1,
        perPage: 20,
        authorUsername: 'johndoe',
      });
    });

    it('should filter merge requests by reviewer', async () => {
      mockGitlab.MergeRequests.all.mockResolvedValue([]);

      await client.list(1, { reviewer_username: 'janedoe' });

      expect(mockGitlab.MergeRequests.all).toHaveBeenCalledWith({
        projectId: 1,
        perPage: 20,
        reviewerUsername: 'janedoe',
      });
    });

    it('should filter merge requests by labels', async () => {
      mockGitlab.MergeRequests.all.mockResolvedValue([]);

      await client.list(1, { labels: 'bug,urgent' });

      expect(mockGitlab.MergeRequests.all).toHaveBeenCalledWith({
        projectId: 1,
        perPage: 20,
        labels: 'bug,urgent',
      });
    });

    it('should limit merge request results', async () => {
      const mockMRs = Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        iid: i + 10,
        title: `MR ${i + 1}`,
        state: 'opened',
        sourceBranch: 'feature',
        targetBranch: 'main',
        author: { id: 1, name: 'User', username: 'user' },
        webUrl: 'https://gitlab.example.com/mr',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
      }));

      mockGitlab.MergeRequests.all.mockResolvedValue(mockMRs);

      const result = await client.list(1, { limit: 10 });

      expect(mockGitlab.MergeRequests.all).toHaveBeenCalledWith({
        projectId: 1,
        perPage: 10,
      });

      expect(result).toHaveLength(10);
    });

    it('should handle snake_case properties in MRs', async () => {
      const mockMRs = [
        {
          id: 1,
          iid: 10,
          title: 'Test MR',
          state: 'opened',
          source_branch: 'feature',
          target_branch: 'main',
          author: { id: 1, name: 'John Doe', username: 'johndoe' },
          web_url: 'https://gitlab.example.com/mr/10',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-02T00:00:00Z',
        },
      ];

      mockGitlab.MergeRequests.all.mockResolvedValue(mockMRs);

      const result = await client.list(1);

      expect(result[0].source_branch).toBe('feature');
      expect(result[0].target_branch).toBe('main');
    });

    it('should handle MRs without description', async () => {
      const mockMRs = [
        {
          id: 1,
          iid: 10,
          title: 'Test MR',
          state: 'opened',
          sourceBranch: 'feature',
          targetBranch: 'main',
          author: { id: 1, name: 'John Doe', username: 'johndoe' },
          webUrl: 'https://gitlab.example.com/mr/10',
          createdAt: '2023-01-01T00:00:00Z',
          updatedAt: '2023-01-02T00:00:00Z',
        },
      ];

      mockGitlab.MergeRequests.all.mockResolvedValue(mockMRs);

      const result = await client.list(1);

      expect(result[0].description).toBeUndefined();
    });

    it('should combine multiple filters', async () => {
      mockGitlab.MergeRequests.all.mockResolvedValue([]);

      await client.list(1, {
        state: 'opened',
        author_username: 'alice',
        reviewer_username: 'bob',
        labels: 'feature,review',
        limit: 5,
      });

      expect(mockGitlab.MergeRequests.all).toHaveBeenCalledWith({
        projectId: 1,
        perPage: 5,
        state: 'opened',
        authorUsername: 'alice',
        reviewerUsername: 'bob',
        labels: 'feature,review',
      });
    });

    it('should work with project path string', async () => {
      mockGitlab.MergeRequests.all.mockResolvedValue([]);

      await client.list('group/project');

      expect(mockGitlab.MergeRequests.all).toHaveBeenCalledWith({
        projectId: 'group/project',
        perPage: 20,
      });
    });

    it('should include conflict fields in list results', async () => {
      const mockMRs = [
        {
          id: 1,
          iid: 10,
          title: 'MR with conflict',
          state: 'opened',
          sourceBranch: 'feature',
          targetBranch: 'main',
          author: { id: 1, name: 'John Doe', username: 'johndoe' },
          webUrl: 'https://gitlab.example.com/mr/10',
          createdAt: '2023-01-01T00:00:00Z',
          updatedAt: '2023-01-02T00:00:00Z',
          hasConflicts: true,
          mergeStatus: 'cannot_be_merged',
          detailedMergeStatus: 'conflict',
        },
        {
          id: 2,
          iid: 11,
          title: 'MR without conflict',
          state: 'opened',
          sourceBranch: 'feature2',
          targetBranch: 'main',
          author: { id: 1, name: 'John Doe', username: 'johndoe' },
          webUrl: 'https://gitlab.example.com/mr/11',
          createdAt: '2023-01-01T00:00:00Z',
          updatedAt: '2023-01-02T00:00:00Z',
          hasConflicts: false,
          mergeStatus: 'can_be_merged',
          detailedMergeStatus: 'mergeable',
        },
      ];

      mockGitlab.MergeRequests.all.mockResolvedValue(mockMRs);
      const result = await client.list(1);

      expect(result[0].has_conflicts).toBe(true);
      expect(result[0].merge_status).toBe('cannot_be_merged');
      expect(result[0].detailed_merge_status).toBe('conflict');

      expect(result[1].has_conflicts).toBe(false);
      expect(result[1].merge_status).toBe('can_be_merged');
      expect(result[1].detailed_merge_status).toBe('mergeable');
    });
  });

  describe('show', () => {
    it('should show merge request by IID', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Test MR',
        description: 'Test description',
        state: 'opened',
        sourceBranch: 'feature',
        targetBranch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        webUrl: 'https://gitlab.example.com/group/project/-/merge_requests/10',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
      };

      mockGitlab.MergeRequests.show.mockResolvedValue(mockMR);

      const result = await client.show(1, 10);

      expect(mockGitlab.MergeRequests.show).toHaveBeenCalledWith(1, 10);
      expect(result).toEqual({
        id: 1,
        iid: 10,
        title: 'Test MR',
        description: 'Test description',
        state: 'opened',
        source_branch: 'feature',
        target_branch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        web_url: 'https://gitlab.example.com/group/project/-/merge_requests/10',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
      });
    });

    it('should handle MR without description', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Test MR',
        state: 'opened',
        sourceBranch: 'feature',
        targetBranch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        webUrl: 'https://gitlab.example.com/mr/10',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
      };

      mockGitlab.MergeRequests.show.mockResolvedValue(mockMR);

      const result = await client.show(1, 10);

      expect(result.description).toBeUndefined();
    });

    it('should work with project path string', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Test MR',
        state: 'opened',
        sourceBranch: 'feature',
        targetBranch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        webUrl: 'https://gitlab.example.com/mr/10',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
      };

      mockGitlab.MergeRequests.show.mockResolvedValue(mockMR);

      await client.show('group/project', 10);

      expect(mockGitlab.MergeRequests.show).toHaveBeenCalledWith('group/project', 10);
    });

    it('should include conflict fields when present', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Test MR',
        state: 'opened',
        sourceBranch: 'feature',
        targetBranch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        webUrl: 'https://gitlab.example.com/mr/10',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
        hasConflicts: true,
        mergeStatus: 'cannot_be_merged',
        detailedMergeStatus: 'conflict',
      };

      mockGitlab.MergeRequests.show.mockResolvedValue(mockMR);
      const result = await client.show(1, 10);

      expect(result.has_conflicts).toBe(true);
      expect(result.merge_status).toBe('cannot_be_merged');
      expect(result.detailed_merge_status).toBe('conflict');
    });

    it('should handle MR without conflict fields', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Test MR',
        state: 'opened',
        sourceBranch: 'feature',
        targetBranch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        webUrl: 'https://gitlab.example.com/mr/10',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
      };

      mockGitlab.MergeRequests.show.mockResolvedValue(mockMR);
      const result = await client.show(1, 10);

      expect(result.has_conflicts).toBeUndefined();
      expect(result.merge_status).toBeUndefined();
      expect(result.detailed_merge_status).toBeUndefined();
    });

    it('should preserve has_conflicts false value (not coerce to undefined)', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Test MR',
        state: 'opened',
        sourceBranch: 'feature',
        targetBranch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        webUrl: 'https://gitlab.example.com/mr/10',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
        hasConflicts: false,
        mergeStatus: 'can_be_merged',
        detailedMergeStatus: 'mergeable',
      };

      mockGitlab.MergeRequests.show.mockResolvedValue(mockMR);
      const result = await client.show(1, 10);

      expect(result.has_conflicts).toBe(false);
      expect(result.merge_status).toBe('can_be_merged');
      expect(result.detailed_merge_status).toBe('mergeable');
    });
  });

  describe('create', () => {
    it('should create merge request with required fields', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'New Feature',
        state: 'opened',
        sourceBranch: 'feature-branch',
        targetBranch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        webUrl: 'https://gitlab.example.com/mr/10',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      };

      mockGitlab.MergeRequests.create.mockResolvedValue(mockMR);

      const result = await client.create(1, {
        source_branch: 'feature-branch',
        target_branch: 'main',
        title: 'New Feature',
      });

      expect(mockGitlab.MergeRequests.create).toHaveBeenCalledWith(
        1,
        'feature-branch',
        'main',
        'New Feature',
        {
          description: undefined,
          labels: undefined,
          removeSourceBranch: undefined,
        }
      );

      expect(result.title).toBe('New Feature');
      expect(result.source_branch).toBe('feature-branch');
    });

    it('should create merge request with all options', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'New Feature',
        description: 'Feature description',
        state: 'opened',
        sourceBranch: 'feature-branch',
        targetBranch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        webUrl: 'https://gitlab.example.com/mr/10',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      };

      mockGitlab.MergeRequests.create.mockResolvedValue(mockMR);

      await client.create(1, {
        source_branch: 'feature-branch',
        target_branch: 'main',
        title: 'New Feature',
        description: 'Feature description',
        labels: 'feature,enhancement',
        remove_source_branch: true,
      });

      expect(mockGitlab.MergeRequests.create).toHaveBeenCalledWith(
        1,
        'feature-branch',
        'main',
        'New Feature',
        {
          description: 'Feature description',
          labels: 'feature,enhancement',
          removeSourceBranch: true,
        }
      );
    });

    it('should work with project path string', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'New Feature',
        state: 'opened',
        sourceBranch: 'feature',
        targetBranch: 'main',
        author: { id: 1, name: 'User', username: 'user' },
        webUrl: 'https://gitlab.example.com/mr/10',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      };

      mockGitlab.MergeRequests.create.mockResolvedValue(mockMR);

      await client.create('group/project', {
        source_branch: 'feature',
        target_branch: 'main',
        title: 'New Feature',
      });

      expect(mockGitlab.MergeRequests.create).toHaveBeenCalledWith(
        'group/project',
        'feature',
        'main',
        'New Feature',
        expect.any(Object)
      );
    });
  });

  describe('approve', () => {
    it('should approve merge request', async () => {
      mockGitlab.MergeRequestApprovals.approve.mockResolvedValue({});

      await client.approve(1, 10);

      expect(mockGitlab.MergeRequestApprovals.approve).toHaveBeenCalledWith(1, 10);
    });

    it('should work with project path string', async () => {
      mockGitlab.MergeRequestApprovals.approve.mockResolvedValue({});

      await client.approve('group/project', 10);

      expect(mockGitlab.MergeRequestApprovals.approve).toHaveBeenCalledWith('group/project', 10);
    });
  });

  describe('merge', () => {
    it('should merge merge request with default options', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Merged MR',
        state: 'merged',
        sourceBranch: 'feature',
        targetBranch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        webUrl: 'https://gitlab.example.com/mr/10',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
      };

      mockGitlab.MergeRequests.accept.mockResolvedValue(mockMR);

      const result = await client.merge(1, 10);

      expect(mockGitlab.MergeRequests.accept).toHaveBeenCalledWith(1, 10, {
        squash: undefined,
        shouldRemoveSourceBranch: undefined,
        sha: undefined,
        mergeWhenPipelineSucceeds: undefined,
      });

      expect(result.state).toBe('merged');
    });

    it('should merge merge request with all options', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Merged MR',
        state: 'merged',
        sourceBranch: 'feature',
        targetBranch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        webUrl: 'https://gitlab.example.com/mr/10',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
      };

      mockGitlab.MergeRequests.accept.mockResolvedValue(mockMR);

      await client.merge(1, 10, {
        squash: true,
        should_remove_source_branch: true,
        auto_merge: true,
        sha: 'abc123',
      });

      expect(mockGitlab.MergeRequests.accept).toHaveBeenCalledWith(1, 10, {
        squash: true,
        shouldRemoveSourceBranch: true,
        sha: 'abc123',
        mergeWhenPipelineSucceeds: true,
      });
    });

    it('should work with project path string', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Merged MR',
        state: 'merged',
        sourceBranch: 'feature',
        targetBranch: 'main',
        author: { id: 1, name: 'User', username: 'user' },
        webUrl: 'https://gitlab.example.com/mr/10',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
      };

      mockGitlab.MergeRequests.accept.mockResolvedValue(mockMR);

      await client.merge('group/project', 10);

      expect(mockGitlab.MergeRequests.accept).toHaveBeenCalledWith(
        'group/project',
        10,
        expect.any(Object)
      );
    });
  });

  describe('update', () => {
    it('should update merge request with title', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Updated Title',
        state: 'opened',
        sourceBranch: 'feature',
        targetBranch: 'main',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        webUrl: 'https://gitlab.example.com/mr/10',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
      };

      mockGitlab.MergeRequests.edit.mockResolvedValue(mockMR);

      const result = await client.update(1, 10, {
        title: 'Updated Title',
      });

      expect(mockGitlab.MergeRequests.edit).toHaveBeenCalledWith(1, 10, {
        title: 'Updated Title',
        description: undefined,
        targetBranch: undefined,
        stateEvent: undefined,
        labels: undefined,
      });

      expect(result.title).toBe('Updated Title');
    });

    it('should update merge request with all fields', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Updated Title',
        description: 'Updated description',
        state: 'closed',
        sourceBranch: 'feature',
        targetBranch: 'develop',
        author: { id: 1, name: 'John Doe', username: 'johndoe' },
        webUrl: 'https://gitlab.example.com/mr/10',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
      };

      mockGitlab.MergeRequests.edit.mockResolvedValue(mockMR);

      await client.update(1, 10, {
        title: 'Updated Title',
        description: 'Updated description',
        target_branch: 'develop',
        state_event: 'close',
        labels: 'bug,critical',
      });

      expect(mockGitlab.MergeRequests.edit).toHaveBeenCalledWith(1, 10, {
        title: 'Updated Title',
        description: 'Updated description',
        targetBranch: 'develop',
        stateEvent: 'close',
        labels: 'bug,critical',
      });
    });

    it('should work with project path string', async () => {
      const mockMR = {
        id: 1,
        iid: 10,
        title: 'Updated',
        state: 'opened',
        sourceBranch: 'feature',
        targetBranch: 'main',
        author: { id: 1, name: 'User', username: 'user' },
        webUrl: 'https://gitlab.example.com/mr/10',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
      };

      mockGitlab.MergeRequests.edit.mockResolvedValue(mockMR);

      await client.update('group/project', 10, { title: 'Updated' });

      expect(mockGitlab.MergeRequests.edit).toHaveBeenCalledWith(
        'group/project',
        10,
        expect.any(Object)
      );
    });
  });

  describe('getChanges', () => {
    it('should get merge request changes', async () => {
      const mockDiffs = [
        {
          diff: 'diff content',
          new_path: 'file.js',
          old_path: 'file.js',
          a_mode: '100644',
          b_mode: '100644',
        },
      ];

      mockGitlab.MergeRequests.allDiffs.mockResolvedValue(mockDiffs);

      const result = await client.getChanges(1, 10);

      expect(mockGitlab.MergeRequests.allDiffs).toHaveBeenCalledWith(1, 10);
      expect(result).toEqual(mockDiffs);
    });

    it('should work with project path string', async () => {
      mockGitlab.MergeRequests.allDiffs.mockResolvedValue([]);

      await client.getChanges('group/project', 10);

      expect(mockGitlab.MergeRequests.allDiffs).toHaveBeenCalledWith('group/project', 10);
    });
  });

  describe('listNotes', () => {
    it('should list merge request notes', async () => {
      const mockNotes = [
        {
          id: 1,
          body: 'Great work!',
          author: { id: 1, username: 'johndoe', name: 'John Doe' },
          createdAt: '2023-01-01T00:00:00Z',
          system: false,
          resolvable: false,
        },
        {
          id: 2,
          body: 'Needs changes',
          author: { id: 2, username: 'janedoe', name: 'Jane Doe' },
          created_at: '2023-01-02T00:00:00Z',
          system: false,
          resolvable: true,
          resolved: false,
        },
      ];

      mockGitlab.MergeRequestNotes.all.mockResolvedValue(mockNotes);

      const result = await client.listNotes(1, 10);

      expect(mockGitlab.MergeRequestNotes.all).toHaveBeenCalledWith(1, 10);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 1,
        body: 'Great work!',
        author: { id: 1, username: 'johndoe', name: 'John Doe' },
        created_at: '2023-01-01T00:00:00Z',
        system: false,
        resolvable: false,
        resolved: undefined,
      });
    });

    it('should handle system notes', async () => {
      const mockNotes = [
        {
          id: 1,
          body: 'approved this merge request',
          author: { id: 1, username: 'user', name: 'User' },
          createdAt: '2023-01-01T00:00:00Z',
          system: true,
          resolvable: false,
        },
      ];

      mockGitlab.MergeRequestNotes.all.mockResolvedValue(mockNotes);

      const result = await client.listNotes(1, 10);

      expect(result[0].system).toBe(true);
    });

    it('should work with project path string', async () => {
      mockGitlab.MergeRequestNotes.all.mockResolvedValue([]);

      await client.listNotes('group/project', 10);

      expect(mockGitlab.MergeRequestNotes.all).toHaveBeenCalledWith('group/project', 10);
    });
  });

  describe('createNote', () => {
    it('should create merge request note', async () => {
      const mockNote = {
        id: 1,
        body: 'LGTM!',
        author: { id: 1, username: 'johndoe', name: 'John Doe' },
        createdAt: '2023-01-01T00:00:00Z',
        system: false,
        resolvable: false,
      };

      mockGitlab.MergeRequestNotes.create.mockResolvedValue(mockNote);

      const result = await client.createNote(1, 10, 'LGTM!');

      expect(mockGitlab.MergeRequestNotes.create).toHaveBeenCalledWith(1, 10, 'LGTM!');
      expect(result).toEqual({
        id: 1,
        body: 'LGTM!',
        author: { id: 1, username: 'johndoe', name: 'John Doe' },
        created_at: '2023-01-01T00:00:00Z',
        system: false,
        resolvable: false,
        resolved: undefined,
      });
    });

    it('should work with project path string', async () => {
      const mockNote = {
        id: 1,
        body: 'Comment',
        author: { id: 1, username: 'user', name: 'User' },
        createdAt: '2023-01-01T00:00:00Z',
        system: false,
        resolvable: false,
      };

      mockGitlab.MergeRequestNotes.create.mockResolvedValue(mockNote);

      await client.createNote('group/project', 10, 'Comment');

      expect(mockGitlab.MergeRequestNotes.create).toHaveBeenCalledWith(
        'group/project',
        10,
        'Comment'
      );
    });
  });

  describe('listDiscussions', () => {
    it('should list merge request discussions', async () => {
      const mockDiscussions = [
        {
          id: 'disc1',
          notes: [
            {
              id: 1,
              body: 'Thread comment 1',
              author: { id: 1, username: 'user1', name: 'User One' },
              createdAt: '2023-01-01T00:00:00Z',
              system: false,
              resolvable: true,
              resolved: false,
            },
            {
              id: 2,
              body: 'Thread comment 2',
              author: { id: 2, username: 'user2', name: 'User Two' },
              createdAt: '2023-01-02T00:00:00Z',
              system: false,
              resolvable: true,
              resolved: true,
            },
          ],
        },
      ];

      mockGitlab.MergeRequestDiscussions.all.mockResolvedValue(mockDiscussions);

      const result = await client.listDiscussions(1, 10);

      expect(mockGitlab.MergeRequestDiscussions.all).toHaveBeenCalledWith(1, 10);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('disc1');
      expect(result[0].notes).toHaveLength(2);
    });

    it('should handle empty discussions', async () => {
      mockGitlab.MergeRequestDiscussions.all.mockResolvedValue([]);

      const result = await client.listDiscussions(1, 10);

      expect(result).toEqual([]);
    });

    it('should work with project path string', async () => {
      mockGitlab.MergeRequestDiscussions.all.mockResolvedValue([]);

      await client.listDiscussions('group/project', 10);

      expect(mockGitlab.MergeRequestDiscussions.all).toHaveBeenCalledWith('group/project', 10);
    });
  });

  describe('createDiscussion', () => {
    it('should create merge request discussion', async () => {
      const mockDiscussion = {
        id: 'disc1',
        notes: [
          {
            id: 1,
            body: 'Start of discussion',
            author: { id: 1, username: 'johndoe', name: 'John Doe' },
            createdAt: '2023-01-01T00:00:00Z',
            system: false,
            resolvable: true,
            resolved: false,
          },
        ],
      };

      mockGitlab.MergeRequestDiscussions.create.mockResolvedValue(mockDiscussion);

      const result = await client.createDiscussion(1, 10, 'Start of discussion');

      expect(mockGitlab.MergeRequestDiscussions.create).toHaveBeenCalledWith(
        1,
        10,
        'Start of discussion'
      );
      expect(result.id).toBe('disc1');
      expect(result.notes).toHaveLength(1);
      expect(result.notes[0].body).toBe('Start of discussion');
    });

    it('should work with project path string', async () => {
      const mockDiscussion = {
        id: 'disc1',
        notes: [
          {
            id: 1,
            body: 'Discussion',
            author: { id: 1, username: 'user', name: 'User' },
            createdAt: '2023-01-01T00:00:00Z',
            system: false,
            resolvable: false,
          },
        ],
      };

      mockGitlab.MergeRequestDiscussions.create.mockResolvedValue(mockDiscussion);

      await client.createDiscussion('group/project', 10, 'Discussion');

      expect(mockGitlab.MergeRequestDiscussions.create).toHaveBeenCalledWith(
        'group/project',
        10,
        'Discussion'
      );
    });
  });

  describe('listCommits', () => {
    it('should list merge request commits', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          shortId: 'abc123',
          title: 'Commit message',
          message: 'Commit message\n\nDetails',
          authorName: 'John Doe',
          authorEmail: 'john@example.com',
          createdAt: '2023-01-01T00:00:00Z',
        },
        {
          id: 'def456',
          short_id: 'def456',
          title: 'Another commit',
          message: 'Another commit',
          author_name: 'Jane Doe',
          author_email: 'jane@example.com',
          created_at: '2023-01-02T00:00:00Z',
        },
      ];

      mockGitlab.MergeRequests.allCommits.mockResolvedValue(mockCommits);

      const result = await client.listCommits(1, 10);

      expect(mockGitlab.MergeRequests.allCommits).toHaveBeenCalledWith(1, 10);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 'abc123',
        short_id: 'abc123',
        title: 'Commit message',
        message: 'Commit message\n\nDetails',
        author_name: 'John Doe',
        author_email: 'john@example.com',
        created_at: '2023-01-01T00:00:00Z',
      });
    });

    it('should extract title from message if title missing', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          shortId: 'abc123',
          message: 'First line\nSecond line',
          authorName: 'John Doe',
          authorEmail: 'john@example.com',
          createdAt: '2023-01-01T00:00:00Z',
        },
      ];

      mockGitlab.MergeRequests.allCommits.mockResolvedValue(mockCommits);

      const result = await client.listCommits(1, 10);

      expect(result[0].title).toBe('First line');
    });

    it('should work with project path string', async () => {
      mockGitlab.MergeRequests.allCommits.mockResolvedValue([]);

      await client.listCommits('group/project', 10);

      expect(mockGitlab.MergeRequests.allCommits).toHaveBeenCalledWith('group/project', 10);
    });
  });

  describe('listPipelines', () => {
    it('should list merge request pipelines', async () => {
      const mockPipelines = [
        {
          id: 1,
          status: 'success',
          ref: 'feature-branch',
          sha: 'abc123',
          webUrl: 'https://gitlab.example.com/pipeline/1',
          createdAt: '2023-01-01T00:00:00Z',
          updatedAt: '2023-01-02T00:00:00Z',
        },
        {
          id: 2,
          status: 'running',
          ref: 'feature-branch',
          sha: 'def456',
          web_url: 'https://gitlab.example.com/pipeline/2',
          created_at: '2023-01-03T00:00:00Z',
          updated_at: '2023-01-03T00:00:00Z',
        },
      ];

      mockGitlab.MergeRequests.allPipelines.mockResolvedValue(mockPipelines);

      const result = await client.listPipelines(1, 10);

      expect(mockGitlab.MergeRequests.allPipelines).toHaveBeenCalledWith(1, 10);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 1,
        status: 'success',
        ref: 'feature-branch',
        sha: 'abc123',
        web_url: 'https://gitlab.example.com/pipeline/1',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
      });
    });

    it('should handle empty pipeline list', async () => {
      mockGitlab.MergeRequests.allPipelines.mockResolvedValue([]);

      const result = await client.listPipelines(1, 10);

      expect(result).toEqual([]);
    });

    it('should work with project path string', async () => {
      mockGitlab.MergeRequests.allPipelines.mockResolvedValue([]);

      await client.listPipelines('group/project', 10);

      expect(mockGitlab.MergeRequests.allPipelines).toHaveBeenCalledWith('group/project', 10);
    });
  });
});
