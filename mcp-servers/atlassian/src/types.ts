/**
 * Atlassian MCP Worker types (hand-written DTOs). Jira Cloud REST v3 + Agile 1.0; Confluence Cloud REST v2 + v1 (CQL search, bulk labels).
 * @module mcp-atlassian/types
 */

/** Resolved Atlassian worker configuration, built from the read-only `/tokens` mount. */
export interface AtlassianConfig {
  /** Atlassian Cloud site base URL, e.g. `https://your-domain.atlassian.net`. */
  siteUrl: string;
  /** Account email used as the Basic-auth username. */
  email: string;
  /** Atlassian Cloud API token (Basic-auth password). Never logged or returned. */
  apiToken: string;
  /** Optional Jira project key allowlist; empty = unrestricted, non-matching keys rejected. */
  jiraProjectKeys: string[];
  /** Optional Confluence space key allowlist; empty = unrestricted, non-matching keys rejected. */
  confluenceSpaceKeys: string[];
}

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

/** Jira account (reporter/assignee/author), normalised. */
export interface JiraUser {
  account_id: string;
  name: string;
}

/** Compact reference to another issue: a parent or a link end. */
export interface JiraIssueRef {
  key: string;
  summary: string;
  status: string;
}

/** Parent of an issue: epic for a story, story for a sub-task. */
export interface JiraIssueParent extends JiraIssueRef {
  type: string;
}

/** Link between two issues; `relation` reads from the side of the issue that carries it. */
export interface JiraIssueLink {
  id: string;
  relation: string;
  issue: JiraIssueRef;
}

/** Jira issue link type with its two direction descriptions. */
export interface JiraLinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

/** Jira issue, normalised to the shape callers see. `description` is Markdown and absent in search results. */
export interface JiraIssue {
  key: string;
  id: string;
  web_url?: string;
  summary: string;
  description?: string;
  type: string;
  status: string;
  project: string;
  priority: string | null;
  labels: string[];
  components: string[];
  parent: JiraIssueParent | null;
  links: JiraIssueLink[];
  assignee: JiraUser | null;
  reporter: JiraUser | null;
  created: string;
  updated: string;
}

/** Caller input for creating an issue. `description` (Markdown) and `description_adf` are mutually exclusive. */
export interface CreateIssueInput {
  project: string;
  type: string;
  summary: string;
  description?: string;
  description_adf?: AdfDoc;
  priority?: string;
  labels?: string[];
  assignee?: string | null;
  parent?: string;
  components?: string[];
}

/** Caller input for updating an issue; omitted fields stay unchanged, `parent: null` detaches. */
export interface UpdateIssueInput {
  type?: string;
  summary?: string;
  description?: string;
  description_adf?: AdfDoc;
  priority?: string;
  labels?: string[];
  assignee?: string | null;
  parent?: string | null;
  components?: string[];
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
  /** `null` for `getChildren` results (re-fetch via `getPage` before an update). */
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
