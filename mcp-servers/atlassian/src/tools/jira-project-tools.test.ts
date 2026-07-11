/**
 * Tests for the Jira project tools.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { META_KEYS } from '@speedwave/mcp-shared';

const stub = { list: vi.fn(), get: vi.fn(), listIssueTypes: vi.fn() };
vi.mock('../domains/jira-projects.js', () => ({ createJiraProjectsClient: () => stub }));

import { createJiraProjectTools } from './jira-project-tools.js';
import type { AtlassianClient } from '../client.js';

const FAKE_CLIENT = {} as AtlassianClient;
function handlerFor(name: string) {
  const def = createJiraProjectTools(FAKE_CLIENT).find((d) => d.tool.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def.handler;
}
function payload(result: { content: Array<{ text: string }>; isError?: true }): unknown {
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

beforeEach(() => Object.values(stub).forEach((m) => m.mockReset()));

describe('definitions', () => {
  it('exposes the 3 expected tools', () => {
    expect(createJiraProjectTools(FAKE_CLIENT).map((d) => d.tool.name)).toEqual([
      'listProjects',
      'getProject',
      'listIssueTypes',
    ]);
  });
  it('listProjects is shown upfront; the rest defer loading', () => {
    const byName = Object.fromEntries(
      createJiraProjectTools(FAKE_CLIENT).map((d) => [d.tool.name, d.tool])
    );
    expect(byName.listProjects._meta).toEqual({ [META_KEYS.DEFER_LOADING]: false });
    expect(byName.getProject._meta).toEqual({ [META_KEYS.DEFER_LOADING]: true });
  });
});

describe('unconfigured', () => {
  it('lists all tools but every handler errors', async () => {
    for (const { handler } of createJiraProjectTools(null))
      expect((await handler({} as never)).isError).toBe(true);
  });
});

describe('listProjects', () => {
  it('forwards query/maxResults and wraps the list', async () => {
    stub.list.mockResolvedValueOnce([{ key: 'PROJ' }]);
    expect(payload(await handlerFor('listProjects')({ query: 'p', maxResults: 5 }))).toEqual({
      projects: [{ key: 'PROJ' }],
    });
    expect(stub.list).toHaveBeenCalledWith({ query: 'p', maxResults: 5 });
  });
  it('works with no params', async () => {
    stub.list.mockResolvedValueOnce([]);
    await handlerFor('listProjects')({});
    expect(stub.list).toHaveBeenCalledWith({ query: undefined, maxResults: undefined });
  });
  it('surfaces errors', async () => {
    stub.list.mockRejectedValueOnce(new Error('x'));
    expect((await handlerFor('listProjects')({})).isError).toBe(true);
  });
});

describe('getProject', () => {
  it('wraps the project', async () => {
    stub.get.mockResolvedValueOnce({ key: 'PROJ' });
    expect(payload(await handlerFor('getProject')({ projectIdOrKey: 'PROJ' }))).toEqual({
      project: { key: 'PROJ' },
    });
    expect(stub.get).toHaveBeenCalledWith('PROJ');
  });
});

describe('listIssueTypes', () => {
  it('wraps the list under `issue_types`', async () => {
    stub.listIssueTypes.mockResolvedValueOnce([{ id: '1', name: 'Bug' }]);
    expect(payload(await handlerFor('listIssueTypes')({ projectIdOrKey: 'PROJ' }))).toEqual({
      issue_types: [{ id: '1', name: 'Bug' }],
    });
    expect(stub.listIssueTypes).toHaveBeenCalledWith('PROJ');
  });
});
