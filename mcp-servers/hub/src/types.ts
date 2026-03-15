/**
 * MCP Services Type Definitions
 *
 * Complete type definitions for all MCP service responses.
 * Replaces `any` types with proper interfaces for type safety.
 */

// =============================================================================
// Redmine Types
// =============================================================================

/**
 * Represents a Redmine user with basic identification information.
 * Used in issue assignments, journal entries, time tracking, and watchers.
 * @interface RedmineUser
 */
export interface RedmineUser {
  /** Unique user identifier in Redmine */
  id: number;
  /** User's display name */
  name: string;
  /** User's login username */
  login?: string;
  /** User's email address */
  mail?: string;
  /** User's first name */
  firstname?: string;
  /** User's last name */
  lastname?: string;
}

/**
 * Represents a Redmine project with basic identification.
 * Projects are containers for issues, wikis, and other resources.
 * @interface RedmineProject
 */
export interface RedmineProject {
  /** Unique project identifier in Redmine */
  id: number;
  /** Project display name */
  name: string;
  /** Project URL identifier (used in paths) */
  identifier?: string;
}

/**
 * Represents a Redmine tracker type (e.g., Bug, Feature, Task).
 * Trackers categorize issues and define their workflow.
 * @interface RedmineTracker
 */
export interface RedmineTracker {
  /** Unique tracker identifier */
  id: number;
  /** Tracker name (e.g., "Bug", "Feature") */
  name: string;
}

/**
 * Represents an issue status in Redmine workflow (e.g., New, In Progress, Closed).
 * Statuses define the current state of an issue in its lifecycle.
 * @interface RedmineStatus
 */
export interface RedmineStatus {
  /** Unique status identifier */
  id: number;
  /** Status name (e.g., "New", "In Progress", "Closed") */
  name: string;
  /** Whether this status indicates a closed issue */
  is_closed?: boolean;
}

/**
 * Represents an issue priority level in Redmine (e.g., Low, Normal, High, Urgent).
 * Priorities indicate the importance or urgency of an issue.
 * @interface RedminePriority
 */
export interface RedminePriority {
  /** Unique priority identifier */
  id: number;
  /** Priority name (e.g., "Low", "Normal", "High", "Urgent") */
  name: string;
}

/**
 * Represents a custom field in Redmine with user-defined metadata.
 * Custom fields allow extending issues with additional project-specific data.
 * @interface RedmineCustomField
 */
export interface RedmineCustomField {
  /** Unique custom field identifier */
  id: number;
  /** Custom field name */
  name: string;
  /** Field value - can be single string or array for multi-select fields */
  value: string | string[];
}

/**
 * Represents a journal entry (comment or change log) on a Redmine issue.
 * Journals track issue history including notes and field changes.
 * @interface RedmineJournal
 */
export interface RedmineJournal {
  /** Unique journal entry identifier */
  id: number;
  /** User who created this journal entry */
  user: RedmineUser;
  /** Comment text added by the user */
  notes: string;
  /** ISO 8601 timestamp when the entry was created */
  created_on: string;
  /** Whether the notes are visible only to certain roles */
  private_notes?: boolean;
  /** Array of field changes recorded in this journal entry */
  details: Array<{
    /** Property type (e.g., "attr", "cf" for custom field) */
    property: string;
    /** Name of the changed field */
    name: string;
    /** Previous value before the change */
    old_value?: string;
    /** New value after the change */
    new_value?: string;
  }>;
}

/**
 * Represents a file attachment on a Redmine issue.
 * Attachments can be documents, images, or any file type.
 * @interface RedmineAttachment
 */
export interface RedmineAttachment {
  /** Unique attachment identifier */
  id: number;
  /** Original filename of the attachment */
  filename: string;
  /** File size in bytes */
  filesize: number;
  /** MIME type of the file (e.g., "image/png", "application/pdf") */
  content_type: string;
  /** Optional description of the attachment */
  description?: string;
  /** URL to download the attachment content */
  content_url?: string;
  /** User who uploaded the attachment */
  author: RedmineUser;
  /** ISO 8601 timestamp when the attachment was created */
  created_on: string;
}

/**
 * Represents a relationship between two Redmine issues.
 * Relations define dependencies, duplicates, and other connections between issues.
 * @interface RedmineRelation
 */
export interface RedmineRelation {
  /** Unique relation identifier */
  id: number;
  /** Source issue ID */
  issue_id: number;
  /** Target issue ID */
  issue_to_id: number;
  /** Type of relationship between the issues */
  relation_type:
    | 'relates'
    | 'duplicates'
    | 'duplicated'
    | 'blocks'
    | 'blocked'
    | 'precedes'
    | 'follows'
    | 'copied_to'
    | 'copied_from';
  /** Delay in days for precedes/follows relations */
  delay?: number;
}

