/**
 * Tests for the Jira Agile (boards/sprints) domain client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createJiraAgileClient } from './jira-agile.js';
import { ScopeError } from '../adf.js';
import type { AtlassianClient } from '../client.js';

function stubClient(projectKeys: string[] = []) {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
    jiraProjectKeys: projectKeys,
    confluenceSpaceKeys: [] as string[],
  } as unknown as AtlassianClient & {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  };
}

const rawBoard = (over: Record<string, unknown> = {}) => ({
  id: 7,
  name: 'Board',
  type: 'scrum',
  location: { projectKey: 'PROJ' },
  ...over,
});
const rawSprint = (over: Record<string, unknown> = {}) => ({
  id: 42,
  name: 'Sprint 1',
  state: 'active',
  originBoardId: 7,
  goal: 'ship it',
  startDate: 's',
  endDate: 'e',
  ...over,
});

let client: ReturnType<typeof stubClient>;
beforeEach(() => {
  client = stubClient();
});

describe('listBoards', () => {
  it('lists boards with capped maxResults and optional filters, normalised', async () => {
    client.get.mockResolvedValueOnce({ values: [rawBoard()] });
    const c = createJiraAgileClient(client);
    const res = await c.listBoards({ name: 'B', projectKeyOrId: 'PROJ', maxResults: 999 });
    expect(client.get).toHaveBeenCalledWith('/rest/agile/1.0/board', {
      maxResults: 100,
      name: 'B',
      projectKeyOrId: 'PROJ',
    });
    expect(res[0]).toEqual({ id: 7, name: 'Board', type: 'scrum', project_key: 'PROJ' });
  });

  it('filters boards by the allowlist and handles a missing values array', async () => {
    client = stubClient(['PROJ']);
    client.get.mockResolvedValueOnce({
      values: [rawBoard(), rawBoard({ id: 8, location: { projectKey: 'OTHER' } })],
    });
    const c = createJiraAgileClient(client);
    expect((await c.listBoards()).map((b) => b.id)).toEqual([7]);
  });

  it('handles a board with no location', async () => {
    client.get.mockResolvedValueOnce({ values: [rawBoard({ location: undefined })] });
    const c = createJiraAgileClient(client);
    expect((await c.listBoards())[0].project_key).toBeUndefined();
  });
});

describe('getBoard / getBoardConfiguration', () => {
  it('gets a board (scope-checked)', async () => {
    client.get.mockResolvedValueOnce(rawBoard());
    const c = createJiraAgileClient(client);
    expect(await c.getBoard(7)).toEqual({
      id: 7,
      name: 'Board',
      type: 'scrum',
      project_key: 'PROJ',
    });
    expect(client.get).toHaveBeenCalledWith('/rest/agile/1.0/board/7');
  });

  it('rejects a board outside the allowlist', async () => {
    client = stubClient(['ALLOWED']);
    client.get.mockResolvedValueOnce(rawBoard({ location: { projectKey: 'OTHER' } }));
    const c = createJiraAgileClient(client);
    await expect(c.getBoard(7)).rejects.toThrow(ScopeError);
  });

  it('gets board configuration', async () => {
    client.get
      .mockResolvedValueOnce(rawBoard()) // enforceBoard
      .mockResolvedValueOnce({
        id: 7,
        name: 'Board',
        filter: { id: '900' },
        columnConfig: { columns: [{ name: 'To Do' }, { name: 'Done' }] },
      });
    const c = createJiraAgileClient(client);
    expect(await c.getBoardConfiguration(7)).toEqual({
      id: 7,
      name: 'Board',
      filter_id: '900',
      column_names: ['To Do', 'Done'],
    });
  });

  it('handles a configuration with no filter/columns', async () => {
    client.get.mockResolvedValueOnce(rawBoard()).mockResolvedValueOnce({ id: 7, name: 'B' });
    const c = createJiraAgileClient(client);
    expect(await c.getBoardConfiguration(7)).toEqual({
      id: 7,
      name: 'B',
      filter_id: undefined,
      column_names: [],
    });
  });
});

describe('sprints', () => {
  it('lists sprints with optional state', async () => {
    client.get
      .mockResolvedValueOnce(rawBoard()) // enforceBoard
      .mockResolvedValueOnce({ values: [rawSprint()] });
    const c = createJiraAgileClient(client);
    const res = await c.listSprints(7, { state: 'active', maxResults: 999 });
    expect(client.get).toHaveBeenNthCalledWith(2, '/rest/agile/1.0/board/7/sprint', {
      maxResults: 100,
      state: 'active',
    });
    expect(res[0]).toMatchObject({
      id: 42,
      name: 'Sprint 1',
      state: 'active',
      board_id: 7,
      goal: 'ship it',
    });
  });

  it('falls back board_id to the requested board when not on the payload', async () => {
    client.get
      .mockResolvedValueOnce(rawBoard())
      .mockResolvedValueOnce({ values: [rawSprint({ originBoardId: undefined })] });
    const c = createJiraAgileClient(client);
    expect((await c.listSprints(7))[0].board_id).toBe(7);
  });

  it('gets a sprint and scope-checks its board', async () => {
    client.get
      .mockResolvedValueOnce(rawSprint()) // get sprint
      .mockResolvedValueOnce(rawBoard()); // enforceBoard
    const c = createJiraAgileClient(client);
    expect(await c.getSprint(42)).toMatchObject({ id: 42, board_id: 7 });
  });

  it('gets a sprint with no board id (no scope check needed)', async () => {
    client.get.mockResolvedValueOnce(rawSprint({ originBoardId: undefined }));
    const c = createJiraAgileClient(client);
    expect((await c.getSprint(42)).board_id).toBeUndefined();
  });
});

describe('moveIssuesToSprint', () => {
  it('scope-checks the sprint board then POSTs up to 50 issues', async () => {
    client.get
      .mockResolvedValueOnce({ originBoardId: 7 }) // sprint lookup
      .mockResolvedValueOnce(rawBoard()); // enforceBoard
    client.post.mockResolvedValueOnce(undefined);
    const c = createJiraAgileClient(client);
    const many = Array.from({ length: 60 }, (_, i) => `PROJ-${i}`);
    await c.moveIssuesToSprint(42, many);
    const sent = client.post.mock.calls[0];
    expect(sent[0]).toBe('/rest/agile/1.0/sprint/42/issue');
    expect((sent[1] as { issues: string[] }).issues).toHaveLength(50);
  });

  it('skips the board scope check when the sprint has no originBoardId', async () => {
    client.get.mockResolvedValueOnce({}); // sprint lookup, no originBoardId
    client.post.mockResolvedValueOnce(undefined);
    const c = createJiraAgileClient(client);
    await c.moveIssuesToSprint(42, ['PROJ-1']);
    expect(client.post).toHaveBeenCalledWith('/rest/agile/1.0/sprint/42/issue', {
      issues: ['PROJ-1'],
    });
  });

  it('rejects when the sprint board is outside the allowlist', async () => {
    client = stubClient(['ALLOWED']);
    client.get
      .mockResolvedValueOnce({ originBoardId: 7 })
      .mockResolvedValueOnce(rawBoard({ location: { projectKey: 'OTHER' } }));
    const c = createJiraAgileClient(client);
    await expect(c.moveIssuesToSprint(42, ['OTHER-1'])).rejects.toThrow(ScopeError);
  });
});

describe('normalisation of minimal payloads', () => {
  it('normalises a board with nothing set', async () => {
    client.get.mockResolvedValueOnce({});
    const c = createJiraAgileClient(client);
    expect(await c.getBoard(7)).toEqual({ id: 0, name: '', type: '', project_key: undefined });
  });

  it('normalises a sprint with nothing set (board_id from the fallback)', async () => {
    client.get.mockResolvedValueOnce({}).mockResolvedValueOnce({ values: [{}] });
    const c = createJiraAgileClient(client);
    expect((await c.listSprints(7))[0]).toEqual({
      id: 0,
      name: '',
      state: '',
      board_id: 7,
      goal: undefined,
      start_date: undefined,
      end_date: undefined,
      complete_date: undefined,
    });
  });

  it('normalises a sprint with complete_date set', async () => {
    client.get.mockResolvedValueOnce(rawSprint({ completeDate: 'cd', state: 'closed' }));
    client.get.mockResolvedValueOnce(rawBoard());
    const c = createJiraAgileClient(client);
    expect((await c.getSprint(42)).complete_date).toBe('cd');
  });

  it('normalises a board configuration with no name/filter and columns with no names', async () => {
    client.get
      .mockResolvedValueOnce(rawBoard())
      .mockResolvedValueOnce({ columnConfig: { columns: [{}, {}] } });
    const c = createJiraAgileClient(client);
    expect(await c.getBoardConfiguration(7)).toEqual({
      id: 0,
      name: '',
      filter_id: undefined,
      column_names: ['', ''],
    });
  });

  it('handles a board missing the values array (empty list)', async () => {
    client.get.mockResolvedValueOnce({});
    const c = createJiraAgileClient(client);
    expect(await c.listBoards()).toEqual([]);
  });

  it('handles a sprint list missing the values array', async () => {
    client.get.mockResolvedValueOnce(rawBoard()).mockResolvedValueOnce({});
    const c = createJiraAgileClient(client);
    expect(await c.listSprints(7)).toEqual([]);
  });
});
