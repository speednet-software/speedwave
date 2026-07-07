/**
 * Tests for the Jira comment & worklog tools.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const stub = { add: vi.fn(), list: vi.fn(), addWorklog: vi.fn() };
vi.mock('../domains/jira-comments.js', () => ({ createJiraCommentsClient: () => stub }));

import { META_KEYS } from '@speedwave/mcp-shared';
import { createJiraCommentTools } from './jira-comment-tools.js';
import type { AtlassianClient } from '../client.js';

const FAKE_CLIENT = {} as AtlassianClient;
function handlerFor(name: string) {
  const def = createJiraCommentTools(FAKE_CLIENT).find((d) => d.tool.name === name);
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
    expect(createJiraCommentTools(FAKE_CLIENT).map((d) => d.tool.name)).toEqual([
      'addComment',
      'getComments',
      'addWorklog',
    ]);
  });
  it('all tools carry metadata and required-field declarations', () => {
    for (const { tool } of createJiraCommentTools(FAKE_CLIENT)) {
      expect(tool.keywords?.length).toBeGreaterThan(0);
      expect(tool.outputSchema?.required).toContain('success');
      expect(tool.inputExamples?.length).toBeGreaterThan(0);
    }
  });
  it('addWorklog declares user-scoped identity metadata pointing at getMyself', () => {
    const tool = createJiraCommentTools(FAKE_CLIENT).find(
      (d) => d.tool.name === 'addWorklog'
    )?.tool;
    expect(tool?._meta?.[META_KEYS.USER_SCOPED]).toBe(true);
    expect(tool?._meta?.[META_KEYS.CURRENT_USER_TOOL]).toBe('getMyself');
  });
});

describe('unconfigured', () => {
  it('lists all tools but every handler errors', async () => {
    const defs = createJiraCommentTools(null);
    expect(defs).toHaveLength(3);
    for (const { handler } of defs) expect((await handler({} as never)).isError).toBe(true);
  });
});

describe('addComment', () => {
  it('forwards bodyText as the body', async () => {
    stub.add.mockResolvedValueOnce({ id: '1' });
    await handlerFor('addComment')({ issueIdOrKey: 'PROJ-1', bodyText: 'hi' });
    expect(stub.add).toHaveBeenCalledWith('PROJ-1', 'hi');
  });
  it('prefers bodyAdf', async () => {
    const adf = { version: 1 as const, type: 'doc' as const, content: [] };
    stub.add.mockResolvedValueOnce({ id: '2' });
    await handlerFor('addComment')({ issueIdOrKey: 'PROJ-1', bodyText: 't', bodyAdf: adf });
    expect(stub.add).toHaveBeenCalledWith('PROJ-1', adf);
  });
  it('defaults to an empty string when neither body is given', async () => {
    stub.add.mockResolvedValueOnce({ id: '3' });
    await handlerFor('addComment')({ issueIdOrKey: 'PROJ-1' });
    expect(stub.add).toHaveBeenCalledWith('PROJ-1', '');
  });
  it('wraps the result under `comment`', async () => {
    stub.add.mockResolvedValueOnce({ id: '4' });
    expect(
      payload(await handlerFor('addComment')({ issueIdOrKey: 'PROJ-1', bodyText: 'x' }))
    ).toEqual({ comment: { id: '4' } });
  });
  it('surfaces errors', async () => {
    stub.add.mockRejectedValueOnce(new Error('nope'));
    expect(
      (await handlerFor('addComment')({ issueIdOrKey: 'PROJ-1', bodyText: 'x' })).isError
    ).toBe(true);
  });
});

describe('getComments', () => {
  it('forwards maxResults and wraps the list', async () => {
    stub.list.mockResolvedValueOnce([{ id: '1' }]);
    expect(
      payload(await handlerFor('getComments')({ issueIdOrKey: 'PROJ-1', maxResults: 10 }))
    ).toEqual({ comments: [{ id: '1' }] });
    expect(stub.list).toHaveBeenCalledWith('PROJ-1', { maxResults: 10 });
  });
});

describe('addWorklog', () => {
  it('forwards time, comment, started', async () => {
    stub.addWorklog.mockResolvedValueOnce({ id: '9' });
    await handlerFor('addWorklog')({
      issueIdOrKey: 'PROJ-1',
      timeSpentSeconds: 3600,
      comment: 'note',
      started: '2026-01-01T00:00:00.000+0000',
    });
    expect(stub.addWorklog).toHaveBeenCalledWith('PROJ-1', {
      timeSpentSeconds: 3600,
      comment: 'note',
      started: '2026-01-01T00:00:00.000+0000',
    });
  });
  it('prefers commentAdf over comment', async () => {
    const adf = { version: 1 as const, type: 'doc' as const, content: [] };
    stub.addWorklog.mockResolvedValueOnce({ id: '10' });
    await handlerFor('addWorklog')({
      issueIdOrKey: 'PROJ-1',
      timeSpentSeconds: 60,
      comment: 't',
      commentAdf: adf,
    });
    expect(stub.addWorklog.mock.calls[0][1].comment).toBe(adf);
  });
  it('omits comment/started when not given', async () => {
    stub.addWorklog.mockResolvedValueOnce({ id: '11' });
    await handlerFor('addWorklog')({ issueIdOrKey: 'PROJ-1', timeSpentSeconds: 60 });
    expect(stub.addWorklog).toHaveBeenCalledWith('PROJ-1', {
      timeSpentSeconds: 60,
      comment: undefined,
      started: undefined,
    });
  });
  it('wraps the result under `worklog`', async () => {
    stub.addWorklog.mockResolvedValueOnce({ id: '12' });
    expect(
      payload(await handlerFor('addWorklog')({ issueIdOrKey: 'PROJ-1', timeSpentSeconds: 1 }))
    ).toEqual({ worklog: { id: '12' } });
  });
});
