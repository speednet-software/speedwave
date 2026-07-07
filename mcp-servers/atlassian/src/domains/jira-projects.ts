/**
 * Jira projects — listing (allowlist-filtered), single-project lookup, and
 * issue-type metadata for a project.
 * @module mcp-atlassian/domains/jira-projects
 */

import { clampPageSize } from '@speedwave/mcp-shared';
import type { AtlassianClient } from '../client.js';
import { assertJiraProjectAllowed, filterByAllowlist } from '../scope.js';
import { deriveBrowseUrl } from '../url.js';
import type { JiraIssueType, JiraProject } from '../types.js';
import { mapUser } from './normalizers.js';

/** Client for Jira project operations. */
export interface JiraProjectsClient {
  /** List projects visible to the account (filtered by the configured allowlist, if any). */
  list(options?: { query?: string; maxResults?: number }): Promise<JiraProject[]>;
  /** Get a single project by key or ID. */
  get(projectIdOrKey: string): Promise<JiraProject>;
  /** List the issue types available in a project. */
  listIssueTypes(projectIdOrKey: string): Promise<JiraIssueType[]>;
}

/**
 * Create a Jira projects client.
 * @param client - The shared Atlassian HTTP client.
 * @returns A {@link JiraProjectsClient}.
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
      // Enforce scope first.
      const project = await this.get(projectIdOrKey);
      const res = await client.get<unknown[]>(`/rest/api/3/issuetype/project`, {
        projectId: project.id,
      });
      return (Array.isArray(res) ? res : []).map(mapIssueType);
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
 * Map a raw Jira issue type to {@link JiraIssueType}.
 * @param raw - The raw object as returned by the Atlassian REST API.
 * @returns The normalised issue type.
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