/**
 * Represents a complete Redmine issue with all associated data.
 * Issues are the core work items in Redmine, containing tasks, bugs, features, etc.
 * @interface RedmineIssue
 */
export interface RedmineIssue {
  /** Unique issue identifier */
  id: number;
  /** Project this issue belongs to */
  project: RedmineProject;
  /** Issue type (Bug, Feature, Task, etc.) */
  tracker: RedmineTracker;
  /** Current workflow status */
  status: RedmineStatus;
  /** Priority level */
  priority: RedminePriority;
  /** User who created the issue */
  author: RedmineUser;
  /** User currently assigned to the issue */
  assigned_to?: RedmineUser;
  /** Issue category for organization */
  category?: { id: number; name: string };
  /** Target version/milestone for the issue */
  fixed_version?: { id: number; name: string };
  /** Parent issue ID for subtasks */
  parent?: { id: number };
  /** Issue title/summary */
  subject: string;
  /** Detailed issue description */
  description: string;
  /** Planned start date (YYYY-MM-DD) */
  start_date?: string;
  /** Target due date (YYYY-MM-DD) */
  due_date?: string;
  /** Completion percentage (0-100) */
  done_ratio: number;
  /** Whether the issue is visible only to certain roles */
  is_private?: boolean;
  /** Estimated time to complete in hours */
  estimated_hours?: number;
  /** Total time logged on the issue in hours */
  spent_hours?: number;
  /** Array of custom field values */
  custom_fields?: RedmineCustomField[];
  /** ISO 8601 timestamp when the issue was created */
  created_on: string;
  /** ISO 8601 timestamp of last update */
  updated_on: string;
  /** ISO 8601 timestamp when the issue was closed */
  closed_on?: string;
  /** History of comments and changes */
  journals?: RedmineJournal[];
  /** Files attached to the issue */
  attachments?: RedmineAttachment[];
  /** Relationships to other issues */
  relations?: RedmineRelation[];
  /** Child/subtask issues */
  children?: Array<{ id: number; tracker: RedmineTracker; subject: string }>;
  /** Users watching this issue for notifications */
  watchers?: RedmineUser[];
}

/**
 * Response from the Redmine list issues API operation.
 * Returns lightweight issue IDs for efficient querying with pagination support.
 * @interface RedmineListIssuesResponse
 */
export interface RedmineListIssuesResponse {
  /** Array of issue IDs matching the query */
  ids: number[];
  /** Total number of issues matching the query */
  total_count: number;
  /** Number of issues skipped (for pagination) */
  offset: number;
  /** Maximum number of issues returned */
  limit: number;
}

/**
 * Response from the Redmine search issues API operation.
 * Returns issue IDs matching a text search query.
 * @interface RedmineSearchIssuesResponse
 */
export interface RedmineSearchIssuesResponse {
  /** Array of issue IDs matching the search query */
  ids: number[];
  /** Total number of issues found */
  total_count: number;
}

/**
 * Represents a time tracking entry in Redmine.
 * Time entries record hours spent on issues or projects.
 * @interface RedmineTimeEntry
 */
export interface RedmineTimeEntry {
  /** Unique time entry identifier */
  id: number;
  /** Project this time was logged against */
  project: RedmineProject;
  /** Optional issue this time was logged against */
  issue?: { id: number };
  /** User who logged the time */
  user: RedmineUser;
  /** Activity type (e.g., Development, Testing, Design) */
  activity: { id: number; name: string };
  /** Number of hours logged */
  hours: number;
  /** Description or notes about the work done */
  comments: string;
  /** Date the work was performed (YYYY-MM-DD) */
  spent_on: string;
  /** ISO 8601 timestamp when the entry was created */
  created_on: string;
  /** ISO 8601 timestamp of last update */
  updated_on: string;
  /** Optional custom field values */
  custom_fields?: RedmineCustomField[];
}

/**
 * Response from the Redmine list time entries API operation.
 * Returns time entries with pagination information.
 * @interface RedmineListTimeEntriesResponse
 */
export interface RedmineListTimeEntriesResponse {
  /** Array of time entry records */
  time_entries: RedmineTimeEntry[];
  /** Total number of time entries matching the query */
  total_count: number;
}

/**
 * Represents custom field mappings for Redmine operations.
 * Maps field names to their numeric IDs or string values for batch operations.
 * @interface RedmineMappings
 */
export interface RedmineMappings {
  /** Key-value pairs mapping field names to IDs or values */
  [key: string]: number | string;
}

/**
 * Configuration settings for Redmine MCP server connection.
 * Contains authentication and project context information.
 * @interface RedmineConfig
 */
