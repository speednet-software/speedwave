/**
 * Atlassian MCP Worker — type definitions.
 *
 * DTOs are hand-written (no external SDK): only the fields Speedwave's tools
 * actually expose are modelled. Jira Cloud REST v3 + Agile 1.0; Confluence
 * Cloud REST v2 (spaces, pages, comments, label reads, attachments) plus v1 for
 * CQL search and bulk label-add (v2 has no equivalent for those two).
 * @module mcp-atlassian/types
 */

//═══════════════════════════════════════════════════════════════════════════════
// Configuration
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolved Atlassian worker configuration, built from the read-only `/tokens` mount.
 * @interface AtlassianConfig
 */
export interface AtlassianConfig {
  /** Atlassian Cloud site base URL, e.g. `https://your-domain.atlassian.net`. */
  siteUrl: string;
  /** Account email used as the Basic-auth username. */
  email: string;
  /** Atlassian Cloud API token (Basic-auth password). Never logged or returned. */
  apiToken: string;
  /**
   * Optional allowlist of Jira project keys. Empty = unrestricted.
   * When non-empty, operations whose project key is not in this list are rejected.
   */
  jiraProjectKeys: string[];
  /**
   * Optional allowlist of Confluence space keys. Empty = unrestricted.
   * When non-empty, operations whose space key is not in this list are rejected.
   */
  confluenceSpaceKeys: string[];
}

// ConnectionTestResult moved to @speedwave/mcp-shared (SSOT). Import directly
// from the shared package; this worker no longer defines its own variant.

//═══════════════════════════════════════════════════════════════════════════════
// Atlassian Document Format (minimal)
//═══════════════════════════════════════════════════════════════════════════════

/** A single ADF node (recursive). Only the subset Speedwave produces is typed. */
export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
}

/** Top-level Atlassian Document Format document. */
export interface AdfDoc {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}

//═══════════════════════════════════════════════════════════════════════════════
// Jira
//═══════════════════════════════════════════════════════════════════════════════

/** Jira account (reporter/assignee/author), normalised. */
export interface JiraUser {
  account_id: string;
  display_name: string;
  email_address?: string;
  active: boolean;
}

/** Jira issue, normalised to the fields Speedwave exposes. */
export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  /** `description` may be ADF (v3) — returned as-is so callers can render it. */
  description?: AdfDoc | string | null;
  status: string;
  issue_type: string;
  project_key: string;
  priority?: string;
  labels: string[];
  assignee?: JiraUser | null;
  reporter?: JiraUser | null;
  created: string;
  updated: string;
  /** Human `/browse/<key>` URL; absent if the API's `self` URL can't be parsed. */
  web_url?: string;
}

/** Result of an enhanced JQL search (`POST /rest/api/3/search/jql`). */
export interface JiraSearchResult {
  issues: JiraIssue[];
  /** Opaque cursor for the next page; absent on the last page. */
  next_page_token?: string | null;
  is_last: boolean;
}

/** Jira workflow transition available for an issue. */
export interface JiraTransition {
  id: string;
  name: string;
  to_status: string;
}

/** Jira issue comment, normalised. */
export interface JiraComment {
  id: string;
  /** Comment body may be ADF (v3). */
  body: AdfDoc | string;
  author?: JiraUser | null;
  created: string;
  updated: string;
}

/** Jira worklog entry, normalised. */
export interface JiraWorklog {
  id: string;
  issue_id: string;
  time_spent_seconds: number;
  comment?: AdfDoc | string | null;
  author?: JiraUser | null;
  started: string;
  created: string;
}

/** Jira project, normalised. */
export interface JiraProject {
  id: string;
  key: string;
  name: string;
  project_type_key?: string;
  lead?: JiraUser | null;
  url?: string;
}

/** Jira issue type metadata. */
export interface JiraIssueType {
  id: string;
  name: string;
  description?: string;
  subtask: boolean;
}

/** Jira issue attachment metadata, normalised. */
export interface JiraAttachment {
  id: string;
  filename: string;
  size?: number;
  mime_type?: string;
  created?: string;
  url?: string;
  author?: JiraUser | null;
}

//═══════════════════════════════════════════════════════════════════════════════
// Jira Agile (boards / sprints)
//═══════════════════════════════════════════════════════════════════════════════

/** Jira Agile board, normalised. */
export interface JiraBoard {
  id: number;
  name: string;
  type: string;
  /** Project key the board is associated with, when resolvable. */
  project_key?: string;
}

/** Jira Agile sprint, normalised. */
export interface JiraSprint {
  id: number;
  name: string;
  state: string;
  board_id?: number;
  goal?: string;
  start_date?: string;
  end_date?: string;
  complete_date?: string;
}

/** Jira Agile board configuration (filter + column statuses), normalised. */
export interface JiraBoardConfiguration {
  id: number;
  name: string;
  filter_id?: string;
  column_names: string[];
}

//═══════════════════════════════════════════════════════════════════════════════
// Confluence
//═══════════════════════════════════════════════════════════════════════════════

/** Confluence space, normalised (v2). */
export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type?: string;
  status?: string;
}

/** Confluence page, normalised (v2). */
export interface ConfluencePage {
  id: string;
  status: string;
  title: string;
  space_id: string;
  /** Space key, resolved for scope-guard checks; may be absent if not resolvable. */
  space_key?: string;
  parent_id?: string | null;
  /**
   * Current version number. `null` when not known — child pages returned by
   * `getChildren` don't carry a version, so it must be re-fetched (via `getPage`)
   * before an update. A full page (from `getPage`/`createPage`/`updatePage`)
   * always has a `number`.
   */
  version: number | null;
  /** Storage-representation body, when requested. */
  body_storage?: string;
  web_url?: string;
}

/** Confluence footer comment on a page, normalised (v2). */
export interface ConfluenceComment {
  id: string;
  page_id: string;
  body_storage: string;
  version: number;
  created_at?: string;
}

/** Confluence content label, normalised (v2). */
export interface ConfluenceLabel {
  id: string;
  name: string;
  prefix?: string;
}

/** Confluence attachment metadata, normalised (v2). */
export interface ConfluenceAttachment {
  id: string;
  title: string;
  media_type?: string;
  file_size?: number;
  page_id: string;
  download_url?: string;
}
