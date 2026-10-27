/**
 * Jira Agile tools (boards, board configuration, sprints, moving issues into a sprint). 6 tools.
 * @module mcp-atlassian/tools/jira-agile-tools
 */

import {
  type Tool,
  type ToolDefinition,
  jsonResult,
  teachingErrorResult,
  withDeclaredParams,
  META_KEYS,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { AtlassianClient } from '../client.js';
import { createJiraAgileClient, MOVE_ISSUES_MAX } from '../domains/jira-agile.js';
import {
  boardConfigurationSchema,
  boardSchema,
  boardsSchema,
  sprintSchema,
  sprintsSchema,
} from './jira-schemas.js';
import { unconfiguredDefinitions, withValidation } from './validation.js';

const listBoardsTool: Tool = {
  name: 'listBoards',
  description:
    'List Jira Agile boards (restricted to the configured project allowlist, if any; a board with no associated project is excluded whenever an allowlist is configured).',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'agile', 'boards', 'scrum', 'kanban', 'list'],
  example: 'const { boards } = await atlassian.listBoards({ project: "PROJ" })',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Filter by board name substring' },
      project: { type: 'string', description: 'Filter to boards of a project (key or ID)' },
      max_results: { type: 'number', description: 'Max boards (default 50, max 100)' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      boards: boardsSchema,
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'All boards', input: {} },
    { description: "A project's boards", input: { project: 'PROJ' } },
    { description: 'By name', input: { name: 'Sprint Board' } },
  ],
};

const getBoardTool: Tool = {
  name: 'getBoard',
  description:
    'Get a single Jira Agile board by ID. Restricted to the configured project allowlist, if any.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'agile', 'board', 'get', 'detail'],
  example: 'const board = await atlassian.getBoard({ board_id: 12 })',
  inputSchema: {
    type: 'object',
    properties: { board_id: { type: 'number', description: 'Agile board ID' } },
    required: ['board_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      board: boardSchema,
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'Get a board', input: { board_id: 12 } }],
};

const getBoardConfigurationTool: Tool = {
  name: 'getBoardConfiguration',
  description: "Get a board's configuration (filter ID and column names).",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'agile', 'board', 'configuration', 'columns', 'filter'],
  example: 'const config = await atlassian.getBoardConfiguration({ board_id: 12 })',
  inputSchema: {
    type: 'object',
    properties: { board_id: { type: 'number', description: 'Agile board ID' } },
    required: ['board_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      configuration: boardConfigurationSchema,
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'Board config', input: { board_id: 12 } }],
};

const listSprintsTool: Tool = {
  name: 'listSprints',
  description: 'List sprints on a Jira Agile board, optionally filtered by state.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'agile', 'sprints', 'list', 'board'],
  example: 'const { sprints } = await atlassian.listSprints({ board_id: 12, state: "active" })',
  inputSchema: {
    type: 'object',
    properties: {
      board_id: { type: 'number', description: 'Agile board ID' },
      state: {
        type: 'string',
        enum: ['active', 'future', 'closed'],
        description: 'Sprint state filter',
      },
      max_results: { type: 'number', description: 'Max sprints (default 50, max 100)' },
    },
    required: ['board_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      sprints: sprintsSchema,
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'All sprints', input: { board_id: 12 } },
    { description: 'Active sprints', input: { board_id: 12, state: 'active' } },
  ],
};

const getSprintTool: Tool = {
  name: 'getSprint',
  description:
    "Get a single Jira Agile sprint by ID. Restricted to the configured project allowlist, if any, via the sprint's board.",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'agile', 'sprint', 'get', 'detail'],
  example: 'const sprint = await atlassian.getSprint({ sprint_id: 34 })',
  inputSchema: {
    type: 'object',
    properties: { sprint_id: { type: 'number', description: 'Sprint ID' } },
    required: ['sprint_id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      sprint: sprintSchema,
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'Get a sprint', input: { sprint_id: 34 } }],
};

