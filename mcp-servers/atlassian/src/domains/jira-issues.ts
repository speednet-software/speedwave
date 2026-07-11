/**
 * Jira issues domain — search (enhanced JQL), CRUD, transitions, assignment, account.
 * @module mcp-atlassian/domains/jira-issues
 */

import { clampPageSize } from '@speedwave/mcp-shared';
import type { AtlassianClient } from '../client.js';
import { toAdf } from '../adf.js';
import {
  assertJiraIssueKeyAllowed,
  assertJiraProjectAllowed,
  filterByAllowlist,
  ScopeError,
} from '../scope.js';
import { deriveBrowseUrl } from '../url.js';
import type {
  AdfDoc,
  JiraAttachment,
  JiraIssue,
  JiraSearchResult,
  JiraTransition,
  JiraUser,
} from '../types.js';
import { mapTransition, mapUser } from './normalizers.js';

/** Fields requested for issues — kept tight to keep responses small. */
const ISSUE_FIELDS = [
  'summary',
  'description',
  'status',
  'issuetype',
  'project',
  'priority',
  'labels',
  'assignee',
  'reporter',
  'created',
  'updated',
] as const;

/**
 * With a project allowlist configured, upstream pages that filter down to zero visible
 * issues are skipped (bounded by this cap) rather than passed through, so a caller can't
 * infer out-of-allowlist matches from an empty page whose cursor says "not last".
 */
const MAX_SEARCH_CONTINUATION_PAGES = 5;

/** Client for Jira issue operations. */
export interface JiraIssuesClient {
  /**
   * Search issues with JQL using the enhanced search endpoint.
   * @param params - Search parameters.
   * @param params.jql - The JQL query string.
   * @param params.maxResults - Page size (default 50, capped at 100).
   * @param params.nextPageToken - Opaque cursor from a previous page.
   * @returns Page of issues plus the next-page cursor (absent on the last page). With a
   * project allowlist configured, all-excluded upstream pages are skipped (bounded) so the
   * cursor/is_last never reveal the existence of out-of-allowlist matches.
   */
  search(params: {
    jql: string;
    maxResults?: number;
    nextPageToken?: string;
  }): Promise<JiraSearchResult>;
  /**
   * Get a single issue by key or ID.
   * @param issueIdOrKey - The issue key (e.g. `PROJ-123`) or numeric ID.
   * @returns The normalised issue.
   */
  get(issueIdOrKey: string): Promise<JiraIssue>;
  /**
   * Create an issue.
   * @param params - Creation parameters.
   * @param params.projectKey - Target project key.
   * @param params.summary - Issue summary.
   * @param params.issueType - Issue type name (e.g. `Task`, `Bug`).
   * @param params.body - Description as plain text (converted to ADF) or a raw ADF document.
   * @param params.priority - Optional priority name.
   * @param params.labels - Optional labels to apply.
   * @param params.assigneeAccountId - Optional account ID to assign to.
   * @returns The created issue, re-fetched and normalised.
   */
  create(params: {
    projectKey: string;
    summary: string;
    issueType: string;
    body?: string | AdfDoc;
    priority?: string;
    labels?: string[];
    assigneeAccountId?: string;
  }): Promise<JiraIssue>;
  /**
   * Update mutable fields of an issue (only provided fields change).
   * @param issueIdOrKey - The issue key (an allowlist requires a key, not a numeric ID) or ID.
   * @param params - Fields to change.
   * @param params.summary - New summary.
   * @param params.body - New description (plain text → ADF, or a raw ADF document).
   * @param params.priority - New priority name.
   * @param params.labels - Replacement label set.
   * @param params.assigneeAccountId - Optional account ID to reassign to.
   * @returns The updated issue, re-fetched and normalised.
   */
  update(
    issueIdOrKey: string,
    params: {
      summary?: string;
      body?: string | AdfDoc;
      priority?: string;
      labels?: string[];
      assigneeAccountId?: string;
    }
  ): Promise<JiraIssue>;
  /** List the workflow transitions currently available for an issue. */
  getTransitions(issueIdOrKey: string): Promise<JiraTransition[]>;
  /** Perform a workflow transition by transition ID. */
  transition(issueIdOrKey: string, transitionId: string): Promise<void>;
  /** Assign an issue to an account (or unassign with `null`). */
  assign(issueIdOrKey: string, accountId: string | null): Promise<void>;
  /** Get the account the API token authenticates as. */
  getMyself(): Promise<JiraUser>;
  /**
   * Attach a file to an issue (`POST .../attachments`, multipart).
   * @param issueIdOrKey - The issue key or ID (allowlist enforced).
   * @param params - Attachment parameters.
   * @param params.filename - File name shown in Jira.
   * @param params.data - Raw file bytes.
   * @param params.contentType - MIME type for the file part.
   * @returns The created attachment, normalised.
   */
  addAttachment(
    issueIdOrKey: string,
    params: { filename: string; data: Buffer; contentType: string }
  ): Promise<JiraAttachment>;
  /**
   * Delete an attachment by its global attachment ID.
   * @param attachmentId - The attachment ID (from a created/listed attachment).
   * @throws {ScopeError} When a Jira project allowlist is configured — a bare
   *   attachment ID cannot be verified against the allowlist, so we fail closed.
   */
  deleteAttachment(attachmentId: string): Promise<void>;
}

