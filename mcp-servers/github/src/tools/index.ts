/**
 * GitHub Tools Aggregator
 *
 * Exports all 45 tools (camelCase names) organized by domain:
 * - Repos: 3 tools (listRepos, getRepo, searchCode)
 * - Pull Requests: 7 tools (listPullRequests, getPullRequest, createPullRequest, mergePullRequest, updatePullRequest, getPrDiff, getPrFiles)
 * - PR Review: 6 tools (listPrCommits, listPrReviews, createPrReview, listPrComments, createPrComment, createPrReviewComment)
 * - Branches: 5 tools (listBranches, getBranch, createBranch, deleteBranch, compareBranches)
 * - Commits: 4 tools (listCommits, listBranchCommits, searchCommits, getCommitDiff)
 * - Repository content: 3 tools (getTree, getFileContents, createOrUpdateFile)
 * - Actions: 7 tools (listWorkflowRuns, getWorkflowRun, getRunLogs, rerunWorkflow, triggerWorkflow, listWorkflowRunArtifacts, downloadArtifact)
 * - Issues: 5 tools (listIssues, getIssue, createIssue, updateIssue, closeIssue)
 * - Labels: 2 tools (listLabels, createLabel)
 * - Releases: 3 tools (createTag, deleteTag, createRelease)
 */

import { ToolDefinition } from '@speedwave/mcp-shared';
import { GitHubClient } from '../client.js';
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

/**
 * Builds the full list of GitHub tool definitions.
 * @param client - GitHub client instance (null when the service is not configured)
 */
export function createToolDefinitions(client: GitHubClient | null): ToolDefinition[] {
  return [
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
  ];
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
