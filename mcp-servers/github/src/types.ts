/**
 * GitHub MCP Server Type Definitions
 *
 * Extracted from client.ts for better modularity.
 * Field names mirror the GitHub REST API (mostly snake_case); the client
 * mappers normalize raw responses to these shapes defensively.
 */

/**
 * GitHub API client configuration.
 * Contains the authentication token and an optional API base URL.
 * @interface GitHubConfig
 */
export interface GitHubConfig {
  /** GitHub Personal Access Token (fine-grained or classic) used for API authentication */
  token: string;
  /** Optional API base URL. Defaults to https://api.github.com for github.com. GHES not supported in v1. */
  baseUrl?: string;
}

/**
 * GitHub repository metadata.
 * Represents a repository with its core identifying properties.
 * @interface GitHubRepo
 * @see https://docs.github.com/en/rest/repos/repos
 */
export interface GitHubRepo {
  /** Unique numeric repository identifier */
  id: number;
  /** Repository name without the owner prefix */
  name: string;
  /** Full name including owner (e.g., "octocat/Hello-World") */
  full_name: string;
  /** Repository owner login */
  owner: { login: string };
  /** Optional repository description */
  description?: string;
  /** Full URL to the repository in the GitHub web interface */
  html_url: string;
  /** Default branch name (typically "main") */
  default_branch: string;
  /** Whether the repository is private */
  private: boolean;
}

/**
 * GitHub Pull Request - a request to merge changes from one branch into another.
 * @interface GitHubPullRequest
 * @see https://docs.github.com/en/rest/pulls/pulls
 */
export interface GitHubPullRequest {
  /** Pull request number, unique within the repository (used in URLs like #123) */
  number: number;
  /** PR title/summary */
  title: string;
  /** Optional detailed description supporting Markdown */
  body?: string;
  /** PR state: "open" or "closed" */
  state: 'open' | 'closed';
  /** Whether the PR has been merged (closed PRs may or may not be merged) */
  merged?: boolean;
  /** Head ref — the branch containing the changes to merge */
  head: { ref: string; sha: string };
  /** Base ref — the branch that will receive the changes */
  base: { ref: string };
  /** PR author login */
  user: { login: string };
  /** Full URL to the PR in the GitHub web interface */
  html_url: string;
  /** ISO 8601 timestamp when the PR was created */
  created_at: string;
  /** ISO 8601 timestamp of the last update */
  updated_at: string;
  /** Whether the PR is a draft */
  draft?: boolean;
}

/**
 * GitHub Issue - a task, bug report, or feature request.
 * @interface GitHubIssue
 * @see https://docs.github.com/en/rest/issues/issues
 */
export interface GitHubIssue {
  /** Issue number, unique within the repository (used in URLs like #123) */
  number: number;
  /** Issue title/summary */
  title: string;
  /** Optional detailed description supporting Markdown */
  body?: string;
  /** Issue state: "open" or "closed" */
  state: 'open' | 'closed';
  /** Issue creator login */
  user: { login: string };
  /** Labels applied to this issue */
  labels: Array<{ name: string }>;
  /** Users assigned to this issue */
  assignees: Array<{ login: string }>;
  /** Full URL to the issue in the GitHub web interface */
  html_url: string;
  /** ISO 8601 timestamp when the issue was created */
  created_at: string;
  /** ISO 8601 timestamp of the last update */
  updated_at: string;
}

/**
 * GitHub Branch - a named pointer to a commit in the repository.
 * @interface GitHubBranch
 * @see https://docs.github.com/en/rest/branches/branches
 */
export interface GitHubBranch {
  /** Branch name */
  name: string;
  /** Latest commit on this branch */
  commit: { sha: string };
  /** Whether the branch is protected (requires special permissions to push/delete) */
  protected: boolean;
}

/**
 * GitHub commit information.
 * @interface GitHubCommit
 * @see https://docs.github.com/en/rest/commits/commits
 */
export interface GitHubCommit {
  /** Full commit SHA hash */
  sha: string;
  /** Embedded commit object with message and author details */
  commit: { message: string; author: { name: string; email: string; date: string } };
  /** Full URL to the commit in the GitHub web interface */
  html_url: string;
}

/**
 * GitHub Label - a tag used to categorize issues and pull requests.
 * @interface GitHubLabel
 * @see https://docs.github.com/en/rest/issues/labels
 */
export interface GitHubLabel {
  /** Unique numeric label identifier */
  id: number;
  /** Label name/text */
  name: string;
  /** Color in hex format WITHOUT the leading "#" (e.g., "ff0000") */
  color: string;
  /** Optional description explaining the label's purpose */
  description?: string;
}

/**
 * GitHub Release - a published release associated with a Git tag.
 * @interface GitHubRelease
 * @see https://docs.github.com/en/rest/releases/releases
 */
export interface GitHubRelease {
  /** Unique numeric release identifier */
  id: number;
  /** Git tag this release is associated with (e.g., "v1.0.0") */
  tag_name: string;
  /** Optional release name (defaults to tag name if not set) */
  name?: string;
  /** Optional release notes in Markdown */
  body?: string;
  /** Whether the release is a draft (unpublished) */
  draft: boolean;
  /** Whether the release is marked as a pre-release */
  prerelease: boolean;
  /** Full URL to the release in the GitHub web interface */
  html_url: string;
  /** ISO 8601 timestamp when the release was created */
  created_at: string;
}

