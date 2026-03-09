import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createIssuesClient } from './issues.js';

// Create inline mock
function createMockGitlab() {
  return {
    Issues: {
      all: vi.fn(),
      show: vi.fn(),
      create: vi.fn(),
      edit: vi.fn(),
    },
  };
}

describe('IssuesClient', () => {
  let mockGitlab: ReturnType<typeof createMockGitlab>;
  let client: ReturnType<typeof createIssuesClient>;

  beforeEach(() => {
    mockGitlab = createMockGitlab();
    client = createIssuesClient(mockGitlab as any);
  });

  describe('list', () => {
    it('should list issues with default options', async () => {
      const mockIssues = [
        {
          id: 1,
          iid: 10,
          title: 'Test Issue',
          description: 'Description',
          state: 'opened',
          labels: ['bug'],
          assignees: [],
          author: { id: 1, username: 'user1', name: 'User One' },
          webUrl: 'https://gitlab.com/issue/1',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        },
      ];
      mockGitlab.Issues.all.mockResolvedValue(mockIssues);

      const result = await client.list('project-123');

      expect(mockGitlab.Issues.all).toHaveBeenCalledWith({
        projectId: 'project-123',
        perPage: 20,
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 1,
        iid: 10,
        title: 'Test Issue',
        state: 'opened',
      });
    });

    it('should list issues with filters', async () => {
      const mockIssues = [
        {
          id: 2,
          iid: 20,
          title: 'Bug Issue',
          state: 'opened',
          labels: ['bug', 'urgent'],
          assignees: [{ id: 5, username: 'dev1', name: 'Developer' }],
          author: { id: 1, username: 'user1', name: 'User One' },
          webUrl: 'https://gitlab.com/issue/2',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        },
      ];
      mockGitlab.Issues.all.mockResolvedValue(mockIssues);

      const result = await client.list('project-123', {
        state: 'opened',
        labels: 'bug',
        assignee_username: 'dev1',
        limit: 10,
      });

      expect(mockGitlab.Issues.all).toHaveBeenCalledWith({
        projectId: 'project-123',
        perPage: 10,
        state: 'opened',
        labels: 'bug',
        assigneeUsername: 'dev1',
      });
      expect(result).toHaveLength(1);
      expect(result[0].labels).toEqual(['bug', 'urgent']);
    });

    it('should limit results to specified limit', async () => {
      const mockIssues = Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        iid: (i + 1) * 10,
        title: `Issue ${i + 1}`,
        state: 'opened',
        labels: [],
        assignees: [],
        author: { id: 1, username: 'user1', name: 'User One' },
        webUrl: `https://gitlab.com/issue/${i + 1}`,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      }));
      mockGitlab.Issues.all.mockResolvedValue(mockIssues);

      const result = await client.list('project-123', { limit: 5 });

      expect(result).toHaveLength(5);
    });
  });

  describe('get', () => {
    it('should get a single issue by IID', async () => {
      const mockIssue = {
        id: 1,
        iid: 10,
        title: 'Test Issue',
        description: 'Detailed description',
        state: 'opened',
        labels: ['bug', 'high-priority'],
        assignees: [{ id: 5, username: 'dev1', name: 'Developer One' }],
        author: { id: 1, username: 'user1', name: 'User One' },
        milestone: { id: 3, title: 'v1.0' },
        webUrl: 'https://gitlab.com/issue/1',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        closed_at: null,
      };
      mockGitlab.Issues.show.mockResolvedValue(mockIssue);

      const result = await client.get('project-123', 10);

      expect(mockGitlab.Issues.show).toHaveBeenCalledWith('project-123', 10);
      expect(result).toMatchObject({
        id: 1,
        iid: 10,
        title: 'Test Issue',
        description: 'Detailed description',
        state: 'opened',
        labels: ['bug', 'high-priority'],
      });
      expect(result.milestone).toEqual({ id: 3, title: 'v1.0' });
    });

    it('should handle issue without optional fields', async () => {
      const mockIssue = {
        id: 2,
        iid: 20,
        title: 'Minimal Issue',
        state: 'closed',
        labels: [],
        assignees: [],
        author: { id: 1, username: 'user1', name: 'User One' },
        webUrl: 'https://gitlab.com/issue/2',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      };
      mockGitlab.Issues.show.mockResolvedValue(mockIssue);

      const result = await client.get('project-123', 20);

      expect(result.description).toBeUndefined();
      expect(result.milestone).toBeUndefined();
      expect(result.closed_at).toBeUndefined();
    });
  });

  describe('create', () => {
    it('should create an issue with minimal options', async () => {
      const mockIssue = {
        id: 3,
        iid: 30,
        title: 'New Issue',
        state: 'opened',
        labels: [],
        assignees: [],
        author: { id: 1, username: 'user1', name: 'User One' },
        webUrl: 'https://gitlab.com/issue/3',
        created_at: '2024-01-03T00:00:00Z',
        updated_at: '2024-01-03T00:00:00Z',
      };
      mockGitlab.Issues.create.mockResolvedValue(mockIssue);

      const result = await client.create('project-123', 'New Issue');

      expect(mockGitlab.Issues.create).toHaveBeenCalledWith('project-123', {
        title: 'New Issue',
        description: undefined,
        labels: undefined,
        assigneeIds: undefined,
        milestoneId: undefined,
      });
      expect(result).toMatchObject({
        id: 3,
        iid: 30,
        title: 'New Issue',
        state: 'opened',
      });
    });

    it('should create an issue with full options', async () => {
      const mockIssue = {
        id: 4,
        iid: 40,
        title: 'Complex Issue',
        description: 'Detailed description',
        state: 'opened',
        labels: ['bug', 'urgent'],
        assignees: [{ id: 5, username: 'dev1', name: 'Developer One' }],
        author: { id: 1, username: 'user1', name: 'User One' },
        milestone: { id: 3, title: 'v1.0' },
        webUrl: 'https://gitlab.com/issue/4',
        created_at: '2024-01-04T00:00:00Z',
        updated_at: '2024-01-04T00:00:00Z',
      };
      mockGitlab.Issues.create.mockResolvedValue(mockIssue);

      const result = await client.create('project-123', 'Complex Issue', {
        description: 'Detailed description',
        labels: 'bug,urgent',
        assignee_ids: [5],
        milestone_id: 3,
      });

      expect(mockGitlab.Issues.create).toHaveBeenCalledWith('project-123', {
        title: 'Complex Issue',
        description: 'Detailed description',
        labels: 'bug,urgent',
        assigneeIds: [5],
        milestoneId: 3,
      });
      expect(result.milestone).toEqual({ id: 3, title: 'v1.0' });
    });
  });

  describe('update', () => {
    it('should update issue title', async () => {
      const mockIssue = {
        id: 5,
        iid: 50,
        title: 'Updated Title',
        state: 'opened',
        labels: [],
        assignees: [],
        author: { id: 1, username: 'user1', name: 'User One' },
        webUrl: 'https://gitlab.com/issue/5',
        created_at: '2024-01-05T00:00:00Z',
        updated_at: '2024-01-05T10:00:00Z',
      };
      mockGitlab.Issues.edit.mockResolvedValue(mockIssue);

      const result = await client.update('project-123', 50, {
        title: 'Updated Title',
      });

      expect(mockGitlab.Issues.edit).toHaveBeenCalledWith('project-123', 50, {
        title: 'Updated Title',
        description: undefined,
        labels: undefined,
        stateEvent: undefined,
      });
      expect(result.title).toBe('Updated Title');
    });

    it('should update multiple fields including state', async () => {
      const mockIssue = {
        id: 6,
        iid: 60,
        title: 'Updated Issue',
        description: 'Updated description',
        state: 'closed',
        labels: ['resolved'],
        assignees: [],
        author: { id: 1, username: 'user1', name: 'User One' },
        webUrl: 'https://gitlab.com/issue/6',
        created_at: '2024-01-06T00:00:00Z',
        updated_at: '2024-01-06T10:00:00Z',
        closed_at: '2024-01-06T10:00:00Z',
      };
      mockGitlab.Issues.edit.mockResolvedValue(mockIssue);

      const result = await client.update('project-123', 60, {
        title: 'Updated Issue',
        description: 'Updated description',
        labels: 'resolved',
        state_event: 'close',
      });

      expect(mockGitlab.Issues.edit).toHaveBeenCalledWith('project-123', 60, {
        title: 'Updated Issue',
        description: 'Updated description',
        labels: 'resolved',
        stateEvent: 'close',
      });
      expect(result.state).toBe('closed');
    });
  });

  describe('close', () => {
    it('should close an issue', async () => {
      const mockIssue = {
        id: 7,
        iid: 70,
        title: 'Closed Issue',
        state: 'closed',
        labels: [],
        assignees: [],
        author: { id: 1, username: 'user1', name: 'User One' },
        webUrl: 'https://gitlab.com/issue/7',
        created_at: '2024-01-07T00:00:00Z',
        updated_at: '2024-01-07T10:00:00Z',
        closed_at: '2024-01-07T10:00:00Z',
      };
      mockGitlab.Issues.edit.mockResolvedValue(mockIssue);

      const result = await client.close('project-123', 70);

      expect(mockGitlab.Issues.edit).toHaveBeenCalledWith('project-123', 70, {
        stateEvent: 'close',
      });
      expect(result.state).toBe('closed');
      expect(result.closed_at).toBe('2024-01-07T10:00:00Z');
    });
  });
});
