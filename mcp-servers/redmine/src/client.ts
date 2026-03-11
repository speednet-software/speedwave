/**
 * Redmine API Client
 *
 * Isolated Redmine client for mcp-redmine worker.
 * ONLY has access to Redmine API key - no other service tokens.
 *
 * Security:
 * - API key read from /tokens/ (RO mount)
 * - API key NEVER exposed in responses
 * - Blast radius containment: only Redmine exposed if compromised
 *
 * Error Handling Convention:
 * - Factory functions (initializeRedmineClient) return null on config failures (graceful degradation)
 * - Instance methods throw errors on API failures
 */

import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { TIMEOUTS, ts } from '@speedwave/mcp-shared';

//═══════════════════════════════════════════════════════════════════════════════
// Axios Retry Config Extension
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Extended Axios request configuration with retry counter.
 * @interface RetryConfig
 * @augments {InternalAxiosRequestConfig}
 */
interface RetryConfig extends InternalAxiosRequestConfig {
  /**
   * Number of retry attempts made for this request.
   */
  __retryCount?: number;
}

//═══════════════════════════════════════════════════════════════════════════════
// Types
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Redmine client configuration.
 * @interface RedmineConfig
 */
export interface RedmineConfig {
  /**
   * Base URL of the Redmine instance.
   */
  url: string;
  /**
   * API key for authentication.
   */
  apiKey: string;
}

/**
 * Mappings for friendly names to Redmine IDs.
 * Allows users to reference status, priority, tracker, and activity by name instead of numeric ID.
 * @interface RedmineMappings
 */
export interface RedmineMappings {
  /**
   * Status ID for "New" status.
   */
  status_new?: number;
  /**
   * Status ID for "In Progress" status.
   */
  status_in_progress?: number;
  /**
   * Status ID for "Resolved" status.
   */
  status_resolved?: number;
  /**
   * Status ID for "Feedback" status.
   */
  status_feedback?: number;
  /**
   * Status ID for "Closed" status.
   */
  status_closed?: number;
  /**
   * Status ID for "Rejected" status.
   */
  status_rejected?: number;
  /**
   * Priority ID for "Low" priority.
   */
  priority_low?: number;
  /**
   * Priority ID for "Normal" priority.
   */
  priority_normal?: number;
  /**
   * Priority ID for "High" priority.
   */
  priority_high?: number;
  /**
   * Priority ID for "Urgent" priority.
   */
  priority_urgent?: number;
  /**
   * Priority ID for "Immediate" priority.
   */
  priority_immediate?: number;
  /**
   * Tracker ID for "Bug" tracker.
   */
  tracker_bug?: number;
  /**
   * Tracker ID for "Feature" tracker.
   */
  tracker_feature?: number;
  /**
   * Tracker ID for "Task" tracker.
   */
  tracker_task?: number;
  /**
   * Tracker ID for "Support" tracker.
   */
  tracker_support?: number;
  /**
   * Activity ID for "Design" activity.
   */
  activity_design?: number;
  /**
   * Activity ID for "Development" activity.
   */
  activity_development?: number;
  /**
   * Activity ID for "Testing" activity.
   */
  activity_testing?: number;
  /**
   * Activity ID for "Documentation" activity.
   */
  activity_documentation?: number;
  /**
   * Activity ID for "Support" activity.
   */
  activity_support?: number;
  /**
   * Activity ID for "Management" activity.
   */
  activity_management?: number;
  /**
   * Activity ID for "DevOps" activity.
   */
  activity_devops?: number;
  /**
   * Activity ID for "Review" activity.
   */
  activity_review?: number;
  /**
   * Index signature to allow custom mapping keys.
   */
  [key: string]: number | undefined;
}

/**
 * Redmine project configuration from /tokens/config.json.
 * Flat structure — no nested integrations.tracker or redmine keys.
 * @interface RedmineProjectConfig
 */
export interface RedmineProjectConfig {
  /**
   * Redmine instance URL.
   */
  host_url: string;
  /**
   * Default project identifier.
   */
  project_id?: string;
  /**
   * Project display name.
   */
  project_name?: string;
  /**
   * ID mappings for status, priority, tracker, activity.
   */
  mappings?: RedmineMappings;
}

/**
 * Redmine issue object.
 * @interface RedmineIssue
 */
