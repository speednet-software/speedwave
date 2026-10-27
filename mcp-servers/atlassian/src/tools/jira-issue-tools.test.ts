/**
 * Tests for the Jira issue tools: metadata, the declared-parameter guard, the emitted JSON against
 * each outputSchema, request shaping and Jira 400 translation. Only `AtlassianClient` is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AxiosError, type AxiosResponse } from 'axios';
import { META_KEYS, type ToolsCallResult } from '@speedwave/mcp-shared';
import { createJiraIssueTools } from './jira-issue-tools.js';
import type { AtlassianClient } from '../client.js';

const client = {
  jiraProjectKeys: [] as string[],
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  uploadAttachment: vi.fn(),
};
const CLIENT = client as unknown as AtlassianClient;

const RAW_ISSUE = {
  key: 'PROJ-7',
  id: '10007',
  self: 'https://acme.atlassian.net/rest/api/3/issue/10007',
  fields: {
    summary: 'Story',
    description: {
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }],
    },
    issuetype: { name: 'Story' },
    status: { name: 'To Do' },
    project: { key: 'PROJ' },
    priority: { name: 'High' },
    labels: ['a'],
    components: [{ name: 'core' }],
    parent: {
      key: 'PROJ-1',
      fields: { summary: 'Epic', issuetype: { name: 'Epic' }, status: { name: 'Open' } },
    },
    issuelinks: [
      {
        id: '900',
        type: { inward: 'is blocked by', outward: 'blocks' },
        inwardIssue: { key: 'PROJ-2', fields: { summary: 'Other', status: { name: 'Open' } } },
      },
    ],
    assignee: { accountId: 'u1', displayName: 'Ann' },
    reporter: { accountId: 'u2', displayName: 'Bob' },
    created: '2026-01-01',
    updated: '2026-01-02',
  },
};

const LINK_TYPES = {
  issueLinkTypes: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }],
};

function defs(c: AtlassianClient | null = CLIENT) {
  return createJiraIssueTools(c);
}

function run(name: string, params: Record<string, unknown>): Promise<ToolsCallResult> {
  const def = defs().find((d) => d.tool.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def.handler(params);
}

function textOf(result: ToolsCallResult): string {
  return (result.content[0] as { text: string }).text;
}

function payload(result: ToolsCallResult): Record<string, unknown> {
  expect(result.isError).toBeUndefined();
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

function schemaKeys(schema: unknown): string[] {
  return Object.keys((schema as { properties: Record<string, unknown> }).properties).sort();
}

function expectEmittedMatchesSchema(name: string, emitted: Record<string, unknown>): void {
  const tool = defs().find((d) => d.tool.name === name)!.tool;
  const declared = schemaKeys(tool.outputSchema).filter((k) => k !== 'success' && k !== 'error');
  expect(Object.keys(emitted).sort()).toEqual(declared);
}

function badRequest(data: unknown): AxiosError {
  return new AxiosError(
    'Request failed with status code 400',
    'ERR_BAD_REQUEST',
    undefined,
    undefined,
    {
      status: 400,
      data,
    } as AxiosResponse
  );
}

function serverError(): AxiosError {
  return new AxiosError(
    'Request failed with status code 500',
    'ERR_BAD_RESPONSE',
    undefined,
    undefined,
    {
      status: 500,
      data: {},
    } as AxiosResponse
  );
}

beforeEach(() => {
  client.jiraProjectKeys = [];
  for (const m of [client.get, client.post, client.put, client.del, client.uploadAttachment]) {
    m.mockReset();
  }
});

describe('definitions', () => {
  it('exposes the 14 issue tools with snake_case parameters', () => {
    expect(defs().map((d) => d.tool.name)).toEqual([
      'searchIssues',
      'getIssue',
      'createIssue',
      'updateIssue',
      'deleteIssue',
      'linkIssues',
      'unlinkIssues',
      'listLinkTypes',
      'getTransitions',
      'transitionIssue',
      'assignIssue',
      'getMyself',
      'addAttachment',
      'deleteAttachment',
    ]);
    for (const { tool } of defs()) {
      for (const name of Object.keys(tool.inputSchema.properties)) {
        expect(name, `${tool.name}.${name}`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('gives every tool keywords, an example, input examples and an outputSchema with success', () => {
    for (const { tool } of defs()) {
      expect(tool.keywords?.length).toBeGreaterThan(0);
      expect(typeof tool.example).toBe('string');
      expect(tool.outputSchema?.required).toContain('success');
      expect(tool.inputExamples?.length).toBeGreaterThan(0);
    }
  });

  it('marks deleteIssue, unlinkIssues and deleteAttachment destructive and reads read-only', () => {
    const byName = Object.fromEntries(defs().map((d) => [d.tool.name, d.tool]));
    for (const name of ['deleteIssue', 'unlinkIssues', 'deleteAttachment']) {
      expect(byName[name].annotations?.destructiveHint, name).toBe(true);
    }
    for (const name of [
      'searchIssues',
      'getIssue',
      'listLinkTypes',
      'getTransitions',
      'getMyself',
    ]) {
      expect(byName[name].annotations?.readOnlyHint, name).toBe(true);
    }
  });

  it('declares identity metadata on the tools that take an assignee or answer "my" queries', () => {
    const userScoped = new Set(['searchIssues', 'createIssue', 'updateIssue', 'assignIssue']);
    for (const { tool } of defs()) {
      const meta = tool._meta as Record<string, unknown>;
      if (userScoped.has(tool.name)) {
        expect(meta[META_KEYS.USER_SCOPED], tool.name).toBe(true);
        expect(meta[META_KEYS.CURRENT_USER_TOOL], tool.name).toBe('getMyself');
      } else {
        expect(meta[META_KEYS.USER_SCOPED], tool.name).toBeFalsy();
      }
      expect(meta.userScoped).toBeUndefined();
      expect(meta.currentUserTool).toBeUndefined();
    }
  });
});

describe('declared-parameter guard', () => {
  describe.each(defs(null).map((d) => [d.tool.name, d] as const))('%s', (_name, def) => {
    it('rejects an undeclared argument before anything is sent', async () => {
      for (const d of [def, defs().find((x) => x.tool.name === def.tool.name)!]) {
        const result = await d.handler({ not_a_declared_param: 1 });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(`${def.tool.name} does not accept this parameter`);
      }
      for (const m of [client.get, client.post, client.put, client.del]) {
        expect(m).not.toHaveBeenCalled();
      }
    });

    it('declares every argument its input examples use', async () => {
      const declared = Object.keys(def.tool.inputSchema.properties);
      for (const example of def.tool.inputExamples ?? []) {
        expect(declared, example.description).toEqual(
          expect.arrayContaining(Object.keys(example.input))
        );
        const result = await def.handler(example.input);
        expect(textOf(result), example.description).toMatch(/not configured/i);
      }
    });
  });

  it('rejects an old camelCase parameter instead of dropping it', async () => {
    const result = await run('getIssue', { issueIdOrKey: 'PROJ-1' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Accepted parameters: issue');
    expect(client.get).not.toHaveBeenCalled();
  });

  it('rejects a missing required argument', async () => {
    const result = await run('linkIssues', { issue: 'PROJ-1', relation: 'blocks' });
    expect(textOf(result)).toContain('linkIssues requires target');
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe('emitted JSON matches outputSchema', () => {
  it('getIssue emits exactly the declared issue keys', async () => {
    client.get.mockResolvedValueOnce(RAW_ISSUE);
    const emitted = payload(await run('getIssue', { issue: 'PROJ-7' }));
    expectEmittedMatchesSchema('getIssue', emitted);
    const tool = defs().find((d) => d.tool.name === 'getIssue')!.tool;
    const issueSchema = (tool.outputSchema as { properties: { issue: unknown } }).properties.issue;
    expect(Object.keys(emitted.issue as object).sort()).toEqual(schemaKeys(issueSchema));
    expect(emitted.issue).toMatchObject({
      key: 'PROJ-7',
      description: 'Body',
      type: 'Story',
      project: 'PROJ',
      components: ['core'],
      parent: { key: 'PROJ-1', summary: 'Epic', type: 'Epic', status: 'Open' },
      links: [{ id: '900', relation: 'is blocked by', issue: { key: 'PROJ-2' } }],
      assignee: { account_id: 'u1', name: 'Ann' },
    });
  });

  it('searchIssues emits next_page_token and is_last, and issues without description', async () => {
    const { description: _omitted, ...searchFields } = RAW_ISSUE.fields;
    client.post.mockResolvedValueOnce({
      issues: [{ ...RAW_ISSUE, fields: searchFields }],
      nextPageToken: 't',
      isLast: false,
    });
    const emitted = payload(await run('searchIssues', { jql: 'project = PROJ' }));
    expectEmittedMatchesSchema('searchIssues', emitted);
    const tool = defs().find((d) => d.tool.name === 'searchIssues')!.tool;
    const items = (tool.outputSchema as { properties: { issues: { items: unknown } } }).properties
      .issues.items;
    const issue = (emitted.issues as object[])[0];
    expect(Object.keys(issue).sort()).toEqual(schemaKeys(items));
    expect(issue).not.toHaveProperty('description');
  });

  it('createIssue and updateIssue emit the issue under `issue`', async () => {
    client.post.mockResolvedValueOnce({ key: 'PROJ-7' });
    client.get.mockResolvedValue(RAW_ISSUE);
    client.put.mockResolvedValueOnce(undefined);
    expectEmittedMatchesSchema(
      'createIssue',
      payload(await run('createIssue', { project: 'PROJ', type: 'Story', summary: 'S' }))
    );
    expectEmittedMatchesSchema(
      'updateIssue',
      payload(await run('updateIssue', { issue: 'PROJ-7', summary: 'S' }))
    );
  });

  it('flag, list and account tools emit exactly their declared keys', async () => {
    client.del.mockResolvedValue(undefined);
    client.post.mockResolvedValue(undefined);
    client.put.mockResolvedValue(undefined);
    client.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/issueLinkType')) return LINK_TYPES;
      if (url.endsWith('/transitions')) {
        return { transitions: [{ id: '5', name: 'Go', to: { name: 'Done' } }] };
      }
      return { accountId: 'u1', displayName: 'Ann' };
    });
    client.uploadAttachment.mockResolvedValue([
      {
        id: '1',
        filename: 'f',
        size: 1,
        mimeType: 'text/plain',
        created: 'c',
        content: 'u',
        author: { accountId: 'u1', displayName: 'Ann' },
      },
    ]);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['deleteIssue', { issue: 'PROJ-1' }],
      ['linkIssues', { issue: 'PROJ-1', relation: 'blocks', target: 'PROJ-2' }],
      ['unlinkIssues', { link_id: '9' }],
      ['listLinkTypes', {}],
      ['getTransitions', { issue: 'PROJ-1' }],
      ['transitionIssue', { issue: 'PROJ-1', transition_id: '5' }],
      ['assignIssue', { issue: 'PROJ-1', assignee: 'u1' }],
      ['getMyself', {}],
      ['deleteAttachment', { attachment_id: '1' }],
    ];
    for (const [name, params] of cases) {
      expectEmittedMatchesSchema(name, payload(await run(name, params)));
    }
  });

  it('addAttachment emits an attachment object with the declared keys', async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'atl-ws-')));
    const prev = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = ws;
    writeFileSync(join(ws, 'f.txt'), 'x');
    client.uploadAttachment.mockResolvedValueOnce([
      {
        id: '1',
        filename: 'f.txt',
        size: 1,
        mimeType: 'text/plain',
        created: 'c',
        content: 'u',
        author: { accountId: 'u1', displayName: 'Ann' },
      },
    ]);
    const emitted = payload(await run('addAttachment', { issue: 'PROJ-1', file_path: 'f.txt' }));
    expectEmittedMatchesSchema('addAttachment', emitted);
    const tool = defs().find((d) => d.tool.name === 'addAttachment')!.tool;
    const attachmentSchema = (tool.outputSchema as { properties: { attachment: unknown } })
      .properties.attachment;
    expect(Object.keys(emitted.attachment as object).sort()).toEqual(schemaKeys(attachmentSchema));
    if (prev === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = prev;
    rmSync(ws, { recursive: true, force: true });
  });
});

describe('searchIssues', () => {
  it('maps max_results and next_page_token to the search request', async () => {
    client.post.mockResolvedValueOnce({ issues: [], isLast: true });
    await run('searchIssues', { jql: 'x', max_results: 5, next_page_token: 't0' });
    const [url, body] = client.post.mock.calls[0];
    expect(url).toBe('/rest/api/3/search/jql');
    expect(body).toMatchObject({ jql: 'x', maxResults: 5, nextPageToken: 't0' });
  });

  it('surfaces a failure as an error result', async () => {
    client.post.mockRejectedValueOnce(new Error('boom'));
    const result = await run('searchIssues', { jql: 'x' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/boom/);
  });
});

describe('createIssue', () => {
  it('sends caller-shaped fields as Jira REST and returns the re-fetched issue', async () => {
    client.post.mockResolvedValueOnce({ key: 'PROJ-7' });
    client.get.mockImplementation(async (url: string) =>
      url.endsWith('/components')
        ? [{ id: '1', name: 'core' }]
        : url.includes('/project/')
          ? { id: '10', key: 'PROJ' }
          : RAW_ISSUE
    );
    await run('createIssue', {
      project: 'PROJ',
      type: 'Sub-task',
      summary: 'S',
      description: 'Hello',
      priority: 'High',
      labels: ['x'],
      parent: 'PROJ-1',
      components: ['core'],
      assignee: 'u1',
    });
    const [url, body] = client.post.mock.calls[0];
    expect(url).toBe('/rest/api/3/issue');
    expect(body.fields).toMatchObject({
      project: { key: 'PROJ' },
      issuetype: { name: 'Sub-task' },
      summary: 'S',
      priority: { name: 'High' },
      labels: ['x'],
      parent: { key: 'PROJ-1' },
      components: [{ name: 'core' }],
      assignee: { accountId: 'u1' },
    });
    expect(body.fields.description.type).toBe('doc');
  });

  it('resolves assignee "me" through /myself', async () => {
    client.get.mockImplementation(async (url: string) =>
      url.endsWith('/myself') ? { accountId: 'me-id', displayName: 'Me' } : RAW_ISSUE
    );
    client.post.mockResolvedValueOnce({ key: 'PROJ-7' });
    await run('createIssue', { project: 'PROJ', type: 'Task', summary: 'S', assignee: 'me' });
    expect(client.post.mock.calls[0][1].fields.assignee).toEqual({ accountId: 'me-id' });
  });

  it('rejects description together with description_adf before sending', async () => {
    const result = await run('createIssue', {
      project: 'PROJ',
      type: 'Task',
      summary: 'S',
      description: 'a',
      description_adf: { version: 1, type: 'doc', content: [] },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('description and description_adf');
    expect(textOf(result)).toContain('not both');
    expect(client.post).not.toHaveBeenCalled();
  });

  it('teaches parent when Jira rejects a sub-task without one (errors.parent)', async () => {
    client.post.mockRejectedValueOnce(badRequest({ errors: { parent: 'Parent is required' } }));
    const result = await run('createIssue', { project: 'PROJ', type: 'Sub-task', summary: 'S' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid parent.');
    expect(textOf(result)).toContain('Sub-task type needs parent');
    expect(textOf(result)).toContain('nothing was created');
    expect(textOf(result)).toContain('Parent is required');
  });

  it('teaches parent when the 400 carries the hint in errorMessages', async () => {
    client.post.mockRejectedValueOnce(
      badRequest({ errorMessages: ['Sub-task must have a parent issue'] })
    );
    const result = await run('createIssue', { project: 'PROJ', type: 'Sub-task', summary: 'S' });
    expect(textOf(result)).toContain('Invalid parent.');
    expect(textOf(result)).toContain('Sub-task must have a parent issue');
  });

  it('rejects a component name the project does not have before sending', async () => {
    client.get.mockImplementation(async (url: string) =>
      url.endsWith('/components')
        ? [
            { id: '1', name: 'core' },
            { id: '2', name: 'docs' },
          ]
        : { id: '10', key: 'PROJ' }
    );
    const result = await run('createIssue', {
      project: 'PROJ',
      type: 'Task',
      summary: 'S',
      components: ['core', 'nope'],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid components.');
    expect(textOf(result)).toContain('Get a valid value from listComponents.');
    expect(textOf(result)).toContain('nothing was created');
    expect(textOf(result)).toContain('Available components: core, docs.');
    expect(textOf(result)).not.toContain('nope');
    expect(client.post).not.toHaveBeenCalled();
  });

  it('says the project has no components when the list is empty', async () => {
    client.get.mockImplementation(async (url: string) =>
      url.endsWith('/components') ? [] : { id: '10', key: 'PROJ' }
    );
    const result = await run('createIssue', {
      project: 'PROJ',
      type: 'Task',
      summary: 'S',
      components: ['core'],
    });
    expect(textOf(result)).toContain('Available components: none.');
  });

  it('teaches parent when Jira refuses a sub-task type sent without one', async () => {
    client.post.mockRejectedValueOnce(
      badRequest({ errors: { issuetype: 'Typ zgłoszenia jest podzadaniem' } })
    );
    client.get.mockImplementation(async (url: string) =>
      url.endsWith('/issuetype/project')
        ? [
            { id: '1', name: 'Zadanie', subtask: false },
            { id: '2', name: 'Podzadanie', subtask: true },
          ]
        : { id: '10', key: 'PROJ' }
    );
    const result = await run('createIssue', { project: 'PROJ', type: 'Podzadanie', summary: 'S' });
    expect(textOf(result)).toContain('Invalid parent.');
    expect(textOf(result)).toContain('nothing was created');
    expect(textOf(result)).toContain('Jira said: Typ zgłoszenia jest podzadaniem');
    expect(textOf(result)).not.toContain('listIssueTypes');
  });

  it('keeps pointing a refused standard type to listIssueTypes when no parent was sent', async () => {
    client.post.mockRejectedValueOnce(badRequest({ errors: { issuetype: 'invalid' } }));
    client.get.mockImplementation(async (url: string) =>
      url.endsWith('/issuetype/project')
        ? [{ id: '2', name: 'Podzadanie', subtask: true }]
        : { id: '10', key: 'PROJ' }
    );
    const result = await run('createIssue', { project: 'PROJ', type: 'Zadanie', summary: 'S' });
    expect(textOf(result)).toContain('Get a valid value from listIssueTypes.');
  });

  it('points an invalid issue type to listIssueTypes with the project', async () => {
    client.post.mockRejectedValueOnce(
      badRequest({ errors: { issuetype: 'The issue type selected is invalid.' } })
    );
    const result = await run('createIssue', { project: 'PROJ', type: 'Nope', summary: 'S' });
    expect(textOf(result)).toContain('Get a valid value from listIssueTypes.');
    expect(textOf(result)).toContain('listIssueTypes with project "PROJ"');
  });

  it.each([
    ['an unrecognised 400', badRequest({ errors: { summary: 'Summary is required' } })],
    ['a 500', serverError()],
    ['a plain error', new Error('boom')],
  ])('passes %s through the existing error path', async (_label, error) => {
    client.post.mockRejectedValueOnce(error);
    const result = await run('createIssue', { project: 'PROJ', type: 'Task', summary: 'S' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('Invalid ');
  });

  it('passes a 400 without a body through the existing error path', async () => {
    client.post.mockRejectedValueOnce(badRequest(undefined));
    const result = await run('createIssue', { project: 'PROJ', type: 'Task', summary: 'S' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Atlassian request error (400)');
  });
});

describe('updateIssue', () => {
  it('sends only provided fields, with parent null detaching and type changing', async () => {
    client.put.mockResolvedValueOnce(undefined);
    client.get.mockResolvedValueOnce(RAW_ISSUE);
    await run('updateIssue', {
      issue: 'PROJ-7',
      type: 'Story',
      parent: null,
      components: [],
      assignee: null,
    });
    const [url, body] = client.put.mock.calls[0];
    expect(url).toBe('/rest/api/3/issue/PROJ-7');
    expect(body.fields).toEqual({
      issuetype: { name: 'Story' },
      parent: null,
      components: [],
      assignee: null,
    });
  });

  it('rejects description together with description_adf before sending', async () => {
    const result = await run('updateIssue', {
      issue: 'PROJ-7',
      description: 'a',
      description_adf: { version: 1, type: 'doc', content: [] },
    });
    expect(textOf(result)).toContain('not both');
    expect(client.put).not.toHaveBeenCalled();
  });

  it('points a refused type change to listIssueTypes with the issue', async () => {
    client.put.mockRejectedValueOnce(
      badRequest({ errors: { issuetype: 'Issue type cannot be changed to a sub-task' } })
    );
    const result = await run('updateIssue', { issue: 'PROJ-7', type: 'Sub-task' });
    expect(textOf(result)).toContain('Get a valid value from listIssueTypes.');
    expect(textOf(result)).toContain('listIssueTypes with issue "PROJ-7"');
    expect(textOf(result)).toContain('nothing was changed');
  });

  it('checks component names against the project of the issue before sending', async () => {
    client.get.mockImplementation(async (url: string) =>
      url.endsWith('/components')
        ? [{ id: '1', name: 'core' }]
        : url.includes('/project/')
          ? { id: '10', key: 'PROJ' }
          : RAW_ISSUE
    );
    const result = await run('updateIssue', { issue: 'PROJ-7', components: ['nope'] });
    expect(textOf(result)).toContain('Invalid components.');
    expect(textOf(result)).toContain('Project PROJ has no component');
    expect(textOf(result)).toContain('nothing was changed');
    expect(client.put).not.toHaveBeenCalled();
  });

  it('sends known component names', async () => {
    client.get.mockImplementation(async (url: string) =>
      url.endsWith('/components')
        ? [{ id: '1', name: 'core' }]
        : url.includes('/project/')
          ? { id: '10', key: 'PROJ' }
          : RAW_ISSUE
    );
    client.put.mockResolvedValueOnce(undefined);
    await run('updateIssue', { issue: 'PROJ-7', components: ['core'] });
    expect(client.put.mock.calls[0][1].fields.components).toEqual([{ name: 'core' }]);
  });

  it('teaches parent on a parent rejection', async () => {
    client.put.mockRejectedValueOnce(badRequest({ errors: { parent: 'Invalid parent' } }));
    const result = await run('updateIssue', { issue: 'PROJ-7', parent: 'PROJ-1' });
    expect(textOf(result)).toContain('Invalid parent.');
  });

  it('passes an unrecognised failure through', async () => {
    client.put.mockRejectedValueOnce(new Error('boom-update'));
    const result = await run('updateIssue', { issue: 'PROJ-7', summary: 'x' });
    expect(textOf(result)).toMatch(/boom-update/);
  });

  it('enforces the project allowlist on the issue key', async () => {
    client.jiraProjectKeys = ['OTHER'];
    const result = await run('updateIssue', { issue: 'PROJ-7', summary: 'x' });
    expect(result.isError).toBe(true);
    expect(client.put).not.toHaveBeenCalled();
  });

  it('sends a parent given as key or numeric id in the matching shape', async () => {
    client.put.mockResolvedValue(undefined);
    client.get.mockResolvedValue(RAW_ISSUE);
    await run('updateIssue', { issue: 'PROJ-7', parent: 'PROJ-2' });
    await run('updateIssue', { issue: 'PROJ-7', parent: '10077' });
    expect(client.put.mock.calls.map((call) => call[1].fields.parent)).toEqual([
      { key: 'PROJ-2' },
      { id: '10077' },
    ]);
  });

  it('checks the project allowlist on the new parent, including an empty one', async () => {
    client.jiraProjectKeys = ['PROJ'];
    for (const parent of ['OTHER-1', '']) {
      const result = await run('updateIssue', { issue: 'PROJ-7', parent });
      expect(result.isError).toBe(true);
    }
    expect(client.put).not.toHaveBeenCalled();
  });

  it('does not label an error message that only mentions a parent as a parent error', async () => {
    client.put.mockRejectedValueOnce(
      badRequest({ errorMessages: ['The parent filter in your workflow is misconfigured'] })
    );
    const result = await run('updateIssue', { issue: 'PROJ-7', summary: 'x' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('Invalid parent.');
  });

  it('rejects a description_adf that is not an ADF document before sending', async () => {
    const result = await run('updateIssue', {
      issue: 'PROJ-7',
      description_adf: { type: 'paragraph' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('description_adf must be an ADF document');
    expect(textOf(result)).not.toContain('paragraph');
    expect(client.put).not.toHaveBeenCalled();
  });
});

describe('deleteIssue', () => {
  it('deletes by key and reports it', async () => {
    client.del.mockResolvedValueOnce(undefined);
    expect(payload(await run('deleteIssue', { issue: 'PROJ-7' }))).toEqual({ deleted: true });
    expect(client.del.mock.calls[0][0]).toBe('/rest/api/3/issue/PROJ-7');
  });

  it('deletes by numeric id and enforces the allowlist on the key', async () => {
    client.del.mockResolvedValueOnce(undefined);
    await run('deleteIssue', { issue: '10007' });
    expect(client.del.mock.calls[0][0]).toBe('/rest/api/3/issue/10007');
    client.jiraProjectKeys = ['OTHER'];
    expect((await run('deleteIssue', { issue: 'PROJ-7' })).isError).toBe(true);
    expect(client.del).toHaveBeenCalledTimes(1);
  });

  it('tells the caller to deal with sub-tasks when Jira refuses', async () => {
    client.del.mockRejectedValueOnce(
      badRequest({
        errorMessages: ["The issue 'PROJ-7' has subtasks. You must specify 'deleteSubtasks'."],
      })
    );
    const result = await run('deleteIssue', { issue: 'PROJ-7' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('PROJ-7 still has sub-tasks');
    expect(textOf(result)).toContain('Delete the sub-tasks first');
  });

  it.each([
    ['another 400', badRequest({ errorMessages: ['Something else'] })],
    ['a 400 without messages', badRequest({})],
    ['a plain error', new Error('boom-delete')],
  ])('passes %s through', async (_label, error) => {
    client.del.mockRejectedValueOnce(error);
    const result = await run('deleteIssue', { issue: 'PROJ-7' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('sub-tasks');
  });
});

describe('linkIssues and unlinkIssues', () => {
  it('sends the issue that blocks as inwardIssue, the way Jira stores "PROJ-1 blocks PROJ-2"', async () => {
    client.get.mockResolvedValueOnce(LINK_TYPES);
    client.post.mockResolvedValueOnce(undefined);
    await run('linkIssues', { issue: 'PROJ-1', relation: 'blocks', target: 'PROJ-2' });
    expect(client.post).toHaveBeenCalledWith('/rest/api/3/issueLink', {
      type: { name: 'Blocks' },
      inwardIssue: { key: 'PROJ-1' },
      outwardIssue: { key: 'PROJ-2' },
    });
  });

  it('links with the relation read from the inward text, case-insensitively, with an id target', async () => {
    client.get.mockResolvedValueOnce(LINK_TYPES);
    client.post.mockResolvedValueOnce(undefined);
    await run('linkIssues', { issue: 'PROJ-1', relation: '  Is Blocked BY ', target: '10002' });
    expect(client.post).toHaveBeenCalledWith('/rest/api/3/issueLink', {
      type: { name: 'Blocks' },
      outwardIssue: { key: 'PROJ-1' },
      inwardIssue: { id: '10002' },
    });
  });

  it('lists the available relations and points to listLinkTypes for an unknown one', async () => {
    client.get.mockResolvedValueOnce(LINK_TYPES);
    const result = await run('linkIssues', {
      issue: 'PROJ-1',
      relation: 'inspires',
      target: 'PROJ-2',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid relation.');
    expect(textOf(result)).toContain('Get a valid value from listLinkTypes.');
    expect(textOf(result)).toContain('blocks, is blocked by');
    expect(textOf(result)).not.toContain('inspires');
    expect(client.post).not.toHaveBeenCalled();
  });

  it('passes other link failures through', async () => {
    client.get.mockResolvedValueOnce(LINK_TYPES);
    client.post.mockRejectedValueOnce(new Error('boom-link'));
    const result = await run('linkIssues', {
      issue: 'PROJ-1',
      relation: 'blocks',
      target: 'PROJ-2',
    });
    expect(textOf(result)).toMatch(/boom-link/);
  });

  it('unlinks by link id', async () => {
    client.del.mockResolvedValueOnce(undefined);
    expect(payload(await run('unlinkIssues', { link_id: '900' }))).toEqual({ unlinked: true });
    expect(client.del.mock.calls[0][0]).toBe('/rest/api/3/issueLink/900');
  });

  it('listLinkTypes returns the types under link_types', async () => {
    client.get.mockResolvedValueOnce(LINK_TYPES);
    expect(payload(await run('listLinkTypes', {}))).toEqual({
      link_types: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }],
    });
  });
});

describe('transitions, assignment, account', () => {
  it('getTransitions lists transitions for `issue`', async () => {
    client.get.mockResolvedValueOnce({
      transitions: [{ id: '5', name: 'Go', to: { name: 'Done' } }],
    });
    expect(payload(await run('getTransitions', { issue: 'PROJ-1' }))).toEqual({
      transitions: [{ id: '5', name: 'Go', to_status: 'Done' }],
    });
  });

  it('transitionIssue posts the transition_id', async () => {
    client.post.mockResolvedValueOnce(undefined);
    await run('transitionIssue', { issue: 'PROJ-1', transition_id: '5' });
    expect(client.post).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1/transitions', {
      transition: { id: '5' },
    });
  });

  it.each([
    ['omitted', undefined, null],
    ['null', null, null],
    ['an account id', 'u9', 'u9'],
  ])('assignIssue with assignee %s sends %j', async (_label, assignee, expected) => {
    client.put.mockResolvedValueOnce(undefined);
    await run('assignIssue', { issue: 'PROJ-1', ...(assignee === undefined ? {} : { assignee }) });
    expect(client.put).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1/assignee', {
      accountId: expected,
    });
  });

  it('assignIssue resolves "me" through getMyself', async () => {
    client.get.mockResolvedValueOnce({ accountId: 'me-id', displayName: 'Me' });
    client.put.mockResolvedValueOnce(undefined);
    await run('assignIssue', { issue: 'PROJ-1', assignee: 'me' });
    expect(client.put).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1/assignee', {
      accountId: 'me-id',
    });
  });

  it('getMyself wraps the account under `user`', async () => {
    client.get.mockResolvedValueOnce({ accountId: 'me-id', displayName: 'Me' });
    expect(payload(await run('getMyself', {}))).toEqual({
      user: { account_id: 'me-id', name: 'Me' },
    });
  });
});

describe('addAttachment', () => {
  let ws: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.WORKSPACE_DIR;
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'atl-ws-')));
    process.env.WORKSPACE_DIR = ws;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = prevEnv;
    rmSync(ws, { recursive: true, force: true });
  });

  it('reads a workspace file, derives the filename and uploads the bytes', async () => {
    writeFileSync(join(ws, 'bug.png'), Buffer.from('real-png-bytes'));
    client.uploadAttachment.mockResolvedValueOnce([{ id: '1', filename: 'bug.png' }]);
    await run('addAttachment', { issue: 'PROJ-1', file_path: join(ws, 'bug.png') });
    const [key, name, data, type] = client.uploadAttachment.mock.calls[0];
    expect([key, name, type]).toEqual(['PROJ-1', 'bug.png', 'application/octet-stream']);
    expect((data as Buffer).toString()).toBe('real-png-bytes');
  });

  it('lets filename and content_type override the defaults', async () => {
    writeFileSync(join(ws, 'shot.png'), Buffer.from('x'));
    client.uploadAttachment.mockResolvedValueOnce([{ id: '4' }]);
    await run('addAttachment', {
      issue: 'PROJ-1',
      file_path: 'shot.png',
      filename: 'renamed.png',
      content_type: 'image/png',
    });
    const call = client.uploadAttachment.mock.calls[0];
    expect([call[1], call[3]]).toEqual(['renamed.png', 'image/png']);
  });

  it('rejects a path that escapes the workspace', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'atl-out-')));
    writeFileSync(join(outside, 'secret'), Buffer.from('token'));
    const result = await run('addAttachment', {
      issue: 'PROJ-1',
      file_path: join(outside, 'secret'),
    });
    expect(result.isError).toBe(true);
    expect(client.uploadAttachment).not.toHaveBeenCalled();
    rmSync(outside, { recursive: true, force: true });
  });

  it('surfaces an upload failure as an error result', async () => {
    writeFileSync(join(ws, 'shot.png'), Buffer.from('x'));
    client.uploadAttachment.mockRejectedValueOnce(new Error('boom-attach'));
    const result = await run('addAttachment', { issue: 'PROJ-1', file_path: 'shot.png' });
    expect(textOf(result)).toMatch(/boom-attach/);
  });
});

describe('addAttachment size cap', () => {
  let ws: string;
  let prevWorkspace: string | undefined;
  let prevMax: string | undefined;

  beforeEach(() => {
    prevWorkspace = process.env.WORKSPACE_DIR;
    prevMax = process.env.ATLASSIAN_MAX_ATTACHMENT_BYTES;
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'atl-ws-cap-')));
    process.env.WORKSPACE_DIR = ws;
    process.env.ATLASSIAN_MAX_ATTACHMENT_BYTES = '10';
    vi.resetModules();
  });
  afterEach(() => {
    if (prevWorkspace === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = prevWorkspace;
    if (prevMax === undefined) delete process.env.ATLASSIAN_MAX_ATTACHMENT_BYTES;
    else process.env.ATLASSIAN_MAX_ATTACHMENT_BYTES = prevMax;
    rmSync(ws, { recursive: true, force: true });
    vi.resetModules();
  });

  async function freshDef() {
    const mod = await import('./jira-issue-tools.js');
    return mod.createJiraIssueTools(CLIENT).find((d) => d.tool.name === 'addAttachment')!;
  }

  it('rejects a file over the byte cap before reading it into memory', async () => {
    writeFileSync(join(ws, 'big.bin'), Buffer.alloc(11, 'x'));
    const result = await (await freshDef()).handler({ issue: 'PROJ-1', file_path: 'big.bin' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/11 bytes > 10 byte limit/);
    expect(client.uploadAttachment).not.toHaveBeenCalled();
  });

  it('accepts a file at exactly the byte cap and states the cap in the description', async () => {
    writeFileSync(join(ws, 'ok.bin'), Buffer.alloc(10, 'x'));
    client.uploadAttachment.mockResolvedValueOnce([{ id: '1' }]);
    const def = await freshDef();
    const result = await def.handler({ issue: 'PROJ-1', file_path: 'ok.bin' });
    expect(result.isError).toBeUndefined();
    expect(def.tool.description).toMatch(/capped at 10 bytes/);
  });

  it('falls back to the default cap for an invalid override', async () => {
    process.env.ATLASSIAN_MAX_ATTACHMENT_BYTES = 'abc';
    vi.resetModules();
    expect((await freshDef()).tool.description).toMatch(/capped at 26214400 bytes/);
  });
});

describe('deleteAttachment', () => {
  it('deletes by attachment_id', async () => {
    client.del.mockResolvedValueOnce(undefined);
    expect(payload(await run('deleteAttachment', { attachment_id: '10475' }))).toEqual({
      deleted: true,
    });
    expect(client.del.mock.calls[0][0]).toBe('/rest/api/3/attachment/10475');
  });

  it('surfaces the allowlist refusal as an error result', async () => {
    client.jiraProjectKeys = ['PROJ'];
    const result = await run('deleteAttachment', { attachment_id: '10475' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/allowlist/);
    expect(client.del).not.toHaveBeenCalled();
  });
});
