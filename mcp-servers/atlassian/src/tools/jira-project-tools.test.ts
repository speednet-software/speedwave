import { describe, it, expect, vi, beforeEach } from 'vitest';
import { META_KEYS, type ToolsCallResult } from '@speedwave/mcp-shared';
import { createJiraProjectTools } from './jira-project-tools.js';
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
  const def = createJiraProjectTools(asClient()).find((d) => d.tool.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def.handler;
}

const textOf = (result: ToolsCallResult) => (result.content[0] as { text: string }).text;

function payload(result: ToolsCallResult): Record<string, unknown> {
  expect(result.isError).toBeUndefined();
  return JSON.parse(textOf(result));
}

const rawProject = (over: Record<string, unknown> = {}) => ({
  id: '100',
  key: 'PROJ',
  name: 'Project',
  projectTypeKey: 'software',
  lead: { accountId: 'u1', displayName: 'Lead', active: true },
  self: 'https://acme.atlassian.net/rest/api/3/project/100',
  ...over,
});

beforeEach(() => {
  client.get.mockReset();
  client.jiraProjectKeys = [];
});

describe('definitions', () => {
  it('exposes the 4 expected tools', () => {
    expect(createJiraProjectTools(asClient()).map((d) => d.tool.name)).toEqual([
      'listProjects',
      'getProject',
      'listIssueTypes',
      'listComponents',
    ]);
  });

  it('declares snake_case parameters and examples that use only declared ones', () => {
    for (const { tool } of createJiraProjectTools(asClient())) {
      const declared = Object.keys(tool.inputSchema.properties);
      for (const name of declared) expect(name, tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const example of tool.inputExamples ?? []) {
        expect(declared, `${tool.name}: ${example.description}`).toEqual(
          expect.arrayContaining(Object.keys(example.input))
        );
      }
    }
  });

  it('carries discovery metadata and success in every output schema', () => {
    for (const { tool } of createJiraProjectTools(asClient())) {
      expect(tool.keywords?.length).toBeGreaterThan(0);
      expect(tool.outputSchema?.required).toContain('success');
      expect(tool._meta).toHaveProperty(META_KEYS.DEFER_LOADING);
    }
  });

  it('documents the project allowlist on listIssueTypes', () => {
    const tool = createJiraProjectTools(asClient()).find(
      (d) => d.tool.name === 'listIssueTypes'
    )?.tool;
    expect(tool?.description).toContain('allowlist');
  });
});

describe('unconfigured', () => {
  it('lists all tools but every handler errors', async () => {
    const defs = createJiraProjectTools(null);
    expect(defs).toHaveLength(4);
    for (const { handler } of defs) {
      expect((await handler({ project: 'PROJ' })).isError).toBe(true);
    }
  });

  it('rejects an undeclared parameter before reporting the missing configuration', async () => {
    const result = await createJiraProjectTools(null)[1].handler({ projectIdOrKey: 'PROJ' });
    expect(textOf(result)).toContain('getProject does not accept this parameter');
  });
});

