/**
 * Tests for the Jira Agile tools.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const stub = {
  listBoards: vi.fn(),
  getBoard: vi.fn(),
  getBoardConfiguration: vi.fn(),
  listSprints: vi.fn(),
  getSprint: vi.fn(),
  moveIssuesToSprint: vi.fn(),
};
vi.mock('../domains/jira-agile.js', () => ({ createJiraAgileClient: () => stub }));

import { META_KEYS } from '@speedwave/mcp-shared';
import { createJiraAgileTools } from './jira-agile-tools.js';
import type { AtlassianClient } from '../client.js';

const FAKE_CLIENT = {} as AtlassianClient;
function handlerFor(name: string) {
  const def = createJiraAgileTools(FAKE_CLIENT).find((d) => d.tool.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def.handler;
}
function payload(result: { content: Array<{ text: string }>; isError?: true }): unknown {
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

beforeEach(() => Object.values(stub).forEach((m) => m.mockReset()));

describe('definitions', () => {
  it('exposes the 6 expected tools', () => {
    expect(createJiraAgileTools(FAKE_CLIENT).map((d) => d.tool.name)).toEqual([
      'listBoards',
      'getBoard',
      'getBoardConfiguration',
      'listSprints',
      'getSprint',
      'moveIssuesToSprint',
    ]);
  });
  it('all defer loading and declare required fields', () => {
    for (const { tool } of createJiraAgileTools(FAKE_CLIENT)) {
      expect(tool._meta).toEqual({ [META_KEYS.DEFER_LOADING]: true });
      expect(tool.outputSchema?.required).toContain('success');
    }
  });
  it('getBoard documents the project allowlist restriction it enforces', () => {
    const tool = createJiraAgileTools(FAKE_CLIENT).find((d) => d.tool.name === 'getBoard')?.tool;
    expect(tool?.description).toContain('configured project allowlist');
  });
});

describe('unconfigured', () => {
  it('lists all tools but every handler errors', async () => {
    for (const { handler } of createJiraAgileTools(null))
      expect((await handler({} as never)).isError).toBe(true);
  });
});

describe('handlers', () => {
  it('listBoards forwards filters and wraps the list', async () => {
    stub.listBoards.mockResolvedValueOnce([{ id: 1 }]);
    expect(
      payload(await handlerFor('listBoards')({ name: 'B', projectKeyOrId: 'PROJ', maxResults: 5 }))
    ).toEqual({ boards: [{ id: 1 }] });
    expect(stub.listBoards).toHaveBeenCalledWith({
      name: 'B',
      projectKeyOrId: 'PROJ',
      maxResults: 5,
    });
  });

  it('getBoard wraps the board', async () => {
    stub.getBoard.mockResolvedValueOnce({ id: 7 });
    expect(payload(await handlerFor('getBoard')({ boardId: 7 }))).toEqual({ board: { id: 7 } });
    expect(stub.getBoard).toHaveBeenCalledWith(7);
  });

  it('getBoardConfiguration wraps the configuration', async () => {
    stub.getBoardConfiguration.mockResolvedValueOnce({ id: 7, column_names: [] });
    expect(payload(await handlerFor('getBoardConfiguration')({ boardId: 7 }))).toEqual({
      configuration: { id: 7, column_names: [] },
    });
  });

  it('listSprints forwards state and wraps the list', async () => {
    stub.listSprints.mockResolvedValueOnce([{ id: 1 }]);
    expect(
      payload(await handlerFor('listSprints')({ boardId: 7, state: 'active', maxResults: 5 }))
    ).toEqual({ sprints: [{ id: 1 }] });
    expect(stub.listSprints).toHaveBeenCalledWith(7, { state: 'active', maxResults: 5 });
  });

  it('getSprint wraps the sprint', async () => {
    stub.getSprint.mockResolvedValueOnce({ id: 34 });
    expect(payload(await handlerFor('getSprint')({ sprintId: 34 }))).toEqual({
      sprint: { id: 34 },
    });
  });

  it('moveIssuesToSprint rejects a batch over 50 with a teaching error and does not call the domain', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `PROJ-${i}`);
    const result = await handlerFor('moveIssuesToSprint')({ sprintId: 34, issueKeysOrIds: many });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/issueKeysOrIds/);
    expect(result.content[0].text).toMatch(/50/);
    expect(stub.moveIssuesToSprint).not.toHaveBeenCalled();
  });

  it('moveIssuesToSprint accepts exactly 50 issues', async () => {
    stub.moveIssuesToSprint.mockResolvedValueOnce(undefined);
    const fifty = Array.from({ length: 50 }, (_, i) => `PROJ-${i}`);
    expect(
      payload(await handlerFor('moveIssuesToSprint')({ sprintId: 34, issueKeysOrIds: fifty }))
    ).toEqual({ moved: true, count: 50 });
    expect(stub.moveIssuesToSprint).toHaveBeenCalledWith(34, fifty);
  });

  it('moveIssuesToSprint counts a small batch exactly', async () => {
    stub.moveIssuesToSprint.mockResolvedValueOnce(undefined);
    expect(
      payload(await handlerFor('moveIssuesToSprint')({ sprintId: 34, issueKeysOrIds: ['PROJ-1'] }))
    ).toEqual({ moved: true, count: 1 });
  });

  it('surfaces a domain error', async () => {
    stub.getBoard.mockRejectedValueOnce(new Error('boom'));
    expect((await handlerFor('getBoard')({ boardId: 7 })).isError).toBe(true);
  });
});