export interface RedmineConfig {
  /** Default project ID to use for operations */
  project_id?: string;
  /** Default project name for display purposes */
  project_name?: string;
  /** Base URL of the Redmine instance */
  url: string;
}

// =============================================================================
// GitLab Types
// =============================================================================

/**
 * Represents a GitLab user account.
 * Users are referenced in projects, merge requests, issues, and commits.
 * @interface GitLabUser
 */
export interface GitLabUser {
  /** Unique user identifier */
  id: number;
  /** Unique username for login and mentions */
  username: string;
  /** User's display name */
  name: string;
  /** Account status */
  state: 'active' | 'blocked' | 'deactivated';
  /** URL to user's avatar image */
  avatar_url: string;
  /** URL to user's profile page */
  web_url: string;
  /** User's email address (if visible) */
  email?: string;
}

/**
 * Represents a GitLab namespace (user or group).
 * Namespaces organize projects and define ownership/permissions.
 * @interface GitLabNamespace
 */
export interface GitLabNamespace {
  /** Unique namespace identifier */
  id: number;
  /** Namespace display name */
  name: string;
  /** URL path segment */
  path: string;
  /** Type of namespace - user account or group */
  kind: 'user' | 'group';
  /** Complete path including parent groups */
  full_path: string;
  /** URL to namespace avatar image */
  avatar_url?: string;
  /** URL to namespace page */
  web_url: string;
}

/**
 * Represents storage and usage statistics for a GitLab project.
 * Provides detailed breakdown of disk space usage by component.
 * @interface GitLabProjectStatistics
 */
export interface GitLabProjectStatistics {
  /** Total number of commits in the repository */
  commit_count: number;
  /** Total storage used in bytes */
  storage_size: number;
  /** Git repository size in bytes */
  repository_size: number;
  /** Wiki storage size in bytes */
  wiki_size?: number;
  /** Large File Storage (LFS) objects size in bytes */
  lfs_objects_size?: number;
  /** CI/CD job artifacts size in bytes */
  job_artifacts_size?: number;
  /** Package registry storage size in bytes */
  packages_size?: number;
  /** Code snippets storage size in bytes */
  snippets_size?: number;
}

/**
 * Represents a software license detected in a GitLab project.
 * Based on license files in the repository (e.g., LICENSE, LICENSE.md).
 * @interface GitLabLicense
 */
export interface GitLabLicense {
  /** SPDX license identifier (e.g., "MIT", "Apache-2.0") */
  key: string;
  /** Full license name */
  name: string;
  /** Common nickname for the license */
  nickname?: string;
  /** URL to license documentation */
  html_url?: string;
  /** URL to license text source */
  source_url?: string;
}

/**
 * Represents a complete GitLab project with all metadata.
 * Projects are Git repositories with additional collaboration features.
 * @interface GitLabProject
 */
export interface GitLabProject {
  /** Unique project identifier */
  id: number;
  /** Project name */
  name: string;
  /** Project name including namespace (e.g., "Group / Project") */
  name_with_namespace: string;
  /** URL path segment */
  path: string;
  /** Complete path including namespace (e.g., "group/project") */
  path_with_namespace: string;
  /** Project description */
  description?: string;
  /** Name of the default branch (usually "main" or "master") */
  default_branch: string;
  /** Project visibility level */
  visibility: 'private' | 'internal' | 'public';
  /** URL to project web interface */
  web_url: string;
  /** SSH clone URL */
  ssh_url_to_repo: string;
  /** HTTPS clone URL */
  http_url_to_repo: string;
  /** URL to README file */
  readme_url?: string;
  /** Array of topic tags */
  topics?: string[];
  /** Number of project forks */
  forks_count: number;
  /** Number of stars received */
  star_count: number;
  /** ISO 8601 timestamp when project was created */
  created_at: string;
  /** ISO 8601 timestamp of last activity */
  last_activity_at: string;
  /** Namespace (user or group) owning the project */
  namespace: GitLabNamespace;
  /** Whether the project is archived (read-only) */
  archived: boolean;
  /** Whether the repository has no commits */
  empty_repo: boolean;
  /** Storage and usage statistics */
  statistics?: GitLabProjectStatistics;
  /** Detected software license */
  license?: GitLabLicense;
  /** User's access permissions for the project */
  permissions?: {
    /** Direct project access level and notifications */
    project_access?: { access_level: number; notification_level: number };
    /** Group-inherited access level and notifications */
    group_access?: { access_level: number; notification_level: number };
  };
}

/**
 * Represents a GitLab milestone for organizing issues and merge requests.
 * Milestones group work items for releases or project phases.
 * @interface GitLabMilestone
 */
