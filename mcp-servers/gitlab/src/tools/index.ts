/**
 * GitLab Tools Aggregator: combines every domain's tool definitions into one list.
 * The exact tool count is pinned by `metadata.test.ts`, not restated here.
 */

import { ToolDefinition } from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { createProjectTools } from './project-tools.js';
import { createUserTools } from './user-tools.js';
import { createMrTools } from './mr-tools.js';
import { createMrNotesTools } from './mr-notes-tools.js';
import { createDiscussionTools } from './discussion-tools.js';
import { createBranchTools } from './branch-tools.js';
import { createCommitTools } from './commit-tools.js';
import { createPipelineTools } from './pipeline-tools.js';
import { createRepositoryTools } from './repository-tools.js';
import { createArtifactTools } from './artifact-tools.js';
import { createIssueTools } from './issue-tools.js';
import { createLabelTools } from './label-tools.js';
import { createReleaseTools } from './release-tools.js';

/**
 * Tool handler function
 * @param client - GitLab client instance
 */
export function createToolDefinitions(client: GitLabClient | null): ToolDefinition[] {
  return [
    ...createProjectTools(client),
    ...createUserTools(client),
    ...createMrTools(client),
    ...createMrNotesTools(client),
    ...createDiscussionTools(client),
    ...createBranchTools(client),
    ...createCommitTools(client),
    ...createPipelineTools(client),
    ...createRepositoryTools(client),
    ...createArtifactTools(client),
    ...createIssueTools(client),
    ...createLabelTools(client),
    ...createReleaseTools(client),
  ];
}

export { createProjectTools } from './project-tools.js';
export { createUserTools } from './user-tools.js';
export { createMrTools } from './mr-tools.js';
export { createMrNotesTools } from './mr-notes-tools.js';
export { createDiscussionTools } from './discussion-tools.js';
export { createBranchTools } from './branch-tools.js';
export { createCommitTools } from './commit-tools.js';
export { createPipelineTools } from './pipeline-tools.js';
export { createRepositoryTools } from './repository-tools.js';
export { createArtifactTools } from './artifact-tools.js';
export { createIssueTools } from './issue-tools.js';
export { createLabelTools } from './label-tools.js';
export { createReleaseTools } from './release-tools.js';
