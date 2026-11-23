import {
  Tool,
  ToolDefinition,
  ToolsCallResult,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  teachingErrorResult,
  clampPageSize,
  normalizeNumericIdParams,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
  META_KEYS,
} from '@speedwave/mcp-shared';
import type { PluginHost } from '../../client.js';
import { TOOL_NAMES } from '../../tool-names.js';
import { withRedmineErrors } from '../../tools/error-handling.js';
import { successResultSchema } from '../../tools/schema-helpers.js';
import { AgileApi, type SprintFields, type SprintFilters } from './api.js';
import { SPRINT_SHARINGS, SPRINT_STATUSES } from './model.js';

/** What the agile tools need from the client. */
interface AgileClient {
  pluginHost(): PluginHost;
}

const DEFER = { [META_KEYS.DEFER_LOADING]: true };

const projectIdProperty = {
  type: ['string', 'number'],
  description:
    'Project ID or identifier, from listProjectIds; defaults to the configured project. If this integration is scoped to a single project, a project ID outside that scope is rejected; the sprint_id itself is not checked against the project',
};
const sprintIdProperty = { type: 'number', description: 'Sprint ID, from listAgileSprints' };
const statusProperty = {
  type: 'string',
  enum: [...SPRINT_STATUSES],
  description: 'Sprint status; the same words the read returns',
};
const sharingProperty = {
  type: 'string',
  enum: [...SPRINT_SHARINGS],
  description: 'Sprint sharing; the same words the read returns',
};
const nameProperty = { type: 'string', description: 'Sprint name' };
const descriptionProperty = { type: 'string', description: 'Sprint description' };
const startDateProperty = { type: 'string', description: 'Start date, YYYY-MM-DD' };
const endDateProperty = { type: 'string', description: 'End date, YYYY-MM-DD' };

const sprintSchema = {
  type: 'object',
  properties: {
    id: { type: 'number' },
    project_id: {
      type: 'number',
      description: 'Owning project; differs from project_id for a shared sprint',
    },
    name: { type: 'string' },
    description: { type: 'string' },
    status: {
      type: 'string',
      description: 'open, active or closed; an unknown numeric code comes back as a string',
    },
    start_date: { type: 'string', description: 'YYYY-MM-DD' },
    end_date: { type: 'string', description: 'YYYY-MM-DD' },
    sharing: {
      type: 'string',
      description:
        'none, descendants, hierarchy, tree or system; an unknown numeric code comes back as a string',
    },
    story_points: {
      type: 'number',
      description: 'Sum over the visible issues (single sprint only)',
    },
    done_ratio: { type: 'number', description: 'Percent done (single sprint only)' },
    estimated_hours: { type: 'number', description: 'Only for users who can view time entries' },
    spent_hours: { type: 'number', description: 'Only for users who can view time entries' },
    issues: {
      type: 'array',
      description: 'Only with include_issues; as the plugin returns them',
      items: { type: 'object' },
    },
  },
};

const agileDataSchema = {
  agile_sprint_id: { type: ['number', 'null'], description: 'Sprint the issue is in, or null' },
  story_points: { type: ['number', 'null'] },
  position: { type: ['number', 'null'], description: 'Card position on the board' },
  color: { type: ['string', 'null'], description: 'Card color' },
};

const listAgileSprintsTool: Tool = {
  name: 'listAgileSprints',
  description:
    'List the sprints of a project (RedmineUP Agile plugin), with optional filters. Status and sharing are words; the status filter takes the same words (not verified against a live instance). Fails with one message when the plugin is not available for the project (missing plugin, Agile module off, no permission, or a variant without sprints).',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: DEFER,
  keywords: ['redmine', 'agile', 'sprint', 'sprints', 'scrum', 'board', 'list', 'iteration'],
  example: `const { sprints } = await redmine.listAgileSprints({ project_id: 'my-project', status: 'active' })`,
  inputSchema: {
    type: 'object',
    properties: {
      project_id: projectIdProperty,
      status: statusProperty,
      name: { type: 'string', description: 'Filter by sprint name' },
      from: { type: 'string', description: 'Sprints from this date, YYYY-MM-DD' },
      to: { type: 'string', description: 'Sprints up to this date, YYYY-MM-DD' },
      include_shared: {
        type: 'boolean',
        description: 'Include sprints shared from other projects',
      },
      limit: { type: 'number', description: 'Maximum results (default 25, at most 100)' },
      offset: { type: 'number', description: 'Pagination offset (default 0)' },
    },
  },
  outputSchema: successResultSchema({
    sprints: { type: 'array', items: sprintSchema },
    total_count: { type: 'number' },
    offset: { type: 'number' },
    limit: { type: 'number' },
  }),
  inputExamples: [
    { description: 'Minimal: sprints of the configured project', input: {} },
    {
      description: 'Full: active sprints of a named project, with shared ones',
      input: { project_id: 'my-project', status: 'active', include_shared: true, limit: 10 },
    },
  ],
};