const moveIssuesToSprintTool: Tool = {
  name: 'moveIssuesToSprint',
  description: `Move issues into a sprint. Rejects with a teaching error if more than ${MOVE_ISSUES_MAX} issues are given: the Agile API caps a single call at ${MOVE_ISSUES_MAX}; split larger batches into multiple calls.`,
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'agile', 'sprint', 'move', 'issues', 'assign'],
  example: 'await atlassian.moveIssuesToSprint({ sprint_id: 34, issues: ["PROJ-1", "PROJ-2"] })',
  inputSchema: {
    type: 'object',
    properties: {
      sprint_id: { type: 'number', description: 'Target sprint ID' },
      issues: {
        type: 'array',
        items: { type: 'string' },
        description: `Issue keys or IDs (max ${MOVE_ISSUES_MAX} per call, rejected if exceeded)`,
      },
    },
    required: ['sprint_id', 'issues'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      moved: { type: 'boolean' },
      count: { type: 'number' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Move two issues',
      input: { sprint_id: 34, issues: ['PROJ-1', 'PROJ-2'] },
    },
  ],
};

/**
 * Build the Jira Agile tool definitions.
 * @param client - The Atlassian client (`null` when not configured).
 */
export function createJiraAgileTools(client: AtlassianClient | null): ToolDefinition[] {
  const tools = [
    listBoardsTool,
    getBoardTool,
    getBoardConfigurationTool,
    listSprintsTool,
    getSprintTool,
    moveIssuesToSprintTool,
  ];
  if (!client) return unconfiguredDefinitions(tools);
  const agile = createJiraAgileClient(client);

  const definitions: ToolDefinition[] = [
    {
      tool: listBoardsTool,
      handler: withValidation(client, async (_c, params) => {
        const { name, project, max_results } = params as {
          name?: string;
          project?: string;
          max_results?: number;
        };
        return jsonResult({
          boards: await agile.listBoards({ name, project, maxResults: max_results }),
        });
      }),
    },
    {
      tool: getBoardTool,
      handler: withValidation(client, async (_c, params) => {
        const { board_id } = params as { board_id: number };
        return jsonResult({ board: await agile.getBoard(board_id) });
      }),
    },
    {
      tool: getBoardConfigurationTool,
      handler: withValidation(client, async (_c, params) => {
        const { board_id } = params as { board_id: number };
        return jsonResult({ configuration: await agile.getBoardConfiguration(board_id) });
      }),
    },
    {
      tool: listSprintsTool,
      handler: withValidation(client, async (_c, params) => {
        const { board_id, state, max_results } = params as {
          board_id: number;
          state?: 'active' | 'future' | 'closed';
          max_results?: number;
        };
        return jsonResult({
          sprints: await agile.listSprints(board_id, { state, maxResults: max_results }),
        });
      }),
    },
    {
      tool: getSprintTool,
      handler: withValidation(client, async (_c, params) => {
        const { sprint_id } = params as { sprint_id: number };
        return jsonResult({ sprint: await agile.getSprint(sprint_id) });
      }),
    },
    {
      tool: moveIssuesToSprintTool,
      handler: withValidation(client, async (_c, params) => {
        const { sprint_id, issues } = params as { sprint_id: number; issues: string[] };
        if (issues.length === 0) {
          return teachingErrorResult({
            paramName: 'issues',
            received: '0 issues',
            nextStep: 'Provide at least one issue key or ID to move into the sprint.',
          });
        }
        if (issues.length > MOVE_ISSUES_MAX) {
          return teachingErrorResult({
            paramName: 'issues',
            received: `${issues.length} issues`,
            nextStep: `The Agile API accepts at most ${MOVE_ISSUES_MAX} issues per call; split this batch into multiple calls of ${MOVE_ISSUES_MAX} or fewer.`,
          });
        }
        await agile.moveIssuesToSprint(sprint_id, issues);
        return jsonResult({ moved: true, count: issues.length });
      }),
    },
  ];
  return definitions.map(({ tool, handler }) => ({
    tool,
    handler: withDeclaredParams(tool, handler),
  }));
}
