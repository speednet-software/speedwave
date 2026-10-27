/**
 * Jira issues domain — search (enhanced JQL), CRUD, transitions, assignment, account.
 * @module mcp-atlassian/domains/jira-issues
 */

import { clampPageSize } from '@speedwave/mcp-shared';
import type { AtlassianClient } from '../client.js';
import { adfToMarkdown, markdownToAdf } from '../adf.js';
import {
  assertJiraIssueKeyAllowed,
  assertJiraProjectAllowed,
  filterByAllowlist,
  ScopeError,
} from '../scope.js';
import { deriveBrowseUrl } from '../url.js';
import type {
  AdfDoc,
  CreateIssueInput,
  JiraAttachment,
  JiraIssue,
  JiraIssueLink,
  JiraIssueParent,
  JiraLinkType,
  JiraSearchResult,
  JiraTransition,
  JiraUser,
  UpdateIssueInput,
} from '../types.js';
import { mapTransition, mapUser } from './normalizers.js';

/** Fields requested for a single issue: kept tight to keep responses small. */
const ISSUE_FIELDS = [
  'summary',
  'description',
  'status',
  'issuetype',
  'project',
  'priority',
  'labels',
  'components',
  'parent',
  'issuelinks',
  'assignee',
  'reporter',
  'created',
  'updated',
] as const;

/** Fields requested for search results: the issue fields without the (large) description. */
const SEARCH_FIELDS = ISSUE_FIELDS.filter((field) => field !== 'description');

/**
 * With a project allowlist, upstream pages that filter to zero visible issues are skipped
 * (bounded by this cap) so a caller can't infer out-of-allowlist matches from an empty page.
 */
const MAX_SEARCH_CONTINUATION_PAGES = 5;

/** Thrown by `linkIssues` when no link type has the requested relation text. */
export class UnknownLinkRelationError extends Error {
  /**
   * Create the error.
   * @param relation - The relation text the caller asked for.
   * @param available - All relation texts the Jira site knows, sorted by link type.
   */
  constructor(
    readonly relation: string,
    readonly available: string[]
  ) {
    super(`Unknown link relation '${relation}'. Available: ${available.join(', ')}`);
    this.name = 'UnknownLinkRelationError';
  }
}

/** Client for Jira issue operations. */
export interface JiraIssuesClient {
  /**
   * Search issues with JQL via the enhanced search endpoint (`maxResults` default 50, capped
   * at 100); with a project allowlist, all-excluded pages are skipped so cursor/is_last don't leak.
   */
  search(params: {
    jql: string;
    maxResults?: number;
    nextPageToken?: string;
  }): Promise<JiraSearchResult>;
  /** Get a single issue by key (e.g. `PROJ-123`) or numeric ID. */
  get(issueIdOrKey: string): Promise<JiraIssue>;
  /**
   * Create an issue from the caller shape (Markdown `description` or raw `description_adf`,
   * `assignee` accountId or `"me"`, `parent` key or id, `components` names).
   * Returns the created issue, re-fetched and normalised.
   * @throws {ScopeError} When the project or the parent is outside the allowlist.
   */
  create(params: CreateIssueInput): Promise<JiraIssue>;
  /**
   * Update the provided fields of an issue (`issue` is a key or numeric ID; an allowlist
   * requires a key). `parent: null` detaches, `components` replaces, `type` changes the issue type.
   * Returns the updated issue, re-fetched and normalised.
   */
  update(issue: string, params: UpdateIssueInput): Promise<JiraIssue>;
  /** Delete an issue by key or numeric ID (Jira refuses issues that still have sub-tasks). */
  delete(issue: string): Promise<void>;
  /**
   * Link `issue` to `target` with a relation read from the side of `issue`, for example
   * `blocks` or `is blocked by`.
   * @throws {UnknownLinkRelationError} When no link type has that inward or outward text.
   */
  linkIssues(issue: string, relation: string, target: string): Promise<void>;
  /** Remove an issue link by its link ID. */
  unlinkIssues(linkId: string): Promise<void>;
  /** List the link types with their inward and outward texts. */
  listLinkTypes(): Promise<JiraLinkType[]>;
  /** List the workflow transitions currently available for an issue. */
  getTransitions(issueIdOrKey: string): Promise<JiraTransition[]>;
  /** Perform a workflow transition by transition ID. */
  transition(issueIdOrKey: string, transitionId: string): Promise<void>;
  /** Assign an issue to an account ID or `"me"`, or unassign with `null`. */
  assign(issueIdOrKey: string, assignee: string | null): Promise<void>;
  /** Get the account the API token authenticates as. */
  getMyself(): Promise<JiraUser>;
  /**
   * Attach a file to an issue (`POST .../attachments`, multipart, allowlist enforced).
   * Returns the normalised attachment.
   */
  addAttachment(
    issueIdOrKey: string,
    params: { filename: string; data: Buffer; contentType: string }
  ): Promise<JiraAttachment>;
  /**
   * Delete an attachment by its global attachment ID.
   * @throws {ScopeError} With a Jira project allowlist — a bare ID can't be verified, fails closed.
   */
  deleteAttachment(attachmentId: string): Promise<void>;
}

