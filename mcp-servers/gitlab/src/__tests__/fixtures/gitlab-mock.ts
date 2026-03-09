/**
 * GitLab Mock Utilities for Tests
 *
 * Provides mock GitBeaker instances and mock data for all entity types
 * used across domain tests
 */

import { vi } from 'vitest';
import type {
  GitLabProject,
  GitLabMergeRequest,
  GitLabCommit,
  GitLabBranch,
  GitLabIssue,
  GitLabLabel,
  GitLabPipeline,
  GitLabJob,
  GitLabNote,
  GitLabDiscussion,
  GitLabTreeItem,
  GitLabFileContent,
  GitLabBlame,
  BranchComparison,
} from '../../types.js';

/**
 * Mock Data - Projects
 */
export const mockProject: GitLabProject = {
  id: 123,
  name: 'test-project',
  path_with_namespace: 'group/test-project',
  description: 'Test project description',
  web_url: 'https://gitlab.example.com/group/test-project',
  default_branch: 'main',
};

/**
 * Mock Data - Commits
 */
export const mockCommit: GitLabCommit = {
  id: 'abc123def456',
  short_id: 'abc123d',
  title: 'feat: add new feature',
  message: 'feat: add new feature\n\nDetailed description',
  author_name: 'John Doe',
  author_email: 'john@example.com',
  created_at: '2025-01-15T10:00:00Z',
};

export const mockCommit2: GitLabCommit = {
  id: 'def456abc789',
  short_id: 'def456a',
  title: 'fix: resolve bug',
  message: 'fix: resolve bug',
  author_name: 'Jane Smith',
  author_email: 'jane@example.com',
  created_at: '2025-01-16T10:00:00Z',
};

/**
 * Mock Data - Branches
 */
export const mockBranch: GitLabBranch = {
  name: 'main',
  commit: mockCommit,
  protected: true,
  merged: false,
  default: true,
  web_url: 'https://gitlab.example.com/group/test-project/-/tree/main',
};

export const mockFeatureBranch: GitLabBranch = {
  name: 'feature/test',
  commit: mockCommit2,
  protected: false,
  merged: false,
  default: false,
  web_url: 'https://gitlab.example.com/group/test-project/-/tree/feature/test',
};

/**
 * Mock Data - Branch Comparison
 */
export const mockBranchComparison: BranchComparison = {
  commits: [mockCommit, mockCommit2],
  diffs: [
    {
      old_path: 'src/file.ts',
      new_path: 'src/file.ts',
      diff: '@@ -1,3 +1,4 @@\n+new line\n existing line',
    },
  ],
  compare_timeout: false,
  compare_same_ref: false,
};

/**
 * Mock Data - Merge Requests
 */
export const mockMergeRequest: GitLabMergeRequest = {
  id: 456,
  iid: 1,
  title: 'Add new feature',
  description: 'This MR adds a new feature',
  state: 'opened',
  source_branch: 'feature/test',
  target_branch: 'main',
  author: {
    id: 1,
    name: 'John Doe',
    username: 'johndoe',
  },
  web_url: 'https://gitlab.example.com/group/test-project/-/merge_requests/1',
  created_at: '2025-01-15T10:00:00Z',
  updated_at: '2025-01-15T12:00:00Z',
};

/**
 * Mock Data - Issues
 */
export const mockIssue: GitLabIssue = {
  id: 789,
  iid: 1,
  title: 'Bug report',
  description: 'There is a bug',
  state: 'opened',
  labels: ['bug', 'priority::high'],
  assignees: [
    {
      id: 1,
      username: 'johndoe',
      name: 'John Doe',
    },
  ],
  author: {
    id: 2,
    username: 'janedoe',
    name: 'Jane Doe',
  },
  milestone: {
    id: 10,
    title: 'v1.0',
  },
  web_url: 'https://gitlab.example.com/group/test-project/-/issues/1',
  created_at: '2025-01-10T10:00:00Z',
  updated_at: '2025-01-15T10:00:00Z',
};

/**
 * Mock Data - Labels
 */