/**
 * GitHub Actions workflow run.
 * @interface GitHubWorkflowRun
 * @see https://docs.github.com/en/rest/actions/workflow-runs
 */
export interface GitHubWorkflowRun {
  /** Unique numeric run identifier */
  id: number;
  /** Optional workflow run name */
  name?: string;
  /** Run status: "queued", "in_progress", "completed", etc. */
  status: string;
  /** Run conclusion when completed: "success", "failure", "cancelled", etc., or null if not finished */
  conclusion: string | null;
  /** Branch the run was triggered on */
  head_branch: string;
  /** Commit SHA the run was triggered on */
  head_sha: string;
  /** Full URL to the run in the GitHub web interface */
  html_url: string;
  /** ISO 8601 timestamp when the run was created */
  created_at: string;
  /** ISO 8601 timestamp of the last update */
  updated_at: string;
}

/**
 * GitHub Actions workflow run artifact - a file or archive produced by a run.
 * @interface GitHubWorkflowRunArtifact
 * @see https://docs.github.com/en/rest/actions/artifacts
 */
export interface GitHubWorkflowRunArtifact {
  /** Unique numeric artifact identifier */
  id: number;
  /** Artifact name */
  name: string;
  /** Artifact size in bytes */
  size_in_bytes: number;
  /** URL to download the artifact ZIP archive (valid briefly) */
  archive_download_url: string;
  /** Whether the artifact has expired and can no longer be downloaded */
  expired: boolean;
}

/**
 * GitHub file content - the contents and metadata of a file in a repository.
 * Note: GitHub returns file content base64-encoded.
 * @interface GitHubFileContent
 * @see https://docs.github.com/en/rest/repos/contents
 */
export interface GitHubFileContent {
  /** Full path from the repository root */
  path: string;
  /** File content (base64-encoded by GitHub) */
  content: string;
  /** Content encoding reported by GitHub (typically "base64") */
  encoding: string;
  /** Git blob SHA for this file (needed to update the file) */
  sha: string;
  /** File size in bytes */
  size: number;
}

/**
 * GitHub tree item - a file ("blob") or directory ("tree") in a repository tree.
 * @interface GitHubTreeItem
 * @see https://docs.github.com/en/rest/git/trees
 */
export interface GitHubTreeItem {
  /** Full path from the repository root */
  path: string;
  /** Unix file mode (e.g., "100644" for a regular file) */
  mode: string;
  /** Item type: "blob" for files, "tree" for directories */
  type: 'blob' | 'tree';
  /** Git object SHA */
  sha: string;
  /** File size in bytes (only present for blobs) */
  size?: number;
}

/**
 * GitHub pull request review - an approval, change request, or comment on a PR.
 * @interface GitHubReview
 * @see https://docs.github.com/en/rest/pulls/reviews
 */
export interface GitHubReview {
  /** Unique numeric review identifier */
  id: number;
  /** Reviewer login */
  user: { login: string };
  /** Review state: "APPROVED", "CHANGES_REQUESTED", "COMMENTED", "PENDING", etc. */
  state: string;
  /** Optional review body text supporting Markdown */
  body?: string;
  /** ISO 8601 timestamp when the review was submitted (absent for pending reviews) */
  submitted_at?: string;
  /** Full URL to the review in the GitHub web interface */
  html_url: string;
}

/**
 * GitHub issue/PR comment - a general comment on an issue or pull request.
 * @interface GitHubComment
 * @see https://docs.github.com/en/rest/issues/comments
 */
export interface GitHubComment {
  /** Unique numeric comment identifier */
  id: number;
  /** Comment author login */
  user: { login: string };
  /** Comment body text supporting Markdown */
  body: string;
  /** ISO 8601 timestamp when the comment was created */
  created_at: string;
  /** Full URL to the comment in the GitHub web interface */
  html_url: string;
}

/**
 * GitHub pull request review comment - a comment attached to a specific line of a diff.
 * @interface GitHubReviewComment
 * @see https://docs.github.com/en/rest/pulls/comments
 */
export interface GitHubReviewComment {
  /** Unique numeric review comment identifier */
  id: number;
  /** Comment author login */
  user: { login: string };
  /** Comment body text supporting Markdown */
  body: string;
  /** Path of the file the comment is attached to */
  path: string;
  /** Line number in the file the comment refers to */
  line?: number;
  /** ISO 8601 timestamp when the comment was created */
  created_at: string;
  /** Full URL to the comment in the GitHub web interface */
  html_url: string;
}

/**
 * GitHub commit comparison result - the diff between a base and head ref.
 * @interface GitHubCommitComparison
 * @see https://docs.github.com/en/rest/commits/commits#compare-two-commits
 */
export interface GitHubCommitComparison {
  /** Number of commits the head ref is ahead of the base ref */
  ahead_by: number;
  /** Number of commits the head ref is behind the base ref */
  behind_by: number;
  /** Total number of commits in the comparison */
  total_commits: number;
  /** Commits unique to the head ref */
  commits: GitHubCommit[];
  /** Comparison status: "ahead", "behind", "identical", or "diverged" */
  status: string;
}

/**
 * Result of a GitHub API connection test with error categorization.
 * @interface ConnectionTestResult
 */
export interface ConnectionTestResult {
  /** True if the connection test succeeded */
  success: boolean;
  /** Human-readable error message when the test failed */
  error?: string;
  /** Categorized error type for downstream handling */
  errorType?: 'auth' | 'network' | 'permission' | 'not_found' | 'unknown';
}
