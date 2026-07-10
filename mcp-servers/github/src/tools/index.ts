/**
 * GitHub Tools Aggregator: exports the GitHub tool definitions via factory functions.
 */

import { ToolDefinition } from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';
import { withNumericForgiveness } from './validation.js';
import { createRepoTools } from './repo-tools.js';
import { createPrTools } from './pr-tools.js';
import { createPrReviewTools } from './pr-review-tools.js';
import { createBranchTools } from './branch-tools.js';
import { createCommitTools } from './commit-tools.js';
import { createRepositoryTools } from './repository-tools.js';
import { createActionsTools } from './actions-tools.js';
import { createIssueTools } from './issue-tools.js';
import { createLabelTools } from './label-tools.js';
import { createReleaseTools } from './release-tools.js';
import { createUserTools } from './user-tools.js';

/**
 * Builds the full list of GitHub tool definitions.
 * @param client - GitHub client instance (null when the service is not configured)
 */
export function createToolDefinitions(client: GitHubClient | null): ToolDefinition[] {
  return [
    ...createUserTools(client),
    ...createRepoTools(client),
    ...createPrTools(client),
    ...createPrReviewTools(client),
    ...createBranchTools(client),
    ...createCommitTools(client),
    ...createRepositoryTools(client),
    ...createActionsTools(client),
    ...createIssueTools(client),
    ...createLabelTools(client),
    ...createReleaseTools(client),
  ].map(withNumericForgiveness);
}

export { createRepoTools } from './repo-tools.js';
export { createPrTools } from './pr-tools.js';
export { createPrReviewTools } from './pr-review-tools.js';
export { createBranchTools } from './branch-tools.js';
export { createCommitTools } from './commit-tools.js';
export { createRepositoryTools } from './repository-tools.js';
export { createActionsTools } from './actions-tools.js';
export { createIssueTools } from './issue-tools.js';
export { createLabelTools } from './label-tools.js';
export { createReleaseTools } from './release-tools.js';
export { createUserTools } from './user-tools.js';