export interface GitLabMilestone {
  /** Unique milestone identifier across GitLab */
  id: number;
  /** Internal milestone ID within the project */
  iid: number;
  /** Milestone title */
  title: string;
  /** Milestone description */
  description?: string;
  /** Current state of the milestone */
  state: 'active' | 'closed';
  /** Target due date (YYYY-MM-DD) */
  due_date?: string;
  /** Start date (YYYY-MM-DD) */
  start_date?: string;
  /** URL to milestone page */
  web_url: string;
}

/**
 * Represents a GitLab merge request (pull request) for code review.
 * Merge requests propose changes from one branch to another.
 * @interface GitLabMergeRequest
 */
export interface GitLabMergeRequest {
  /** Unique merge request identifier across GitLab */
  id: number;
  /** Internal MR number within the project */
  iid: number;
  /** Project containing this merge request */
  project_id: number;
  /** Merge request title */
  title: string;
  /** Detailed description of changes */
  description?: string;
  /** Current state of the merge request */
  state: 'opened' | 'closed' | 'merged' | 'locked';
  /** ISO 8601 timestamp when created */
  created_at: string;
  /** ISO 8601 timestamp of last update */
  updated_at: string;
  /** ISO 8601 timestamp when merged (if applicable) */
  merged_at?: string;
  /** ISO 8601 timestamp when closed (if applicable) */
  closed_at?: string;
  /** Branch to merge changes into */
  target_branch: string;
  /** Branch containing the changes */
  source_branch: string;
  /** Number of comments/notes */
  user_notes_count: number;
  /** Number of upvotes/approvals */
  upvotes: number;
  /** Number of downvotes */
  downvotes: number;
  /** User who created the merge request */
  author: GitLabUser;
  /** Primary assignee (deprecated, use assignees) */
  assignee?: GitLabUser;
  /** Users assigned to work on the MR */
  assignees?: GitLabUser[];
  /** Users assigned to review the MR */
  reviewers?: GitLabUser[];
  /** Project ID containing the source branch */
  source_project_id: number;
  /** Project ID containing the target branch */
  target_project_id: number;
  /** Array of label names */
  labels: string[];
  /** Whether marked as draft/WIP */
  draft: boolean;
  /** Legacy WIP flag */
  work_in_progress: boolean;
  /** Associated milestone */
  milestone?: GitLabMilestone;
  /** Auto-merge when pipeline passes */
  merge_when_pipeline_succeeds: boolean;
  /** Simple merge status (can_be_merged, etc.) */
  merge_status: string;
  /** Detailed merge status information */
  detailed_merge_status?: string;
  /** SHA of the latest commit in source branch */
  sha: string;
  /** SHA of the merge commit (after merge) */
  merge_commit_sha?: string;
  /** SHA of squashed commit (if squash merge) */
  squash_commit_sha?: string;
  /** URL to merge request page */
  web_url: string;
  /** Various reference formats for the MR */
  references?: {
    /** Short reference (e.g., "!123") */
    short: string;
    /** Relative reference within namespace */
    relative: string;
    /** Full reference including project path */
    full: string;
  };
  /** Number of changed lines */
  changes_count?: string;
  /** Whether there are merge conflicts */
  has_conflicts?: boolean;
  /** Whether all blocking discussions are resolved */
  blocking_discussions_resolved?: boolean;
  /** Number of commits unique to source branch */
  diverged_commits_count?: number;
}

/**
 * Represents a GitLab CI/CD job within a pipeline.
 * Jobs execute scripts defined in .gitlab-ci.yml.
 * @interface GitLabJob
 */
export interface GitLabJob {
  /** Unique job identifier */
  id: number;
  /** Job name from .gitlab-ci.yml */
  name: string;
  /** Pipeline stage (e.g., build, test, deploy) */
  stage: string;
  /** Current execution status */
  status:
    | 'created'
    | 'pending'
    | 'running'
    | 'success'
    | 'failed'
    | 'canceled'
    | 'skipped'
    | 'manual';
  /** Git reference (branch or tag name) */
  ref: string;
  /** Whether ref is a tag */
  tag: boolean;
  /** Code coverage percentage */
  coverage?: number;
  /** Whether pipeline continues if job fails */
  allow_failure: boolean;
  /** ISO 8601 timestamp when job was created */
  created_at: string;
  /** ISO 8601 timestamp when job started */
  started_at?: string;
  /** ISO 8601 timestamp when job finished */
  finished_at?: string;
  /** Job execution duration in seconds */
  duration?: number;
  /** Time spent in queue in seconds */
  queued_duration?: number;
  /** User who triggered the job */
  user: GitLabUser;
  /** Commit associated with this job */
  commit?: {
    /** Full commit SHA */
    id: string;
    /** Short commit SHA */
    short_id: string;
    /** Commit message title */
    title: string;
  };
  /** Pipeline containing this job */
  pipeline?: {
    /** Pipeline ID */
    id: number;
    /** Project ID */
    project_id: number;
    /** Git reference */
    ref: string;
    /** Commit SHA */
    sha: string;
    /** Pipeline status */
    status: string;
  };
  /** URL to job details page */
  web_url: string;
  /** Job artifacts metadata */
  artifacts?: Array<{
    /** Artifact type (e.g., archive, junit) */
    file_type: string;
    /** Artifact size in bytes */
    size: number;
    /** Artifact filename */
    filename: string;
  }>;
}