export interface RedmineIssue {
  /**
   * Issue ID.
   */
  id: number;
  /**
   * Project the issue belongs to.
   */
  project: { id: number; name: string };
  /**
   * Issue tracker (Bug, Feature, Task, etc.).
   */
  tracker: { id: number; name: string };
  /**
   * Issue status (New, In Progress, Closed, etc.).
   */
  status: { id: number; name: string };
  /**
   * Issue priority (Low, Normal, High, etc.).
   */
  priority: { id: number; name: string };
  /**
   * Issue author.
   */
  author: { id: number; name: string };
  /**
   * Assigned user (optional).
   */
  assigned_to?: { id: number; name: string };
  /**
   * Issue title/subject.
   */
  subject: string;
  /**
   * Issue description in Textile markup.
   */
  description?: string;
  /**
   * Start date (YYYY-MM-DD format).
   */
  start_date?: string;
  /**
   * Due date (YYYY-MM-DD format).
   */
  due_date?: string;
  /**
   * Completion percentage (0-100).
   */
  done_ratio?: number;
  /**
   * Estimated hours for completion.
   */
  estimated_hours?: number;
  /**
   * Total hours spent on this issue.
   */
  spent_hours?: number;
  /**
   * Parent issue (for subtasks).
   */
  parent?: { id: number };
  /**
   * Child issues (subtasks).
   */
  children?: Array<{ id: number; subject: string }>;
  /**
   * Creation timestamp.
   */
  created_on: string;
  /**
   * Last update timestamp.
   */
  updated_on: string;
  /**
   * Issue journals (comments and change history).
   */
  journals?: RedmineJournal[];
  /**
   * Issue relations (links to other issues).
   */
  relations?: Array<{
    id: number;
    issue_id: number;
    issue_to_id: number;
    relation_type: string;
    delay?: number;
  }>;
  /**
   * Issue watchers (users watching this issue).
   */
  watchers?: Array<{
    id: number;
    name: string;
  }>;
  /**
   * Issue attachments (uploaded files).
   */
  attachments?: Array<{
    id: number;
    filename: string;
    filesize: number;
    content_type: string;
    description?: string;
    content_url: string;
    author: { id: number; name: string };
    created_on: string;
  }>;
}

/**
 * Redmine journal entry (comment or change history).
 * @interface RedmineJournal
 */
export interface RedmineJournal {
  /**
   * Journal entry ID.
   */
  id: number;
  /**
   * User who created this journal entry.
   */
  user: { id: number; name: string };
  /**
   * Comment text (optional).
   */
  notes?: string;
  /**
   * Creation timestamp.
   */
  created_on: string;
  /**
   * Whether this is a private note.
   */
  private_notes?: boolean;
  /**
   * Change details (field modifications).
   */
  details: Array<{
    /**
     * Property type (e.g., "attr", "cf", "attachment").
     */
    property: string;
    /**
     * Field name that was changed.
     */
    name: string;
    /**
     * Previous value.
     */
    old_value?: string;
    /**
     * New value.
     */
    new_value?: string;
  }>;
}

/**
 * Redmine time entry (time log).
 * @interface RedmineTimeEntry
 */
export interface RedmineTimeEntry {
  /**
   * Time entry ID.
   */
  id: number;
  /**
   * Project the time was logged against.
   */
  project: { id: number; name: string };
  /**
   * Issue the time was logged against (optional).
   */
  issue?: { id: number };
  /**
   * User who logged the time.
   */
  user: { id: number; name: string };
  /**
   * Activity type (Development, Testing, etc.).
   */
  activity: { id: number; name: string };
  /**
   * Hours logged.
   */
  hours: number;
  /**
   * Time entry comments.
   */
  comments?: string;
  /**
   * Date when the time was spent (YYYY-MM-DD format).
   */
  spent_on: string;
  /**
   * Creation timestamp.
   */
  created_on: string;
  /**
   * Last update timestamp.
   */
  updated_on: string;
}

/**
 * Redmine user object.
 * @interface RedmineUser
 */
export interface RedmineUser {
  /**
   * User ID.
   */
  id: number;
  /**
   * Login username.
   */
  login: string;
  /**
   * First name.
   */
  firstname: string;
  /**
   * Last name.
   */
  lastname: string;
  /**
   * Email address (optional).
   */
  mail?: string;
  /**
   * Account creation timestamp.
   */
  created_on: string;
  /**
   * Last update timestamp.
   */
  updated_on: string;
}

/**
 * Redmine project object.
 * @interface RedmineProject
 */
