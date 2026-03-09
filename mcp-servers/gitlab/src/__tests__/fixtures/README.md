# GitLab Mock Utilities

This directory contains shared mock utilities for GitLab MCP domain tests.

## Files

- `gitlab-mock.ts` - Mock GitBeaker instances and mock data for all entity types

## Usage

### Using Mock Data

Import individual mock data objects as needed:

```typescript
import { mockProject, mockMergeRequest, mockCommit } from './fixtures/gitlab-mock.js';

// Use in your tests
expect(result).toEqual(mockProject);
```

### Using Mock GitLab Instance

Create a fully mocked GitBeaker instance:

```typescript
import { createMockGitlab } from './fixtures/gitlab-mock.js';
import { createProjectsClient } from '../../domains/projects.js';

const mockGitlab = createMockGitlab();
const client = createProjectsClient(mockGitlab as any);

// Now all GitBeaker methods return mock data
const projects = await client.list();
expect(mockGitlab.Projects.all).toHaveBeenCalled();
```

### Using Mock GitLab with Custom Overrides

Override specific method responses for individual tests:

```typescript
import { createMockGitlabWithOverrides } from './fixtures/gitlab-mock.js';

const mockGitlab = createMockGitlabWithOverrides({
  'Projects.all': [{ id: 999, name: 'custom-project' }],
  'Branches.show': { name: 'custom-branch' },
});

const client = createProjectsClient(mockGitlab as any);
const projects = await client.list();
expect(projects[0].id).toBe(999);
```

## Available Mock Data

### Projects

- `mockProject` - Standard project

### Commits

- `mockCommit` - First commit
- `mockCommit2` - Second commit

### Branches

- `mockBranch` - Main branch
- `mockFeatureBranch` - Feature branch
- `mockBranchComparison` - Branch comparison result

### Merge Requests

- `mockMergeRequest` - Standard MR

### Issues

- `mockIssue` - Standard issue

### Labels

- `mockLabel` - Standard label

### Pipelines & Jobs

- `mockPipeline` - Successful pipeline
- `mockPipelineFailed` - Failed pipeline
- `mockJob` - Job with artifacts
- `mockJobWithoutArtifacts` - Job without artifacts

### Notes & Discussions

- `mockNote` - User comment
- `mockSystemNote` - System note
- `mockDiscussion` - Discussion thread

### Repository

- `mockTreeItem` - Directory tree item
- `mockFileTreeItem` - File tree item
- `mockFileContent` - File content
- `mockBlame` - Git blame data
- `mockDiff` - Diff data

## Functions

### `createMockGitlab()`

Returns a complete mock GitBeaker instance with all methods mocked using `vi.fn()`.
All methods return appropriate mock data by default.

### `createMockGitlabWithOverrides(overrides)`

Returns a mock GitBeaker instance with custom method responses.

**Parameters:**

- `overrides` - Object mapping method paths to custom return values
  - Format: `{ 'Resource.method': returnValue }`
  - Example: `{ 'Projects.all': [...], 'Branches.show': {...} }`

**Example:**

```typescript
const mockGitlab = createMockGitlabWithOverrides({
  'Issues.all': [{ id: 1, title: 'Custom issue' }],
  'MergeRequests.show': { id: 1, state: 'merged' },
});
```
