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

const AGILE_UNAVAILABLE_MESSAGE =
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
    return sprintWithId(body);
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
    return sprintWithId(body);
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
    await agileCall(() =>
      this.host.put(
        `/projects/${pathSegment(project)}/agile_sprints/${pathSegment(sprintId)}.json`,
        sprintBody(fields)
      )
    );
    try {
      return await this.getSprint(project, sprintId, false);
    } catch (error) {
      throw new Error(readBackFailure(`sprint ${sprintId}`, error));
    }
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
    await this.host.put(`/issues/${pathSegment(issueId)}.json`, {
      issue: { agile_data_attributes: attributes },
    });
    try {
      return await this.readAgileData(issueId);
    } catch (error) {
      throw new Error(readBackFailure(`issue ${issueId}`, error));
    }
  }

  private async readAgileData(issueId: number): Promise<AgileData> {
    const body = await agileCall(() =>
      this.host.get(`/issues/${pathSegment(issueId)}/agile_data.json`)
    );
    return parseAgileData(body);
  }
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

function sprintWithId(body: unknown): AgileSprint {
  const sprint = parseSprint(body);
  if (sprint.id === undefined) {
    throw new Error(
      'Redmine answered without a sprint id, so the response is not the documented sprint shape. The write may have gone through: list the sprints to check.'
    );
  }
  return sprint;
}

function sprintBody(fields: SprintFields): { agile_sprint: Record<string, unknown> } {
  const { status, sharing, ...rest } = fields;
  const body: Record<string, unknown> = { ...rest };
  if (status !== undefined) body.status = statusCode(status);
  if (sharing !== undefined) body.sharing = sharingCode(sharing);
  return { agile_sprint: body };
}

function readBackFailure(target: string, error: unknown): string {
  const cause = error instanceof Error ? error.message : String(error);
  return `The write to ${target} was sent, but reading it back failed: ${cause} Check the ${target} before sending it again.`;
}