/**
 * Create a Jira issues client.
 * @param client - The shared Atlassian HTTP client.
 * @returns A {@link JiraIssuesClient}.
 */
export function createJiraIssuesClient(client: AtlassianClient): JiraIssuesClient {
  // Enforce the Jira project allowlist for an issue ref (see assertJiraIssueKeyAllowed).
  const enforceFromIssueKey = (issueIdOrKey: string): void =>
    assertJiraIssueKeyAllowed(issueIdOrKey, client.jiraProjectKeys);

  return {
    async search({ jql, maxResults = 50, nextPageToken }) {
      const capped = clampPageSize(maxResults, 50, 100);
      const scoped = client.jiraProjectKeys.length > 0;
      let cursor = nextPageToken;
      let issues: JiraIssue[] = [];
      let upstreamDone = false;
      let pages = 0;
      do {
        const body: Record<string, unknown> = {
          jql,
          maxResults: capped,
          fields: [...ISSUE_FIELDS],
        };
        if (cursor) body.nextPageToken = cursor;
        // POST search is idempotent → safe to retry transient 5xx.
        const res = await client.post<{
          issues?: unknown[];
          nextPageToken?: string | null;
          isLast?: boolean;
        }>('/rest/api/3/search/jql', body, { retryable: true });
        issues = filterByAllowlist(
          (res.issues ?? []).map(mapIssue),
          (i) => i.project_key,
          client.jiraProjectKeys
        );
        cursor = res.nextPageToken ?? undefined;
        upstreamDone = res.isLast ?? res.nextPageToken == null;
        pages += 1;
      } while (
        scoped &&
        !upstreamDone &&
        issues.length === 0 &&
        pages < MAX_SEARCH_CONTINUATION_PAGES
      );
      return {
        issues,
        next_page_token: cursor ?? null,
        is_last: upstreamDone,
      };
    },

    async get(issueIdOrKey) {
      const raw = await client.get<unknown>(
        `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}`,
        {
          fields: ISSUE_FIELDS.join(','),
        }
      );
      const issue = mapIssue(raw);
      assertJiraProjectAllowed(issue.project_key, client.jiraProjectKeys);
      return issue;
    },

    async create({ projectKey, summary, issueType, body, priority, labels, assigneeAccountId }) {
      assertJiraProjectAllowed(projectKey, client.jiraProjectKeys);
      const fields: Record<string, unknown> = {
        project: { key: projectKey },
        summary,
        issuetype: { name: issueType },
      };
      if (body !== undefined) fields.description = toAdf(body);
      if (priority) fields.priority = { name: priority };
      if (labels) fields.labels = labels;
      if (assigneeAccountId) fields.assignee = { accountId: assigneeAccountId };
      const created = await client.post<{ key: string }>('/rest/api/3/issue', { fields });
      // Re-fetch for a fully-populated, normalised issue.
      const raw = await client.get<unknown>(
        `/rest/api/3/issue/${encodeURIComponent(created.key)}`,
        {
          fields: ISSUE_FIELDS.join(','),
        }
      );
      return mapIssue(raw);
    },

    async update(issueIdOrKey, { summary, body, priority, labels, assigneeAccountId }) {
      enforceFromIssueKey(issueIdOrKey);
      const fields: Record<string, unknown> = {};
      if (summary !== undefined) fields.summary = summary;
      if (body !== undefined) fields.description = toAdf(body);
      if (priority !== undefined) fields.priority = { name: priority };
      if (labels !== undefined) fields.labels = labels;
      if (assigneeAccountId) fields.assignee = { accountId: assigneeAccountId };
      await client.put<void>(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}`, { fields });
      const raw = await client.get<unknown>(
        `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}`,
        {
          fields: ISSUE_FIELDS.join(','),
        }
      );
      const issue = mapIssue(raw);
      assertJiraProjectAllowed(issue.project_key, client.jiraProjectKeys);
      return issue;
    },

    async getTransitions(issueIdOrKey) {
      enforceFromIssueKey(issueIdOrKey);
      const res = await client.get<{ transitions?: unknown[] }>(
        `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/transitions`
      );
      return (res.transitions ?? []).map(mapTransition);
    },

    async transition(issueIdOrKey, transitionId) {
      enforceFromIssueKey(issueIdOrKey);
      await client.post<void>(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/transitions`, {
        transition: { id: transitionId },
      });
    },

    async assign(issueIdOrKey, accountId) {
      enforceFromIssueKey(issueIdOrKey);
      await client.put<void>(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/assignee`, {
        accountId,
      });
    },

    async getMyself() {
      return mapUser(await client.get<unknown>('/rest/api/3/myself'));
    },

    async addAttachment(issueIdOrKey, { filename, data, contentType }) {
      enforceFromIssueKey(issueIdOrKey);
      const res = await client.uploadAttachment<unknown>(issueIdOrKey, filename, data, contentType);
      // Jira returns an array of created attachments; normalise the first.
      const first = Array.isArray(res) ? res[0] : res;
      return mapAttachment(first);
    },

    async deleteAttachment(attachmentId) {
      // Attachment delete is by global attachment ID; when a project allowlist is
      // configured we cannot verify the attachment's project, so fail closed.
      if (client.jiraProjectKeys.length > 0) {
        throw new ScopeError(
          'Deleting attachments is not allowed while a Jira project allowlist is configured ' +
            '(an attachment ID cannot be checked against the allowlist).'
        );
      }
      await client.del<void>(`/rest/api/3/attachment/${encodeURIComponent(attachmentId)}`);
    },
  };
}

/**
 * Map a raw Jira attachment object to {@link JiraAttachment}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 * @returns The normalised attachment.
 */
export function mapAttachment(raw: unknown): JiraAttachment {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    filename: String(o.filename ?? ''),
    size: typeof o.size === 'number' ? o.size : undefined,
    mime_type: o.mimeType ? String(o.mimeType) : undefined,
    created: o.created ? String(o.created) : undefined,
    url: o.content ? String(o.content) : undefined,
    author: o.author ? mapUser(o.author) : null,
  };
}

//═══════════════════════════════════════════════════════════════════════════════
// Normalisers
//═══════════════════════════════════════════════════════════════════════════════

/**
 * Map a raw Jira issue (with `fields`) to {@link JiraIssue}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 * @returns The normalised issue.
 */
export function mapIssue(raw: unknown): JiraIssue {
  const o = (raw ?? {}) as Record<string, unknown>;
  const f = (o.fields ?? {}) as Record<string, unknown>;
  const project = (f.project ?? {}) as Record<string, unknown>;
  const status = (f.status ?? {}) as Record<string, unknown>;
  const issuetype = (f.issuetype ?? {}) as Record<string, unknown>;
  const priority = (f.priority ?? {}) as Record<string, unknown>;
  const key = String(o.key ?? '');
  return {
    id: String(o.id ?? ''),
    key,
    summary: String(f.summary ?? ''),
    description: (f.description ?? null) as AdfDoc | string | null,
    status: String(status.name ?? ''),
    issue_type: String(issuetype.name ?? ''),
    project_key: String(project.key ?? key.split('-')[0]),
    priority: priority.name ? String(priority.name) : undefined,
    labels: Array.isArray(f.labels) ? (f.labels as unknown[]).map(String) : [],
    assignee: f.assignee ? mapUser(f.assignee) : null,
    reporter: f.reporter ? mapUser(f.reporter) : null,
    created: String(f.created ?? ''),
    updated: String(f.updated ?? ''),
    web_url: o.self ? deriveBrowseUrl(String(o.self), key) : undefined,
  };
}
