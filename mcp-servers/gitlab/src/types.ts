/**
 * GitLab MCP Server Type Definitions
 *
 * Extracted from client.ts for better modularity
 */

/**
 * GitLab server connection configuration.
 * Contains authentication credentials and server URL for GitLab API access.
 * @interface GitLabConfig
 */
export interface GitLabConfig {
  /** GitLab Personal Access Token or OAuth token for API authentication */
  token: string;
  /** GitLab server URL (e.g., "https://gitlab.com" or self-hosted instance) */
  host: string;
}

/**
 * GitLab project configuration and metadata.
 * Represents a repository in the GitLab system with its core properties.
 * @interface GitLabProject
 * @see https://docs.gitlab.com/ee/api/projects.html
 */
export interface GitLabProject {
  /** Unique project identifier (numeric) */
  id: number;
  /** Project name without namespace */
  name: string;
  /** Full path including namespace (e.g., "group/subgroup/project") */
  path_with_namespace: string;
  /** Optional project description */
  description?: string;
  /** Full URL to the project in GitLab web interface */
  web_url: string;
  /** Default branch name (typically "main" or "master") */
  default_branch?: string;
}

/**
 * GitLab Merge Request (MR) - equivalent to GitHub Pull Request.
 * Represents a request to merge changes from one branch into another.
 * @interface GitLabMergeRequest
 * @see https://docs.gitlab.com/ee/api/merge_requests.html
 */
export interface GitLabMergeRequest {
  /** Global unique identifier across all projects */
  id: number;
  /** Internal ID unique within the project (used in URLs like !123) */
  iid: number;
  /** MR title/summary */
  title: string;
  /** Optional detailed description supporting Markdown */
  description?: string;
  /** MR state: "opened", "closed", "locked", "merged" */
  state: string;
  /** Branch containing the changes to be merged */
  source_branch: string;
  /** Target branch that will receive the changes */
  target_branch: string;
  /** MR author information */
  author: { id: number; name: string; username: string };
  /** Full URL to the MR in GitLab web interface */
  web_url: string;
  /** ISO 8601 timestamp when MR was created */
  created_at: string;
  /** ISO 8601 timestamp of last update */
  updated_at: string;
  /** Whether the MR has merge conflicts */
  has_conflicts?: boolean;
  /** Merge status: "can_be_merged", "cannot_be_merged", etc. */
  merge_status?: string;
  /** Detailed merge status: "mergeable", "conflict", "checking", etc. */
  detailed_merge_status?: string;
}

/**
 * GitLab CI/CD Pipeline.
 * Represents an automated workflow execution containing multiple jobs/stages.
 * @interface GitLabPipeline
 * @see https://docs.gitlab.com/ee/api/pipelines.html
 */
export interface GitLabPipeline {
  /** Unique pipeline identifier */
  id: number;
  /** Pipeline status: "created", "waiting_for_resource", "preparing", "pending", "running", "success", "failed", "canceled", "skipped", "manual", "scheduled" */
  status: string;
  /** Branch or tag name the pipeline ran on */
  ref: string;
  /** Full commit SHA that triggered the pipeline */
  sha: string;
  /** Full URL to the pipeline in GitLab web interface */
  web_url: string;
  /** ISO 8601 timestamp when pipeline was created */
  created_at: string;
  /** ISO 8601 timestamp of last update */
  updated_at: string;
}

/**
 * GitLab commit information.
 * Represents a single commit in a repository with author and message details.
 * @interface GitLabCommit
 * @see https://docs.gitlab.com/ee/api/commits.html
 */
export interface GitLabCommit {
  /** Full commit SHA hash (40 characters) */
  id: string;
  /** Short commit SHA hash (typically 8 characters) */
  short_id: string;
  /** First line of the commit message */
  title: string;
  /** Complete commit message including title and body */
  message: string;
  /** Author's name from git config */
  author_name: string;
  /** Author's email from git config */
  author_email: string;
  /** ISO 8601 timestamp when commit was created */
  created_at: string;
}

// Notes & Discussions
/**
 * GitLab Note - a comment on issues, merge requests, snippets, or commits.
 * Can be user-generated or system-generated (activity notifications).
 * @interface GitLabNote
 * @see https://docs.gitlab.com/ee/api/notes.html
 */
export interface GitLabNote {
  /** Unique note identifier */
  id: number;
  /** Note content (supports Markdown) */
  body: string;
  /** Note author information */
  author: { id: number; username: string; name: string };
  /** ISO 8601 timestamp when note was created */
  created_at: string;
  /** True if this is a system-generated note (e.g., "closed the issue") */
  system: boolean;
  /** True if this note can be marked as resolved (e.g., code review comment) */
  resolvable: boolean;
  /** True if this resolvable note has been resolved */
  resolved?: boolean;
}

/**
 * GitLab Discussion - a thread of related notes/comments.
 * Groups multiple notes together into a conversation thread.
 * @interface GitLabDiscussion
 * @see https://docs.gitlab.com/ee/api/discussions.html
 */
export interface GitLabDiscussion {
  /** Unique discussion thread identifier */
  id: string;
  /** Array of notes/comments in this discussion thread */
  notes: GitLabNote[];
}

// Issues
/**
 * GitLab Issue - a task, bug report, or feature request.
 * Issues are the primary way to track work in GitLab projects.
 * @interface GitLabIssue
 * @see https://docs.gitlab.com/ee/api/issues.html
 */
