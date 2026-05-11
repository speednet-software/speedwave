/**
 * Tests for the Jira projects domain client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createJiraProjectsClient } from './jira-projects.js';
import { ScopeError } from '../scope.js';
import type { AtlassianClient } from '../client.js';

function stubClient(projectKeys: string[] = []) {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
    jiraProjectKeys: projectKeys,
    confluenceSpaceKeys: [] as string[],
  } as unknown as AtlassianClient & { get: ReturnType<typeof vi.fn> };
}

function rawProject(over: Record<string, unknown> = {}) {
  return {
    id: '100',
    key: 'PROJ',
    name: 'Project',
    projectTypeKey: 'software',
    lead: { accountId: 'u1', displayName: 'Lead', active: true },
    self: 'https://acme.atlassian.net/rest/api/3/project/100',
    ...over,
  };
}

let client: ReturnType<typeof stubClient>;
beforeEach(() => {
  client = stubClient();
});

describe('list', () => {
  it('searches projects, caps maxResults, and normalises', async () => {
    client.get.mockResolvedValueOnce({ values: [rawProject()] });
    const c = createJiraProjectsClient(client);
    const res = await c.list({ query: 'pr', maxResults: 999 });
    expect(client.get).toHaveBeenCalledWith('/rest/api/3/project/search', {
      maxResults: 100,
      expand: 'lead',
      query: 'pr',
    });
    expect(res[0]).toMatchObject({
      id: '100',
      key: 'PROJ',
      name: 'Project',
      project_type_key: 'software',
    });
    expect(res[0].url).toBe('https://acme.atlassian.net/browse/PROJ');
  });

  it('filters by the configured allowlist', async () => {
    client = stubClient(['PROJ']);
    client.get.mockResolvedValueOnce({
      values: [rawProject(), rawProject({ key: 'OTHER', id: '2' })],
    });
    const c = createJiraProjectsClient(client);
    const res = await c.list();
    expect(res.map((p) => p.key)).toEqual(['PROJ']);
  });

  it('handles a missing values array and omits query when not given', async () => {
    client.get.mockResolvedValueOnce({});
    const c = createJiraProjectsClient(client);
    expect(await c.list()).toEqual([]);
    expect(client.get).toHaveBeenCalledWith('/rest/api/3/project/search', {
      maxResults: 50,
      expand: 'lead',
    });
  });
});

describe('get', () => {
  it('fetches and normalises a project', async () => {
    client.get.mockResolvedValueOnce(rawProject());
    const c = createJiraProjectsClient(client);
    const p = await c.get('PROJ');
    expect(client.get).toHaveBeenCalledWith('/rest/api/3/project/PROJ', { expand: 'lead' });
    expect(p.key).toBe('PROJ');
    expect(p.lead).toEqual({
      account_id: 'u1',
      display_name: 'Lead',
      email_address: undefined,
      active: true,
    });
  });

  it('enforces the allowlist', async () => {
    client = stubClient(['ALLOWED']);
    client.get.mockResolvedValueOnce(rawProject({ key: 'OTHER' }));
    const c = createJiraProjectsClient(client);
    await expect(c.get('OTHER')).rejects.toThrow(ScopeError);
  });

  it('handles a project with no lead and a bad self URL', async () => {
    client.get.mockResolvedValueOnce(rawProject({ lead: undefined, self: 'nope' }));
    const c = createJiraProjectsClient(client);
    const p = await c.get('PROJ');
    expect(p.lead).toBeNull();
    expect(p.url).toBeUndefined();
  });
});

describe('listIssueTypes', () => {
  it('resolves the project (scope-checked) then lists its issue types', async () => {
    client.get
      .mockResolvedValueOnce(rawProject()) // get(projectIdOrKey)
      .mockResolvedValueOnce([
        { id: '1', name: 'Bug', description: 'A bug', subtask: false },
        { id: '2', name: 'Sub-task', subtask: true },
      ]);
    const c = createJiraProjectsClient(client);
    const types = await c.listIssueTypes('PROJ');
    expect(client.get).toHaveBeenNthCalledWith(2, '/rest/api/3/issuetype/project', {
      projectId: '100',
    });
    expect(types).toEqual([
      { id: '1', name: 'Bug', description: 'A bug', subtask: false },
      { id: '2', name: 'Sub-task', description: undefined, subtask: true },
    ]);
  });

  it('handles a non-array response', async () => {
    client.get.mockResolvedValueOnce(rawProject()).mockResolvedValueOnce({});
    const c = createJiraProjectsClient(client);
    expect(await c.listIssueTypes('PROJ')).toEqual([]);
  });

  it('propagates a scope rejection from the project lookup', async () => {
    client = stubClient(['ALLOWED']);
    client.get.mockResolvedValueOnce(rawProject({ key: 'OTHER' }));
    const c = createJiraProjectsClient(client);
    await expect(c.listIssueTypes('OTHER')).rejects.toThrow(ScopeError);
  });
});

describe('normalisation of minimal payloads', () => {
  it('normalises a project with every optional field absent', async () => {
    client.get.mockResolvedValueOnce({}); // raw project with nothing
    const c = createJiraProjectsClient(client);
    const p = await c.get('X');
    expect(p).toEqual({
      id: '',
      key: '',
      name: '',
      project_type_key: undefined,
      lead: null,
      url: undefined,
    });
  });

  it('normalises an issue type with no description', async () => {
    client.get.mockResolvedValueOnce({}).mockResolvedValueOnce([{}]);
    const c = createJiraProjectsClient(client);
    expect(await c.listIssueTypes('X')).toEqual([
      { id: '', name: '', description: undefined, subtask: false },
    ]);
  });

  it('normalises a project whose self URL is present but the key is empty', async () => {
    client.get.mockResolvedValueOnce({ self: 'https://acme.atlassian.net/rest/api/3/project/9' });
    const c = createJiraProjectsClient(client);
    expect((await c.get('X')).url).toBe('https://acme.atlassian.net/browse/');
  });
});