export const mockLabel: GitLabLabel = {
  id: 1,
  name: 'bug',
  color: '#FF0000',
  description: 'Bug label',
  text_color: '#FFFFFF',
};

/**
 * Mock Data - Pipelines
 */
export const mockPipeline: GitLabPipeline = {
  id: 100,
  status: 'success',
  ref: 'main',
  sha: 'abc123def456',
  web_url: 'https://gitlab.example.com/group/test-project/-/pipelines/100',
  created_at: '2025-01-15T10:00:00Z',
  updated_at: '2025-01-15T10:30:00Z',
};

export const mockPipelineFailed: GitLabPipeline = {
  id: 101,
  status: 'failed',
  ref: 'feature/test',
  sha: 'def456abc789',
  web_url: 'https://gitlab.example.com/group/test-project/-/pipelines/101',
  created_at: '2025-01-16T10:00:00Z',
  updated_at: '2025-01-16T10:30:00Z',
};

/**
 * Mock Data - Jobs & Artifacts
 */
export const mockJob: GitLabJob = {
  id: 200,
  name: 'build',
  status: 'success',
  stage: 'build',
  artifacts: [
    {
      file_type: 'archive',
      size: 1024000,
      filename: 'artifacts.zip',
      file_format: undefined,
    },
  ],
  web_url: 'https://gitlab.example.com/group/test-project/-/jobs/200',
};

export const mockJobWithoutArtifacts: GitLabJob = {
  id: 201,
  name: 'test',
  status: 'success',
  stage: 'test',
  artifacts: [],
  web_url: 'https://gitlab.example.com/group/test-project/-/jobs/201',
};

/**
 * Mock Data - Notes
 */
export const mockNote: GitLabNote = {
  id: 300,
  body: 'This is a comment',
  author: {
    id: 1,
    username: 'johndoe',
    name: 'John Doe',
  },
  created_at: '2025-01-15T11:00:00Z',
  system: false,
  resolvable: true,
  resolved: false,
};

export const mockSystemNote: GitLabNote = {
  id: 301,
  body: 'merged',
  author: {
    id: 1,
    username: 'johndoe',
    name: 'John Doe',
  },
  created_at: '2025-01-15T12:00:00Z',
  system: true,
  resolvable: false,
  resolved: undefined,
};

/**
 * Mock Data - Discussions
 */
export const mockDiscussion: GitLabDiscussion = {
  id: 'abc123',
  notes: [mockNote, mockSystemNote],
};

/**
 * Mock Data - Repository
 */
export const mockTreeItem: GitLabTreeItem = {
  id: 'tree123',
  name: 'src',
  type: 'tree',
  path: 'src',
  mode: '040000',
};

export const mockFileTreeItem: GitLabTreeItem = {
  id: 'file123',
  name: 'index.ts',
  type: 'blob',
  path: 'src/index.ts',
  mode: '100644',
};

export const mockFileContent: GitLabFileContent = {
  file_name: 'index.ts',
  file_path: 'src/index.ts',
  size: 1024,
  encoding: 'base64',
  content: 'Y29uc3QgZm9vID0gImJhciI7',
  ref: 'main',
};

export const mockBlame: GitLabBlame = {
  commit: mockCommit,
  lines: ['const foo = "bar";', 'export default foo;'],
};

/**
 * Mock Data - Diffs
 */
export const mockDiff = {
  old_path: 'src/file.ts',
  new_path: 'src/file.ts',
  diff: '@@ -1,3 +1,4 @@\n+new line\n existing line',
};

/**
 * Create Mock GitLab Instance
 *
 * Returns a mocked GitBeaker instance with vi.fn() for all methods
 * used across domain clients
 */