export interface RedmineProject {
  /**
   * Project ID.
   */
  id: number;
  /**
   * Project name.
   */
  name: string;
  /**
   * Project identifier (slug).
   */
  identifier: string;
  /**
   * Project description.
   */
  description?: string;
  /**
   * Project status (1=active, 5=archived, 9=closed).
   */
  status: number;
  /**
   * Whether project is public.
   */
  is_public: boolean;
  /**
   * Parent project (for subprojects).
   */
  parent?: { id: number; name: string };
  /**
   * Creation timestamp.
   */
  created_on: string;
  /**
   * Last update timestamp.
   */
  updated_on: string;
  /**
   * Project homepage URL.
   */
  homepage?: string;
  /**
   * Custom fields.
   */
  custom_fields?: Array<{ id: number; name: string; value: string | string[] }>;
  /**
   * Available trackers.
   */
  trackers?: Array<{ id: number; name: string }>;
  /**
   * Issue categories.
   */
  issue_categories?: Array<{ id: number; name: string }>;
  /**
   * Enabled modules.
   */
  enabled_modules?: Array<{ id: number; name: string }>;
  /**
   * Time entry activities.
   */
  time_entry_activities?: Array<{ id: number; name: string; is_default?: boolean }>;
}

//═══════════════════════════════════════════════════════════════════════════════
// Payload Types for API requests
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Redmine relation type defining valid relationship kinds between issues.
 */
export type RelationType =
  | 'relates'
  | 'duplicates'
  | 'duplicated'
  | 'blocks'
  | 'blocked'
  | 'precedes'
  | 'follows'
  | 'copied_to'
  | 'copied_from';

/**
 * Redmine issue relation object.
 * @interface IssueRelation
 */
export interface IssueRelation {
  /**
   * Relation ID.
   */
  id: number;
  /**
   * Source issue ID.
   */
  issue_id: number;
  /**
   * Target issue ID.
   */
  issue_to_id: number;
  /**
   * Type of relation (relates, blocks, precedes, etc.).
   */
  relation_type: RelationType;
  /**
   * Delay in days (only for precedes/follows relations).
   */
  delay?: number;
}

/**
 * Payload for creating or updating an issue.
 * @interface IssuePayload
 */
interface IssuePayload {
  /**
   * Project identifier.
   */
  project_id: string;
  /**
   * Issue subject/title.
   */
  subject: string;
  /**
   * Issue description.
   */
  description?: string;
  /**
   * Tracker ID.
   */
  tracker_id?: number;
  /**
   * Status ID.
   */
  status_id?: number;
  /**
   * Priority ID.
   */
  priority_id?: number;
  /**
   * Assigned user ID.
   */
  assigned_to_id?: number;
  /**
   * Parent issue ID (for subtasks).
   */
  parent_issue_id?: number;
  /**
   * Estimated hours.
   */
  estimated_hours?: number;
  /**
   * Update notes/comment.
   */
  notes?: string;
}

/**
 * Payload for creating or updating a time entry.
 * @interface TimeEntryPayload
 */
interface TimeEntryPayload {
  /**
   * Hours to log.
   */
  hours: number;
  /**
   * Issue ID (optional if project_id is provided).
   */
  issue_id?: number;
  /**
   * Project ID (optional if issue_id is provided).
   */
  project_id?: string;
  /**
   * Activity ID.
   */
  activity_id?: number;
  /**
   * Time entry comments.
   */
  comments?: string;
  /**
   * Date when time was spent (YYYY-MM-DD format).
   */
  spent_on?: string;
}

//═══════════════════════════════════════════════════════════════════════════════
// Token Loading
//═══════════════════════════════════════════════════════════════════════════════

const TOKENS_DIR = process.env.TOKENS_DIR || '/tokens';

/**
 * Load Redmine API key from tokens directory.
 * @returns Promise resolving to the API key string.
 * @throws {Error} When token file cannot be read.
 */
async function loadApiKey(): Promise<string> {
  const tokenPath = path.join(TOKENS_DIR, 'api_key');
  const token = await fs.readFile(tokenPath, 'utf-8');
  return token.trim();
}

/**
 * Load Redmine project configuration from /tokens/config.json.
 * @returns Promise resolving to the project configuration, or null if not found/invalid.
 */
async function loadRedmineConfig(): Promise<RedmineProjectConfig | null> {
  try {
    const configData = await fs.readFile(`${TOKENS_DIR}/config.json`, 'utf-8');
    return JSON.parse(configData);
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.warn(`${ts()} Invalid JSON in /tokens/config.json: ${error.message}`);
    } else if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`${ts()} Failed to read /tokens/config.json: ${error}`);
    }
    return null;
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Input Validation
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Sanitize Textile markup to remove potentially dangerous content.
 * Removes script tags, iframes, objects, embeds, and javascript: protocols.
 * @param textile - The Textile markup to sanitize.
 * @returns Sanitized Textile markup.
 */
function sanitizeTextile(textile: string): string {
  return textile
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    .replace(/<iframe[^>]*>.*?<\/iframe>/gi, '')
    .replace(/<object[^>]*>.*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/javascript:/gi, '');
}

//═══════════════════════════════════════════════════════════════════════════════
// Client Class
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Redmine API client.
 * Provides methods for interacting with Redmine issues, time entries, journals, users, and projects.
 * @class RedmineClient
 */
