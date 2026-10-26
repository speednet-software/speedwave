/**
 * Jira projects: listing (allowlist-filtered), single-project lookup, issue-type metadata and
 * components.
 * @module mcp-atlassian/domains/jira-projects
 */

import { clampPageSize } from '@speedwave/mcp-shared';
import type { AtlassianClient } from '../client.js';
import {
  assertJiraIssueKeyAllowed,
  assertJiraProjectAllowed,
  filterByAllowlist,
} from '../scope.js';
import { deriveBrowseUrl } from '../url.js';
import type { JiraComponent, JiraIssueType, JiraProject } from '../types.js';
import { mapUser } from './normalizers.js';

interface CreateMetaIssueTypesPage {
  issueTypes?: unknown[];
  createMetaIssueType?: unknown[];
  total?: number;
}

const CREATE_META_PAGE_SIZE = 100;

/** Client for Jira project operations. */
export interface JiraProjectsClient {
  /** List projects visible to the account (filtered by the configured allowlist, if any). */
  list(options?: { query?: string; maxResults?: number }): Promise<JiraProject[]>;
  /** Get a single project by key or ID. */
  get(projectIdOrKey: string): Promise<JiraProject>;
  /** List the issue types available in a project. */
  listIssueTypes(projectIdOrKey: string): Promise<JiraIssueType[]>;
  /**
   * List the issue types an issue can change to: the types of its project with the same sub-task
   * kind as its current type, the current type excluded.
   */
  listIssueTypesForIssue(issueIdOrKey: string): Promise<JiraIssueType[]>;
  /** List the components of a project. */
  listComponents(projectIdOrKey: string): Promise<JiraComponent[]>;
}

/**
 * Create a {@link JiraProjectsClient} from the shared Atlassian HTTP client.
 * @param client - The shared Atlassian HTTP client.
 * @returns A Jira projects client.
 */
export function createJiraProjectsClient(client: AtlassianClient): JiraProjectsClient {
  return {
    async list(options = {}) {
      const params: Record<string, unknown> = {
        maxResults: clampPageSize(options.maxResults, 50, 100),
        expand: 'lead',
      };
      if (options.query) params.query = options.query;
      const res = await client.get<{ values?: unknown[] }>('/rest/api/3/project/search', params);
      const projects = (res.values ?? []).map(mapProject);
      return filterByAllowlist(projects, (p) => p.key, client.jiraProjectKeys);
    },

    async get(projectIdOrKey) {
      const raw = await client.get<unknown>(
        `/rest/api/3/project/${encodeURIComponent(projectIdOrKey)}`,
        { expand: 'lead' }
      );
      const project = mapProject(raw);
      assertJiraProjectAllowed(project.key, client.jiraProjectKeys);
      return project;
    },

    async listIssueTypes(projectIdOrKey) {
      const project = await this.get(projectIdOrKey);
      const res = await client.get<unknown[]>(`/rest/api/3/issuetype/project`, {
        projectId: project.id,
      });
      return (Array.isArray(res) ? res : []).map(mapIssueType);
    },

    async listIssueTypesForIssue(issueIdOrKey) {
      assertJiraIssueKeyAllowed(issueIdOrKey, client.jiraProjectKeys);
      const issue = await client.get<{ fields?: Record<string, unknown> }>(
        `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}`,
        { fields: 'issuetype,project' }
      );
      const current = mapIssueType(issue.fields?.issuetype);
      const projectKey = String(
        (issue.fields?.project as { key?: unknown } | undefined)?.key ?? ''
      );
      assertJiraProjectAllowed(projectKey, client.jiraProjectKeys);
      const allowed: unknown[] = [];
      let total = 0;
      do {
        const page = await client.get<CreateMetaIssueTypesPage>(
          `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
          { startAt: allowed.length, maxResults: CREATE_META_PAGE_SIZE }
        );
        const types = page.issueTypes ?? page.createMetaIssueType ?? [];
        if (types.length === 0) break;
        allowed.push(...types);
        total = page.total ?? 0;
      } while (allowed.length < total);
      return allowed
        .map(mapIssueType)
        .filter((type) => type.id !== current.id && type.subtask === current.subtask);
    },

    async listComponents(projectIdOrKey) {
      const project = await this.get(projectIdOrKey);
      const res = await client.get<unknown[]>(
        `/rest/api/3/project/${encodeURIComponent(project.key)}/components`
      );
      return (Array.isArray(res) ? res : []).map(mapComponent);
    },
  };
}

/**
 * Map a raw Jira project to {@link JiraProject}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 */
export function mapProject(raw: unknown): JiraProject {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    key: String(o.key ?? ''),
    name: String(o.name ?? ''),
    project_type_key: o.projectTypeKey ? String(o.projectTypeKey) : undefined,
    lead: o.lead ? mapUser(o.lead) : null,
    url: o.self ? deriveBrowseUrl(String(o.self), String(o.key ?? '')) : undefined,
  };
}

/**
 * Map a raw Jira issue type (Atlassian REST API shape) to {@link JiraIssueType}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 */
export function mapIssueType(raw: unknown): JiraIssueType {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    name: String(o.name ?? ''),
    description: o.description ? String(o.description) : undefined,
    subtask: Boolean(o.subtask ?? false),
  };
}

function mapComponent(raw: unknown): JiraComponent {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(o.id ?? ''),
    name: String(o.name ?? ''),
    description: o.description ? String(o.description) : undefined,
  };
}