/**
 * Create a {@link JiraIssuesClient} from the shared Atlassian HTTP client.
 * @param client - The shared Atlassian HTTP client.
 * @returns A Jira issues client.
 */
export function createJiraIssuesClient(client: AtlassianClient): JiraIssuesClient {
  let linkTypes: JiraLinkType[] | undefined;

  const enforceFromIssueKey = (issueIdOrKey: string): void =>
    assertJiraIssueKeyAllowed(issueIdOrKey, client.jiraProjectKeys);

  const fetchIssue = async (issueIdOrKey: string): Promise<JiraIssue> =>
    mapIssue(
      await client.get<unknown>(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}`, {
        fields: ISSUE_FIELDS.join(','),
      })
    );

  const cachedLinkTypes = async (): Promise<JiraLinkType[]> => {
    if (!linkTypes) {
      const res = await client.get<{ issueLinkTypes?: unknown[] }>('/rest/api/3/issueLinkType');
      linkTypes = (res.issueLinkTypes ?? []).map(mapLinkType);
    }
    return linkTypes;
  };

  const resolveAssignee = async (assignee: string): Promise<{ accountId: string }> => ({
    accountId:
      assignee === 'me'
        ? mapUser(await client.get<unknown>('/rest/api/3/myself')).account_id
        : assignee,
  });

  const writableFields = async (
    input: CreateIssueInput | UpdateIssueInput
  ): Promise<Record<string, unknown>> => {
    const fields: Record<string, unknown> = {};
    if (input.description !== undefined) fields.description = markdownToAdf(input.description);
    if (input.description_adf !== undefined) fields.description = input.description_adf;
    if (input.priority !== undefined) fields.priority = { name: input.priority };
    if (input.labels !== undefined) fields.labels = input.labels;
    if (input.components !== undefined) fields.components = input.components.map(toNamed);
    if (input.parent !== undefined) {
      fields.parent = input.parent === null ? null : issueRef(input.parent);
    }
    if (input.assignee !== undefined) {
      fields.assignee = input.assignee === null ? null : await resolveAssignee(input.assignee);
    }
    return fields;
  };

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
          fields: [...SEARCH_FIELDS],
        };
        if (cursor) body.nextPageToken = cursor;
        const res = await client.post<{
          issues?: unknown[];
          nextPageToken?: string | null;
          isLast?: boolean;
        }>('/rest/api/3/search/jql', body, { retryable: true });
        issues = filterByAllowlist(
          (res.issues ?? []).map(mapIssue),
          (i) => i.project,
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
      const issue = await fetchIssue(issueIdOrKey);
      assertJiraProjectAllowed(issue.project, client.jiraProjectKeys);
      return issue;
    },

    async create(input) {
      assertJiraProjectAllowed(input.project, client.jiraProjectKeys);
      if (input.parent !== undefined) enforceFromIssueKey(input.parent);
      const fields: Record<string, unknown> = {
        project: { key: input.project },
        summary: input.summary,
        issuetype: { name: input.type },
        ...(await writableFields(input)),
      };
      const created = await client.post<{ key: string }>('/rest/api/3/issue', { fields });
      return fetchIssue(created.key);
    },

    async update(issue, input) {
      enforceFromIssueKey(issue);
      if (input.parent !== undefined && input.parent !== null) enforceFromIssueKey(input.parent);
      const fields: Record<string, unknown> = { ...(await writableFields(input)) };
      if (input.type !== undefined) fields.issuetype = { name: input.type };
      if (input.summary !== undefined) fields.summary = input.summary;
      await client.put<void>(`/rest/api/3/issue/${encodeURIComponent(issue)}`, { fields });
      const updated = await fetchIssue(issue);
      assertJiraProjectAllowed(updated.project, client.jiraProjectKeys);
      return updated;
    },

    async delete(issue) {
      enforceFromIssueKey(issue);
      await client.del<void>(`/rest/api/3/issue/${encodeURIComponent(issue)}`);
    },

    async linkIssues(issue, relation, target) {
      enforceFromIssueKey(issue);
      enforceFromIssueKey(target);
      const { type, issueIsOutward } = resolveRelation(await cachedLinkTypes(), relation);
      const own = issueRef(issue);
      const other = issueRef(target);
      await client.post<void>('/rest/api/3/issueLink', {
        type: { name: type.name },
        outwardIssue: issueIsOutward ? own : other,
        inwardIssue: issueIsOutward ? other : own,
      });
    },

    async unlinkIssues(linkId) {
      const path = `/rest/api/3/issueLink/${encodeURIComponent(linkId)}`;
      if (client.jiraProjectKeys.length > 0) {
        const link = (await client.get<Record<string, unknown>>(path)) ?? {};
        enforceFromIssueKey(linkEndKey(link.inwardIssue));
        enforceFromIssueKey(linkEndKey(link.outwardIssue));
      }
      await client.del<void>(path);
    },

    async listLinkTypes() {
      linkTypes = undefined;
      return cachedLinkTypes();
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

    async assign(issueIdOrKey, assignee) {
      enforceFromIssueKey(issueIdOrKey);
      await client.put<void>(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/assignee`, {
        accountId: assignee === null ? null : (await resolveAssignee(assignee)).accountId,
      });
    },

    async getMyself() {
      return mapUser(await client.get<unknown>('/rest/api/3/myself'));
    },

    async addAttachment(issueIdOrKey, { filename, data, contentType }) {
      enforceFromIssueKey(issueIdOrKey);
      const res = await client.uploadAttachment<unknown>(issueIdOrKey, filename, data, contentType);
      const first = Array.isArray(res) ? res[0] : res;
      return mapAttachment(first);
    },

    async deleteAttachment(attachmentId) {
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

function issueRef(issueIdOrKey: string): { id: string } | { key: string } {
  const trimmed = issueIdOrKey.trim();
  return /^\d+$/.test(trimmed) ? { id: trimmed } : { key: trimmed };
}

function toNamed(name: string): { name: string } {
  return { name };
}

function linkEndKey(end: unknown): string {
  return String(((end ?? {}) as Record<string, unknown>).key ?? '');
}

function resolveRelation(
  types: JiraLinkType[],
  relation: string
): { type: JiraLinkType; issueIsOutward: boolean } {
  const wanted = relation.trim().toLowerCase();
  const byOutward = types.find((t) => t.outward.toLowerCase() === wanted);
  if (byOutward) return { type: byOutward, issueIsOutward: true };
  const byInward = types.find((t) => t.inward.toLowerCase() === wanted);
  if (byInward) return { type: byInward, issueIsOutward: false };
  throw new UnknownLinkRelationError(
    relation,
    types.flatMap((t) => [t.outward, t.inward]).filter((text, i, all) => all.indexOf(text) === i)
  );
}

function mapLinkType(raw: unknown): JiraLinkType {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    name: String(o.name ?? ''),
    inward: String(o.inward ?? ''),
    outward: String(o.outward ?? ''),
  };
}

