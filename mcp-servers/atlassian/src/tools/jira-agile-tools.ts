/**
 * Jira Agile tools — listBoards, getBoard, getBoardConfiguration, listSprints,
 * getSprint, moveIssuesToSprint. 6 tools.
 * @module mcp-atlassian/tools/jira-agile-tools
 */

import {
  type Tool,
  type ToolDefinition,
  jsonResult,
  errorResult,
  notConfiguredMessage,
  teachingErrorResult,
  META_KEYS,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
} from '@speedwave/mcp-shared';
import { AtlassianClient } from '../client.js';
import { createJiraAgileClient } from '../domains/jira-agile.js';
import { withValidation } from './validation.js';

/** Agile API hard cap on issues per `moveIssuesToSprint` call. */
const MOVE_ISSUES_MAX = 50;

const listBoardsTool: Tool = {
  name: 'listBoards',
  description:
    'List Jira Agile boards (restricted to the configured project allowlist, if any; a board with no associated project is excluded whenever an allowlist is configured).',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'agile', 'boards', 'scrum', 'kanban', 'list'],
  example: 'const { boards } = await atlassian.listBoards({ projectKeyOrId: "PROJ" })',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Filter by board name substring' },
      projectKeyOrId: { type: 'string', description: 'Filter to boards of a project' },
      maxResults: { type: 'number', description: 'Max boards (default 50, max 100)' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      boards: { type: 'array' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'All boards', input: {} },
    { description: "A project's boards", input: { projectKeyOrId: 'PROJ' } },
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
  example: 'const board = await atlassian.getBoard({ boardId: 12 })',
  inputSchema: {
    type: 'object',
    properties: { boardId: { type: 'number', description: 'Agile board ID' } },
    required: ['boardId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      board: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'Get a board', input: { boardId: 12 } }],
};

const getBoardConfigurationTool: Tool = {
  name: 'getBoardConfiguration',
  description: "Get a board's configuration (filter ID and column names).",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'agile', 'board', 'configuration', 'columns', 'filter'],
  example: 'const config = await atlassian.getBoardConfiguration({ boardId: 12 })',
  inputSchema: {
    type: 'object',
    properties: { boardId: { type: 'number', description: 'Agile board ID' } },
    required: ['boardId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      configuration: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'Board config', input: { boardId: 12 } }],
};

const listSprintsTool: Tool = {
  name: 'listSprints',
  description: 'List sprints on a Jira Agile board, optionally filtered by state.',
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'agile', 'sprints', 'list', 'board'],
  example: 'const { sprints } = await atlassian.listSprints({ boardId: 12, state: "active" })',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: { type: 'number', description: 'Agile board ID' },
      state: {
        type: 'string',
        enum: ['active', 'future', 'closed'],
        description: 'Sprint state filter',
      },
      maxResults: { type: 'number', description: 'Max sprints (default 50, max 100)' },
    },
    required: ['boardId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      sprints: { type: 'array' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [
    { description: 'All sprints', input: { boardId: 12 } },
    { description: 'Active sprints', input: { boardId: 12, state: 'active' } },
  ],
};

const getSprintTool: Tool = {
  name: 'getSprint',
  description:
    "Get a single Jira Agile sprint by ID. Restricted to the configured project allowlist, if any, via the sprint's board.",
  annotations: READ_ONLY_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'agile', 'sprint', 'get', 'detail'],
  example: 'const sprint = await atlassian.getSprint({ sprintId: 34 })',
  inputSchema: {
    type: 'object',
    properties: { sprintId: { type: 'number', description: 'Sprint ID' } },
    required: ['sprintId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      sprint: { type: 'object' },
      error: { type: 'string' },
    },
    required: ['success'],
  },
  inputExamples: [{ description: 'Get a sprint', input: { sprintId: 34 } }],
};