/**
 * Represents a GitLab CI/CD pipeline execution.
 * Pipelines orchestrate multiple jobs across stages for testing and deployment.
 * @interface GitLabPipeline
 */
export interface GitLabPipeline {
  /** Unique pipeline identifier across GitLab */
  id: number;
  /** Internal pipeline ID within the project */
  iid: number;
  /** Project containing this pipeline */
  project_id: number;
  /** Commit SHA that triggered the pipeline */
  sha: string;
  /** Git reference (branch or tag name) */
  ref: string;
  /** Current execution status */
  status:
    | 'created'
    | 'waiting_for_resource'
    | 'preparing'
    | 'pending'
    | 'running'
    | 'success'
    | 'failed'
    | 'canceled'
    | 'skipped'
    | 'manual'
    | 'scheduled';
  /** Pipeline trigger source (push, web, schedule, etc.) */
  source: string;
  /** ISO 8601 timestamp when pipeline was created */
  created_at: string;
  /** ISO 8601 timestamp of last update */
  updated_at: string;
  /** ISO 8601 timestamp when pipeline started */
  started_at?: string;
  /** ISO 8601 timestamp when pipeline finished */
  finished_at?: string;
  /** ISO 8601 timestamp of the commit */
  committed_at?: string;
  /** Total pipeline duration in seconds */
  duration?: number;
  /** Time spent queued in seconds */
  queued_duration?: number;
  /** Overall code coverage percentage */
  coverage?: string;
  /** URL to pipeline details page */
  web_url: string;
  /** User who triggered the pipeline */
  user?: GitLabUser;
  /** Detailed status information for UI display */
  detailed_status?: {
    /** Status icon name */
    icon: string;
    /** Status text */
    text: string;
    /** Status label */
    label: string;
    /** Status group (success, failed, etc.) */
    group: string;
    /** Tooltip text */
    tooltip: string;
    /** Whether details page exists */
    has_details: boolean;
    /** Path to details page */
    details_path?: string;
  };
  /** Jobs included in this pipeline */
  jobs?: GitLabJob[];
}

/**
 * Represents a Git commit in a GitLab repository.
 * Contains commit metadata including author, message, and timestamps.
 * @interface GitLabCommit
 */
export interface GitLabCommit {
  /** Full commit SHA */
  id: string;
  /** Short commit SHA (first 8 characters) */
  short_id: string;
  /** First line of commit message */
  title: string;
  /** Full commit message */
  message: string;
  /** Name of the author */
  author_name: string;
  /** Email of the author */
  author_email: string;
  /** ISO 8601 timestamp when authored */
  authored_date: string;
  /** Name of the committer (may differ from author) */
  committer_name: string;
  /** Email of the committer */
  committer_email: string;
  /** ISO 8601 timestamp when committed */
  committed_date: string;
  /** ISO 8601 timestamp (same as committed_date) */
  created_at: string;
  /** Array of parent commit SHAs */
  parent_ids: string[];
  /** URL to commit page */
  web_url: string;
}

/**
 * Represents a file diff in a GitLab commit or merge request.
 * Contains unified diff format and file change metadata.
 * @interface GitLabDiff
 */
export interface GitLabDiff {
  /** Original file path (before changes) */
  old_path: string;
  /** New file path (after changes) */
  new_path: string;
  /** Original file mode (e.g., "100644") */
  a_mode: string;
  /** New file mode */
  b_mode: string;
  /** Whether this is a newly created file */
  new_file: boolean;
  /** Whether the file was renamed */
  renamed_file: boolean;
  /** Whether the file was deleted */
  deleted_file: boolean;
  /** Unified diff content */
  diff: string;
}

/**
 * Response from the GitLab list projects API operation.
 * Returns lightweight project identifiers for efficient querying (granular pattern).
 * @interface GitLabListProjectsResponse
 */
export interface GitLabListProjectsResponse {
  /** Array of project basic info (ID and path) */
  projects: Array<{ id: number; path: string }>;
  /** Total number of projects returned */
  count: number;
}

/**
 * Response from the GitLab list merge requests API operation.
 * Returns lightweight MR identifiers for efficient querying (granular pattern).
 * @interface GitLabListMrsResponse
 */