describe('listProjects', () => {
  it('passes query and max_results and returns normalised projects', async () => {
    client.get.mockResolvedValueOnce({ values: [rawProject()] });

    const result = payload(await handlerFor('listProjects')({ query: 'pr', max_results: 5 }));

    expect(client.get).toHaveBeenCalledWith('/rest/api/3/project/search', {
      maxResults: 5,
      expand: 'lead',
      query: 'pr',
    });
    expect(result).toEqual({
      projects: [
        {
          id: '100',
          key: 'PROJ',
          name: 'Project',
          project_type_key: 'software',
          lead: { account_id: 'u1', name: 'Lead' },
          url: 'https://acme.atlassian.net/browse/PROJ',
        },
      ],
    });
  });

  it('filters by the configured allowlist', async () => {
    client.jiraProjectKeys = ['PROJ'];
    client.get.mockResolvedValueOnce({
      values: [rawProject(), rawProject({ key: 'OTHER', id: '2' })],
    });

    const result = payload(await handlerFor('listProjects')({}));

    expect((result.projects as Array<{ key: string }>).map((p) => p.key)).toEqual(['PROJ']);
  });

  it('rejects the old camelCase parameter', async () => {
    const result = await handlerFor('listProjects')({ maxResults: 5 });

    expect(result.isError).toBe(true);
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe('getProject', () => {
  it('fetches a project by the project parameter', async () => {
    client.get.mockResolvedValueOnce(rawProject());

    const result = payload(await handlerFor('getProject')({ project: 'PROJ' }));

    expect(client.get).toHaveBeenCalledWith('/rest/api/3/project/PROJ', { expand: 'lead' });
    expect(result.project).toMatchObject({ key: 'PROJ', name: 'Project' });
  });

  it('rejects a project outside the allowlist', async () => {
    client.jiraProjectKeys = ['ALLOWED'];
    client.get.mockResolvedValueOnce(rawProject({ key: 'OTHER' }));

    expect((await handlerFor('getProject')({ project: 'OTHER' })).isError).toBe(true);
  });

  it('rejects the old projectIdOrKey parameter', async () => {
    const result = await handlerFor('getProject')({ projectIdOrKey: 'PROJ' });

    expect(result.isError).toBe(true);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('returns a project with every optional field absent', async () => {
    client.get.mockResolvedValueOnce({});

    const result = payload(await handlerFor('getProject')({ project: 'X' }));

    expect(result.project).toEqual({ id: '', key: '', name: '', lead: null });
  });
});

describe('listIssueTypes', () => {
  const projectTypes = [
    { id: '1', name: 'Bug', description: 'A bug', subtask: false },
    { id: '2', name: 'Task', subtask: false },
    { id: '3', name: 'Sub-task', subtask: true },
  ];

  it('lists the issue types of a project', async () => {
    client.get.mockResolvedValueOnce(rawProject()).mockResolvedValueOnce(projectTypes);

    const result = payload(await handlerFor('listIssueTypes')({ project: 'PROJ' }));

    expect(client.get).toHaveBeenNthCalledWith(2, '/rest/api/3/issuetype/project', {
      projectId: '100',
    });
    expect(result).toEqual({
      issue_types: [
        { id: '1', name: 'Bug', description: 'A bug', subtask: false },
        { id: '2', name: 'Task', subtask: false },
        { id: '3', name: 'Sub-task', subtask: true },
      ],
    });
  });

  it('returns an empty list when Jira answers with a non-array', async () => {
    client.get.mockResolvedValueOnce(rawProject()).mockResolvedValueOnce({});

    expect(payload(await handlerFor('listIssueTypes')({ project: 'PROJ' }))).toEqual({
      issue_types: [],
    });
  });

  it('lists the types an issue can change to: same kind as the current type, current one excluded', async () => {
    client.get
      .mockResolvedValueOnce({
        fields: {
          issuetype: { id: '1', name: 'Bug', subtask: false },
          project: { key: 'PROJ' },
        },
      })
      .mockResolvedValueOnce({ issueTypes: projectTypes });

    const result = payload(await handlerFor('listIssueTypes')({ issue: 'PROJ-7' }));

    expect(client.get).toHaveBeenNthCalledWith(1, '/rest/api/3/issue/PROJ-7', {
      fields: 'issuetype,project',
    });
    expect(client.get).toHaveBeenNthCalledWith(2, '/rest/api/3/issue/createmeta/PROJ/issuetypes', {
      startAt: 0,
      maxResults: 100,
    });
    expect(result).toEqual({ issue_types: [{ id: '2', name: 'Task', subtask: false }] });
  });

  it('keeps only sub-task types for a sub-task issue', async () => {
    client.get
      .mockResolvedValueOnce({
        fields: { issuetype: { id: '3', subtask: true }, project: { key: 'PROJ' } },
      })
      .mockResolvedValueOnce({
        issueTypes: [...projectTypes, { id: '4', name: 'Review', subtask: true }],
      });

    const result = payload(await handlerFor('listIssueTypes')({ issue: '10042' }));

    expect(result).toEqual({ issue_types: [{ id: '4', name: 'Review', subtask: true }] });
  });

  it('reads the createMetaIssueType key and pages until total is reached', async () => {
    client.get
      .mockResolvedValueOnce({
        fields: { issuetype: { id: '1', subtask: false }, project: { key: 'PROJ' } },
      })
      .mockResolvedValueOnce({
        createMetaIssueType: [{ id: '2', name: 'Task', subtask: false }],
        startAt: 0,
        total: 2,
      })
      .mockResolvedValueOnce({
        issueTypes: [{ id: '5', name: 'Spike', subtask: false }],
        startAt: 1,
        total: 2,
      });

    const result = payload(await handlerFor('listIssueTypes')({ issue: 'PROJ-7' }));

    expect(client.get).toHaveBeenNthCalledWith(3, '/rest/api/3/issue/createmeta/PROJ/issuetypes', {
      startAt: 1,
      maxResults: 100,
    });
    expect(result).toEqual({
      issue_types: [
        { id: '2', name: 'Task', subtask: false },
        { id: '5', name: 'Spike', subtask: false },
      ],
    });
  });

  it('stops paging when a page comes back empty', async () => {
    client.get
      .mockResolvedValueOnce({
        fields: { issuetype: { id: '1', subtask: false }, project: { key: 'PROJ' } },
      })
      .mockResolvedValueOnce({ issueTypes: [], total: 3 });

    expect(payload(await handlerFor('listIssueTypes')({ issue: 'PROJ-7' }))).toEqual({
      issue_types: [],
    });
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it('returns an empty list when createmeta lists no issue types', async () => {
    client.get
      .mockResolvedValueOnce({
        fields: { issuetype: { id: '1', subtask: false }, project: { key: 'PROJ' } },
      })
      .mockResolvedValueOnce({});

    expect(payload(await handlerFor('listIssueTypes')({ issue: 'PROJ-7' }))).toEqual({
      issue_types: [],
    });
  });

  it('refuses an issue whose project is outside the allowlist before reading createmeta', async () => {
    client.jiraProjectKeys = ['ALLOWED'];
    client.get.mockResolvedValueOnce({
      fields: { issuetype: { id: '1', subtask: false }, project: { key: 'OTHER' } },
    });

    const result = await handlerFor('listIssueTypes')({ issue: 'ALLOWED-1' });

    expect(result.isError).toBe(true);
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('refuses an issue key outside the allowlist without calling Jira', async () => {
    client.jiraProjectKeys = ['ALLOWED'];

    const result = await handlerFor('listIssueTypes')({ issue: 'OTHER-1' });

    expect(result.isError).toBe(true);
    expect(client.get).not.toHaveBeenCalled();
  });

  it.each([
    ['both', { project: 'PROJ', issue: 'PROJ-1' }],
    ['neither', {}],
  ])('requires exactly one of project and issue (%s given)', async (_label, params) => {
    const result = await handlerFor('listIssueTypes')(params);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('project or issue');
    expect(client.get).not.toHaveBeenCalled();
  });

  it('rejects the old projectIdOrKey parameter', async () => {
    const result = await handlerFor('listIssueTypes')({ projectIdOrKey: 'PROJ' });

    expect(result.isError).toBe(true);
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe('listComponents', () => {
  it('lists the components of a project after the allowlist check', async () => {
    client.get.mockResolvedValueOnce(rawProject()).mockResolvedValueOnce([
      { id: '10', name: 'core', description: 'Core engine', self: 'x' },
      { id: '11', name: 'ui' },
    ]);

    const result = payload(await handlerFor('listComponents')({ project: 'PROJ' }));

    expect(client.get).toHaveBeenNthCalledWith(2, '/rest/api/3/project/PROJ/components');
    expect(result).toEqual({
      components: [
        { id: '10', name: 'core', description: 'Core engine' },
        { id: '11', name: 'ui' },
      ],
    });
  });

  it('resolves a numeric project id to its key before listing', async () => {
    client.get.mockResolvedValueOnce(rawProject()).mockResolvedValueOnce([]);

    await handlerFor('listComponents')({ project: '100' });

    expect(client.get).toHaveBeenNthCalledWith(2, '/rest/api/3/project/PROJ/components');
  });

  it('returns an empty list when Jira answers with a non-array', async () => {
    client.get.mockResolvedValueOnce(rawProject()).mockResolvedValueOnce({});

    expect(payload(await handlerFor('listComponents')({ project: 'PROJ' }))).toEqual({
      components: [],
    });
  });

  it('refuses a project outside the allowlist before listing components', async () => {
    client.jiraProjectKeys = ['ALLOWED'];
    client.get.mockResolvedValueOnce(rawProject({ key: 'OTHER' }));

    const result = await handlerFor('listComponents')({ project: 'OTHER' });

    expect(result.isError).toBe(true);
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('requires project', async () => {
    const result = await handlerFor('listComponents')({});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('project');
  });
});