/**
 * Map a raw Jira attachment object (Atlassian REST API shape) to {@link JiraAttachment}.
 * @param raw - The raw object as returned by the Atlassian REST API.
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

/**
 * Map a raw Jira issue (with `fields`, Atlassian REST API shape) to {@link JiraIssue}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 */
function mapIssue(raw: unknown): JiraIssue {
  const o = (raw ?? {}) as Record<string, unknown>;
  const f = (o.fields ?? {}) as Record<string, unknown>;
  const key = String(o.key ?? '');
  const issue: JiraIssue = {
    key,
    id: String(o.id ?? ''),
    web_url: o.self ? deriveBrowseUrl(String(o.self), key) : undefined,
    summary: String(f.summary ?? ''),
    type: nameOf(f.issuetype),
    status: nameOf(f.status),
    project: String(asRecord(f.project).key ?? key.split('-')[0]),
    priority: asRecord(f.priority).name ? nameOf(f.priority) : null,
    labels: Array.isArray(f.labels) ? (f.labels as unknown[]).map(String) : [],
    components: Array.isArray(f.components)
      ? (f.components as unknown[]).map((c) => nameOf(c))
      : [],
    parent: f.parent ? mapParent(f.parent) : null,
    links: Array.isArray(f.issuelinks) ? (f.issuelinks as unknown[]).map(mapLink) : [],
    assignee: f.assignee ? mapUser(f.assignee) : null,
    reporter: f.reporter ? mapUser(f.reporter) : null,
    created: String(f.created ?? ''),
    updated: String(f.updated ?? ''),
  };
  if (f.description !== undefined) {
    issue.description = adfToMarkdown(f.description as AdfDoc | null);
  }
  return issue;
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function nameOf(value: unknown): string {
  return String(asRecord(value).name ?? '');
}

function mapParent(raw: unknown): JiraIssueParent {
  const f = asRecord(asRecord(raw).fields);
  return {
    key: String(asRecord(raw).key ?? ''),
    summary: String(f.summary ?? ''),
    type: nameOf(f.issuetype),
    status: nameOf(f.status),
  };
}

function mapLink(raw: unknown): JiraIssueLink {
  const o = asRecord(raw);
  const type = asRecord(o.type);
  const other = asRecord(o.inwardIssue ?? o.outwardIssue);
  const fields = asRecord(other.fields);
  return {
    id: String(o.id ?? ''),
    relation: String((o.inwardIssue ? type.outward : type.inward) ?? ''),
    issue: {
      key: String(other.key ?? ''),
      summary: String(fields.summary ?? ''),
      status: nameOf(fields.status),
    },
  };
}
