import axios from 'axios';
import { pathSegment, type PluginHost } from '../../client.js';
import {
  parseAgileData,
  parseSprint,
  parseSprintList,
  sharingCode,
  statusCode,
  type AgileData,
  type AgileSprint,
  type SprintList,
  type SprintSharing,
  type SprintStatus,
} from './model.js';

export const AGILE_UNAVAILABLE_MESSAGE =
  'Redmine answered 403 or 404 for an agile endpoint. The RedmineUP Agile plugin is not available for this project: the plugin may be missing, the Agile module disabled, the permission absent, or the plugin variant has no sprints. A wrong sprint or issue ID gives the same answer.';

/** Sprint fields, status and sharing as words. */
export interface SprintFields {
  name?: string;
  description?: string;
  start_date?: string;
  end_date?: string;
  status?: SprintStatus;
  sharing?: SprintSharing;
}

/** Filters and paging of a sprint list. */
export interface SprintFilters {
  name?: string;
  status?: SprintStatus;
  from?: string;
  to?: string;
  include_shared?: boolean;
  limit?: number;
  offset?: number;
}

async function agileCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (status === 403 || status === 404) {
      throw new Error(AGILE_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }
}

function sprintBody(fields: SprintFields): { agile_sprint: Record<string, unknown> } {
  const { status, sharing, ...rest } = fields;
  const body: Record<string, unknown> = { ...rest };
  if (status !== undefined) body.status = statusCode(status);
  if (sharing !== undefined) body.sharing = sharingCode(sharing);
  return { agile_sprint: body };
}

/** HTTP adapter over the RedmineUP Agile REST API. */
export class AgileApi {
  /**
   * Create the adapter.
   * @param host - The client's plugin interface.
   */
  constructor(private readonly host: PluginHost) {}

  /**
   * Resolve the project a call targets and check it against the configured scope.
   * @param projectId - Caller-given project, or undefined for the configured one.
   * @returns The project to use, or null when none is configured or given.
   */
  async resolveProject(projectId?: string | number): Promise<string | null> {
    const target = projectId || this.host.getProjectScope();
    if (!target) return null;
    await this.host.ensureProjectInScope(target);
    return String(target);
  }

  /**
   * List the sprints of a project.
   * @param project - Project ID or identifier.
   * @param filters - Redmine's sprint filters and paging.
   */
  async listSprints(project: string, filters: SprintFilters): Promise<SprintList> {
    const { include_shared, ...rest } = filters;
    const params = { ...rest, ...(include_shared ? { include_shared: 1 } : {}) };
    const body = await agileCall(() =>
      this.host.get(`/projects/${pathSegment(project)}/agile_sprints.json`, params)
    );
    return parseSprintList(body, filters);
  }

  /**
   * Read one sprint, with its issues on request.
   * @param project - Project ID or identifier.
   * @param sprintId - Sprint ID.
   * @param includeIssues - Whether to add the sprint's issues.
   */
  async getSprint(project: string, sprintId: number, includeIssues: boolean): Promise<AgileSprint> {
    const params = includeIssues ? { include: 'issues' } : undefined;
    const body = await agileCall(() =>
      this.host.get(
        `/projects/${pathSegment(project)}/agile_sprints/${pathSegment(sprintId)}.json`,
        params
      )
    );
    return parseSprint(body);
  }

  /**
   * Create a sprint.
   * @param project - Project ID or identifier.
   * @param fields - Sprint fields; status and sharing as words.
   */
  async createSprint(project: string, fields: SprintFields): Promise<AgileSprint> {
    const body = await agileCall(() =>
      this.host.post(`/projects/${pathSegment(project)}/agile_sprints.json`, sprintBody(fields))
    );
    return parseSprint(body);
  }

  /**
   * Update a sprint and read it back.
   * @param project - Project ID or identifier.
   * @param sprintId - Sprint ID.
   * @param fields - Fields to change; status and sharing as words.
   */
  async updateSprint(
    project: string,
    sprintId: number,
    fields: SprintFields
  ): Promise<AgileSprint> {
    if (Object.values(fields).every((value) => value === undefined)) {
      throw new Error(
        `Nothing to update on sprint ${sprintId}: no field was given, so no request was sent to Redmine. Pass at least one field.`
      );
    }
    await agileCall(() =>
      this.host.put(
        `/projects/${pathSegment(project)}/agile_sprints/${pathSegment(sprintId)}.json`,
        sprintBody(fields)
      )
    );
    return this.getSprint(project, sprintId, false);
  }

  /**
   * Delete a sprint; its issues stay and lose the assignment.
   * @param project - Project ID or identifier.
   * @param sprintId - Sprint ID.
   */
  async deleteSprint(project: string, sprintId: number): Promise<void> {
    await agileCall(() =>
      this.host.delete(
        `/projects/${pathSegment(project)}/agile_sprints/${pathSegment(sprintId)}.json`
      )
    );
  }

  /**
   * Read the agile data of an issue.
   * @param issueId - Issue ID.
   */
  async getIssueAgileData(issueId: number): Promise<AgileData> {
    await this.host.ensureIssueInScope(issueId);
    return this.readAgileData(issueId);
  }

  /**
   * Write the agile data of an issue and read it back.
   * @param issueId - Issue ID.
   * @param data - Sprint to assign (null unlinks) and story points.
   * @param data.agile_sprint_id - Sprint ID, or null to unlink.
   * @param data.story_points - Story points.
   */
  async setIssueAgileData(
    issueId: number,
    data: { agile_sprint_id?: number | null; story_points?: number }
  ): Promise<AgileData> {
    await this.host.ensureIssueInScope(issueId);
    const attributes: Record<string, unknown> = {};
    if (data.agile_sprint_id !== undefined) attributes.agile_sprint_id = data.agile_sprint_id;
    if (data.story_points !== undefined) attributes.story_points = data.story_points;
    await agileCall(() =>
      this.host.put(`/issues/${pathSegment(issueId)}.json`, {
        issue: { agile_data_attributes: attributes },
      })
    );
    return this.readAgileData(issueId);
  }

  private async readAgileData(issueId: number): Promise<AgileData> {
    const body = await agileCall(() =>
      this.host.get(`/issues/${pathSegment(issueId)}/agile_data.json`)
    );
    return parseAgileData(body);
  }
}
