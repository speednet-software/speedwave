/**
 * Jira issue comments and worklog entries. Comment bodies use Atlassian
 * Document Format (Jira Cloud REST v3).
 * @module mcp-atlassian/domains/jira-comments
 */

import { clampPageSize } from '@speedwave/mcp-shared';
import type { AtlassianClient } from '../client.js';
import { toAdf } from '../adf.js';
import { assertJiraIssueKeyAllowed } from '../scope.js';
import type { AdfDoc, JiraComment, JiraWorklog } from '../types.js';
import { mapUser } from './normalizers.js';

/** Client for Jira comments and worklog. */
export interface JiraCommentsClient {
  /** Add a comment to an issue. `body` is plain text (→ ADF) or a raw ADF object. */
  add(issueIdOrKey: string, body: string | AdfDoc): Promise<JiraComment>;
  /** List comments on an issue (most recent last, Jira default ordering). */
  list(issueIdOrKey: string, options?: { maxResults?: number }): Promise<JiraComment[]>;
  /**
   * Log work against an issue.
   * @param issueIdOrKey - The issue key or numeric ID.
   * @param params - Worklog parameters.
   * @param params.timeSpentSeconds - Seconds of work logged.
   * @param params.comment - Optional worklog comment (plain text → ADF, or a raw ADF document).
   * @param params.started - Optional ISO 8601 start timestamp (defaults to now, server-side).
   * @returns The created worklog entry, normalised.
   */
  addWorklog(
    issueIdOrKey: string,
    params: { timeSpentSeconds: number; comment?: string | AdfDoc; started?: string }
  ): Promise<JiraWorklog>;
}

/**
 * Create a Jira comments client.
 * @param client - The shared Atlassian HTTP client.
 * @returns A {@link JiraCommentsClient}.
 */
export function createJiraCommentsClient(client: AtlassianClient): JiraCommentsClient {
  // Enforce the Jira project allowlist for an issue ref (see assertJiraIssueKeyAllowed).
  const enforce = (issueIdOrKey: string): void =>
    assertJiraIssueKeyAllowed(issueIdOrKey, client.jiraProjectKeys);

  return {
    async add(issueIdOrKey, body) {
      enforce(issueIdOrKey);
      const raw = await client.post<unknown>(
        `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment`,
        { body: toAdf(body) }
      );
      return mapComment(raw);
    },

    async list(issueIdOrKey, options = {}) {
      enforce(issueIdOrKey);
      const res = await client.get<{ comments?: unknown[] }>(
        `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment`,
        { maxResults: clampPageSize(options.maxResults, 50, 100) }
      );
      return (res.comments ?? []).map(mapComment);
    },

    async addWorklog(issueIdOrKey, { timeSpentSeconds, comment, started }) {
      enforce(issueIdOrKey);
      const data: Record<string, unknown> = { timeSpentSeconds };
      if (comment !== undefined) data.comment = toAdf(comment);
      if (started) data.started = started;
      const raw = await client.post<unknown>(
        `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/worklog`,
        data
      );
      return mapWorklog(raw, issueIdOrKey);
    },
  };
}

/**
 * Map a raw Jira comment to {@link JiraComment}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 */
export function mapComment(raw: unknown): JiraComment {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    body: (o.body ?? '') as AdfDoc | string,
    author: o.author ? mapUser(o.author) : null,
    created: String(o.created ?? ''),
    updated: String(o.updated ?? o.created ?? ''),
  };
}

/**
 * Map a raw Jira worklog entry to {@link JiraWorklog}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 * @param issueIdOrKey - The Jira issue key (e.g. `PROJ-123`) or numeric ID.
 */
export function mapWorklog(raw: unknown, issueIdOrKey: string): JiraWorklog {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    issue_id: String(o.issueId ?? issueIdOrKey),
    time_spent_seconds: Number(o.timeSpentSeconds ?? 0),
    comment: (o.comment ?? null) as AdfDoc | string | null,
    author: o.author ? mapUser(o.author) : null,
    started: String(o.started ?? ''),
    created: String(o.created ?? ''),
  };
}