export class RedmineClient {
  private client: AxiosInstance;
  private config: RedmineConfig;
  private mappings: RedmineMappings;
  private projectConfig: RedmineProjectConfig | null;

  /**
   * Create a new Redmine client instance.
   * @param config - Redmine configuration (URL and API key).
   * @param projectConfig - Project configuration from /tokens/config.json.
   */
  constructor(config: RedmineConfig, projectConfig: RedmineProjectConfig | null = null) {
    this.config = config;
    this.mappings = projectConfig?.mappings ?? {};
    this.projectConfig = projectConfig;

    this.client = axios.create({
      baseURL: config.url,
      timeout: TIMEOUTS.API_CALL_MS,
      headers: {
        'X-Redmine-API-Key': config.apiKey,
        'Content-Type': 'application/json',
      },
    });

    // Add retry interceptor
    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const config = error.config as RetryConfig | undefined;
        if (!config || (config.__retryCount ?? 0) >= 3) {
          return Promise.reject(error);
        }

        config.__retryCount = (config.__retryCount ?? 0) + 1;

        const delay = Math.pow(2, config.__retryCount) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));

        return this.client(config);
      }
    );
  }

  /**
   * Get ID mappings for status, priority, tracker, and activity.
   * @returns The mappings object.
   */
  getMappings(): RedmineMappings {
    return this.mappings;
  }

  /**
   * Get project configuration.
   * @returns Configuration object with project_id, project_name, and URL.
   */
  getConfig(): { project_id?: string; project_name?: string; url: string } {
    return {
      project_id: this.projectConfig?.project_id,
      project_name: this.projectConfig?.project_name,
      url: this.config.url,
    };
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Issue Operations
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * List issues from Redmine with optional filtering.
   * @param options - Filter and pagination options.
   * @param options.project_id - Filter by project identifier.
   * @param options.assigned_to_id - Filter by assignee ('me', user ID, or username).
   * @param options.status_id - Filter by status ('open', 'closed', '*', or status ID).
   * @param options.parent_id - Filter by parent issue ID.
   * @param options.limit - Maximum number of results (default 25).
   * @param options.offset - Pagination offset (default 0).
   * @returns Promise resolving to object with issues array and total_count.
   * @throws {Error} When API request fails.
   */
  async listIssues(
    options: {
      project_id?: string;
      assigned_to_id?: string | number;
      status_id?: string;
      parent_id?: number;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ issues: RedmineIssue[]; total_count: number }> {
    const params: Record<string, string | number> = {
      limit: options.limit || 25,
      offset: options.offset || 0,
    };

    if (options.project_id) params.project_id = options.project_id;
    if (options.assigned_to_id) params.assigned_to_id = options.assigned_to_id;
    if (options.status_id) params.status_id = options.status_id;
    if (options.parent_id) params.parent_id = options.parent_id;

    const response = await this.client.get('/issues.json', { params });
    return response.data;
  }

  /**
   * Get a single issue by ID with full details.
   * @param issueId - The issue ID.
   * @param options - Options for including additional data.
   * @param options.include - Array of additional data to include (journals, attachments, relations, children, watchers).
   * @returns Promise resolving to the Redmine issue.
   * @throws {Error} When API request fails or issue not found.
   */
  async showIssue(issueId: number, options: { include?: string[] } = {}): Promise<RedmineIssue> {
    const params: Record<string, string> = {};
    if (options.include && options.include.length > 0) {
      params.include = options.include.join(',');
    }

    const response = await this.client.get(`/issues/${issueId}.json`, { params });
    return response.data.issue;
  }

  /**
   * Search issues by text query.
   * @param query - Search query string.
   * @param options - Search options.
   * @param options.project_id - Limit search to specific project.
   * @param options.limit - Maximum number of results (default 25).
   * @returns Promise resolving to search results with IDs and total_count.
   * @throws {Error} When API request fails.
   */
  async searchIssues(
    query: string,
    options: {
      project_id?: string;
      limit?: number;
    } = {}
  ): Promise<{ results: Array<{ id: number; type: string; title: string }>; total_count: number }> {
    const params: Record<string, string | number> = {
      q: query,
      issues: 1,
      limit: options.limit || 25,
    };

    if (options.project_id) {
      params.scope = `project:${options.project_id}`;
    }

    const response = await this.client.get('/search.json', { params });
    return response.data;
  }

  /**
   * Create a new issue in Redmine.
   * @param options - Issue creation options.
   * @param options.project_id - Project identifier (required).
   * @param options.subject - Issue subject/title (required).
   * @param options.description - Issue description in Textile markup.
   * @param options.tracker_id - Tracker ID (Bug, Feature, Task, etc.).
   * @param options.status_id - Status ID.
   * @param options.priority_id - Priority ID.
   * @param options.assigned_to_id - Assigned user ID.
   * @param options.parent_issue_id - Parent issue ID (for subtasks).
   * @param options.estimated_hours - Estimated hours for completion.
   * @returns Promise resolving to the created issue.
   * @throws {Error} When subject is empty or API request fails.
   */
  async createIssue(options: {
    project_id: string;
    subject: string;
    description?: string;
    tracker_id?: number;
    status_id?: number;
    priority_id?: number;
    assigned_to_id?: number;
    parent_issue_id?: number;
    estimated_hours?: number;
  }): Promise<RedmineIssue> {
    const trimmedSubject = options.subject.trim();
    if (!trimmedSubject) {
      throw new Error('Subject cannot be empty');
    }

    const issue: IssuePayload = {
      project_id: options.project_id,
      subject: trimmedSubject,
    };

    if (options.description) {
      issue.description = sanitizeTextile(options.description);
    }
    if (options.tracker_id) issue.tracker_id = options.tracker_id;
    if (options.status_id) issue.status_id = options.status_id;
    if (options.priority_id) issue.priority_id = options.priority_id;
    if (options.assigned_to_id) issue.assigned_to_id = options.assigned_to_id;
    if (options.parent_issue_id) issue.parent_issue_id = options.parent_issue_id;
    if (options.estimated_hours) issue.estimated_hours = options.estimated_hours;

    const response = await this.client.post('/issues.json', { issue });
    return response.data.issue;
  }

  /**
   * Update an existing issue in Redmine.
   * @param issueId - The issue ID to update.
   * @param options - Update options (all optional).
   * @param options.project_id - Move issue to another project.
   * @param options.subject - New issue subject/title.
   * @param options.description - New issue description in Textile markup.
   * @param options.tracker_id - New tracker ID.
   * @param options.status_id - New status ID.
   * @param options.priority_id - New priority ID.
   * @param options.assigned_to_id - New assigned user ID.
   * @param options.parent_issue_id - New parent issue ID.
   * @param options.estimated_hours - New estimated hours.
   * @param options.notes - Update notes/comment.
   * @returns Promise resolving to the updated issue.
   * @throws {Error} When API request fails.
   */
  async updateIssue(
    issueId: number,
    options: {
      project_id?: string;
      subject?: string;
      description?: string;
      tracker_id?: number;
      status_id?: number;
      priority_id?: number;
      assigned_to_id?: number;
      parent_issue_id?: number;
      estimated_hours?: number;
      notes?: string;
    }
  ): Promise<RedmineIssue> {
    const issue: Partial<IssuePayload> = {};

    if (options.project_id) issue.project_id = options.project_id;
    if (options.subject) issue.subject = options.subject.trim();
    if (options.description !== undefined) {
      issue.description = sanitizeTextile(options.description);
    }
    if (options.tracker_id) issue.tracker_id = options.tracker_id;
    if (options.status_id) issue.status_id = options.status_id;
    if (options.priority_id) issue.priority_id = options.priority_id;
    if (options.assigned_to_id !== undefined) issue.assigned_to_id = options.assigned_to_id;
    if (options.parent_issue_id !== undefined) issue.parent_issue_id = options.parent_issue_id;
    if (options.estimated_hours !== undefined) issue.estimated_hours = options.estimated_hours;
    if (options.notes) issue.notes = sanitizeTextile(options.notes);

    await this.client.put(`/issues/${issueId}.json`, { issue });

    // Return updated issue to allow verification of changes.
    // Note: Redmine API is synchronous, so the returned data should reflect
    // the update. However, if verification fails, the caller should check
    // if the issue status allows the requested change (e.g., closed issues
    // may silently reject assignment changes).
    return this.showIssue(issueId);
  }

  /**
   * Add a comment to an issue.
   * @param issueId - The issue ID.
   * @param comment - Comment text in Textile markup.
   * @returns Promise that resolves when comment is added.
   * @throws {Error} When API request fails.
   */
  async commentIssue(issueId: number, comment: string): Promise<void> {
    await this.client.put(`/issues/${issueId}.json`, {
      issue: { notes: sanitizeTextile(comment) },
    });
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Time Entry Operations
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * List time entries with optional filtering.
   * @param options - Filter options.
   * @param options.issue_id - Filter by issue ID.
   * @param options.project_id - Filter by project ID.
   * @param options.user_id - Filter by user ID.
   * @param options.from - From date (YYYY-MM-DD format).
   * @param options.to - To date (YYYY-MM-DD format).
   * @param options.limit - Maximum number of results (default 25).
   * @returns Promise resolving to object with time_entries array and total_count.
   * @throws {Error} When API request fails.
   */
  async listTimeEntries(
    options: {
      issue_id?: number;
      project_id?: string;
      user_id?: number;
      from?: string;
      to?: string;
      limit?: number;
    } = {}
  ): Promise<{ time_entries: RedmineTimeEntry[]; total_count: number }> {
    const params: Record<string, string | number> = {
      limit: options.limit || 25,
    };

    if (options.issue_id) params.issue_id = options.issue_id;
    if (options.project_id) params.project_id = options.project_id;
    if (options.user_id) params.user_id = options.user_id;
    if (options.from) params.from = options.from;
    if (options.to) params.to = options.to;

    const response = await this.client.get('/time_entries.json', { params });
    return response.data;
  }

  /**
   * Create a new time entry (log time).
   * @param options - Time entry options.
   * @param options.issue_id - Issue ID (required if project_id not provided).
   * @param options.project_id - Project ID (required if issue_id not provided).
   * @param options.hours - Hours spent (required).
   * @param options.activity_id - Activity ID (Development, Testing, etc.).
   * @param options.comments - Time entry comments.
   * @param options.spent_on - Date when time was spent (YYYY-MM-DD format, default today).
   * @returns Promise resolving to the created time entry.
   * @throws {Error} When API request fails.
   */
  async createTimeEntry(options: {
    issue_id?: number;
    project_id?: string;
    hours: number;
    activity_id?: number;
    comments?: string;
    spent_on?: string;
  }): Promise<RedmineTimeEntry> {
    const time_entry: TimeEntryPayload = { hours: options.hours };

    if (options.issue_id) time_entry.issue_id = options.issue_id;
    if (options.project_id) time_entry.project_id = options.project_id;
    if (options.activity_id) time_entry.activity_id = options.activity_id;
    if (options.comments) time_entry.comments = options.comments;
    if (options.spent_on) time_entry.spent_on = options.spent_on;

    const response = await this.client.post('/time_entries.json', { time_entry });
    return response.data.time_entry;
  }

  /**
   * Update an existing time entry.
   * @param timeEntryId - The time entry ID to update.
   * @param options - Update options (all optional).
   * @param options.hours - New hours value.
   * @param options.activity_id - New activity ID.
   * @param options.comments - New comments.
   * @returns Promise that resolves when update is complete.
   * @throws {Error} When API request fails.
   */
  async updateTimeEntry(
    timeEntryId: number,
    options: {
      hours?: number;
      activity_id?: number;
      comments?: string;
    }
  ): Promise<void> {
    const time_entry: Partial<TimeEntryPayload> = {};

    if (options.hours !== undefined) time_entry.hours = options.hours;
    if (options.activity_id) time_entry.activity_id = options.activity_id;
    if (options.comments !== undefined) time_entry.comments = options.comments;

    await this.client.put(`/time_entries/${timeEntryId}.json`, { time_entry });
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Journal Operations
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * List all journals (comments and change history) for an issue.
   * @param issueId - The issue ID.
   * @returns Promise resolving to array of journal entries.
   * @throws {Error} When API request fails or issue not found.
   */
  async listJournals(issueId: number): Promise<RedmineJournal[]> {
    const issue = await this.showIssue(issueId, { include: ['journals'] });
    return issue.journals || [];
  }

  /**
   * Update an existing journal entry.
   * @param issueId - The issue ID.
   * @param journalId - The journal entry ID to update.
   * @param notes - New notes text in Textile markup.
   * @returns Promise that resolves when update is complete.
   * @throws {Error} When API request fails.
   */
  async updateJournal(issueId: number, journalId: number, notes: string): Promise<void> {
    await this.client.put(`/issues/${issueId}/journals/${journalId}.json`, {
      journal: { notes: sanitizeTextile(notes) },
    });
  }

  /**
   * Delete a journal entry.
   * @param issueId - The issue ID.
   * @param journalId - The journal entry ID to delete.
   * @returns Promise that resolves when deletion is complete.
   * @throws {Error} When API request fails.
   */
  async deleteJournal(issueId: number, journalId: number): Promise<void> {
    await this.client.delete(`/issues/${issueId}/journals/${journalId}.json`);
  }

  //═════════════════════════════════════════════════════════════════════════════
  // User Operations
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Get the current authenticated user's profile.
   * @returns Promise resolving to the current user's data.
   * @throws {Error} When API request fails or authentication is invalid.
   */
  async getCurrentUser(): Promise<RedmineUser> {
    const response = await this.client.get('/users/current.json');
    return response.data.user;
  }

  /**
   * List users, optionally filtered by project membership.
   * @param projectId - Optional project ID to filter users by membership.
   * @returns Promise resolving to array of users.
   * @throws {Error} When API request fails.
   */
  async listUsers(projectId?: string): Promise<RedmineUser[]> {
    if (projectId) {
      const response = await this.client.get(`/projects/${projectId}/memberships.json`);
      return response.data.memberships.map((m: { user: RedmineUser }) => m.user);
    }
    const response = await this.client.get('/users.json');
    return response.data.users;
  }

  /**
   * Resolve a user identifier to a user ID.
   * Supports 'me' (current user), numeric ID string, or username.
   * @param identifier - User identifier ('me', user ID, or username).
   * @returns Promise resolving to user ID or null if not found.
   * @throws {Error} When API request fails.
   */
  async resolveUser(identifier: string): Promise<number | null> {
    if (identifier === 'me') {
      const user = await this.getCurrentUser();
      return user.id;
    }

    if (/^\d+$/.test(identifier)) {
      return parseInt(identifier, 10);
    }

    const response = await this.client.get('/users.json', {
      params: { name: identifier },
    });

    if (response.data.users && response.data.users.length > 0) {
      return response.data.users[0].id;
    }

    return null;
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Project Operations
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * List projects with optional filtering and pagination.
   * @param options - Filter and pagination options.
   * @param options.status - Project status filter ('active', 'closed', 'archived', 'all').
   * @param options.limit - Maximum number of results (default 100).
   * @param options.offset - Pagination offset (default 0).
   * @returns Promise resolving to object with projects array and total_count.
   * @throws {Error} When API request fails.
   */
  async listProjects(
    options: {
      status?: 'active' | 'closed' | 'archived' | 'all';
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ projects: RedmineProject[]; total_count: number }> {
    const params: Record<string, number> = {
      limit: options.limit || 100,
      offset: options.offset || 0,
    };

    const response = await this.client.get('/projects.json', { params });
    let projects = response.data.projects as RedmineProject[];

    // Filter by status (Redmine API doesn't support status parameter)
    if (options.status && options.status !== 'all') {
      const statusMap: Record<string, number> = { active: 1, closed: 9, archived: 5 };
      const statusValue = statusMap[options.status];
      if (statusValue !== undefined) {
        projects = projects.filter((p: RedmineProject) => p.status === statusValue);
      }
    }

    return { projects, total_count: response.data.total_count };
  }

  /**
   * Get a single project by ID or identifier with full details.
   * @param projectId - Project ID (numeric) or identifier (string slug).
   * @param options - Options for including additional data.
   * @param options.include - Array of additional data to include (trackers, issue_categories, enabled_modules, time_entry_activities, issue_custom_fields).
   * @returns Promise resolving to the Redmine project.
   * @throws {Error} When API request fails or project not found.
   */
  async showProject(
    projectId: string | number,
    options: {
      include?: string[];
    } = {}
  ): Promise<RedmineProject> {
    const params: Record<string, string> = {};

    if (options.include && options.include.length > 0) {
      params.include = options.include.join(',');
    }

    const response = await this.client.get(`/projects/${projectId}.json`, { params });
    return response.data.project;
  }

  /**
   * Search projects by text query (name, identifier, or description).
   * @param query - Search query string.
   * @param options - Search options.
   * @param options.limit - Maximum number of results (default 25).
   * @returns Promise resolving to object with matching projects and total_count.
   * @throws {Error} When API request fails.
   */
  async searchProjects(
    query: string,
    options: {
      limit?: number;
    } = {}
  ): Promise<{
    projects: Array<{ id: number; identifier: string; name: string }>;
    total_count: number;
  }> {
    const queryLower = query.toLowerCase();

    const response = await this.client.get('/projects.json', {
      params: { limit: 100 },
    });

    const allProjects = response.data.projects as RedmineProject[];

    // Filter by name, identifier or description
    const matched = allProjects.filter(
      (p: RedmineProject) =>
        p.name.toLowerCase().includes(queryLower) ||
        p.identifier.toLowerCase().includes(queryLower) ||
        (p.description && p.description.toLowerCase().includes(queryLower))
    );

    const limited = matched.slice(0, options.limit || 25);

    return {
      projects: limited.map((p: RedmineProject) => ({
        id: p.id,
        identifier: p.identifier,
        name: p.name,
      })),
      total_count: matched.length,
    };
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Relation Operations
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * List all relations for a specific issue.
   * @param issueId - The issue ID.
   * @returns Promise resolving to object with relations array.
   * @throws {Error} When API request fails.
   */
  async listRelations(issueId: number): Promise<{ relations: IssueRelation[] }> {
    const response = await this.client.get(`/issues/${issueId}/relations.json`);
    return { relations: response.data.relations || [] };
  }

  /**
   * Create a relation between two issues.
   * @param options - Relation creation options.
   * @param options.issue_id - Source issue ID (required).
   * @param options.issue_to_id - Target issue ID (required).
   * @param options.relation_type - Type of relation (default: 'relates').
   * @param options.delay - Delay in days (only for precedes/follows).
   * @returns Promise resolving to the created relation.
   * @throws {Error} When API request fails or validation error.
   */
  async createRelation(options: {
    issue_id: number;
    issue_to_id: number;
    relation_type?: RelationType;
    delay?: number;
  }): Promise<{ relation: IssueRelation }> {
    const relation: { issue_to_id: number; relation_type?: string; delay?: number } = {
      issue_to_id: options.issue_to_id,
    };

    if (options.relation_type) {
      relation.relation_type = options.relation_type;
    }
    if (options.delay !== undefined) {
      relation.delay = options.delay;
    }

    const response = await this.client.post(`/issues/${options.issue_id}/relations.json`, {
      relation,
    });
    return { relation: response.data.relation };
  }

  /**
   * Delete a relation by ID.
   * @param relationId - The relation ID to delete.
   * @returns Promise that resolves when deletion is complete.
   * @throws {Error} When API request fails or relation not found.
   */
  async deleteRelation(relationId: number): Promise<void> {
    await this.client.delete(`/relations/${relationId}.json`);
  }

  //═════════════════════════════════════════════════════════════════════════════
  // Error Handling
  //═════════════════════════════════════════════════════════════════════════════

  /**
   * Format error objects into user-friendly error messages.
   * Handles Axios errors with appropriate HTTP status code messages.
   * @param error - The error object to format.
   * @returns Formatted error message string.
   */
  static formatError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      if (axiosError.response) {
        const status = axiosError.response.status;
        const data = axiosError.response.data as { errors?: unknown };

        if (status === 401)
          return 'Authentication failed. Check your Redmine API key. Run: speedwave setup redmine';
        if (status === 403)
          return 'Permission denied. Your Redmine API key may not have sufficient permissions.';
        if (status === 404) return 'Resource not found in Redmine.';
        if (status === 422 && data?.errors)
          return `Validation error: ${JSON.stringify(data.errors)}`;
        if (data?.errors) return `Error: ${JSON.stringify(data.errors)}`;

        return `HTTP ${status}: ${axiosError.message}`;
      }
      if (axiosError.request) {
        return 'Network error. Check your Redmine URL.';
      }
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown error';
  }
}

//═══════════════════════════════════════════════════════════════════════════════
// Client Factory
//═══════════════════════════════════════════════════════════════════════════════

/**
 * IMPORTANT: Returns null (not throws) when tokens are missing or invalid.
 * This enables "graceful degradation" - server starts even without config:
 * - User can run `speedwave up` without configuring all integrations
 * - Healthcheck reports `configured: false` for unconfigured services
 * - Tools return clear "not configured" error when called
 *
 * DO NOT change this to throw - it breaks container startup for unconfigured services.
 * @returns Configured RedmineClient instance, or null if API key not found/invalid
 */
export async function initializeRedmineClient(): Promise<RedmineClient | null> {
  try {
    const apiKey = await loadApiKey();

    // Validate API key is not empty (0-byte placeholder file)
    if (!apiKey) {
      // Graceful degradation: log warning, return null, let server start
      // DO NOT throw here - see JSDoc above for rationale
      console.warn(`${ts()} Redmine API key is empty. Run: speedwave setup redmine`);
      return null;
    }

    console.log(`${ts()} ✅ Redmine: API key loaded`);

    // Load project config from /tokens/config.json
    const projectConfig = await loadRedmineConfig();

    // Determine host URL: config.json > REDMINE_URL env > null (fail)
    let host: string | null = null;
    if (projectConfig?.host_url) {
      host = projectConfig.host_url;
      console.log(`${ts()} ✅ Redmine host from config.json: ${host}`);
    } else if (process.env.REDMINE_URL) {
      host = process.env.REDMINE_URL;
      console.log(`${ts()} ✅ Redmine host from REDMINE_URL env: ${host}`);
    }

    if (!host) {
      // Graceful degradation: log warning, return null, let server start
      // DO NOT throw here - see JSDoc above for rationale
      console.warn(`${ts()} No Redmine URL found (config.json or REDMINE_URL env var)`);
      return null;
    }

    console.log(`${ts()} ✅ Redmine: URL configured: ${host}`);

    return new RedmineClient(
      {
        url: host,
        apiKey,
      },
      projectConfig
    );
  } catch (error) {
    // Graceful degradation: log warning, return null, let server start
    // DO NOT throw here - see JSDoc above for rationale
    console.warn(
      `${ts()} Failed to initialize Redmine client: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return null;
  }
}
