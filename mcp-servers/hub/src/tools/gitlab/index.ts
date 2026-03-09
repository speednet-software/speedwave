/**
 * GitLab Tools Index
 *
 * Exports all GitLab tool metadata for progressive discovery.
 * Tools are loaded dynamically by the search_tools handler.
 *
 * Available tools (46):
 *
 * Projects (3):
 * - listProjectIds: List project IDs and paths
 * - getProjectFull: Get complete project data
 * - searchCode: Search code across projects
 *
 * Merge Requests (11):
 * - listMrIds: List MR IIDs
 * - getMrFull: Get complete MR data
 * - createMergeRequest: Create new MR
 * - approveMergeRequest: Approve MR
 * - mergeMergeRequest: Merge MR
 * - updateMergeRequest: Update MR
 * - getMrChanges: Get MR diff
 * - listMrCommits: List commits in MR
 * - listMrPipelines: List pipelines for MR
 * - listMrNotes: List notes/comments on MR
 * - createMrNote: Add comment to MR
 *
 * Discussions (2):
 * - listMrDiscussions: List discussion threads
 * - createMrDiscussion: Create discussion thread
 *
 * Branches (5):
 * - listBranches: List branches in project
 * - getBranch: Get branch details
 * - createBranch: Create new branch
 * - deleteBranch: Delete branch
 * - compareBranches: Compare two branches
 *
 * Commits (4):
 * - listBranchCommits: List commits from branch
 * - listCommits: List commits with filters
 * - searchCommits: Search commits by message
 * - getCommitDiff: Get commit diff
 *
 * Pipelines (5):
 * - listPipelineIds: List pipeline IDs
 * - getPipelineFull: Get complete pipeline data
 * - getJobLog: Get job log
 * - retryPipeline: Retry pipeline
 * - triggerPipeline: Trigger new pipeline
 *
 * Repository (3):
 * - getTree: Get file tree
 * - getFile: Get file content
 * - getBlame: Get git blame
 *
 * Artifacts (3):
 * - listArtifacts: List pipeline artifacts
 * - downloadArtifact: Download artifact
 * - deleteArtifacts: Delete job artifacts
 *
 * Issues (5):
 * - listIssues: List project issues
 * - getIssue: Get issue details
 * - createIssue: Create new issue
 * - updateIssue: Update issue
 * - closeIssue: Close issue
 *
 * Labels (2):
 * - listLabels: List project labels
 * - createLabel: Create new label
 *
 * Releases (3):
 * - createTag: Create Git tag
 * - deleteTag: Delete Git tag
 * - createRelease: Create release
 */

import { ToolMetadata } from '../../hub-types.js';

// Projects
import { metadata as listProjectIds } from './list_projects.js';
import { metadata as getProjectFull } from './show_project.js';
import { metadata as searchCode } from './search_code.js';

// Merge Requests
import { metadata as listMrIds } from './list_merge_requests.js';
import { metadata as getMrFull } from './show_merge_request.js';
import { metadata as createMergeRequest } from './create_merge_request.js';
import { metadata as approveMergeRequest } from './approve_merge_request.js';
import { metadata as mergeMergeRequest } from './merge_merge_request.js';
import { metadata as updateMergeRequest } from './update_merge_request.js';
import { metadata as getMrChanges } from './get_mr_changes.js';
import { metadata as listMrCommits } from './list_mr_commits.js';
import { metadata as listMrPipelines } from './list_mr_pipelines.js';
import { metadata as listMrNotes } from './list_mr_notes.js';
import { metadata as createMrNote } from './create_mr_note.js';

// Discussions
import { metadata as listMrDiscussions } from './list_mr_discussions.js';
import { metadata as createMrDiscussion } from './create_mr_discussion.js';

// Branches
import { metadata as listBranches } from './list_branches.js';
import { metadata as getBranch } from './get_branch.js';
import { metadata as createBranch } from './create_branch.js';
import { metadata as deleteBranch } from './delete_branch.js';
import { metadata as compareBranches } from './compare_branches.js';

// Commits
import { metadata as listBranchCommits } from './list_branch_commits.js';
import { metadata as listCommits } from './list_commits.js';
import { metadata as searchCommits } from './search_commits.js';
import { metadata as getCommitDiff } from './get_commit_diff.js';

// Pipelines
import { metadata as listPipelineIds } from './list_pipelines.js';
import { metadata as getPipelineFull } from './show_pipeline.js';
import { metadata as getJobLog } from './get_job_log.js';
import { metadata as retryPipeline } from './retry_pipeline.js';
import { metadata as triggerPipeline } from './trigger_pipeline.js';

// Repository
import { metadata as getTree } from './get_tree.js';
import { metadata as getFile } from './get_file.js';
import { metadata as getBlame } from './get_blame.js';

// Artifacts
import { metadata as listArtifacts } from './list_artifacts.js';
import { metadata as downloadArtifact } from './download_artifact.js';
import { metadata as deleteArtifacts } from './delete_artifacts.js';

// Issues
import { metadata as listIssues } from './list_issues.js';
import { metadata as getIssue } from './get_issue.js';
import { metadata as createIssue } from './create_issue.js';
import { metadata as updateIssue } from './update_issue.js';
import { metadata as closeIssue } from './close_issue.js';

// Labels
import { metadata as listLabels } from './list_labels.js';
import { metadata as createLabel } from './create_label.js';

// Releases
import { metadata as createTag } from './create_tag.js';
import { metadata as deleteTag } from './delete_tag.js';
import { metadata as createRelease } from './create_release.js';

/**
 * All GitLab tools metadata indexed by camelCase name
 */
export const toolMetadata: Record<string, ToolMetadata> = {
  // Projects
  listProjectIds,
  getProjectFull,
  searchCode,
  // Merge Requests
  listMrIds,
  getMrFull,
  createMergeRequest,
  approveMergeRequest,
  mergeMergeRequest,
  updateMergeRequest,
  getMrChanges,
  listMrCommits,
  listMrPipelines,
  listMrNotes,
  createMrNote,
  // Discussions
  listMrDiscussions,
  createMrDiscussion,
  // Branches
  listBranches,
  getBranch,
  createBranch,
  deleteBranch,
  compareBranches,
  // Commits
  listBranchCommits,
  listCommits,
  searchCommits,
  getCommitDiff,
  // Pipelines
  listPipelineIds,
  getPipelineFull,
  getJobLog,
  retryPipeline,
  triggerPipeline,
  // Repository
  getTree,
  getFile,
  getBlame,
  // Artifacts
  listArtifacts,
  downloadArtifact,
  deleteArtifacts,
  // Issues
  listIssues,
  getIssue,
  createIssue,
  updateIssue,
  closeIssue,
  // Labels
  listLabels,
  createLabel,
  // Releases
  createTag,
  deleteTag,
  createRelease,
};

/**
 * All GitLab tools array
 * Derived from toolMetadata keys to maintain SSOT
 */
export const tools = Object.keys(toolMetadata) as (keyof typeof toolMetadata)[];

/**
 * Union type of all GitLab tool names for type safety
 */
export type GitLabToolName = keyof typeof toolMetadata;