export interface GitLabListMrsResponse {
  /** Array of MR basic info (IID and title) */
  mrs: Array<{ iid: number; title: string }>;
  /** Total number of merge requests returned */
  count: number;
}

/**
 * Response from the GitLab list pipelines API operation.
 * Returns lightweight pipeline identifiers for efficient querying (granular pattern).
 * @interface GitLabListPipelinesResponse
 */
export interface GitLabListPipelinesResponse {
  /** Array of pipeline basic info (ID, ref, and status) */
  pipelines: Array<{ id: number; ref: string; status: string }>;
  /** Total number of pipelines returned */
  count: number;
}

// =============================================================================
// Slack Types
// =============================================================================

/**
 * Represents a Slack channel (public, private, DM, or group).
 * Channels are the primary containers for conversations in Slack workspaces.
 * @interface SlackChannel
 */
export interface SlackChannel {
  /** Unique channel identifier */
  id: string;
  /** Channel name without # prefix */
  name: string;
  /** Normalized channel name for consistency */
  name_normalized?: string;
  /** Whether this is a public channel */
  is_channel: boolean;
  /** Whether this is a private channel */
  is_group: boolean;
  /** Whether this is a direct message */
  is_im: boolean;
  /** Whether this is a multi-party direct message */
  is_mpim: boolean;
  /** Whether the channel is private (visible only to members) */
  is_private: boolean;
  /** Whether the channel has been archived */
  is_archived: boolean;
  /** Whether this is the #general channel */
  is_general: boolean;
  /** Whether the channel is shared with another workspace */
  is_shared: boolean;
  /** Whether the channel is shared across the organization */
  is_org_shared: boolean;
  /** Whether the current user is a member of this channel */
  is_member: boolean;
  /** Whether there's a pending external share request */
  is_pending_ext_shared: boolean;
  /** Unix timestamp when the channel was created */
  created: number;
  /** User ID of the channel creator */
  creator?: string;
  /** Unix timestamp when the channel was unlinked */
  unlinked?: number;
  /** Number of members in the channel */
  num_members?: number;
  /** Channel topic metadata */
  topic?: {
    /** Topic text */
    value: string;
    /** User ID who set the topic */
    creator: string;
    /** Unix timestamp when topic was last set */
    last_set: number;
  };
  /** Channel purpose metadata */
  purpose?: {
    /** Purpose text */
    value: string;
    /** User ID who set the purpose */
    creator: string;
    /** Unix timestamp when purpose was last set */
    last_set: number;
  };
}

/**
 * Represents a message in a Slack channel or thread.
 * Messages can contain text, attachments, files, reactions, and threaded replies.
 * @interface SlackMessage
 */
export interface SlackMessage {
  /** Message type (usually "message") */
  type: string;
  /** Message subtype (e.g., "bot_message", "channel_join") */
  subtype?: string;
  /** User ID who sent the message */
  user?: string;
  /** Bot ID if sent by a bot */
  bot_id?: string;
  /** Message text content */
  text: string;
  /** Unique message timestamp identifier */
  ts: string;
  /** Parent message timestamp if this is a thread reply */
  thread_ts?: string;
  /** Number of replies in the thread */
  reply_count?: number;
  /** Number of unique users who replied in the thread */
  reply_users_count?: number;
  /** Timestamp of the latest reply */
  latest_reply?: string;
  /** Array of user IDs who replied in the thread */
  reply_users?: string[];
  /** Emoji reactions on the message */
  reactions?: Array<{
    /** Emoji name (without colons) */
    name: string;
    /** Number of users who used this reaction */
    count: number;
    /** Array of user IDs who reacted */
    users: string[];
  }>;
  /** Legacy message attachments for rich formatting */
  attachments?: Array<{
    /** Plain text summary for clients that don't support attachments */
    fallback?: string;
    /** Color bar shown on the left (hex color or "good"/"warning"/"danger") */
    color?: string;
    /** Text shown above the attachment */
    pretext?: string;
    /** Author's name */
    author_name?: string;
    /** Link to author's profile or website */
    author_link?: string;
    /** URL to author's icon image */
    author_icon?: string;
    /** Attachment title */
    title?: string;
    /** Link for the title */
    title_link?: string;
    /** Main attachment text content */
    text?: string;
    /** Array of key-value pairs for structured data */
    fields?: Array<{
      /** Field name */
      title: string;
      /** Field value */
      value: string;
      /** Whether to display field as short (two columns) */
      short: boolean;
    }>;
    /** URL to full-size image */
    image_url?: string;
    /** URL to thumbnail image */
    thumb_url?: string;
    /** Footer text */
    footer?: string;
    /** URL to footer icon */
    footer_icon?: string;
    /** Unix timestamp for the attachment */
    ts?: string;
  }>;
  /** Block Kit UI components (modern formatting) */
  blocks?: unknown[];
  /** Files attached to the message */
  files?: Array<{
    /** Unique file identifier */
    id: string;
    /** Filename */
    name: string;
    /** File title/description */
    title: string;
    /** MIME type (e.g., "image/png", "application/pdf") */
    mimetype: string;
    /** File extension type */
    filetype: string;
    /** File size in bytes */
    size: number;
    /** Private download URL (requires authentication) */
    url_private?: string;
    /** Permanent link to the file */
    permalink?: string;
  }>;
  /** Edit history if the message was edited */
  edited?: {
    /** User ID who edited the message */
    user: string;
    /** Timestamp of the edit */
    ts: string;
  };
}

