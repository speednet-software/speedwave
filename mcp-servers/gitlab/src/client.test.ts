/**
 * Comprehensive tests for GitLab API Client
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { GitLabConfig, GitLabClient as GitLabClientType } from './client.js';

// Create mock functions
const mockLoadToken = vi.fn();
const mockReadFile = vi.fn();
const mockGitlabConstructor = vi.fn();

// Mock @gitbeaker/rest - use a class that delegates to mockGitlabConstructor
vi.mock('@gitbeaker/rest', () => {
  return {
    Gitlab: class MockGitlab {
      constructor(...args: unknown[]) {
        mockGitlabConstructor(...args);
        // Copy all properties from mockGitlabInstance returned by setup
        const instance =
          mockGitlabConstructor.mock.results[mockGitlabConstructor.mock.results.length - 1]?.value;
        if (instance) {
          Object.assign(this, instance);
        }
      }
    },
  };
});

// Mock shared module
vi.mock('../../shared/dist/index.js', () => ({
  loadToken: mockLoadToken,
  ts: () => '[00:00:00]',
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    readFile: mockReadFile,
  },
}));

// Type for mock GitLab instance endpoints
interface MockGitlabEndpoints {
  Users: { showCurrentUser: Mock };
  Projects: { all: Mock; show: Mock };
  Search: { all: Mock };
  MergeRequests: {
    all: Mock;
    show: Mock;
    create: Mock;
    edit: Mock;
    accept: Mock;
    allDiffs: Mock;
    allCommits: Mock;
    allPipelines: Mock;
  };
  MergeRequestApprovals: { approve: Mock };
  MergeRequestNotes: { all: Mock; create: Mock };
  MergeRequestDiscussions: { all: Mock; create: Mock };
  Commits: { all: Mock; showDiff: Mock };
  Pipelines: { all: Mock; show: Mock; retry: Mock; create: Mock };
  Jobs: { all: Mock; showLog: Mock; erase: Mock };
  Tags: { create: Mock };
  ProjectReleases: { create: Mock };
  Branches: { all: Mock; show: Mock; create: Mock; remove: Mock };
  Repositories: { compare: Mock; allRepositoryTrees: Mock };
  RepositoryFiles: { show: Mock; allFileBlames: Mock };
  Issues: { all: Mock; create: Mock; edit: Mock };
  ProjectLabels: { all: Mock; create: Mock };
}

describe('GitLabClient', () => {
  let GitLabClientClass: typeof GitLabClientType;
  let client: InstanceType<typeof GitLabClientType>;
  let mockGitlabInstance: MockGitlabEndpoints;
  let config: GitLabConfig;

  beforeEach(async () => {
    vi.resetModules();

    // Setup mock GitLab instance
    mockGitlabInstance = {
      Users: {
        showCurrentUser: vi.fn(),
      },
      Projects: {
        all: vi.fn(),
        show: vi.fn(),
      },
      Search: {
        all: vi.fn(),
      },
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
      Commits: {
        all: vi.fn(),
        showDiff: vi.fn(),
      },
      Pipelines: {
        all: vi.fn(),
        show: vi.fn(),
        retry: vi.fn(),
        create: vi.fn(),
      },
      Jobs: {
        all: vi.fn(),
        showLog: vi.fn(),
        erase: vi.fn(),
      },
      Tags: {
        create: vi.fn(),
      },
      ProjectReleases: {
        create: vi.fn(),
      },
      Branches: {
        all: vi.fn(),
        show: vi.fn(),
        create: vi.fn(),
        remove: vi.fn(),
      },
      Repositories: {
        compare: vi.fn(),
        allRepositoryTrees: vi.fn(),
      },
      RepositoryFiles: {
        show: vi.fn(),
        allFileBlames: vi.fn(),
      },
      Issues: {
        all: vi.fn(),
        create: vi.fn(),
        edit: vi.fn(),
      },
      ProjectLabels: {
        all: vi.fn(),
        create: vi.fn(),
      },
    };

    // Mock Gitlab constructor
    mockGitlabConstructor.mockImplementation(() => mockGitlabInstance);

    config = {
      token: 'test-token',
      host: 'https://gitlab.example.com',
    };

    // Import client after mocks are set up
    const module = await import('./client.js');
    GitLabClientClass = module.GitLabClient;
    client = new GitLabClientClass(config);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create a GitLab client with provided config', () => {
      expect(mockGitlabConstructor).toHaveBeenCalledWith({
        token: 'test-token',
        host: 'https://gitlab.example.com',
      });
    });
  });

  describe('formatError', () => {
    it('should format 401 errors with authentication message', () => {
      const error = { response: { status: 401 } };
      const message = GitLabClientClass.formatError(error);
      expect(message).toContain('Authentication failed');
      expect(message).toContain('speedwave setup gitlab');
    });

    it('should format 401 errors from cause.response', () => {
      const error = { cause: { response: { status: 401 } } };
      const message = GitLabClientClass.formatError(error);
      expect(message).toContain('Authentication failed');
    });

    it('should format 401 errors from message', () => {
      const error = { message: 'Request failed with status 401 Unauthorized' };
      const message = GitLabClientClass.formatError(error);
      expect(message).toContain('Authentication failed');
    });

    it('should format 403 errors with permission message', () => {
      const error = { response: { status: 403 } };
      const message = GitLabClientClass.formatError(error);
      expect(message).toContain('Permission denied');
    });

    it('should format 403 errors from message', () => {
      const error = { message: '403 Forbidden' };
      const message = GitLabClientClass.formatError(error);
      expect(message).toContain('Permission denied');
    });

    it('should format 404 errors', () => {
      const error = { response: { status: 404 } };
      const message = GitLabClientClass.formatError(error);
      expect(message).toBe('Resource not found in GitLab.');
    });

    it('should format 404 errors from message', () => {
      const error = { message: 'Resource not found' };
      const message = GitLabClientClass.formatError(error);
      expect(message).toBe('Resource not found in GitLab.');
    });

    it('should format network errors with getaddrinfo', () => {
      const error = { message: 'getaddrinfo ENOTFOUND gitlab.example.com' };
      const message = GitLabClientClass.formatError(error);
      expect(message).toContain('Network error');
      expect(message).toContain('speedwave setup gitlab');
    });

    it('should format network errors with ECONNREFUSED', () => {
      const error = { message: 'connect ECONNREFUSED 127.0.0.1:443' };
      const message = GitLabClientClass.formatError(error);
      expect(message).toContain('Network error');
    });

    it('should format network errors with network keyword', () => {
      const error = { message: 'network timeout' };
      const message = GitLabClientClass.formatError(error);
      expect(message).toContain('Network error');
    });

    it('should extract description from gitbeaker errors', () => {
      const error = { cause: { description: 'Invalid parameter: name' } };
      const message = GitLabClientClass.formatError(error);
      expect(message).toBe('GitLab API error: Invalid parameter: name');
    });

    it('should return generic message for unknown errors', () => {
      const error = { message: 'Something went wrong' };
      const message = GitLabClientClass.formatError(error);
      expect(message).toBe('Something went wrong');
    });

    it('should return generic message for empty errors', () => {
      const error = {};
      const message = GitLabClientClass.formatError(error);
      expect(message).toBe('GitLab API error');
    });
  });

  describe('testConnection', () => {
    it('should return success when connection succeeds', async () => {
      mockGitlabInstance.Users.showCurrentUser.mockResolvedValue({ id: 1 });
      const result = await client.testConnection();
      expect(result).toEqual({ success: true });
      expect(mockGitlabInstance.Users.showCurrentUser).toHaveBeenCalled();
    });

    it('should return error result when connection fails', async () => {
      mockGitlabInstance.Users.showCurrentUser.mockRejectedValue(
        new Error('getaddrinfo ENOTFOUND gitlab.example.com')
      );
      const result = await client.testConnection();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.errorType).toBe('network');
    });
  });

  describe('listProjects', () => {
    it('should list projects with default options', async () => {
      const mockProjects = [
        {
          id: 1,
          name: 'Project 1',
          pathWithNamespace: 'group/project-1',
          description: 'Test project',
          webUrl: 'https://gitlab.example.com/group/project-1',
          defaultBranch: 'main',
        },
        {
          id: 2,
          name: 'Project 2',
          pathWithNamespace: 'group/project-2',
          webUrl: 'https://gitlab.example.com/group/project-2',
        },
      ];

      mockGitlabInstance.Projects.all.mockResolvedValue(mockProjects);

      const result = await client.listProjects();

      expect(mockGitlabInstance.Projects.all).toHaveBeenCalledWith({
        search: undefined,
        perPage: 20,
        page: 1,
        pagination: 'offset',
        owned: undefined,
      });

      expect(result).toEqual([
        {
          id: 1,
          name: 'Project 1',
          path_with_namespace: 'group/project-1',
          description: 'Test project',
          web_url: 'https://gitlab.example.com/group/project-1',
          default_branch: 'main',
        },
        {
          id: 2,
          name: 'Project 2',
          path_with_namespace: 'group/project-2',
          description: undefined,
          web_url: 'https://gitlab.example.com/group/project-2',
          default_branch: undefined,
        },
      ]);
    });

    it('should list projects with search and limit', async () => {
      const mockProjects = [
        {
          id: 1,
          name: 'Search Project',
          pathWithNamespace: 'group/search-project',
          webUrl: 'https://gitlab.example.com/group/search-project',
        },
      ];

      mockGitlabInstance.Projects.all.mockResolvedValue(mockProjects);

      await client.listProjects({ search: 'test', limit: 10 });

      expect(mockGitlabInstance.Projects.all).toHaveBeenCalledWith({
        search: 'test',
        perPage: 10,
        page: 1,
        pagination: 'offset',
        owned: undefined,
      });
    });

    it('should list only owned projects', async () => {
      mockGitlabInstance.Projects.all.mockResolvedValue([]);
      await client.listProjects({ owned: true });

      expect(mockGitlabInstance.Projects.all).toHaveBeenCalledWith({
        search: undefined,
        perPage: 20,
        page: 1,
        pagination: 'offset',
        owned: true,
      });
    });

    it('should handle snake_case properties', async () => {
      const mockProjects = [
        {
          id: 1,
          name: 'Project',
          path_with_namespace: 'group/project',
          web_url: 'https://gitlab.example.com/group/project',
        },
      ];

      mockGitlabInstance.Projects.all.mockResolvedValue(mockProjects);
      const result = await client.listProjects();

      expect(result[0].path_with_namespace).toBe('group/project');
      expect(result[0].web_url).toBe('https://gitlab.example.com/group/project');
    });

    it('should limit results to specified limit', async () => {
      const mockProjects = Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        name: `Project ${i + 1}`,
        pathWithNamespace: `group/project-${i + 1}`,
        webUrl: `https://gitlab.example.com/group/project-${i + 1}`,
      }));

      mockGitlabInstance.Projects.all.mockResolvedValue(mockProjects);
      const result = await client.listProjects({ limit: 10 });

      expect(result).toHaveLength(10);
    });
  });

  describe('showProject', () => {
    it('should show project by ID', async () => {
      const mockProject = {
        id: 1,
        name: 'Test Project',
        pathWithNamespace: 'group/test-project',
        description: 'A test project',
        webUrl: 'https://gitlab.example.com/group/test-project',
        defaultBranch: 'main',
      };

      mockGitlabInstance.Projects.show.mockResolvedValue(mockProject);

      const result = await client.showProject(1);

      expect(mockGitlabInstance.Projects.show).toHaveBeenCalledWith(1, {
        license: undefined,
        statistics: undefined,
      });
      expect(result).toEqual({
        id: 1,
        name: 'Test Project',
        path_with_namespace: 'group/test-project',
        description: 'A test project',
        web_url: 'https://gitlab.example.com/group/test-project',
        default_branch: 'main',
      });
    });

    it('should show project by path', async () => {
      const mockProject = {
        id: 1,
        name: 'Test Project',
        pathWithNamespace: 'group/test-project',
        webUrl: 'https://gitlab.example.com/group/test-project',
      };

      mockGitlabInstance.Projects.show.mockResolvedValue(mockProject);

      await client.showProject('group/test-project');

      expect(mockGitlabInstance.Projects.show).toHaveBeenCalledWith('group/test-project', {
        license: undefined,
        statistics: undefined,
      });
    });
  });

  describe('searchCode', () => {
    it('should search code globally', async () => {
      const mockResults = [{ filename: 'test.js', data: 'const test = "value";' }];

      mockGitlabInstance.Search.all.mockResolvedValue(mockResults);

      const result = await client.searchCode('test');

      expect(mockGitlabInstance.Search.all).toHaveBeenCalledWith('blobs', 'test');
      expect(result).toEqual(mockResults);
    });

    it('should search code within a project', async () => {
      const mockResults = [{ filename: 'test.js', data: 'const test = "value";' }];

      mockGitlabInstance.Search.all.mockResolvedValue(mockResults);

      const result = await client.searchCode('test', { project_id: 1 });

      expect(mockGitlabInstance.Search.all).toHaveBeenCalledWith('blobs', 'test', {
        projectId: 1,
      });
      expect(result).toEqual(mockResults);
    });

    it('should search code with scope', async () => {
      mockGitlabInstance.Search.all.mockResolvedValue([]);

      await client.searchCode('test', { project_id: 'group/project', scope: 'blobs' });

      expect(mockGitlabInstance.Search.all).toHaveBeenCalledWith('blobs', 'test', {
        projectId: 'group/project',
      });
    });
  });

  describe('listMergeRequests', () => {
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

      mockGitlabInstance.MergeRequests.all.mockResolvedValue(mockMRs);

      const result = await client.listMergeRequests(1);

      expect(mockGitlabInstance.MergeRequests.all).toHaveBeenCalledWith({
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
      mockGitlabInstance.MergeRequests.all.mockResolvedValue([]);

      await client.listMergeRequests(1, { state: 'merged' });

      expect(mockGitlabInstance.MergeRequests.all).toHaveBeenCalledWith({
        projectId: 1,
        perPage: 20,
        state: 'merged',
      });
    });

    it('should filter merge requests by author', async () => {
      mockGitlabInstance.MergeRequests.all.mockResolvedValue([]);

      await client.listMergeRequests(1, { author_username: 'johndoe' });

      expect(mockGitlabInstance.MergeRequests.all).toHaveBeenCalledWith({
        projectId: 1,
        perPage: 20,
        authorUsername: 'johndoe',
      });
    });

    it('should filter merge requests by reviewer', async () => {
      mockGitlabInstance.MergeRequests.all.mockResolvedValue([]);

      await client.listMergeRequests(1, { reviewer_username: 'janedoe' });

      expect(mockGitlabInstance.MergeRequests.all).toHaveBeenCalledWith({
        projectId: 1,
        perPage: 20,
        reviewerUsername: 'janedoe',
      });
    });

    it('should filter merge requests by labels', async () => {
      mockGitlabInstance.MergeRequests.all.mockResolvedValue([]);

      await client.listMergeRequests(1, { labels: 'bug,urgent' });

      expect(mockGitlabInstance.MergeRequests.all).toHaveBeenCalledWith({
        projectId: 1,
        perPage: 20,
        labels: 'bug,urgent',
      });
    });

    it('should limit merge request results', async () => {
      mockGitlabInstance.MergeRequests.all.mockResolvedValue([]);

      await client.listMergeRequests(1, { limit: 5 });

      expect(mockGitlabInstance.MergeRequests.all).toHaveBeenCalledWith({
        projectId: 1,
        perPage: 5,
      });
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

      mockGitlabInstance.MergeRequests.all.mockResolvedValue(mockMRs);
      const result = await client.listMergeRequests(1);

      expect(result[0].source_branch).toBe('feature');
      expect(result[0].target_branch).toBe('main');
    });

    it('should limit results to specified limit', async () => {
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

      mockGitlabInstance.MergeRequests.all.mockResolvedValue(mockMRs);
      const result = await client.listMergeRequests(1, { limit: 10 });

      expect(result).toHaveLength(10);
    });
  });

  describe('showMergeRequest', () => {
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

      mockGitlabInstance.MergeRequests.show.mockResolvedValue(mockMR);

      const result = await client.showMergeRequest(1, 10);

      expect(mockGitlabInstance.MergeRequests.show).toHaveBeenCalledWith(1, 10);
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
  });

  describe('createMergeRequest', () => {
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

      mockGitlabInstance.MergeRequests.create.mockResolvedValue(mockMR);

      const result = await client.createMergeRequest(1, {
        source_branch: 'feature-branch',
        target_branch: 'main',
        title: 'New Feature',
      });

      expect(mockGitlabInstance.MergeRequests.create).toHaveBeenCalledWith(
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

      mockGitlabInstance.MergeRequests.create.mockResolvedValue(mockMR);

      await client.createMergeRequest(1, {
        source_branch: 'feature-branch',
        target_branch: 'main',
        title: 'New Feature',
        description: 'Feature description',
        labels: 'feature,enhancement',
        remove_source_branch: true,
      });

      expect(mockGitlabInstance.MergeRequests.create).toHaveBeenCalledWith(
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
  });

  describe('approveMergeRequest', () => {
    it('should approve merge request', async () => {
      mockGitlabInstance.MergeRequestApprovals.approve.mockResolvedValue({});

      await client.approveMergeRequest(1, 10);

      expect(mockGitlabInstance.MergeRequestApprovals.approve).toHaveBeenCalledWith(1, 10);
    });
  });

  describe('mergeMergeRequest', () => {
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

      mockGitlabInstance.MergeRequests.accept.mockResolvedValue(mockMR);

      const result = await client.mergeMergeRequest(1, 10);

      expect(mockGitlabInstance.MergeRequests.accept).toHaveBeenCalledWith(1, 10, {
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

      mockGitlabInstance.MergeRequests.accept.mockResolvedValue(mockMR);

      await client.mergeMergeRequest(1, 10, {
        squash: true,
        should_remove_source_branch: true,
        auto_merge: true,
        sha: 'abc123',
      });

      expect(mockGitlabInstance.MergeRequests.accept).toHaveBeenCalledWith(1, 10, {
        squash: true,
        shouldRemoveSourceBranch: true,
        sha: 'abc123',
        mergeWhenPipelineSucceeds: true,
      });
    });
  });

  describe('updateMergeRequest', () => {
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

      mockGitlabInstance.MergeRequests.edit.mockResolvedValue(mockMR);

      const result = await client.updateMergeRequest(1, 10, {
        title: 'Updated Title',
      });

      expect(mockGitlabInstance.MergeRequests.edit).toHaveBeenCalledWith(1, 10, {
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

      mockGitlabInstance.MergeRequests.edit.mockResolvedValue(mockMR);

      await client.updateMergeRequest(1, 10, {
        title: 'Updated Title',
        description: 'Updated description',
        target_branch: 'develop',
        state_event: 'close',
        labels: 'bug,critical',
      });

      expect(mockGitlabInstance.MergeRequests.edit).toHaveBeenCalledWith(1, 10, {
        title: 'Updated Title',
        description: 'Updated description',
        targetBranch: 'develop',
        stateEvent: 'close',
        labels: 'bug,critical',
      });
    });
  });

  describe('getMrChanges', () => {
    it('should get merge request changes', async () => {
      const mockDiffs = [{ diff: 'diff content', new_path: 'file.js', old_path: 'file.js' }];

      mockGitlabInstance.MergeRequests.allDiffs.mockResolvedValue(mockDiffs);

      const result = await client.getMrChanges(1, 10);

      expect(mockGitlabInstance.MergeRequests.allDiffs).toHaveBeenCalledWith(1, 10);
      expect(result).toEqual(mockDiffs);
    });
  });

  describe('listBranchCommits', () => {
    it('should list commits with default limit', async () => {
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
      ];

      mockGitlabInstance.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.listBranchCommits(1, 'main');

      expect(mockGitlabInstance.Commits.all).toHaveBeenCalledWith(1, {
        refName: 'main',
        perPage: 20,
      });

      expect(result).toEqual([
        {
          id: 'abc123',
          short_id: 'abc123',
          title: 'Commit message',
          message: 'Commit message\n\nDetails',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2023-01-01T00:00:00Z',
        },
      ]);
    });

    it('should list commits with custom limit', async () => {
      mockGitlabInstance.Commits.all.mockResolvedValue([]);

      await client.listBranchCommits(1, 'develop', 10);

      expect(mockGitlabInstance.Commits.all).toHaveBeenCalledWith(1, {
        refName: 'develop',
        perPage: 10,
      });
    });

    it('should handle snake_case properties in commits', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          short_id: 'abc123',
          title: 'Commit',
          message: 'Message',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2023-01-01T00:00:00Z',
        },
      ];

      mockGitlabInstance.Commits.all.mockResolvedValue(mockCommits);
      const result = await client.listBranchCommits(1, 'main');

      expect(result[0].author_name).toBe('John Doe');
      expect(result[0].author_email).toBe('john@example.com');
    });

    it('should limit results to specified limit', async () => {
      const mockCommits = Array.from({ length: 30 }, (_, i) => ({
        id: `commit-${i}`,
        shortId: `commit-${i}`,
        title: `Commit ${i}`,
        message: `Message ${i}`,
        authorName: 'User',
        authorEmail: 'user@example.com',
        createdAt: '2023-01-01T00:00:00Z',
      }));

      mockGitlabInstance.Commits.all.mockResolvedValue(mockCommits);
      const result = await client.listBranchCommits(1, 'main', 10);

      expect(result).toHaveLength(10);
    });
  });

  describe('getCommitDiff', () => {
    it('should get commit diff', async () => {
      const mockDiff = [{ diff: 'diff content', new_path: 'file.js', old_path: 'file.js' }];

      mockGitlabInstance.Commits.showDiff.mockResolvedValue(mockDiff);

      const result = await client.getCommitDiff(1, 'abc123');

      expect(mockGitlabInstance.Commits.showDiff).toHaveBeenCalledWith(1, 'abc123');
      expect(result).toEqual(mockDiff);
    });
  });

  describe('listPipelines', () => {
    it('should list pipelines with default options', async () => {
      const mockPipelines = [
        {
          id: 1,
          status: 'success',
          ref: 'main',
          sha: 'abc123',
          webUrl: 'https://gitlab.example.com/pipeline/1',
          createdAt: '2023-01-01T00:00:00Z',
          updatedAt: '2023-01-02T00:00:00Z',
        },
      ];

      mockGitlabInstance.Pipelines.all.mockResolvedValue(mockPipelines);

      const result = await client.listPipelines(1);

      expect(mockGitlabInstance.Pipelines.all).toHaveBeenCalledWith(1, {
        status: undefined,
        ref: undefined,
        perPage: 5,
        page: 1,
      });

      expect(result).toEqual([
        {
          id: 1,
          status: 'success',
          ref: 'main',
          sha: 'abc123',
          web_url: 'https://gitlab.example.com/pipeline/1',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-02T00:00:00Z',
        },
      ]);
    });

    it('should filter pipelines by status', async () => {
      mockGitlabInstance.Pipelines.all.mockResolvedValue([]);

      await client.listPipelines(1, { status: 'running' });

      expect(mockGitlabInstance.Pipelines.all).toHaveBeenCalledWith(1, {
        status: 'running',
        ref: undefined,
        perPage: 5,
        page: 1,
      });
    });

    it('should filter pipelines by ref', async () => {
      mockGitlabInstance.Pipelines.all.mockResolvedValue([]);

      await client.listPipelines(1, { ref: 'develop' });

      expect(mockGitlabInstance.Pipelines.all).toHaveBeenCalledWith(1, {
        status: undefined,
        ref: 'develop',
        perPage: 5,
        page: 1,
      });
    });

    it('should paginate pipelines', async () => {
      mockGitlabInstance.Pipelines.all.mockResolvedValue([]);

      await client.listPipelines(1, { page: 2, limit: 10 });

      expect(mockGitlabInstance.Pipelines.all).toHaveBeenCalledWith(1, {
        status: undefined,
        ref: undefined,
        perPage: 10,
        page: 2,
      });
    });

    it('should handle snake_case properties in pipelines', async () => {
      const mockPipelines = [
        {
          id: 1,
          status: 'success',
          ref: 'main',
          sha: 'abc123',
          web_url: 'https://gitlab.example.com/pipeline/1',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-02T00:00:00Z',
        },
      ];

      mockGitlabInstance.Pipelines.all.mockResolvedValue(mockPipelines);
      const result = await client.listPipelines(1);

      expect(result[0].web_url).toBe('https://gitlab.example.com/pipeline/1');
    });
  });

  describe('showPipeline', () => {
    it('should show pipeline with jobs', async () => {
      const mockPipeline = {
        id: 1,
        status: 'success',
        ref: 'main',
      };

      const mockJobs = [
        { id: 1, name: 'test', status: 'success' },
        { id: 2, name: 'build', status: 'success' },
      ];

      mockGitlabInstance.Pipelines.show.mockResolvedValue(mockPipeline);
      mockGitlabInstance.Jobs.all.mockResolvedValue(mockJobs);

      const result = await client.showPipeline(1, 1);

      expect(mockGitlabInstance.Pipelines.show).toHaveBeenCalledWith(1, 1);
      expect(mockGitlabInstance.Jobs.all).toHaveBeenCalledWith(1, { pipelineId: 1 });
      expect(result).toEqual({
        pipeline: mockPipeline,
        jobs: mockJobs,
      });
    });
  });

  describe('getJobLog', () => {
    it('should get job log with default tail', async () => {
      const mockLog = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`).join('\n');

      mockGitlabInstance.Jobs.showLog.mockResolvedValue(mockLog);

      const result = await client.getJobLog(1, 1);

      expect(mockGitlabInstance.Jobs.showLog).toHaveBeenCalledWith(1, 1);

      const lines = result.split('\n');
      expect(lines).toHaveLength(100);
      expect(lines[0]).toBe('Line 101');
      expect(lines[99]).toBe('Line 200');
    });

    it('should get job log with custom tail', async () => {
      const mockLog = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`).join('\n');

      mockGitlabInstance.Jobs.showLog.mockResolvedValue(mockLog);

      const result = await client.getJobLog(1, 1, 50);

      const lines = result.split('\n');
      expect(lines).toHaveLength(50);
      expect(lines[0]).toBe('Line 151');
    });

    it('should return full log if shorter than tail', async () => {
      const mockLog = 'Line 1\nLine 2\nLine 3';

      mockGitlabInstance.Jobs.showLog.mockResolvedValue(mockLog);

      const result = await client.getJobLog(1, 1, 100);

      expect(result).toBe(mockLog);
    });
  });

  describe('retryPipeline', () => {
    it('should retry pipeline', async () => {
      const mockPipeline = {
        id: 1,
        status: 'running',
        ref: 'main',
        sha: 'abc123',
        webUrl: 'https://gitlab.example.com/pipeline/1',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
      };

      mockGitlabInstance.Pipelines.retry.mockResolvedValue(mockPipeline);

      const result = await client.retryPipeline(1, 1);

      expect(mockGitlabInstance.Pipelines.retry).toHaveBeenCalledWith(1, 1);
      expect(result).toEqual({
        id: 1,
        status: 'running',
        ref: 'main',
        sha: 'abc123',
        web_url: 'https://gitlab.example.com/pipeline/1',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-02T00:00:00Z',
      });
    });
  });

  describe('triggerPipeline', () => {
    it('should trigger pipeline with ref only', async () => {
      const mockPipeline = {
        id: 123,
        status: 'pending',
        ref: 'master',
        sha: 'abc123',
        webUrl: 'https://gitlab.example.com/pipeline/123',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      };

      mockGitlabInstance.Pipelines.create.mockResolvedValue(mockPipeline);

      const result = await client.triggerPipeline(1, { ref: 'master' });

      expect(mockGitlabInstance.Pipelines.create).toHaveBeenCalledWith(1, 'master', {
        variables: undefined,
      });
      expect(result).toEqual({
        id: 123,
        status: 'pending',
        ref: 'master',
        sha: 'abc123',
        web_url: 'https://gitlab.example.com/pipeline/123',
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-01T00:00:00Z',
      });
    });

    it('should trigger pipeline with variables', async () => {
      const mockPipeline = {
        id: 124,
        status: 'pending',
        ref: 'master',
        sha: 'def456',
        webUrl: 'https://gitlab.example.com/pipeline/124',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      };

      mockGitlabInstance.Pipelines.create.mockResolvedValue(mockPipeline);

      await client.triggerPipeline(1, {
        ref: 'master',
        variables: [{ key: 'RELEASE_TYPE', value: 'patch' }],
      });

      expect(mockGitlabInstance.Pipelines.create).toHaveBeenCalledWith(1, 'master', {
        variables: [{ key: 'RELEASE_TYPE', value: 'patch' }],
      });
    });

    it('should trigger pipeline with multiple variables', async () => {
      const mockPipeline = {
        id: 125,
        status: 'pending',
        ref: 'develop',
        sha: 'ghi789',
        webUrl: 'https://gitlab.example.com/pipeline/125',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      };

      mockGitlabInstance.Pipelines.create.mockResolvedValue(mockPipeline);

      await client.triggerPipeline('group/project', {
        ref: 'develop',
        variables: [
          { key: 'DEPLOY_ENV', value: 'staging' },
          { key: 'SKIP_TESTS', value: 'false' },
        ],
      });

      expect(mockGitlabInstance.Pipelines.create).toHaveBeenCalledWith('group/project', 'develop', {
        variables: [
          { key: 'DEPLOY_ENV', value: 'staging' },
          { key: 'SKIP_TESTS', value: 'false' },
        ],
      });
    });
  });

  describe('createTag', () => {
    it('should create tag with required fields', async () => {
      const mockTag = {
        name: 'v1.0.0',
        target: 'abc123',
      };

      mockGitlabInstance.Tags.create.mockResolvedValue(mockTag);

      const result = await client.createTag(1, {
        tag_name: 'v1.0.0',
        ref: 'main',
      });

      expect(mockGitlabInstance.Tags.create).toHaveBeenCalledWith(1, 'v1.0.0', 'main', {
        message: undefined,
      });
      expect(result).toEqual(mockTag);
    });

    it('should create tag with message', async () => {
      const mockTag = {
        name: 'v1.0.0',
        target: 'abc123',
        message: 'Release v1.0.0',
      };

      mockGitlabInstance.Tags.create.mockResolvedValue(mockTag);

      await client.createTag(1, {
        tag_name: 'v1.0.0',
        ref: 'main',
        message: 'Release v1.0.0',
      });

      expect(mockGitlabInstance.Tags.create).toHaveBeenCalledWith(1, 'v1.0.0', 'main', {
        message: 'Release v1.0.0',
      });
    });
  });

  describe('createRelease', () => {
    it('should create release with tag name', async () => {
      const mockRelease = {
        tag_name: 'v1.0.0',
        name: 'v1.0.0',
      };

      mockGitlabInstance.ProjectReleases.create.mockResolvedValue(mockRelease);

      const result = await client.createRelease(1, {
        tag_name: 'v1.0.0',
      });

      expect(mockGitlabInstance.ProjectReleases.create).toHaveBeenCalledWith(1, {
        tagName: 'v1.0.0',
        name: 'v1.0.0',
        description: undefined,
      });
      expect(result).toEqual(mockRelease);
    });

    it('should create release with custom name and description', async () => {
      const mockRelease = {
        tag_name: 'v1.0.0',
        name: 'Release 1.0.0',
        description: 'First major release',
      };

      mockGitlabInstance.ProjectReleases.create.mockResolvedValue(mockRelease);

      await client.createRelease(1, {
        tag_name: 'v1.0.0',
        name: 'Release 1.0.0',
        description: 'First major release',
      });

      expect(mockGitlabInstance.ProjectReleases.create).toHaveBeenCalledWith(1, {
        tagName: 'v1.0.0',
        name: 'Release 1.0.0',
        description: 'First major release',
      });
    });
  });

  //═════════════════════════════════════════════════════════════════════════════
  // MR Related Methods
  //═════════════════════════════════════════════════════════════════════════════

  describe('listMrCommits', () => {
    it('should list MR commits with default limit', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          shortId: 'abc123',
          title: 'Fix bug',
          message: 'Fix bug\n\nDetails here',
          authorName: 'John Doe',
          authorEmail: 'john@example.com',
          createdAt: '2023-01-01T00:00:00Z',
        },
      ];

      mockGitlabInstance.MergeRequests.allCommits.mockResolvedValue(mockCommits);

      const result = await client.listMrCommits(1, 10);

      expect(mockGitlabInstance.MergeRequests.allCommits).toHaveBeenCalledWith(1, 10, {
        perPage: 20,
      });
      expect(result).toEqual([
        {
          id: 'abc123',
          short_id: 'abc123',
          title: 'Fix bug',
          message: 'Fix bug\n\nDetails here',
          author_name: 'John Doe',
          author_email: 'john@example.com',
          created_at: '2023-01-01T00:00:00Z',
        },
      ]);
    });

    it('should list MR commits with custom limit', async () => {
      mockGitlabInstance.MergeRequests.allCommits.mockResolvedValue([]);

      await client.listMrCommits(1, 10, 5);

      expect(mockGitlabInstance.MergeRequests.allCommits).toHaveBeenCalledWith(1, 10, {
        perPage: 5,
      });
    });

    it('should handle snake_case properties', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          short_id: 'abc123',
          title: 'Fix',
          message: 'Fix',
          author_name: 'John',
          author_email: 'john@example.com',
          created_at: '2023-01-01T00:00:00Z',
        },
      ];

      mockGitlabInstance.MergeRequests.allCommits.mockResolvedValue(mockCommits);

      const result = await client.listMrCommits(1, 10);

      expect(result[0].author_name).toBe('John');
    });
  });

  describe('listMrPipelines', () => {
    it('should list MR pipelines with default limit', async () => {
      const mockPipelines = [
        {
          id: 1,
          status: 'success',
          ref: 'feature',
          sha: 'abc123',
          webUrl: 'https://gitlab.example.com/pipeline/1',
          createdAt: '2023-01-01T00:00:00Z',
          updatedAt: '2023-01-02T00:00:00Z',
        },
      ];

      mockGitlabInstance.MergeRequests.allPipelines.mockResolvedValue(mockPipelines);

      const result = await client.listMrPipelines(1, 10);

      expect(mockGitlabInstance.MergeRequests.allPipelines).toHaveBeenCalledWith(1, 10);
      expect(result).toEqual([
        {
          id: 1,
          status: 'success',
          ref: 'feature',
          sha: 'abc123',
          web_url: 'https://gitlab.example.com/pipeline/1',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-02T00:00:00Z',
        },
      ]);
    });

    it('should limit results', async () => {
      const mockPipelines = Array.from({ length: 20 }, (_, i) => ({
        id: i + 1,
        status: 'success',
        ref: 'feature',
        sha: `sha${i}`,
        webUrl: `https://gitlab.example.com/pipeline/${i}`,
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-02T00:00:00Z',
      }));

      mockGitlabInstance.MergeRequests.allPipelines.mockResolvedValue(mockPipelines);

      const result = await client.listMrPipelines(1, 10, 5);

      expect(result).toHaveLength(5);
    });
  });

  describe('listMrNotes', () => {
    it('should list MR notes', async () => {
      const mockNotes = [
        { id: 1, body: 'Comment 1', author: { username: 'user1' } },
        { id: 2, body: 'Comment 2', author: { username: 'user2' } },
      ];

      mockGitlabInstance.MergeRequestNotes.all.mockResolvedValue(mockNotes);

      const result = await client.listMrNotes(1, 10);

      expect(mockGitlabInstance.MergeRequestNotes.all).toHaveBeenCalledWith(1, 10, {
        perPage: 20,
      });
      expect(result).toEqual(mockNotes);
    });

    it('should limit notes', async () => {
      const mockNotes = Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        body: `Note ${i}`,
      }));

      mockGitlabInstance.MergeRequestNotes.all.mockResolvedValue(mockNotes);

      const result = await client.listMrNotes(1, 10, 10);

      expect(result).toHaveLength(10);
    });
  });

  describe('createMrNote', () => {
    it('should create MR note', async () => {
      const mockNote = { id: 1, body: 'New comment' };

      mockGitlabInstance.MergeRequestNotes.create.mockResolvedValue(mockNote);

      const result = await client.createMrNote(1, 10, 'New comment');

      expect(mockGitlabInstance.MergeRequestNotes.create).toHaveBeenCalledWith(
        1,
        10,
        'New comment'
      );
      expect(result).toEqual(mockNote);
    });
  });

  describe('listMrDiscussions', () => {
    it('should list MR discussions', async () => {
      const mockDiscussions = [
        { id: 'disc1', notes: [{ body: 'Discussion 1' }] },
        { id: 'disc2', notes: [{ body: 'Discussion 2' }] },
      ];

      mockGitlabInstance.MergeRequestDiscussions.all.mockResolvedValue(mockDiscussions);

      const result = await client.listMrDiscussions(1, 10);

      expect(mockGitlabInstance.MergeRequestDiscussions.all).toHaveBeenCalledWith(1, 10, {
        perPage: 20,
      });
      expect(result).toEqual(mockDiscussions);
    });

    it('should limit discussions', async () => {
      const mockDiscussions = Array.from({ length: 30 }, (_, i) => ({
        id: `disc${i}`,
        notes: [],
      }));

      mockGitlabInstance.MergeRequestDiscussions.all.mockResolvedValue(mockDiscussions);

      const result = await client.listMrDiscussions(1, 10, 5);

      expect(result).toHaveLength(5);
    });
  });

  describe('createMrDiscussion', () => {
    it('should create MR discussion', async () => {
      const mockDiscussion = { id: 'disc1', notes: [{ body: 'New discussion' }] };

      mockGitlabInstance.MergeRequestDiscussions.create.mockResolvedValue(mockDiscussion);

      const result = await client.createMrDiscussion(1, 10, 'New discussion');

      expect(mockGitlabInstance.MergeRequestDiscussions.create).toHaveBeenCalledWith(
        1,
        10,
        'New discussion'
      );
      expect(result).toEqual(mockDiscussion);
    });
  });

  //═════════════════════════════════════════════════════════════════════════════
  // Branches
  //═════════════════════════════════════════════════════════════════════════════

  describe('listBranches', () => {
    it('should list branches with default options', async () => {
      const mockBranches = [
        { name: 'main', commit: { id: 'abc123' } },
        { name: 'develop', commit: { id: 'def456' } },
      ];

      mockGitlabInstance.Branches.all.mockResolvedValue(mockBranches);

      const result = await client.listBranches(1);

      expect(mockGitlabInstance.Branches.all).toHaveBeenCalledWith(1, {
        search: undefined,
        perPage: 20,
      });
      expect(result).toEqual(mockBranches);
    });

    it('should search branches', async () => {
      mockGitlabInstance.Branches.all.mockResolvedValue([]);

      await client.listBranches(1, { search: 'feat' });

      expect(mockGitlabInstance.Branches.all).toHaveBeenCalledWith(1, {
        search: 'feat',
        perPage: 20,
      });
    });

    it('should limit branches', async () => {
      const mockBranches = Array.from({ length: 30 }, (_, i) => ({
        name: `branch-${i}`,
        commit: { id: `sha${i}` },
      }));

      mockGitlabInstance.Branches.all.mockResolvedValue(mockBranches);

      const result = await client.listBranches(1, { limit: 10 });

      expect(result).toHaveLength(10);
    });
  });

  describe('getBranch', () => {
    it('should get branch by name', async () => {
      const mockBranch = { name: 'main', commit: { id: 'abc123' }, protected: true };

      mockGitlabInstance.Branches.show.mockResolvedValue(mockBranch);

      const result = await client.getBranch(1, 'main');

      expect(mockGitlabInstance.Branches.show).toHaveBeenCalledWith(1, 'main');
      expect(result).toEqual(mockBranch);
    });
  });

  describe('createBranch', () => {
    it('should create branch', async () => {
      const mockBranch = { name: 'feature-branch', commit: { id: 'abc123' } };

      mockGitlabInstance.Branches.create.mockResolvedValue(mockBranch);

      const result = await client.createBranch(1, 'feature-branch', 'main');

      expect(mockGitlabInstance.Branches.create).toHaveBeenCalledWith(1, 'feature-branch', 'main');
      expect(result).toEqual(mockBranch);
    });
  });

  describe('deleteBranch', () => {
    it('should delete branch', async () => {
      mockGitlabInstance.Branches.remove.mockResolvedValue(undefined);

      await client.deleteBranch(1, 'feature-branch');

      expect(mockGitlabInstance.Branches.remove).toHaveBeenCalledWith(1, 'feature-branch');
    });
  });

  describe('compareBranches', () => {
    it('should compare branches', async () => {
      const mockComparison = {
        commits: [{ id: 'abc123' }],
        diffs: [{ new_path: 'file.js' }],
        compare_timeout: false,
      };

      mockGitlabInstance.Repositories.compare.mockResolvedValue(mockComparison);

      const result = await client.compareBranches(1, 'main', 'feature');

      expect(mockGitlabInstance.Repositories.compare).toHaveBeenCalledWith(1, 'main', 'feature');
      expect(result).toEqual(mockComparison);
    });
  });

  //═════════════════════════════════════════════════════════════════════════════
  // Commits
  //═════════════════════════════════════════════════════════════════════════════

  describe('listCommits', () => {
    it('should list commits with default options', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          shortId: 'abc123',
          title: 'Commit 1',
          message: 'Message 1',
          authorName: 'John',
          authorEmail: 'john@example.com',
          createdAt: '2023-01-01T00:00:00Z',
        },
      ];

      mockGitlabInstance.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.listCommits(1);

      expect(mockGitlabInstance.Commits.all).toHaveBeenCalledWith(1, {
        refName: undefined,
        since: undefined,
        until: undefined,
        path: undefined,
        perPage: 20,
      });
      expect(result[0].author_name).toBe('John');
    });

    it('should list commits with all options', async () => {
      mockGitlabInstance.Commits.all.mockResolvedValue([]);

      await client.listCommits(1, {
        ref: 'develop',
        since: '2023-01-01',
        until: '2023-12-31',
        path: 'src/',
        limit: 50,
      });

      expect(mockGitlabInstance.Commits.all).toHaveBeenCalledWith(1, {
        refName: 'develop',
        since: '2023-01-01',
        until: '2023-12-31',
        path: 'src/',
        perPage: 50,
      });
    });
  });

  describe('searchCommits', () => {
    it('should search commits by message', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          shortId: 'abc123',
          title: 'Fix critical bug',
          message: 'Fix critical bug in auth',
          authorName: 'John',
          authorEmail: 'john@example.com',
          createdAt: '2023-01-01T00:00:00Z',
        },
        {
          id: 'def456',
          shortId: 'def456',
          title: 'Add feature',
          message: 'Add new feature',
          authorName: 'Jane',
          authorEmail: 'jane@example.com',
          createdAt: '2023-01-02T00:00:00Z',
        },
      ];

      mockGitlabInstance.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.searchCommits(1, 'critical');

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Fix critical bug');
    });

    it('should search commits case-insensitively', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          shortId: 'abc123',
          title: 'FIX BUG',
          message: 'Fix bug',
          authorName: 'John',
          authorEmail: 'john@example.com',
          createdAt: '2023-01-01T00:00:00Z',
        },
      ];

      mockGitlabInstance.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.searchCommits(1, 'fix');

      expect(result).toHaveLength(1);
    });

    it('should search commits with ref option', async () => {
      mockGitlabInstance.Commits.all.mockResolvedValue([]);

      await client.searchCommits(1, 'test', { ref: 'develop' });

      expect(mockGitlabInstance.Commits.all).toHaveBeenCalledWith(1, {
        refName: 'develop',
        perPage: 100, // searchCommits always fetches 100 to filter locally
      });
    });

    it('should limit search results', async () => {
      const mockCommits = Array.from({ length: 30 }, (_, i) => ({
        id: `commit${i}`,
        shortId: `c${i}`,
        title: 'fix: something',
        message: 'fix: something',
        authorName: 'John',
        authorEmail: 'john@example.com',
        createdAt: '2023-01-01T00:00:00Z',
      }));

      mockGitlabInstance.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.searchCommits(1, 'fix', { limit: 5 });

      expect(result).toHaveLength(5);
    });
  });

  //═════════════════════════════════════════════════════════════════════════════
  // Repository
  //═════════════════════════════════════════════════════════════════════════════

  describe('getTree', () => {
    it('should get tree with default options', async () => {
      const mockTree = [
        { name: 'src', type: 'tree', path: 'src' },
        { name: 'README.md', type: 'blob', path: 'README.md' },
      ];

      mockGitlabInstance.Repositories.allRepositoryTrees.mockResolvedValue(mockTree);

      const result = await client.getTree(1);

      expect(mockGitlabInstance.Repositories.allRepositoryTrees).toHaveBeenCalledWith(1, {
        path: undefined,
        ref: undefined,
        recursive: undefined,
        perPage: 100,
      });
      expect(result).toEqual(mockTree);
    });

    it('should get tree with all options', async () => {
      mockGitlabInstance.Repositories.allRepositoryTrees.mockResolvedValue([]);

      await client.getTree(1, {
        path: 'src',
        ref: 'develop',
        recursive: true,
        limit: 50,
      });

      expect(mockGitlabInstance.Repositories.allRepositoryTrees).toHaveBeenCalledWith(1, {
        path: 'src',
        ref: 'develop',
        recursive: true,
        perPage: 50,
      });
    });

    it('should limit tree results', async () => {
      const mockTree = Array.from({ length: 150 }, (_, i) => ({
        name: `file${i}`,
        type: 'blob',
        path: `file${i}`,
      }));

      mockGitlabInstance.Repositories.allRepositoryTrees.mockResolvedValue(mockTree);

      const result = await client.getTree(1, { limit: 50 });

      expect(result).toHaveLength(50);
    });
  });

  describe('getFile', () => {
    it('should get file with default ref', async () => {
      const mockFile = {
        content: 'Y29uc29sZS5sb2coImhlbGxvIik=',
        encoding: 'base64',
        size: 22,
      };

      mockGitlabInstance.RepositoryFiles.show.mockResolvedValue(mockFile);

      const result = await client.getFile(1, 'src/index.js');

      expect(mockGitlabInstance.RepositoryFiles.show).toHaveBeenCalledWith(
        1,
        'src/index.js',
        'main'
      );
      expect(result).toEqual({
        content: 'Y29uc29sZS5sb2coImhlbGxvIik=',
        encoding: 'base64',
        size: 22,
      });
    });

    it('should get file with custom ref', async () => {
      const mockFile = { content: 'test', encoding: 'base64', size: 4 };

      mockGitlabInstance.RepositoryFiles.show.mockResolvedValue(mockFile);

      await client.getFile(1, 'README.md', 'develop');

      expect(mockGitlabInstance.RepositoryFiles.show).toHaveBeenCalledWith(
        1,
        'README.md',
        'develop'
      );
    });
  });

  describe('getBlame', () => {
    it('should get blame with default ref', async () => {
      const mockBlame = [
        {
          commit: { id: 'abc123', author_name: 'John' },
          lines: ['line 1', 'line 2'],
        },
      ];

      mockGitlabInstance.RepositoryFiles.allFileBlames.mockResolvedValue(mockBlame);

      const result = await client.getBlame(1, 'src/index.js');

      expect(mockGitlabInstance.RepositoryFiles.allFileBlames).toHaveBeenCalledWith(
        1,
        'src/index.js',
        'main'
      );
      expect(result).toEqual(mockBlame);
    });

    it('should get blame with custom ref', async () => {
      mockGitlabInstance.RepositoryFiles.allFileBlames.mockResolvedValue([]);

      await client.getBlame(1, 'README.md', 'develop');

      expect(mockGitlabInstance.RepositoryFiles.allFileBlames).toHaveBeenCalledWith(
        1,
        'README.md',
        'develop'
      );
    });
  });

  //═════════════════════════════════════════════════════════════════════════════
  // Artifacts
  //═════════════════════════════════════════════════════════════════════════════

  describe('listArtifacts', () => {
    it('should list artifacts from jobs with artifacts', async () => {
      const mockJobs = [
        {
          id: 1,
          name: 'build',
          artifacts: [{ filename: 'artifact.zip' }],
        },
        {
          id: 2,
          name: 'test',
          artifacts: [],
        },
        {
          id: 3,
          name: 'deploy',
          artifacts: [{ filename: 'deploy.tar' }],
        },
      ];

      mockGitlabInstance.Jobs.all.mockResolvedValue(mockJobs);

      const result = await client.listArtifacts(1, 100);

      expect(mockGitlabInstance.Jobs.all).toHaveBeenCalledWith(1, { pipelineId: 100 });
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        job_id: 1,
        job_name: 'build',
        artifacts: [{ filename: 'artifact.zip' }],
      });
    });

    it('should return empty array when no jobs have artifacts', async () => {
      const mockJobs = [
        { id: 1, name: 'test', artifacts: [] },
        { id: 2, name: 'lint', artifacts: null },
      ];

      mockGitlabInstance.Jobs.all.mockResolvedValue(mockJobs);

      const result = await client.listArtifacts(1, 100);

      expect(result).toHaveLength(0);
    });
  });

  describe('downloadArtifact', () => {
    it('should download job log as artifact', async () => {
      const mockLog = 'Build output line 1\nBuild output line 2';

      mockGitlabInstance.Jobs.showLog.mockResolvedValue(mockLog);

      const result = await client.downloadArtifact(1, 123);

      expect(mockGitlabInstance.Jobs.showLog).toHaveBeenCalledWith(1, 123);
      expect(result.filename).toBe('job-123-log.txt');
      expect(result.data.toString()).toBe(mockLog);
    });
  });

  describe('deleteArtifacts', () => {
    it('should delete job artifacts', async () => {
      mockGitlabInstance.Jobs.erase.mockResolvedValue(undefined);

      await client.deleteArtifacts(1, 123);

      expect(mockGitlabInstance.Jobs.erase).toHaveBeenCalledWith(1, 123);
    });
  });

  //═════════════════════════════════════════════════════════════════════════════
  // Issues
  //═════════════════════════════════════════════════════════════════════════════

  describe('listIssues', () => {
    it('should list issues with default options', async () => {
      const mockIssues = [
        { id: 1, iid: 1, title: 'Issue 1', state: 'opened' },
        { id: 2, iid: 2, title: 'Issue 2', state: 'opened' },
      ];

      mockGitlabInstance.Issues.all.mockResolvedValue(mockIssues);

      const result = await client.listIssues(1);

      expect(mockGitlabInstance.Issues.all).toHaveBeenCalledWith({
        projectId: 1,
        state: undefined,
        labels: undefined,
        assigneeUsername: undefined,
        perPage: 20,
      });
      expect(result).toEqual(mockIssues);
    });

    it('should list issues with all filters', async () => {
      mockGitlabInstance.Issues.all.mockResolvedValue([]);

      await client.listIssues(1, {
        state: 'closed',
        labels: 'bug,critical',
        assignee_username: 'johndoe',
        limit: 10,
      });

      expect(mockGitlabInstance.Issues.all).toHaveBeenCalledWith({
        projectId: 1,
        state: 'closed',
        labels: 'bug,critical',
        assigneeUsername: 'johndoe',
        perPage: 10,
      });
    });

    it('should handle paginated response', async () => {
      const mockResponse = {
        data: [
          { id: 1, iid: 1, title: 'Issue 1' },
          { id: 2, iid: 2, title: 'Issue 2' },
        ],
      };

      mockGitlabInstance.Issues.all.mockResolvedValue(mockResponse);

      const result = await client.listIssues(1);

      expect(result).toHaveLength(2);
    });

    it('should limit issues', async () => {
      const mockIssues = Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        iid: i + 1,
        title: `Issue ${i + 1}`,
      }));

      mockGitlabInstance.Issues.all.mockResolvedValue(mockIssues);

      const result = await client.listIssues(1, { limit: 10 });

      expect(result).toHaveLength(10);
    });
  });

  describe('getIssue', () => {
    it('should get issue by iid', async () => {
      const mockIssues = [{ id: 1, iid: 5, title: 'Test Issue', state: 'opened' }];

      mockGitlabInstance.Issues.all.mockResolvedValue(mockIssues);

      const result = await client.getIssue(1, 5);

      expect(mockGitlabInstance.Issues.all).toHaveBeenCalledWith({
        projectId: 1,
        iids: [5],
      });
      expect(result).toEqual(mockIssues[0]);
    });

    it('should return null when issue not found', async () => {
      mockGitlabInstance.Issues.all.mockResolvedValue([]);

      const result = await client.getIssue(1, 999);

      expect(result).toBeNull();
    });

    it('should handle paginated response', async () => {
      const mockResponse = {
        data: [{ id: 1, iid: 5, title: 'Test Issue' }],
      };

      mockGitlabInstance.Issues.all.mockResolvedValue(mockResponse);

      const result = await client.getIssue(1, 5);

      expect(result).toEqual({ id: 1, iid: 5, title: 'Test Issue' });
    });
  });

  describe('createIssue', () => {
    it('should create issue with required fields', async () => {
      const mockIssue = { id: 1, iid: 10, title: 'New Issue' };

      mockGitlabInstance.Issues.create.mockResolvedValue(mockIssue);

      const result = await client.createIssue(1, { title: 'New Issue' });

      expect(mockGitlabInstance.Issues.create).toHaveBeenCalledWith(1, 'New Issue', {
        description: undefined,
        labels: undefined,
        assigneeIds: undefined,
        milestoneId: undefined,
      });
      expect(result).toEqual(mockIssue);
    });

    it('should create issue with all options', async () => {
      const mockIssue = { id: 1, iid: 10, title: 'New Issue' };

      mockGitlabInstance.Issues.create.mockResolvedValue(mockIssue);

      await client.createIssue(1, {
        title: 'New Issue',
        description: 'Issue description',
        labels: 'bug,urgent',
        assignee_ids: [1, 2],
        milestone_id: 5,
      });

      expect(mockGitlabInstance.Issues.create).toHaveBeenCalledWith(1, 'New Issue', {
        description: 'Issue description',
        labels: 'bug,urgent',
        assigneeIds: [1, 2],
        milestoneId: 5,
      });
    });
  });

  describe('updateIssue', () => {
    it('should update issue with title', async () => {
      const mockIssue = { id: 1, iid: 10, title: 'Updated Title' };

      mockGitlabInstance.Issues.edit.mockResolvedValue(mockIssue);

      const result = await client.updateIssue(1, 10, { title: 'Updated Title' });

      expect(mockGitlabInstance.Issues.edit).toHaveBeenCalledWith(1, 10, {
        title: 'Updated Title',
        description: undefined,
        labels: undefined,
        stateEvent: undefined,
      });
      expect(result).toEqual(mockIssue);
    });

    it('should update issue with all fields', async () => {
      const mockIssue = { id: 1, iid: 10, title: 'Updated' };

      mockGitlabInstance.Issues.edit.mockResolvedValue(mockIssue);

      await client.updateIssue(1, 10, {
        title: 'Updated',
        description: 'New description',
        labels: 'bug',
        state_event: 'close',
      });

      expect(mockGitlabInstance.Issues.edit).toHaveBeenCalledWith(1, 10, {
        title: 'Updated',
        description: 'New description',
        labels: 'bug',
        stateEvent: 'close',
      });
    });
  });

  describe('closeIssue', () => {
    it('should close issue', async () => {
      const mockIssue = { id: 1, iid: 10, state: 'closed' };

      mockGitlabInstance.Issues.edit.mockResolvedValue(mockIssue);

      const result = await client.closeIssue(1, 10);

      expect(mockGitlabInstance.Issues.edit).toHaveBeenCalledWith(1, 10, {
        stateEvent: 'close',
      });
      expect(result).toEqual(mockIssue);
    });
  });

  //═════════════════════════════════════════════════════════════════════════════
  // Labels
  //═════════════════════════════════════════════════════════════════════════════

  describe('listLabels', () => {
    it('should list labels with default options', async () => {
      const mockLabels = [
        { id: 1, name: 'bug', color: '#ff0000' },
        { id: 2, name: 'feature', color: '#00ff00' },
      ];

      mockGitlabInstance.ProjectLabels.all.mockResolvedValue(mockLabels);

      const result = await client.listLabels(1);

      expect(mockGitlabInstance.ProjectLabels.all).toHaveBeenCalledWith(1, {
        search: undefined,
        perPage: 50,
      });
      expect(result).toEqual(mockLabels);
    });

    it('should search labels', async () => {
      mockGitlabInstance.ProjectLabels.all.mockResolvedValue([]);

      await client.listLabels(1, { search: 'bug' });

      expect(mockGitlabInstance.ProjectLabels.all).toHaveBeenCalledWith(1, {
        search: 'bug',
        perPage: 50,
      });
    });

    it('should limit labels', async () => {
      const mockLabels = Array.from({ length: 60 }, (_, i) => ({
        id: i + 1,
        name: `label-${i}`,
        color: '#000000',
      }));

      mockGitlabInstance.ProjectLabels.all.mockResolvedValue(mockLabels);

      const result = await client.listLabels(1, { limit: 20 });

      expect(result).toHaveLength(20);
    });
  });

  describe('createLabel', () => {
    it('should create label with required fields', async () => {
      const mockLabel = { id: 1, name: 'new-label', color: '#ff0000' };

      mockGitlabInstance.ProjectLabels.create.mockResolvedValue(mockLabel);

      const result = await client.createLabel(1, {
        name: 'new-label',
        color: '#ff0000',
      });

      expect(mockGitlabInstance.ProjectLabels.create).toHaveBeenCalledWith(
        1,
        'new-label',
        '#ff0000',
        {
          description: undefined,
        }
      );
      expect(result).toEqual(mockLabel);
    });

    it('should create label with description', async () => {
      const mockLabel = {
        id: 1,
        name: 'new-label',
        color: '#ff0000',
        description: 'Label description',
      };

      mockGitlabInstance.ProjectLabels.create.mockResolvedValue(mockLabel);

      await client.createLabel(1, {
        name: 'new-label',
        color: '#ff0000',
        description: 'Label description',
      });

      expect(mockGitlabInstance.ProjectLabels.create).toHaveBeenCalledWith(
        1,
        'new-label',
        '#ff0000',
        {
          description: 'Label description',
        }
      );
    });
  });
});

describe('initializeGitLabClient', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let initializeGitLabClient: typeof import('./client.js').initializeGitLabClient;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Import after mocks are cleared
    const module = await import('./client.js');
    initializeGitLabClient = module.initializeGitLabClient;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should load host URL from /tokens/host_url', async () => {
    mockLoadToken.mockResolvedValue('test-token');
    mockReadFile.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.endsWith('/host_url')) {
        return 'https://gitlab.custom.com';
      }
      throw new Error('File not found');
    });

    const mockGitlabInstance = {
      Users: {
        showCurrentUser: vi.fn().mockResolvedValue({ id: 1 }),
      },
    };
    mockGitlabConstructor.mockImplementation(() => mockGitlabInstance);

    const client = await initializeGitLabClient();

    expect(mockLoadToken).toHaveBeenCalledWith('/tokens/token');
    expect(mockReadFile).toHaveBeenCalledWith('/tokens/host_url', 'utf-8');
    expect(client).not.toBeNull();
    expect(mockGitlabConstructor).toHaveBeenCalledWith({
      token: 'test-token',
      host: 'https://gitlab.custom.com',
    });
  });

  it('should use custom TOKENS_DIR for host_url and token paths', async () => {
    process.env.TOKENS_DIR = '/custom/tokens';

    mockLoadToken.mockResolvedValue('test-token');
    mockReadFile.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path === '/custom/tokens/host_url') {
        return 'https://gitlab.example.com';
      }
      throw new Error('File not found');
    });

    const mockGitlabInstance = {
      Users: {
        showCurrentUser: vi.fn().mockResolvedValue({ id: 1 }),
      },
    };
    mockGitlabConstructor.mockImplementation(() => mockGitlabInstance);

    await initializeGitLabClient();

    expect(mockLoadToken).toHaveBeenCalledWith('/custom/tokens/token');
    expect(mockReadFile).toHaveBeenCalledWith('/custom/tokens/host_url', 'utf-8');
  });

  it('should fall back to GITLAB_URL env var when host_url file missing', async () => {
    process.env.GITLAB_URL = 'https://gitlab-env.example.com';

    mockLoadToken.mockResolvedValue('test-token');
    mockReadFile.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('host_url')) {
        throw new Error('ENOENT');
      }
      throw new Error('File not found');
    });

    const mockGitlabInstance = {
      Users: {
        showCurrentUser: vi.fn().mockResolvedValue({ id: 1 }),
      },
    };
    mockGitlabConstructor.mockImplementation(() => mockGitlabInstance);

    await initializeGitLabClient();

    expect(mockGitlabConstructor).toHaveBeenCalledWith({
      token: 'test-token',
      host: 'https://gitlab-env.example.com',
    });
  });

  it('should fall back to https://gitlab.com when no config', async () => {
    delete process.env.GITLAB_URL;

    mockLoadToken.mockResolvedValue('test-token');
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const mockGitlabInstance = {
      Users: {
        showCurrentUser: vi.fn().mockResolvedValue({ id: 1 }),
      },
    };
    mockGitlabConstructor.mockImplementation(() => mockGitlabInstance);

    await initializeGitLabClient();

    expect(mockGitlabConstructor).toHaveBeenCalledWith({
      token: 'test-token',
      host: 'https://gitlab.com',
    });
  });

  it('should return null when token is empty', async () => {
    mockLoadToken.mockResolvedValue('');

    const result = await initializeGitLabClient();
    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('should return null when token is null', async () => {
    mockLoadToken.mockResolvedValue(null);

    const result = await initializeGitLabClient();
    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('should return null when connection test fails', async () => {
    mockLoadToken.mockResolvedValue('test-token');
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const mockGitlabInstance = {
      Users: {
        showCurrentUser: vi.fn().mockRejectedValue(new Error('Connection failed')),
      },
    };
    mockGitlabConstructor.mockImplementation(() => mockGitlabInstance);

    const result = await initializeGitLabClient();
    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('should return null when initialization throws error', async () => {
    mockLoadToken.mockRejectedValue(new Error('Failed to load token'));

    const result = await initializeGitLabClient();
    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('Response Mappers', () => {
  let GitLabClientClass: typeof GitLabClientType;
  let client: InstanceType<typeof GitLabClientType>;
  let mockGitlabInstance: MockGitlabEndpoints;

  beforeEach(async () => {
    mockGitlabInstance = {
      Users: { showCurrentUser: vi.fn() },
      Projects: { all: vi.fn(), show: vi.fn() },
      Search: { all: vi.fn() },
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
      MergeRequestApprovals: { approve: vi.fn() },
      MergeRequestNotes: { all: vi.fn(), create: vi.fn() },
      MergeRequestDiscussions: { all: vi.fn(), create: vi.fn() },
      Commits: { all: vi.fn(), showDiff: vi.fn() },
      Pipelines: { all: vi.fn(), show: vi.fn(), retry: vi.fn(), create: vi.fn() },
      Jobs: { all: vi.fn(), showLog: vi.fn(), erase: vi.fn() },
      Tags: { create: vi.fn() },
      ProjectReleases: { create: vi.fn() },
      Branches: { all: vi.fn(), show: vi.fn(), create: vi.fn(), remove: vi.fn() },
      Repositories: { compare: vi.fn(), allRepositoryTrees: vi.fn() },
      RepositoryFiles: { show: vi.fn(), allFileBlames: vi.fn() },
      Issues: { all: vi.fn(), create: vi.fn(), edit: vi.fn() },
      ProjectLabels: { all: vi.fn(), create: vi.fn() },
    };

    mockGitlabConstructor.mockImplementation(() => mockGitlabInstance);

    vi.resetModules();
    const module = await import('./client.js');
    GitLabClientClass = module.GitLabClient;
    client = new GitLabClientClass({ token: 'test-token', host: 'https://gitlab.example.com' });
  });

  describe('mapMergeRequestResponse', () => {
    it('should handle camelCase API response', async () => {
      const mockMr = {
        id: 1,
        iid: 10,
        title: 'Test MR',
        description: 'Description',
        state: 'opened',
        sourceBranch: 'feature',
        targetBranch: 'main',
        author: { id: 1, name: 'User', username: 'user' },
        webUrl: 'https://gitlab.com/mr/1',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      };
      mockGitlabInstance.MergeRequests.show.mockResolvedValue(mockMr);

      const result = await client.showMergeRequest(1, 10);

      expect(result.source_branch).toBe('feature');
      expect(result.target_branch).toBe('main');
      expect(result.web_url).toBe('https://gitlab.com/mr/1');
    });

    it('should handle snake_case API response', async () => {
      const mockMr = {
        id: 1,
        iid: 10,
        title: 'Test MR',
        state: 'opened',
        source_branch: 'feature',
        target_branch: 'main',
        author: { id: 1, name: 'User', username: 'user' },
        web_url: 'https://gitlab.com/mr/1',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      };
      mockGitlabInstance.MergeRequests.show.mockResolvedValue(mockMr);

      const result = await client.showMergeRequest(1, 10);

      expect(result.source_branch).toBe('feature');
      expect(result.target_branch).toBe('main');
    });

    it('should handle missing author with fallback', async () => {
      const mockMrs = [
        {
          id: 1,
          iid: 10,
          title: 'Test MR',
          state: 'opened',
          // no author field
        },
      ];
      mockGitlabInstance.MergeRequests.all.mockResolvedValue(mockMrs);

      const result = await client.listMergeRequests(1);

      expect(result[0].author).toEqual({ id: 0, name: '', username: '' });
    });
  });

  describe('mapCommitResponse', () => {
    it('should handle camelCase response', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          shortId: 'abc',
          title: 'Commit title',
          message: 'Commit message',
          authorName: 'Author',
          authorEmail: 'author@example.com',
          createdAt: '2024-01-01T00:00:00Z',
        },
      ];
      mockGitlabInstance.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.listBranchCommits(1, 'main');

      expect(result[0].short_id).toBe('abc');
      expect(result[0].author_name).toBe('Author');
      expect(result[0].author_email).toBe('author@example.com');
    });

    it('should handle snake_case response', async () => {
      const mockCommits = [
        {
          id: 'abc123',
          short_id: 'abc',
          title: 'Commit title',
          message: 'Commit message',
          author_name: 'Author',
          author_email: 'author@example.com',
          created_at: '2024-01-01T00:00:00Z',
        },
      ];
      mockGitlabInstance.Commits.all.mockResolvedValue(mockCommits);

      const result = await client.listBranchCommits(1, 'main');

      expect(result[0].short_id).toBe('abc');
      expect(result[0].author_name).toBe('Author');
    });
  });

  describe('mapPipelineResponse', () => {
    it('should handle camelCase response', async () => {
      const mockPipelines = [
        {
          id: 1,
          status: 'success',
          ref: 'main',
          sha: 'abc123',
          webUrl: 'https://gitlab.com/pipeline/1',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      ];
      mockGitlabInstance.Pipelines.all.mockResolvedValue(mockPipelines);

      const result = await client.listPipelines(1);

      expect(result[0].web_url).toBe('https://gitlab.com/pipeline/1');
      expect(result[0].status).toBe('success');
    });

    it('should handle snake_case response', async () => {
      const mockPipelines = [
        {
          id: 1,
          status: 'success',
          ref: 'main',
          sha: 'abc123',
          web_url: 'https://gitlab.com/pipeline/1',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        },
      ];
      mockGitlabInstance.Pipelines.all.mockResolvedValue(mockPipelines);

      const result = await client.listPipelines(1);

      expect(result[0].web_url).toBe('https://gitlab.com/pipeline/1');
    });
  });
});

describe('testConnection error logging', () => {
  let GitLabClientClass: typeof GitLabClientType;
  let client: InstanceType<typeof GitLabClientType>;

  beforeEach(async () => {
    const mockGitlabInstance = {
      Users: {
        showCurrentUser: vi
          .fn()
          .mockRejectedValue(new Error('getaddrinfo ENOTFOUND gitlab.example.com')),
      },
    };
    mockGitlabConstructor.mockImplementation(() => mockGitlabInstance);

    vi.resetModules();
    const module = await import('./client.js');
    GitLabClientClass = module.GitLabClient;
    client = new GitLabClientClass({ token: 'test-token', host: 'https://gitlab.example.com' });
  });

  it('should log error when connection fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await client.testConnection();

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('network');
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('GitLab connection test failed'),
      expect.any(String)
    );

    consoleSpy.mockRestore();
  });
});