const getAgileSprintTool: Tool = {
  name: 'getAgileSprint',
  description:
    'Get one sprint with its totals (story points, done ratio, hours) and, with include_issues, its issues as the plugin returns them (id, subject, hours, story points, done ratio). The way to list the issues of a sprint: listIssueIds has no sprint filter.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: DEFER,
  keywords: ['redmine', 'agile', 'sprint', 'issues', 'story points', 'scrum', 'board', 'get'],
  example: `const sprint = await redmine.getAgileSprint({ sprint_id: 12, include_issues: true })`,
  inputSchema: {
    type: 'object',
    properties: {
      project_id: projectIdProperty,
      sprint_id: sprintIdProperty,
      include_issues: { type: 'boolean', description: "Add the sprint's issues" },
    },
    required: ['sprint_id'],
  },
  outputSchema: successResultSchema(sprintSchema.properties),
  inputExamples: [
    { description: 'Minimal: a sprint with totals', input: { sprint_id: 12 } },
    {
      description: 'Full: a sprint with its issues',
      input: { project_id: 'my-project', sprint_id: 12, include_issues: true },
    },
  ],
};

const getIssueAgileDataTool: Tool = {
  name: 'getIssueAgileData',
  description:
    'Get the agile data of an issue: its sprint, story points, card position on the board and card color. For a kanban board order the cards of a status column by position.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: DEFER,
  keywords: ['redmine', 'agile', 'story points', 'position', 'kanban', 'board', 'card', 'sprint'],
  example: `const { story_points, agile_sprint_id } = await redmine.getIssueAgileData({ issue_id: 12345 })`,
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID from listIssueIds or searchIssueIds' },
    },
    required: ['issue_id'],
  },
  outputSchema: successResultSchema(agileDataSchema),
  inputExamples: [{ description: 'Minimal: agile data of an issue', input: { issue_id: 12345 } }],
};

const setIssueAgileDataTool: Tool = {
  name: 'setIssueAgileData',
  description:
    'Assign an issue to a sprint, unlink it (agile_sprint_id: null) or set its story points. Returns the agile data read back after the write. Redmine documents only the sprint assignment; story_points is not documented as writable, so check the returned story_points against what you sent.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFER,
  keywords: ['redmine', 'agile', 'sprint', 'story points', 'assign', 'set', 'update', 'move'],
  example: `const data = await redmine.setIssueAgileData({ issue_id: 12345, agile_sprint_id: 12, story_points: 5 })
if (data.story_points !== 5) throw new Error('story_points was not saved')`,
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'number', description: 'Issue ID from listIssueIds or searchIssueIds' },
      agile_sprint_id: {
        type: ['number', 'null'],
        description: 'Sprint ID from listAgileSprints, or null to unlink the issue from its sprint',
      },
      story_points: { type: 'number', description: 'Story points' },
    },
    required: ['issue_id'],
  },
  outputSchema: successResultSchema(agileDataSchema),
  inputExamples: [
    {
      description: 'Minimal: put an issue in a sprint',
      input: { issue_id: 12345, agile_sprint_id: 12 },
    },
    {
      description: 'Unlink an issue from its sprint',
      input: { issue_id: 12345, agile_sprint_id: null },
    },
    {
      description: 'Full: sprint and story points',
      input: { issue_id: 12345, agile_sprint_id: 12, story_points: 5 },
    },
  ],
};

const sprintWriteProperties = {
  project_id: projectIdProperty,
  description: descriptionProperty,
  status: statusProperty,
  sharing: sharingProperty,
};