const moveIssuesToSprintTool: Tool = {
  name: 'moveIssuesToSprint',
  description:
    'Move issues into a sprint. Rejects with a teaching error if more than 50 issueKeysOrIds are given — the Agile API caps a single call at 50; split larger batches into multiple calls.',
  annotations: WRITE_ANNOTATIONS,
  _meta: { [META_KEYS.DEFER_LOADING]: true },
  keywords: ['jira', 'agile', 'sprint', 'move', 'issues', 'assign'],
  example:
    'await atlassian.moveIssuesToSprint({ sprintId: 34, issueKeysOrIds: ["PROJ-1", "PROJ-2"] })',
  inputSchema: {
    type: 'object',
    properties: {
      sprintId: { type: 'number', description: 'Target sprint ID' },
      issueKeysOrIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Issue keys or IDs (max 50 per call — rejected if exceeded)',
      },
    },
    required: ['sprintId', 'issueKeysOrIds'],
  },
  outputSchema: {
    type: 'object',
    properties: { success: { type: 'boolean' }, error: { type: 'string' } },
    required: ['success'],
  },
  inputExamples: [
    {
      description: 'Move two issues',
      input: { sprintId: 34, issueKeysOrIds: ['PROJ-1', 'PROJ-2'] },
    },
  ],
};

/**
 * Build the Jira Agile tool definitions.
 * @param client - The Atlassian client (`null` when not configured).
 * @returns Tool definitions for boards and sprints.
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
  if (!client) {
    const unconfigured = async () => errorResult(notConfiguredMessage('Atlassian'));
    return tools.map((tool) => ({ tool, handler: unconfigured }));
  }
  const agile = createJiraAgileClient(client);

  return [
    {
      tool: listBoardsTool,
      handler: withValidation(client, async (_c, params) => {
        const { name, projectKeyOrId, maxResults } = params as {
          name?: string;
          projectKeyOrId?: string;
          maxResults?: number;
        };
        return jsonResult({ boards: await agile.listBoards({ name, projectKeyOrId, maxResults }) });
      }),
    },
    {
      tool: getBoardTool,
      handler: withValidation(client, async (_c, params) => {
        const { boardId } = params as { boardId: number };
        return jsonResult({ board: await agile.getBoard(boardId) });
      }),
    },
    {
      tool: getBoardConfigurationTool,
      handler: withValidation(client, async (_c, params) => {
        const { boardId } = params as { boardId: number };
        return jsonResult({ configuration: await agile.getBoardConfiguration(boardId) });
      }),
    },
    {
      tool: listSprintsTool,
      handler: withValidation(client, async (_c, params) => {
        const { boardId, state, maxResults } = params as {
          boardId: number;
          state?: 'active' | 'future' | 'closed';
          maxResults?: number;
        };
        return jsonResult({ sprints: await agile.listSprints(boardId, { state, maxResults }) });
      }),
    },
    {
      tool: getSprintTool,
      handler: withValidation(client, async (_c, params) => {
        const { sprintId } = params as { sprintId: number };
        return jsonResult({ sprint: await agile.getSprint(sprintId) });
      }),
    },
    {
      tool: moveIssuesToSprintTool,
      handler: withValidation(client, async (_c, params) => {
        const { sprintId, issueKeysOrIds } = params as {
          sprintId: number;
          issueKeysOrIds: string[];
        };
        if (issueKeysOrIds.length === 0) {
          return teachingErrorResult({
            paramName: 'issueKeysOrIds',
            received: '0 issues',
            nextStep: 'Provide at least one issue key or ID to move into the sprint.',
          });
        }
        if (issueKeysOrIds.length > MOVE_ISSUES_MAX) {
          return teachingErrorResult({
            paramName: 'issueKeysOrIds',
            received: `${issueKeysOrIds.length} issues`,
            nextStep: `The Agile API accepts at most ${MOVE_ISSUES_MAX} issues per call; split this batch into multiple calls of ${MOVE_ISSUES_MAX} or fewer.`,
          });
        }
        await agile.moveIssuesToSprint(sprintId, issueKeysOrIds);
        return jsonResult({ moved: true, count: issueKeysOrIds.length });
      }),
    },
  ];
}
