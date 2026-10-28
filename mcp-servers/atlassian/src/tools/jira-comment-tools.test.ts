import { describe, it, expect, vi, beforeEach } from 'vitest';
import { META_KEYS, type ToolsCallResult } from '@speedwave/mcp-shared';
import { createJiraCommentTools } from './jira-comment-tools.js';
import { declaredFields } from './jira-test-helpers.js';
import type { AtlassianClient } from '../client.js';
import type { AdfDoc } from '../types.js';

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
  const def = createJiraCommentTools(asClient()).find((d) => d.tool.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def.handler;
}

const textOf = (result: ToolsCallResult) => (result.content[0] as { text: string }).text;

function payload(result: ToolsCallResult): Record<string, unknown> {
  expect(result.isError).toBeUndefined();
  return JSON.parse(textOf(result));
}

const adfParagraph = (text: string): AdfDoc => ({
  version: 1,
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const rawComment = (over: Record<string, unknown> = {}) => ({
  id: '5',
  body: adfParagraph('hello'),
  author: { accountId: 'u1', displayName: 'Ann', active: true },
  created: 't1',
  updated: 't2',
  ...over,
});

beforeEach(() => {
  client.get.mockReset();
  client.post.mockReset();
  client.jiraProjectKeys = [];
});

describe('definitions', () => {
  it('exposes the 3 expected tools', () => {
    expect(createJiraCommentTools(asClient()).map((d) => d.tool.name)).toEqual([
      'addComment',
      'getComments',
      'addWorklog',
    ]);
  });

  it('declares snake_case parameters only', () => {
    for (const { tool } of createJiraCommentTools(asClient())) {
      for (const name of Object.keys(tool.inputSchema.properties)) {
        expect(name, tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('declares every parameter its input examples use', () => {
    for (const { tool } of createJiraCommentTools(asClient())) {
      const declared = Object.keys(tool.inputSchema.properties);
      for (const example of tool.inputExamples ?? []) {
        expect(declared, `${tool.name}: ${example.description}`).toEqual(
          expect.arrayContaining(Object.keys(example.input))
        );
      }
    }
  });

  it('carries discovery metadata and success in every output schema', () => {
    for (const { tool } of createJiraCommentTools(asClient())) {
      expect(tool.keywords?.length).toBeGreaterThan(0);
      expect(tool.outputSchema?.required).toContain('success');
      expect(tool._meta).toEqual({ [META_KEYS.DEFER_LOADING]: true });
    }
  });

  it('documents the shared-account attribution on addWorklog', () => {
    const tool = createJiraCommentTools(asClient()).find((d) => d.tool.name === 'addWorklog')?.tool;
    expect(tool?.description).toContain('shared Atlassian account');
  });
});

describe('unconfigured', () => {
  it('lists all tools but every handler errors', async () => {
    const defs = createJiraCommentTools(null);
    expect(defs).toHaveLength(3);
    for (const { handler } of defs) {
      expect((await handler({ issue: 'PROJ-1', time_spent_seconds: 1 })).isError).toBe(true);
    }
  });

  it('rejects an undeclared parameter before reporting the missing configuration', async () => {
    const result = await createJiraCommentTools(null)[0].handler({ issueIdOrKey: 'PROJ-1' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('addComment does not accept this parameter');
  });
});

describe('addComment', () => {
  it('converts a Markdown body to ADF and returns the comment body as Markdown', async () => {
    client.post.mockResolvedValueOnce(rawComment({ body: adfParagraph('Done') }));

    const result = payload(await handlerFor('addComment')({ issue: 'PROJ-1', body: '**Done**' }));

    const [path, sent] = client.post.mock.calls[0];
    expect(path).toBe('/rest/api/3/issue/PROJ-1/comment');
    expect(sent.body.type).toBe('doc');
    expect(sent.body.content[0].content[0]).toMatchObject({
      text: 'Done',
      marks: [{ type: 'strong' }],
    });
    expect(result).toEqual({
      comment: {
        id: '5',
        body: 'Done',
        author: { account_id: 'u1', name: 'Ann' },
        created: 't1',
        updated: 't2',
      },
    });
  });

  it('sends body_adf unchanged', async () => {
    const adf = adfParagraph('raw');
    client.post.mockResolvedValueOnce(rawComment());

    await handlerFor('addComment')({ issue: 'PROJ-1', body_adf: adf });

    expect(client.post.mock.calls[0][1]).toEqual({ body: adf });
  });

  it.each([
    ['both bodies', { body: 'x', body_adf: adfParagraph('x') }],
    ['neither body', {}],
  ])('rejects %s without calling Jira', async (_label, extra) => {
    const result = await handlerFor('addComment')({ issue: 'PROJ-1', ...extra });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('body_adf');
    expect(client.post).not.toHaveBeenCalled();
  });

  it('rejects a body_adf that is not an ADF document', async () => {
    const result = await handlerFor('addComment')({ issue: 'PROJ-1', body_adf: { foo: 1 } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('body_adf');
    expect(client.post).not.toHaveBeenCalled();
  });

  it('rejects the old camelCase parameters', async () => {
    const result = await handlerFor('addComment')({ issueIdOrKey: 'PROJ-1', bodyText: 'x' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('issueIdOrKey, bodyText');
    expect(client.post).not.toHaveBeenCalled();
  });

  it('enforces the project allowlist', async () => {
    client.jiraProjectKeys = ['OTHER'];

    const result = await handlerFor('addComment')({ issue: 'PROJ-1', body: 'x' });

    expect(result.isError).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('surfaces client errors', async () => {
    client.post.mockRejectedValueOnce(new Error('nope'));

    expect((await handlerFor('addComment')({ issue: 'PROJ-1', body: 'x' })).isError).toBe(true);
  });

  it('emits exactly the keys its output schema names', async () => {
    client.post.mockResolvedValueOnce(rawComment());
    const tool = createJiraCommentTools(asClient())[0].tool;

    const result = payload(await handlerFor('addComment')({ issue: 'PROJ-1', body: 'x' }));

    expect(Object.keys(result)).toEqual(['comment']);
    expect(Object.keys(tool.outputSchema!.properties).sort()).toEqual([
      'comment',
      'error',
      'success',
    ]);
  });
});

describe('getComments', () => {
  it('lists comments with Markdown bodies and passes max_results', async () => {
    client.get.mockResolvedValueOnce({ comments: [rawComment()] });

    const result = payload(await handlerFor('getComments')({ issue: 'PROJ-1', max_results: 10 }));

    expect(client.get).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1/comment', {
      maxResults: 10,
    });
    expect((result.comments as Array<{ body: string }>)[0].body).toBe('hello');
    expect(result.count).toBe(1);
  });

  it('renders ADF nodes without a Markdown equivalent as visible markers', async () => {
    const panel: AdfDoc = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'panel',
          attrs: { panelType: 'info' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'careful' }] }],
        },
      ],
    };
    client.get.mockResolvedValueOnce({ comments: [rawComment({ body: panel })] });

    const result = payload(await handlerFor('getComments')({ issue: 'PROJ-1' }));

    const body = (result.comments as Array<{ body: string }>)[0].body;
    expect(body).toContain('[adf:panel info]');
    expect(body).toContain('careful');
  });

  it('returns an empty body for a comment without one', async () => {
    client.get.mockResolvedValueOnce({ comments: [rawComment({ body: undefined })] });

    const result = payload(await handlerFor('getComments')({ issue: 'PROJ-1' }));

    expect((result.comments as Array<{ body: string }>)[0].body).toBe('');
  });

  it('keeps a plain string body', async () => {
    client.get.mockResolvedValueOnce({ comments: [rawComment({ body: 'legacy' })] });

    const result = payload(await handlerFor('getComments')({ issue: 'PROJ-1' }));

    expect((result.comments as Array<{ body: string }>)[0].body).toBe('legacy');
  });

  it('returns an empty list when Jira omits comments', async () => {
    client.get.mockResolvedValueOnce({});

    expect(payload(await handlerFor('getComments')({ issue: 'PROJ-1' }))).toEqual({
      comments: [],
      count: 0,
    });
  });

  it('rejects the old camelCase parameters', async () => {
    const result = await handlerFor('getComments')({ issueIdOrKey: 'PROJ-1', maxResults: 5 });

    expect(result.isError).toBe(true);
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe('addWorklog', () => {
  it('converts a Markdown comment to ADF and returns the comment as Markdown', async () => {
    client.post.mockResolvedValueOnce({
      id: '9',
      issueId: '100',
      timeSpentSeconds: 3600,
      comment: adfParagraph('note'),
      author: { accountId: 'u1', displayName: 'Ann', active: true },
      started: 's',
      created: 'c',
    });

    const result = payload(
      await handlerFor('addWorklog')({
        issue: 'PROJ-1',
        time_spent_seconds: 3600,
        comment: '_note_',
        started: '2026-01-01T00:00:00.000+0000',
      })
    );

    const [path, sent] = client.post.mock.calls[0];
    expect(path).toBe('/rest/api/3/issue/PROJ-1/worklog');
    expect(sent.timeSpentSeconds).toBe(3600);
    expect(sent.started).toBe('2026-01-01T00:00:00.000+0000');
    expect(sent.comment.content[0].content[0]).toMatchObject({ marks: [{ type: 'em' }] });
    expect(result.worklog).toMatchObject({
      id: '9',
      issue_id: '100',
      time_spent_seconds: 3600,
      comment: 'note',
      started: 's',
      created: 'c',
    });
  });

  it('sends comment_adf unchanged', async () => {
    const adf = adfParagraph('raw');
    client.post.mockResolvedValueOnce({ id: '10' });

    await handlerFor('addWorklog')({
      issue: 'PROJ-1',
      time_spent_seconds: 60,
      comment_adf: adf,
    });

    expect(client.post.mock.calls[0][1]).toEqual({ timeSpentSeconds: 60, comment: adf });
  });

  it('omits comment and started when not given and returns a null comment', async () => {
    client.post.mockResolvedValueOnce({ id: '11' });

    const result = payload(
      await handlerFor('addWorklog')({ issue: 'PROJ-7', time_spent_seconds: 60 })
    );

    expect(client.post.mock.calls[0][1]).toEqual({ timeSpentSeconds: 60 });
    expect(result.worklog).toMatchObject({ id: '11', issue_id: 'PROJ-7', comment: null });
  });

  it('rejects comment together with comment_adf without calling Jira', async () => {
    const result = await handlerFor('addWorklog')({
      issue: 'PROJ-1',
      time_spent_seconds: 60,
      comment: 'x',
      comment_adf: adfParagraph('x'),
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('comment_adf');
    expect(client.post).not.toHaveBeenCalled();
  });

  it('rejects a comment_adf that is not an ADF document', async () => {
    const result = await handlerFor('addWorklog')({
      issue: 'PROJ-1',
      time_spent_seconds: 60,
      comment_adf: 'text',
    });

    expect(result.isError).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('rejects the old camelCase parameters', async () => {
    const result = await handlerFor('addWorklog')({ issueIdOrKey: 'PROJ-1', timeSpentSeconds: 1 });

    expect(result.isError).toBe(true);
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe('output schemas', () => {
  it('declare every field of the comments and the worklog the tools return', async () => {
    const tools = createJiraCommentTools(asClient());
    client.post.mockResolvedValueOnce(rawComment()).mockResolvedValueOnce({
      id: '9',
      issueId: '100',
      timeSpentSeconds: 60,
      comment: adfParagraph('note'),
      author: { accountId: 'u1', displayName: 'Ann' },
      started: 's',
      created: 'c',
    });
    client.get.mockResolvedValueOnce({ comments: [rawComment()] });

    const added = payload(await handlerFor('addComment')({ issue: 'PROJ-1', body: 'x' }));
    const listed = payload(await handlerFor('getComments')({ issue: 'PROJ-1' }));
    const logged = payload(
      await handlerFor('addWorklog')({ issue: 'PROJ-1', time_spent_seconds: 60 })
    );

    expect(Object.keys(added.comment as object).sort()).toEqual(
      declaredFields(tools, 'addComment', 'comment')
    );
    expect(Object.keys((listed.comments as object[])[0]).sort()).toEqual(
      declaredFields(tools, 'getComments', 'comments')
    );
    expect(Object.keys(logged.worklog as object).sort()).toEqual(
      declaredFields(tools, 'addWorklog', 'worklog')
    );
  });
});