export function createMockGitlab() {
  return {
    // Projects
    Projects: {
      all: vi.fn().mockResolvedValue([
        {
          id: mockProject.id,
          name: mockProject.name,
          pathWithNamespace: mockProject.path_with_namespace,
          description: mockProject.description,
          webUrl: mockProject.web_url,
          defaultBranch: mockProject.default_branch,
        },
      ]),
      show: vi.fn().mockResolvedValue({
        id: mockProject.id,
        name: mockProject.name,
        pathWithNamespace: mockProject.path_with_namespace,
        description: mockProject.description,
        webUrl: mockProject.web_url,
        defaultBranch: mockProject.default_branch,
      }),
    },

    // Branches
    Branches: {
      all: vi.fn().mockResolvedValue([
        {
          name: mockBranch.name,
          commit: {
            id: mockCommit.id,
            shortId: mockCommit.short_id,
            title: mockCommit.title,
            message: mockCommit.message,
            authorName: mockCommit.author_name,
            authorEmail: mockCommit.author_email,
            createdAt: mockCommit.created_at,
          },
          protected: mockBranch.protected,
          merged: mockBranch.merged,
          default: mockBranch.default,
          webUrl: mockBranch.web_url,
        },
      ]),
      show: vi.fn().mockResolvedValue({
        name: mockBranch.name,
        commit: {
          id: mockCommit.id,
          shortId: mockCommit.short_id,
          title: mockCommit.title,
          message: mockCommit.message,
          authorName: mockCommit.author_name,
          authorEmail: mockCommit.author_email,
          createdAt: mockCommit.created_at,
        },
        protected: mockBranch.protected,
        merged: mockBranch.merged,
        default: mockBranch.default,
        webUrl: mockBranch.web_url,
      }),
      create: vi.fn().mockResolvedValue({
        name: mockFeatureBranch.name,
        commit: {
          id: mockCommit2.id,
          shortId: mockCommit2.short_id,
          title: mockCommit2.title,
          message: mockCommit2.message,
          authorName: mockCommit2.author_name,
          authorEmail: mockCommit2.author_email,
          createdAt: mockCommit2.created_at,
        },
        protected: mockFeatureBranch.protected,
        merged: mockFeatureBranch.merged,
        default: mockFeatureBranch.default,
        webUrl: mockFeatureBranch.web_url,
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    },

    // Repositories
    Repositories: {
      compare: vi.fn().mockResolvedValue({
        commits: [
          {
            id: mockCommit.id,
            shortId: mockCommit.short_id,
            title: mockCommit.title,
            message: mockCommit.message,
            authorName: mockCommit.author_name,
            authorEmail: mockCommit.author_email,
            createdAt: mockCommit.created_at,
          },
        ],
        diffs: [
          {
            oldPath: mockDiff.old_path,
            newPath: mockDiff.new_path,
            diff: mockDiff.diff,
          },
        ],
        compareTimeout: false,
        compareSameRef: false,
      }),
      allRepositoryTrees: vi.fn().mockResolvedValue([
        {
          id: mockTreeItem.id,
          name: mockTreeItem.name,
          type: mockTreeItem.type,
          path: mockTreeItem.path,
          mode: mockTreeItem.mode,
        },
        {
          id: mockFileTreeItem.id,
          name: mockFileTreeItem.name,
          type: mockFileTreeItem.type,
          path: mockFileTreeItem.path,
          mode: mockFileTreeItem.mode,
        },
      ]),
    },

    // Repository Files
    RepositoryFiles: {
      show: vi.fn().mockResolvedValue({
        fileName: mockFileContent.file_name,
        filePath: mockFileContent.file_path,
        size: mockFileContent.size,
        encoding: mockFileContent.encoding,
        content: mockFileContent.content,
        ref: mockFileContent.ref,
      }),
      allFileBlames: vi.fn().mockResolvedValue([
        {
          commit: {
            id: mockCommit.id,
            shortId: mockCommit.short_id,
            title: mockCommit.title,
            message: mockCommit.message,
            authorName: mockCommit.author_name,
            authorEmail: mockCommit.author_email,
            createdAt: mockCommit.created_at,
          },
          lines: mockBlame.lines,
        },
      ]),
    },

    // Commits
    Commits: {
      all: vi.fn().mockResolvedValue([
        {
          id: mockCommit.id,
          shortId: mockCommit.short_id,
          title: mockCommit.title,
          message: mockCommit.message,
          authorName: mockCommit.author_name,
          authorEmail: mockCommit.author_email,
          createdAt: mockCommit.created_at,
        },
      ]),
      showDiff: vi.fn().mockResolvedValue([mockDiff]),
    },

    // Merge Requests
    MergeRequests: {
      all: vi.fn().mockResolvedValue([
        {
          id: mockMergeRequest.id,
          iid: mockMergeRequest.iid,
          title: mockMergeRequest.title,
          description: mockMergeRequest.description,
          state: mockMergeRequest.state,
          sourceBranch: mockMergeRequest.source_branch,
          targetBranch: mockMergeRequest.target_branch,
          author: mockMergeRequest.author,
          webUrl: mockMergeRequest.web_url,
          createdAt: mockMergeRequest.created_at,
          updatedAt: mockMergeRequest.updated_at,
        },
      ]),
      show: vi.fn().mockResolvedValue({
        id: mockMergeRequest.id,
        iid: mockMergeRequest.iid,
        title: mockMergeRequest.title,
        description: mockMergeRequest.description,
        state: mockMergeRequest.state,
        sourceBranch: mockMergeRequest.source_branch,
        targetBranch: mockMergeRequest.target_branch,
        author: mockMergeRequest.author,
        webUrl: mockMergeRequest.web_url,
        createdAt: mockMergeRequest.created_at,
        updatedAt: mockMergeRequest.updated_at,
      }),
      create: vi.fn().mockResolvedValue({
        id: mockMergeRequest.id,
        iid: mockMergeRequest.iid,
        title: mockMergeRequest.title,
        description: mockMergeRequest.description,
        state: mockMergeRequest.state,
        sourceBranch: mockMergeRequest.source_branch,
        targetBranch: mockMergeRequest.target_branch,
        author: mockMergeRequest.author,
        webUrl: mockMergeRequest.web_url,
        createdAt: mockMergeRequest.created_at,
        updatedAt: mockMergeRequest.updated_at,
      }),
      edit: vi.fn().mockResolvedValue({
        id: mockMergeRequest.id,
        iid: mockMergeRequest.iid,
        title: mockMergeRequest.title,
        description: mockMergeRequest.description,
        state: mockMergeRequest.state,
        sourceBranch: mockMergeRequest.source_branch,
        targetBranch: mockMergeRequest.target_branch,
        author: mockMergeRequest.author,
        webUrl: mockMergeRequest.web_url,
        createdAt: mockMergeRequest.created_at,
        updatedAt: mockMergeRequest.updated_at,
      }),
      accept: vi.fn().mockResolvedValue({
        id: mockMergeRequest.id,
        iid: mockMergeRequest.iid,
        title: mockMergeRequest.title,
        description: mockMergeRequest.description,
        state: 'merged',
        sourceBranch: mockMergeRequest.source_branch,
        targetBranch: mockMergeRequest.target_branch,
        author: mockMergeRequest.author,
        webUrl: mockMergeRequest.web_url,
        createdAt: mockMergeRequest.created_at,
        updatedAt: mockMergeRequest.updated_at,
      }),
      allDiffs: vi.fn().mockResolvedValue([mockDiff]),
      allCommits: vi.fn().mockResolvedValue([
        {
          id: mockCommit.id,
          shortId: mockCommit.short_id,
          title: mockCommit.title,
          message: mockCommit.message,
          authorName: mockCommit.author_name,
          authorEmail: mockCommit.author_email,
          createdAt: mockCommit.created_at,
        },
      ]),
      allPipelines: vi.fn().mockResolvedValue([
        {
          id: mockPipeline.id,
          status: mockPipeline.status,
          ref: mockPipeline.ref,
          sha: mockPipeline.sha,
          webUrl: mockPipeline.web_url,
          createdAt: mockPipeline.created_at,
          updatedAt: mockPipeline.updated_at,
        },
      ]),
    },

    // Merge Request Approvals
    MergeRequestApprovals: {
      approve: vi.fn().mockResolvedValue(undefined),
    },

    // Merge Request Notes
    MergeRequestNotes: {
      all: vi.fn().mockResolvedValue([
        {
          id: mockNote.id,
          body: mockNote.body,
          author: mockNote.author,
          createdAt: mockNote.created_at,
          system: mockNote.system,
          resolvable: mockNote.resolvable,
          resolved: mockNote.resolved,
        },
      ]),
      create: vi.fn().mockResolvedValue({
        id: mockNote.id,
        body: mockNote.body,
        author: mockNote.author,
        createdAt: mockNote.created_at,
        system: mockNote.system,
        resolvable: mockNote.resolvable,
        resolved: mockNote.resolved,
      }),
    },

    // Merge Request Discussions
    MergeRequestDiscussions: {
      all: vi.fn().mockResolvedValue([
        {
          id: mockDiscussion.id,
          notes: [
            {
              id: mockNote.id,
              body: mockNote.body,
              author: mockNote.author,
              createdAt: mockNote.created_at,
              system: mockNote.system,
              resolvable: mockNote.resolvable,
              resolved: mockNote.resolved,
            },
          ],
        },
      ]),
      create: vi.fn().mockResolvedValue({
        id: mockDiscussion.id,
        notes: [
          {
            id: mockNote.id,
            body: mockNote.body,
            author: mockNote.author,
            createdAt: mockNote.created_at,
            system: mockNote.system,
            resolvable: mockNote.resolvable,
            resolved: mockNote.resolved,
          },
        ],
      }),
    },

    // Issues
    Issues: {
      all: vi.fn().mockResolvedValue([
        {
          id: mockIssue.id,
          iid: mockIssue.iid,
          title: mockIssue.title,
          description: mockIssue.description,
          state: mockIssue.state,
          labels: mockIssue.labels,
          assignees: mockIssue.assignees,
          author: mockIssue.author,
          milestone: mockIssue.milestone,
          webUrl: mockIssue.web_url,
          createdAt: mockIssue.created_at,
          updatedAt: mockIssue.updated_at,
          closedAt: mockIssue.closed_at,
        },
      ]),
      show: vi.fn().mockResolvedValue({
        id: mockIssue.id,
        iid: mockIssue.iid,
        title: mockIssue.title,
        description: mockIssue.description,
        state: mockIssue.state,
        labels: mockIssue.labels,
        assignees: mockIssue.assignees,
        author: mockIssue.author,
        milestone: mockIssue.milestone,
        webUrl: mockIssue.web_url,
        createdAt: mockIssue.created_at,
        updatedAt: mockIssue.updated_at,
        closedAt: mockIssue.closed_at,
      }),
      create: vi.fn().mockResolvedValue({
        id: mockIssue.id,
        iid: mockIssue.iid,
        title: mockIssue.title,
        description: mockIssue.description,
        state: mockIssue.state,
        labels: mockIssue.labels,
        assignees: mockIssue.assignees,
        author: mockIssue.author,
        milestone: mockIssue.milestone,
        webUrl: mockIssue.web_url,
        createdAt: mockIssue.created_at,
        updatedAt: mockIssue.updated_at,
        closedAt: mockIssue.closed_at,
      }),
      edit: vi.fn().mockResolvedValue({
        id: mockIssue.id,
        iid: mockIssue.iid,
        title: mockIssue.title,
        description: mockIssue.description,
        state: mockIssue.state,
        labels: mockIssue.labels,
        assignees: mockIssue.assignees,
        author: mockIssue.author,
        milestone: mockIssue.milestone,
        webUrl: mockIssue.web_url,
        createdAt: mockIssue.created_at,
        updatedAt: mockIssue.updated_at,
        closedAt: mockIssue.closed_at,
      }),
    },

    // Project Labels
    ProjectLabels: {
      all: vi.fn().mockResolvedValue([
        {
          id: mockLabel.id,
          name: mockLabel.name,
          color: mockLabel.color,
          description: mockLabel.description,
          textColor: mockLabel.text_color,
        },
      ]),
      create: vi.fn().mockResolvedValue({
        id: mockLabel.id,
        name: mockLabel.name,
        color: mockLabel.color,
        description: mockLabel.description,
        textColor: mockLabel.text_color,
      }),
    },

    // Pipelines
    Pipelines: {
      all: vi.fn().mockResolvedValue([
        {
          id: mockPipeline.id,
          status: mockPipeline.status,
          ref: mockPipeline.ref,
          sha: mockPipeline.sha,
          webUrl: mockPipeline.web_url,
          createdAt: mockPipeline.created_at,
          updatedAt: mockPipeline.updated_at,
        },
      ]),
      show: vi.fn().mockResolvedValue({
        id: mockPipeline.id,
        status: mockPipeline.status,
        ref: mockPipeline.ref,
        sha: mockPipeline.sha,
        webUrl: mockPipeline.web_url,
        createdAt: mockPipeline.created_at,
        updatedAt: mockPipeline.updated_at,
      }),
      create: vi.fn().mockResolvedValue({
        id: mockPipeline.id,
        status: 'pending',
        ref: mockPipeline.ref,
        sha: mockPipeline.sha,
        webUrl: mockPipeline.web_url,
        createdAt: mockPipeline.created_at,
        updatedAt: mockPipeline.updated_at,
      }),
      retry: vi.fn().mockResolvedValue({
        id: mockPipeline.id,
        status: 'pending',
        ref: mockPipeline.ref,
        sha: mockPipeline.sha,
        webUrl: mockPipeline.web_url,
        createdAt: mockPipeline.created_at,
        updatedAt: mockPipeline.updated_at,
      }),
    },

    // Jobs
    Jobs: {
      all: vi.fn().mockResolvedValue([
        {
          id: mockJob.id,
          name: mockJob.name,
          status: mockJob.status,
          stage: mockJob.stage,
          artifactsFile: {
            size: 1024000,
            filename: 'artifacts.zip',
          },
          webUrl: mockJob.web_url,
        },
      ]),
      showLog: vi.fn().mockResolvedValue('Job log output\nLine 2\nLine 3'),
    },

    // Job Artifacts
    JobArtifacts: {
      downloadArchive: vi
        .fn()
        .mockResolvedValue(
          new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], { type: 'application/zip' })
        ),
      remove: vi.fn().mockResolvedValue(undefined),
    },

    // Tags
    Tags: {
      create: vi.fn().mockResolvedValue({
        name: 'v1.0.0',
        message: 'Release v1.0.0',
        target: 'main',
        commit: {
          id: mockCommit.id,
          shortId: mockCommit.short_id,
          title: mockCommit.title,
          message: mockCommit.message,
          authorName: mockCommit.author_name,
          authorEmail: mockCommit.author_email,
          createdAt: mockCommit.created_at,
        },
      }),
    },

    // Project Releases
    ProjectReleases: {
      create: vi.fn().mockResolvedValue({
        tagName: 'v1.0.0',
        name: 'Release v1.0.0',
        description: 'Release description',
        createdAt: '2025-01-15T10:00:00Z',
      }),
    },

    // Search
    Search: {
      all: vi.fn().mockResolvedValue([
        {
          basename: 'index.ts',
          data: 'const foo = "bar";',
          path: 'src/index.ts',
          filename: 'src/index.ts',
          ref: 'main',
          startline: 1,
        },
      ]),
    },
  };
}

/**
 * Create Mock GitLab with Custom Responses
 *
 * Allows overriding specific mock responses for individual tests
 * @param {Record<string, unknown>} overrides - Custom response overrides for mock methods
 * @returns {ReturnType<typeof createMockGitlab>} Mock GitLab instance with applied overrides
 */
export function createMockGitlabWithOverrides(overrides: Record<string, unknown> = {}) {
  const mockGitlab = createMockGitlab();

  // Apply overrides
  Object.keys(overrides).forEach((key) => {
    const parts = key.split('.');
    let target: Record<string, unknown> = mockGitlab as unknown as Record<string, unknown>;

    for (let i = 0; i < parts.length - 1; i++) {
      target = target[parts[i]] as Record<string, unknown>;
    }

    const method = parts[parts.length - 1];
    target[method] = vi.fn().mockResolvedValue(overrides[key]);
  });

  return mockGitlab;
}