const createAgileSprintTool: Tool = {
  name: 'createAgileSprint',
  description:
    'Create a sprint in a project (RedmineUP Agile; needs the Manage sprints permission, a PRO feature). Dates must not overlap other sprints of the project unless the sprint is shared. Returns the created sprint.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFER,
  keywords: ['redmine', 'agile', 'sprint', 'create', 'new', 'scrum', 'iteration'],
  example: `const sprint = await redmine.createAgileSprint({ name: 'Sprint 12', start_date: '2026-12-01', end_date: '2026-12-14' })`,
  inputSchema: {
    type: 'object',
    properties: {
      ...sprintWriteProperties,
      name: nameProperty,
      start_date: startDateProperty,
      end_date: endDateProperty,
    },
    required: ['name', 'start_date', 'end_date'],
  },
  outputSchema: successResultSchema(sprintSchema.properties),
  inputExamples: [
    {
      description: 'Minimal: a sprint in the configured project',
      input: { name: 'Sprint 12', start_date: '2026-12-01', end_date: '2026-12-14' },
    },
    {
      description: 'Full: an active sprint shared with subprojects',
      input: {
        project_id: 'my-project',
        name: 'Sprint 12',
        start_date: '2026-12-01',
        end_date: '2026-12-14',
        status: 'active',
        sharing: 'descendants',
        description: 'Reports',
      },
    },
  ],
};

const updateAgileSprintTool: Tool = {
  name: 'updateAgileSprint',
  description:
    'Change fields of a sprint (needs the Manage sprints permission). A sprint with open issues cannot be closed. Returns the sprint read back after the write.',
  annotations: WRITE_ANNOTATIONS,
  _meta: DEFER,
  keywords: ['redmine', 'agile', 'sprint', 'update', 'edit', 'close', 'rename', 'scrum'],
  example: `const sprint = await redmine.updateAgileSprint({ sprint_id: 12, status: 'closed' })`,
  inputSchema: {
    type: 'object',
    properties: {
      ...sprintWriteProperties,
      sprint_id: sprintIdProperty,
      name: nameProperty,
      start_date: startDateProperty,
      end_date: endDateProperty,
    },
    required: ['sprint_id'],
  },
  outputSchema: successResultSchema(sprintSchema.properties),
  inputExamples: [
    { description: 'Minimal: close a sprint', input: { sprint_id: 12, status: 'closed' } },
    {
      description: 'Full: rename and move a sprint',
      input: {
        project_id: 'my-project',
        sprint_id: 12,
        name: 'Sprint 12b',
        start_date: '2026-12-02',
        end_date: '2026-12-15',
      },
    },
  ],
};

const deleteAgileSprintTool: Tool = {
  name: 'deleteAgileSprint',
  description:
    'Delete a sprint (needs the Manage sprints permission). Its issues stay and lose only the sprint assignment; this cannot be undone.',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  _meta: DEFER,
  keywords: ['redmine', 'agile', 'sprint', 'delete', 'remove', 'scrum'],
  example: `await redmine.deleteAgileSprint({ sprint_id: 12 })`,
  inputSchema: {
    type: 'object',
    properties: { project_id: projectIdProperty, sprint_id: sprintIdProperty },
    required: ['sprint_id'],
  },
  outputSchema: successResultSchema({ deleted: { type: 'boolean' } }),
  inputExamples: [
    { description: 'Minimal: delete a sprint of the configured project', input: { sprint_id: 12 } },
    {
      description: 'Full: delete a sprint of a named project',
      input: { project_id: 'my-project', sprint_id: 12 },
    },
  ],
};

const TOOLS = [
  listAgileSprintsTool,
  getAgileSprintTool,
  getIssueAgileDataTool,
  setIssueAgileDataTool,
  createAgileSprintTool,
  updateAgileSprintTool,
  deleteAgileSprintTool,
];

/**
 * Tool definitions of the RedmineUP Agile plugin: sprints and the agile data of an issue.
 * @param client - Redmine client, or null when the integration is not configured.
 */
