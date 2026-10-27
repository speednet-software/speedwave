import { describe, it, expect, vi, beforeEach } from 'vitest';
import { META_KEYS, type ToolsCallResult } from '@speedwave/mcp-shared';
import { createJiraAgileTools } from './jira-agile-tools.js';
import { declaredFields } from './jira-test-helpers.js';
import type { AtlassianClient } from '../client.js';

const client = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  jiraProjectKeys: [] as string[],
  confluenceSpaceKeys: [] as string[],
};

const asClient = () => client as unknown as AtlassianClient;

function handlerFor(name: string) {
  const def = createJiraAgileTools(asClient()).find((d) => d.tool.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def.handler;
}

const textOf = (result: ToolsCallResult) => (result.content[0] as { text: string }).text;

function payload(result: ToolsCallResult): Record<string, unknown> {
  expect(result.isError).toBeUndefined();
  return JSON.parse(textOf(result));
}

const rawBoard = (over: Record<string, unknown> = {}) => ({
  id: 7,
  name: 'Board',
  type: 'scrum',
  location: { projectKey: 'PROJ' },
  ...over,
});

const rawSprint = (over: Record<string, unknown> = {}) => ({
  id: 34,
  name: 'Sprint 1',
  state: 'active',
  originBoardId: 7,
  goal: 'ship it',
  startDate: 's',
  endDate: 'e',
  ...over,
});

beforeEach(() => {
  client.get.mockReset();
  client.post.mockReset();
  client.jiraProjectKeys = [];
});

describe('definitions', () => {
  it('exposes the 6 expected tools', () => {
    expect(createJiraAgileTools(asClient()).map((d) => d.tool.name)).toEqual([
      'listBoards',
      'getBoard',
      'getBoardConfiguration',
      'listSprints',
      'getSprint',
      'moveIssuesToSprint',
    ]);
  });

  it('declares snake_case parameters and examples that use only declared ones', () => {
    for (const { tool } of createJiraAgileTools(asClient())) {
      const declared = Object.keys(tool.inputSchema.properties);
      for (const name of declared) expect(name, tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const example of tool.inputExamples ?? []) {
        expect(declared, `${tool.name}: ${example.description}`).toEqual(
          expect.arrayContaining(Object.keys(example.input))
        );
      }
    }
  });

  it('defers loading and requires success in every output schema', () => {
    for (const { tool } of createJiraAgileTools(asClient())) {
      expect(tool._meta).toEqual({ [META_KEYS.DEFER_LOADING]: true });
      expect(tool.outputSchema?.required).toContain('success');
    }
  });

  it('documents the project allowlist restriction on getBoard', () => {
    const tool = createJiraAgileTools(asClient()).find((d) => d.tool.name === 'getBoard')?.tool;
    expect(tool?.description).toContain('configured project allowlist');
  });

  it('names the emitted move result keys in the moveIssuesToSprint output schema', () => {
    const tool = createJiraAgileTools(asClient()).find(
      (d) => d.tool.name === 'moveIssuesToSprint'
    )?.tool;
    expect(Object.keys(tool!.outputSchema!.properties).sort()).toEqual([
      'count',
      'error',
      'moved',
      'success',
    ]);
  });
});

describe('unconfigured', () => {
  it('lists all tools but every handler errors', async () => {
    for (const { tool, handler } of createJiraAgileTools(null)) {
      const result = await handler(tool.inputExamples![0].input);
      expect(result.isError, tool.name).toBe(true);
      expect(textOf(result), tool.name).toContain('not configured');
    }
  });

  it('rejects an undeclared parameter before reporting the missing configuration', async () => {
    const result = await createJiraAgileTools(null)[1].handler({ boardId: 1 });
    expect(textOf(result)).toContain('getBoard does not accept this parameter');
  });
});

describe('listBoards', () => {
  it('passes name, project and max_results and returns normalised boards', async () => {
    client.get.mockResolvedValueOnce({ values: [rawBoard()] });

    const result = payload(
      await handlerFor('listBoards')({ name: 'B', project: 'PROJ', max_results: 5 })
    );

    expect(client.get).toHaveBeenCalledWith('/rest/agile/1.0/board', {
      maxResults: 5,
      name: 'B',
      projectKeyOrId: 'PROJ',
    });
    expect(result).toEqual({
      boards: [{ id: 7, name: 'Board', type: 'scrum', project_key: 'PROJ' }],
      count: 1,
    });
  });

  it('filters by the configured allowlist', async () => {
    client.jiraProjectKeys = ['PROJ'];
    client.get.mockResolvedValueOnce({
      values: [rawBoard(), rawBoard({ id: 8, location: { projectKey: 'OTHER' } })],
    });

    const result = payload(await handlerFor('listBoards')({}));

    expect((result.boards as Array<{ id: number }>).map((b) => b.id)).toEqual([7]);
  });

  it('rejects the old projectKeyOrId parameter', async () => {
    const result = await handlerFor('listBoards')({ projectKeyOrId: 'PROJ' });

    expect(result.isError).toBe(true);
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe('getBoard', () => {
  it('returns the board', async () => {
    client.get.mockResolvedValueOnce(rawBoard());

    expect(payload(await handlerFor('getBoard')({ board_id: 7 }))).toEqual({
      board: { id: 7, name: 'Board', type: 'scrum', project_key: 'PROJ' },
    });
    expect(client.get).toHaveBeenCalledWith('/rest/agile/1.0/board/7');
  });

  it('rejects a board of a project outside the allowlist', async () => {
    client.jiraProjectKeys = ['ALLOWED'];
    client.get.mockResolvedValueOnce(rawBoard());

    expect((await handlerFor('getBoard')({ board_id: 7 })).isError).toBe(true);
  });

  it('surfaces client errors', async () => {
    client.get.mockRejectedValueOnce(new Error('boom'));

    expect((await handlerFor('getBoard')({ board_id: 7 })).isError).toBe(true);
  });

  it('rejects the old boardId parameter', async () => {
    const result = await handlerFor('getBoard')({ boardId: 7 });

    expect(result.isError).toBe(true);
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe('getBoardConfiguration', () => {
  it('returns filter id and column names', async () => {
    client.get.mockResolvedValueOnce(rawBoard()).mockResolvedValueOnce({
      id: 7,
      name: 'Board',
      filter: { id: '900' },
      columnConfig: { columns: [{ name: 'To Do' }, { name: 'Done' }] },
    });

    expect(payload(await handlerFor('getBoardConfiguration')({ board_id: 7 }))).toEqual({
      configuration: { id: 7, name: 'Board', filter_id: '900', column_names: ['To Do', 'Done'] },
    });
    expect(client.get).toHaveBeenNthCalledWith(2, '/rest/agile/1.0/board/7/configuration');
  });
});

describe('listSprints', () => {
  it('passes state and max_results and returns normalised sprints', async () => {
    client.get.mockResolvedValueOnce(rawBoard()).mockResolvedValueOnce({ values: [rawSprint()] });

    const result = payload(
      await handlerFor('listSprints')({ board_id: 7, state: 'active', max_results: 5 })
    );

    expect(client.get).toHaveBeenNthCalledWith(2, '/rest/agile/1.0/board/7/sprint', {
      maxResults: 5,
      state: 'active',
    });
    expect(result).toEqual({
      sprints: [
        {
          id: 34,
          name: 'Sprint 1',
          state: 'active',
          board_id: 7,
          goal: 'ship it',
          start_date: 's',
          end_date: 'e',
        },
      ],
      count: 1,
    });
  });

  it('returns an empty list when Jira omits values', async () => {
    client.get.mockResolvedValueOnce(rawBoard()).mockResolvedValueOnce({});

    expect(payload(await handlerFor('listSprints')({ board_id: 7 }))).toEqual({
      sprints: [],
      count: 0,
    });
  });
});

describe('getSprint', () => {
  it('returns the sprint after checking its board', async () => {
    client.get.mockResolvedValueOnce(rawSprint()).mockResolvedValueOnce(rawBoard());

    const result = payload(await handlerFor('getSprint')({ sprint_id: 34 }));

    expect(client.get).toHaveBeenNthCalledWith(1, '/rest/agile/1.0/sprint/34');
    expect(result.sprint).toMatchObject({ id: 34, board_id: 7 });
  });

  it('refuses a sprint without a board while an allowlist is active', async () => {
    client.jiraProjectKeys = ['PROJ'];
    client.get.mockResolvedValueOnce(rawSprint({ originBoardId: undefined }));

    expect((await handlerFor('getSprint')({ sprint_id: 34 })).isError).toBe(true);
  });

  it('allows a sprint without a board when no allowlist is active', async () => {
    client.get.mockResolvedValueOnce(rawSprint({ originBoardId: undefined }));

    expect(payload(await handlerFor('getSprint')({ sprint_id: 34 })).sprint).toMatchObject({
      id: 34,
    });
  });
});

describe('moveIssuesToSprint', () => {
  const sprintWithBoard = () => {
    client.get.mockResolvedValueOnce(rawSprint()).mockResolvedValueOnce(rawBoard());
    client.post.mockResolvedValueOnce(undefined);
  };

  it('moves issues and reports the count', async () => {
    sprintWithBoard();

    const result = payload(
      await handlerFor('moveIssuesToSprint')({ sprint_id: 34, issues: ['PROJ-1', 'PROJ-2'] })
    );

    expect(client.post).toHaveBeenCalledWith('/rest/agile/1.0/sprint/34/issue', {
      issues: ['PROJ-1', 'PROJ-2'],
    });
    expect(result).toEqual({ moved: true, count: 2 });
  });

  it('accepts exactly 50 issues', async () => {
    sprintWithBoard();
    const fifty = Array.from({ length: 50 }, (_, i) => `PROJ-${i}`);

    expect(
      payload(await handlerFor('moveIssuesToSprint')({ sprint_id: 34, issues: fifty }))
    ).toEqual({ moved: true, count: 50 });
  });

  it('rejects an empty list without calling Jira', async () => {
    const result = await handlerFor('moveIssuesToSprint')({ sprint_id: 34, issues: [] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('issues');
    expect(client.get).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });

  it('rejects a batch over 50 without calling Jira', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `PROJ-${i}`);

    const result = await handlerFor('moveIssuesToSprint')({ sprint_id: 34, issues: many });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/50/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('refuses an issue outside the allowlist without moving anything', async () => {
    client.jiraProjectKeys = ['PROJ'];
    client.get.mockResolvedValueOnce(rawSprint()).mockResolvedValueOnce(rawBoard());

    const result = await handlerFor('moveIssuesToSprint')({
      sprint_id: 34,
      issues: ['PROJ-1', 'OTHER-1'],
    });

    expect(result.isError).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('rejects the old issueKeysOrIds parameter', async () => {
    const result = await handlerFor('moveIssuesToSprint')({
      sprint_id: 34,
      issueKeysOrIds: ['PROJ-1'],
    });

    expect(result.isError).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe('output schemas', () => {
  it('declare every field of the boards, configuration and sprints the tools return', async () => {
    const tools = createJiraAgileTools(asClient());
    const fullSprint = rawSprint({ completeDate: 'c' });
    client.get
      .mockResolvedValueOnce({ values: [rawBoard()] })
      .mockResolvedValueOnce(rawBoard())
      .mockResolvedValueOnce(rawBoard())
      .mockResolvedValueOnce({
        id: 7,
        name: 'Board',
        filter: { id: '900' },
        columnConfig: { columns: [{ name: 'To Do' }] },
      })
      .mockResolvedValueOnce(rawBoard())
      .mockResolvedValueOnce({ values: [fullSprint] })
      .mockResolvedValueOnce(fullSprint)
      .mockResolvedValueOnce(rawBoard());

    const boards = payload(await handlerFor('listBoards')({}));
    const board = payload(await handlerFor('getBoard')({ board_id: 7 }));
    const configuration = payload(await handlerFor('getBoardConfiguration')({ board_id: 7 }));
    const sprints = payload(await handlerFor('listSprints')({ board_id: 7 }));
    const sprint = payload(await handlerFor('getSprint')({ sprint_id: 34 }));

    expect(Object.keys((boards.boards as object[])[0]).sort()).toEqual(
      declaredFields(tools, 'listBoards', 'boards')
    );
    expect(Object.keys(board.board as object).sort()).toEqual(
      declaredFields(tools, 'getBoard', 'board')
    );
    expect(Object.keys(configuration.configuration as object).sort()).toEqual(
      declaredFields(tools, 'getBoardConfiguration', 'configuration')
    );
    expect(Object.keys((sprints.sprints as object[])[0]).sort()).toEqual(
      declaredFields(tools, 'listSprints', 'sprints')
    );
    expect(Object.keys(sprint.sprint as object).sort()).toEqual(
      declaredFields(tools, 'getSprint', 'sprint')
    );
  });
});