/**
 * Represents a user account in a Slack workspace.
 * Contains profile information, permissions, and metadata about the user.
 * @interface SlackUser
 */
export interface SlackUser {
  /** Unique user identifier */
  id: string;
  /** Workspace/team identifier */
  team_id: string;
  /** Unique username for mentions (@username) */
  name: string;
  /** Whether the account has been deactivated */
  deleted: boolean;
  /** Color hex code for displaying the user in UI */
  color?: string;
  /** User's full real name */
  real_name: string;
  /** User's timezone identifier (e.g., "America/New_York") */
  tz?: string;
  /** Human-readable timezone label */
  tz_label?: string;
  /** Timezone offset from UTC in seconds */
  tz_offset?: number;
  /** User's profile information */
  profile: {
    /** Hash of the avatar image */
    avatar_hash?: string;
    /** Current status text */
    status_text?: string;
    /** Current status emoji */
    status_emoji?: string;
    /** User's full real name */
    real_name: string;
    /** Preferred display name */
    display_name: string;
    /** Normalized version of real name */
    real_name_normalized: string;
    /** Normalized version of display name */
    display_name_normalized: string;
    /** User's email address */
    email?: string;
    /** URL to 24x24px avatar image */
    image_24?: string;
    /** URL to 32x32px avatar image */
    image_32?: string;
    /** URL to 48x48px avatar image */
    image_48?: string;
    /** URL to 72x72px avatar image */
    image_72?: string;
    /** URL to 192x192px avatar image */
    image_192?: string;
    /** URL to 512x512px avatar image */
    image_512?: string;
    /** Team/workspace identifier */
    team?: string;
    /** User's first name */
    first_name?: string;
    /** User's last name */
    last_name?: string;
    /** Job title */
    title?: string;
    /** Phone number */
    phone?: string;
    /** Skype username */
    skype?: string;
  };
  /** Whether the user is a workspace admin */
  is_admin: boolean;
  /** Whether the user is a workspace owner */
  is_owner: boolean;
  /** Whether the user is the primary workspace owner */
  is_primary_owner: boolean;
  /** Whether the user is a restricted (multi-channel guest) account */
  is_restricted: boolean;
  /** Whether the user is ultra-restricted (single-channel guest) */
  is_ultra_restricted: boolean;
  /** Whether this is a bot account */
  is_bot: boolean;
  /** Whether this is an app user (Slackbot, etc.) */
  is_app_user: boolean;
  /** Unix timestamp of last profile update */
  updated: number;
}

/**
 * Response from the Slack list channels API operation.
 * Returns lightweight channel identifiers for efficient querying (granular pattern).
 * @interface SlackListChannelsResponse
 */
export interface SlackListChannelsResponse {
  /** Array of channel basic info (ID, name, and privacy status) */
  channels: Array<{ id: string; name: string; is_private: boolean }>;
  /** Total number of channels returned */
  count: number;
}

/**
 * Response from the Slack get channel messages API operation.
 * Returns messages from a channel with pagination support.
 * @interface SlackGetChannelMessagesResponse
 */
export interface SlackGetChannelMessagesResponse {
  /** Array of messages from the channel */
  messages: SlackMessage[];
  /** Whether there are more messages to fetch */
  has_more: boolean;
  /** Pagination metadata */
  response_metadata?: {
    /** Cursor for fetching the next page of results */
    next_cursor?: string;
  };
}

// =============================================================================
// SharePoint Types
// =============================================================================

/**
 * Represents a file or folder item in SharePoint/OneDrive.
 * Drive items are the fundamental objects in Microsoft Graph for file storage.
 * @interface SharePointDriveItem
 */