export function createAgileTools(client: AgileClient | null): ToolDefinition[] {
  if (!client) {
    const unconfigured = async () => errorResult(notConfiguredMessage('Redmine'));
    return TOOLS.map((tool) => ({ tool, handler: unconfigured }));
  }

  const handlers: Record<string, ToolDefinition['handler']> = {
    listAgileSprints: projectHandler(
      client,
      (api, project, p) => api.listSprints(project, sprintListFilters(p)),
      wordsError
    ),
    getAgileSprint: projectHandler(client, (api, project, p) =>
      api.getSprint(project, p.sprint_id as number, p.include_issues === true)
    ),
    createAgileSprint: projectHandler(
      client,
      (api, project, p) => api.createSprint(project, sprintFields(p)),
      wordsError
    ),
    updateAgileSprint: projectHandler(
      client,
      (api, project, p) => api.updateSprint(project, p.sprint_id as number, sprintFields(p)),
      updateError
    ),
    deleteAgileSprint: projectHandler(client, async (api, project, p) => {
      await api.deleteSprint(project, p.sprint_id as number);
      return { deleted: true };
    }),
    getIssueAgileData: async (params) =>
      withRedmineErrors({ issue_id: params.issue_id as number }, async () =>
        jsonResult(
          await new AgileApi(client.pluginHost()).getIssueAgileData(params.issue_id as number)
        )
      ),
    setIssueAgileData: async (params) => {
      const checked = normalizeNumericIdParams(
        params,
        params.agile_sprint_id === null ? [] : ['agile_sprint_id']
      );
      if (!checked.ok) return teachingErrorResult(checked.error);
      const { issue_id, agile_sprint_id, story_points } = checked.value as {
        issue_id: number;
        agile_sprint_id?: number | null;
        story_points?: number;
      };
      if (agile_sprint_id === undefined && story_points === undefined) {
        return teachingErrorResult({
          paramName: 'agile_sprint_id or story_points',
          nextStep:
            'Pass agile_sprint_id (a sprint ID, or null to unlink) and/or story_points; nothing was sent to Redmine.',
        });
      }
      return withRedmineErrors({ issue_id }, async () =>
        jsonResult(
          await new AgileApi(client.pluginHost()).setIssueAgileData(issue_id, {
            agile_sprint_id,
            story_points,
          })
        )
      );
    },
  };

  return TOOLS.map((tool) => ({ tool, handler: handlers[tool.name] }));
}

type ProjectCall = (api: AgileApi, project: string, p: Record<string, unknown>) => Promise<unknown>;
type ParamCheck = (p: Record<string, unknown>) => ToolsCallResult | undefined;

function projectHandler(client: AgileClient, call: ProjectCall, check?: ParamCheck) {
  return async (params: Record<string, unknown>): Promise<ToolsCallResult> => {
    const invalid = check?.(params);
    if (invalid) return invalid;
    const api = new AgileApi(client.pluginHost());
    const project_id = params.project_id as string | number | undefined;
    return withRedmineErrors(project_id === undefined ? undefined : { project_id }, async () => {
      const project = await api.resolveProject(project_id);
      if (!project) return noProject(project_id);
      return jsonResult(await call(api, project, params));
    });
  };
}

function noProject(project_id: unknown): ToolsCallResult {
  return teachingErrorResult({
    paramName: 'project_id',
    received: project_id as string | number | undefined,
    correctValueTool: TOOL_NAMES.LIST_PROJECT_IDS,
    nextStep: 'No default project is configured, so pass project_id explicitly.',
  });
}

function sprintListFilters(p: Record<string, unknown>): SprintFilters {
  const filters: Record<string, unknown> = { ...p, limit: clampPageSize(p.limit, 25, 100) };
  delete filters.project_id;
  return filters as SprintFilters;
}

function sprintFields(p: Record<string, unknown>): SprintFields {
  const { name, description, start_date, end_date, status, sharing } = p as SprintFields;
  return { name, description, start_date, end_date, status, sharing };
}

function wordsError(p: Record<string, unknown>): ToolsCallResult | undefined {
  for (const [paramName, words] of [
    ['status', SPRINT_STATUSES],
    ['sharing', SPRINT_SHARINGS],
  ] as const) {
    const value = p[paramName];
    if (value !== undefined && !(words as readonly unknown[]).includes(value)) {
      return teachingErrorResult({
        paramName,
        received: value as string,
        nextStep: `Use one of: ${words.join(', ')}. Nothing was sent to Redmine.`,
      });
    }
  }
  return undefined;
}

function updateError(p: Record<string, unknown>): ToolsCallResult | undefined {
  const invalid = wordsError(p);
  if (invalid) return invalid;
  if (Object.values(sprintFields(p)).every((value) => value === undefined)) {
    return teachingErrorResult({
      paramName: 'name, description, start_date, end_date, status or sharing',
      nextStep: `Pass at least one field to change on sprint ${String(p.sprint_id)}; nothing was sent to Redmine.`,
    });
  }
  return undefined;
}