export interface GitLabIssue {
  /** Global unique identifier across all projects */
  id: number;
  /** Internal ID unique within the project (used in URLs like #123) */
  iid: number;
  /** Issue title/summary */
  title: string;
  /** Optional detailed description supporting Markdown */
  description?: string;
  /** Issue state: "opened" or "closed" */
  state: 'opened' | 'closed';
  /** Array of label names applied to this issue */
  labels: string[];
  /** Array of users assigned to work on this issue */
  assignees: Array<{ id: number; username: string; name: string }>;
  /** Issue creator information */
  author: { id: number; username: string; name: string };
  /** Optional milestone this issue belongs to */
  milestone?: { id: number; title: string };
  /** Full URL to the issue in GitLab web interface */
  web_url: string;
  /** ISO 8601 timestamp when issue was created */
  created_at: string;
  /** ISO 8601 timestamp of last update */
  updated_at: string;
  /** ISO 8601 timestamp when issue was closed (if closed) */
  closed_at?: string;
}

// Labels
/**
 * GitLab Label - a tag used to categorize issues, merge requests, and epics.
 * Labels help organize and filter work items.
 * @interface GitLabLabel
 * @see https://docs.gitlab.com/ee/api/labels.html
 */
export interface GitLabLabel {
  /** Unique label identifier */
  id: number;
  /** Label name/text */
  name: string;
  /** Background color in hex format (e.g., "#FF0000") */
  color: string;
  /** Optional description explaining the label's purpose */
  description?: string;
  /** Text color in hex format for optimal contrast with background */
  text_color?: string;
}

// Branches
/**
 * GitLab Branch - a named pointer to a commit in the repository.
 * Represents a line of development within a project.
 * @interface GitLabBranch
 * @see https://docs.gitlab.com/ee/api/branches.html
 */
export interface GitLabBranch {
  /** Branch name */
  name: string;
  /** Latest commit on this branch */
  commit: GitLabCommit;
  /** True if branch is protected (requires special permissions to push/delete) */
  protected: boolean;
  /** True if this branch has been merged into the default branch */
  merged: boolean;
  /** True if this is the project's default branch */
  default: boolean;
  /** Full URL to the branch in GitLab web interface */
  web_url: string;
}

/**
 * GitLab Branch Comparison result.
 * Shows differences between two branches including commits and file changes.
 * @interface BranchComparison
 * @see https://docs.gitlab.com/ee/api/repositories.html#compare-branches-tags-or-commits
 */
export interface BranchComparison {
  /** Array of commits that differ between the branches */
  commits: GitLabCommit[];
  /** Array of file diffs showing changes between branches */
  diffs: Array<{ old_path: string; new_path: string; diff: string }>;
  /** True if comparison timed out (too many changes) */
  compare_timeout: boolean;
  /** True if comparing the same reference (no differences) */
  compare_same_ref: boolean;
}

// Repository
/**
 * GitLab Repository Tree Item - a file or directory in the repository.
 * Part of the repository tree structure listing.
 * @interface GitLabTreeItem
 * @see https://docs.gitlab.com/ee/api/repositories.html#list-repository-tree
 */
export interface GitLabTreeItem {
  /** Git object ID (SHA hash) */
  id: string;
  /** File or directory name */
  name: string;
  /** Item type: "tree" for directories, "blob" for files */
  type: 'tree' | 'blob';
  /** Full path from repository root */
  path: string;
  /** Unix file mode permissions (e.g., "100644" for regular file) */
  mode: string;
}

/**
 * GitLab File Content - the contents and metadata of a file in the repository.
 * Retrieved when fetching a specific file from a branch or commit.
 * @interface GitLabFileContent
 * @see https://docs.gitlab.com/ee/api/repository_files.html
 */
export interface GitLabFileContent {
  /** File name without path */
  file_name: string;
  /** Full path from repository root */
  file_path: string;
  /** File size in bytes */
  size: number;
  /** Content encoding: "base64" or "text" */
  encoding: string;
  /** File content (base64-encoded if binary, plain text otherwise) */
  content: string;
  /** Branch or commit SHA this content was retrieved from */
  ref: string;
}

/**
 * GitLab Blame information - shows which commit last modified each line of a file.
 * Useful for understanding code history and authorship.
 * @interface GitLabBlame
 * @see https://docs.gitlab.com/ee/api/repository_files.html#get-file-blame-from-repository
 */
export interface GitLabBlame {
  /** Commit that last modified these lines */
  commit: GitLabCommit;
  /** Array of file lines attributed to this commit */
  lines: string[];
}

// Artifacts
/**
 * GitLab CI/CD Artifact - files generated by pipeline jobs.
 * Artifacts can include build outputs, test reports, logs, etc.
 * @interface GitLabArtifact
 * @see https://docs.gitlab.com/ee/api/job_artifacts.html
 */
export interface GitLabArtifact {
  /** Artifact type (e.g., "archive", "metadata", "trace") */
  file_type: string;
  /** Artifact size in bytes */
  size: number;
  /** Artifact filename */
  filename: string;
  /** Optional file format/extension */
  file_format?: string;
}

/**
 * GitLab CI/CD Job - a single task within a pipeline.
 * Jobs run scripts and can produce artifacts as outputs.
 * @interface GitLabJob
 * @see https://docs.gitlab.com/ee/api/jobs.html
 */
export interface GitLabJob {
  /** Unique job identifier */
  id: number;
  /** Job name as defined in .gitlab-ci.yml */
  name: string;
  /** Job status: "created", "pending", "running", "success", "failed", "canceled", "skipped", "manual" */
  status: string;
  /** Pipeline stage this job belongs to (e.g., "build", "test", "deploy") */
  stage: string;
  /** Array of artifacts produced by this job */
  artifacts: GitLabArtifact[];
  /** Full URL to the job in GitLab web interface */
  web_url: string;
}