export interface SharePointDriveItem {
  /** Unique identifier for the drive item */
  id: string;
  /** Name of the file or folder */
  name: string;
  /** Size in bytes (files only) */
  size?: number;
  /** ISO 8601 timestamp when the item was created */
  createdDateTime: string;
  /** ISO 8601 timestamp of last modification */
  lastModifiedDateTime: string;
  /** URL to view the item in SharePoint web interface */
  webUrl: string;
  /** User who created the item */
  createdBy?: {
    /** User information */
    user?: SharePointUser;
  };
  /** User who last modified the item */
  lastModifiedBy?: {
    /** User information */
    user?: SharePointUser;
  };
  /** Reference to the parent container */
  parentReference?: {
    /** Drive identifier */
    driveId: string;
    /** Type of drive (e.g., "business", "personal") */
    driveType: string;
    /** Parent folder ID */
    id: string;
    /** Full path to the parent folder */
    path: string;
  };
  /** File-specific metadata (present if item is a file) */
  file?: {
    /** MIME type (e.g., "application/pdf", "text/plain") */
    mimeType: string;
    /** File integrity hashes */
    hashes?: {
      /** Quick XOR hash for change detection */
      quickXorHash?: string;
      /** SHA-1 hash */
      sha1Hash?: string;
      /** SHA-256 hash */
      sha256Hash?: string;
    };
  };
  /** Folder-specific metadata (present if item is a folder) */
  folder?: {
    /** Number of child items */
    childCount: number;
  };
  /** Pre-authenticated download URL (temporary, expires) */
  '@microsoft.graph.downloadUrl'?: string;
}

/**
 * Represents a user in SharePoint/Microsoft 365.
 * Contains basic identity and contact information.
 * @interface SharePointUser
 */
export interface SharePointUser {
  /** Unique user identifier in Azure AD */
  id: string;
  /** User's display name */
  displayName: string;
  /** User's email address */
  email?: string;
  /** User Principal Name (UPN) for authentication */
  userPrincipalName?: string;
}

/**
 * Represents a SharePoint site collection.
 * Sites are top-level containers for document libraries, lists, and pages.
 * @interface SharePointSite
 */
export interface SharePointSite {
  /** Unique site identifier */
  id: string;
  /** Site name (URL-friendly) */
  name: string;
  /** Human-readable site title */
  displayName: string;
  /** URL to access the site in browser */
  webUrl: string;
  /** ISO 8601 timestamp when the site was created */
  createdDateTime: string;
  /** ISO 8601 timestamp of last modification */
  lastModifiedDateTime: string;
}

/**
 * Response from the SharePoint list files API operation.
 * Returns lightweight file identifiers for efficient querying (granular pattern).
 * @interface SharePointListFilesResponse
 */
export interface SharePointListFilesResponse {
  /** Array of file basic info (ID, name, and folder status) */
  files: Array<{ id: string; name: string; isFolder: boolean }>;
  /** Total number of files returned */
  count: number;
}

/**
 * Represents a simplified file or folder in SharePoint.
 * Used for lightweight file operations and listings.
 * @interface SharePointFile
 */
export interface SharePointFile {
  /** Unique file identifier */
  id: string;
  /** File or folder name */
  name: string;
  /** Full path to the file within the drive */
  path: string;
  /** Size in bytes (files only) */
  size?: number;
  /** ISO 8601 timestamp of last modification */
  lastModified?: string;
  /** Whether this is a folder (true) or file (false) */
  isFolder: boolean;
  /** URL to view the file in SharePoint web interface */
  webUrl?: string;
  /** MIME type for files (e.g., "application/pdf") */
  mimeType?: string;
}

// =============================================================================
// Common Types
// =============================================================================

/**
 * Represents pagination metadata for API responses.
 * Used across all services for consistent pagination handling.
 * @interface PaginationMeta
 */
export interface PaginationMeta {
  /** Total number of items available */
  total_count: number;
  /** Number of items skipped */
  offset: number;
  /** Maximum number of items per page */
  limit: number;
}

/**
 * Represents an error from an MCP service operation.
 * Provides structured error information with retry guidance.
 * @interface ServiceError
 */
export interface ServiceError {
  /** Error code for programmatic handling */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Whether the operation can be retried */
  retryable: boolean;
  /** Additional error details specific to the service */
  details?: Record<string, unknown>;
}

/**
 * Represents a standardized tool result wrapper for all MCP operations.
 * Provides consistent success/error handling with metadata across all services.
 * @interface ToolResult
 */
export interface ToolResult<T> {
  /** Whether the operation completed successfully */
  success: boolean;
  /** Result data (present if success is true) */
  data?: T;
  /** Error information (present if success is false) */
  error?: ServiceError;
  /** Execution metadata for debugging and monitoring */
  metadata?: {
    /** ISO 8601 timestamp when the operation was executed */
    timestamp: string;
    /** Execution time in milliseconds */
    executionMs: number;
    /** Name of the service that handled the operation */
    service: string;
  };
}
