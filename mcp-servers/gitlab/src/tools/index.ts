/**
 * GitLab Tools Aggregator
 *
 * Exports all 46 tools organized by domain:
 * - Project: 3 tools (list_project_ids, get_project_full, search_code)
 * - Merge Request: 7 tools (list_mr_ids, get_mr_full, create_merge_request, approve_merge_request, merge_merge_request, update_merge_request, get_mr_changes)
 * - MR Notes: 4 tools (list_mr_commits, list_mr_pipelines, list_mr_notes, create_mr_note)
 * - Discussion: 2 tools (list_mr_discussions, create_mr_discussion)
 * - Branch: 5 tools (list_branches, get_branch, create_branch, delete_branch, compare_branches)
 * - Commit: 4 tools (list_branch_commits, list_commits, search_commits, get_commit_diff)
 * - Pipeline: 5 tools (list_pipeline_ids, get_pipeline_full, get_job_log, retry_pipeline, trigger_pipeline)
 * - Repository: 3 tools (get_tree, get_file, get_blame)
 * - Artifact: 3 tools (list_artifacts, download_artifact, delete_artifacts)
 * - Issue: 5 tools (list_issues, get_issue, create_issue, update_issue, close_issue)
 * - Label: 2 tools (list_labels, create_label)
 * - Release: 3 tools (create_tag, delete_tag, create_release)
 */

import { ToolDefinition } from '@speedwave/mcp-shared';
import { GitLabClient } from '../client.js';
import { createProjectTools } from './project-tools.js';
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
