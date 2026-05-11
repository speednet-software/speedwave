/**
 * Tests for the Jira comments & worklog domain client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createJiraCommentsClient } from './jira-comments.js';
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
  } as unknown as AtlassianClient & {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  };
}

let client: ReturnType<typeof stubClient>;
beforeEach(() => {
  client = stubClient();
});

describe('add', () => {
  it('POSTs an ADF body and normalises the response', async () => {
    client.post.mockResolvedValueOnce({
      id: '5',
      body: { type: 'doc' },
      author: { accountId: 'u1', displayName: 'A', active: true },
      created: 't1',
      updated: 't2',
    });
    const c = createJiraCommentsClient(client);
    const comment = await c.add('PROJ-1', 'hello');
    const sent = client.post.mock.calls[0];
    expect(sent[0]).toBe('/rest/api/3/issue/PROJ-1/comment');
    expect((sent[1] as { body: { type: string } }).body.type).toBe('doc');
    expect(comment).toMatchObject({ id: '5', created: 't1', updated: 't2' });
    expect(comment.author).toEqual({
      account_id: 'u1',
      display_name: 'A',
      email_address: undefined,
      active: true,
    });
  });

  it('passes a raw ADF body through', async () => {
    const adf = { type: 'doc' as const, version: 1 as const, content: [] };
    client.post.mockResolvedValueOnce({ id: '6' });
    const c = createJiraCommentsClient(client);
    await c.add('PROJ-1', adf);
    expect((client.post.mock.calls[0][1] as { body: unknown }).body).toBe(adf);
  });

  it('enforces the allowlist', async () => {
    client = stubClient(['ALLOWED']);
    const c = createJiraCommentsClient(client);
    await expect(c.add('OTHER-1', 'x')).rejects.toThrow(ScopeError);
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe('list', () => {
  it('GETs comments with a capped maxResults and normalises', async () => {
    client.get.mockResolvedValueOnce({ comments: [{ id: '1', body: 'x', created: 'c' }] });
    const c = createJiraCommentsClient(client);
    const res = await c.list('PROJ-1', { maxResults: 999 });
    expect(client.get).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1/comment', {
      maxResults: 100,
    });
    expect(res).toEqual([{ id: '1', body: 'x', author: null, created: 'c', updated: 'c' }]);
  });

  it('defaults maxResults to 50 and handles a missing comments array', async () => {
    client.get.mockResolvedValueOnce({});
    const c = createJiraCommentsClient(client);
    expect(await c.list('PROJ-1')).toEqual([]);
    expect(client.get).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1/comment', { maxResults: 50 });
  });
});

describe('addWorklog', () => {
  it('POSTs the worklog with optional comment/started and normalises', async () => {
    client.post.mockResolvedValueOnce({
      id: '99',
      issueId: '10001',
      timeSpentSeconds: 3600,
      comment: { type: 'doc' },
      author: { accountId: 'u1', displayName: 'A', active: true },
      started: 's',
      created: 'cr',
    });
    const c = createJiraCommentsClient(client);
    const wl = await c.addWorklog('PROJ-1', {
      timeSpentSeconds: 3600,
      comment: 'note',
      started: '2026-01-01T00:00:00.000+0000',
    });
    const sent = client.post.mock.calls[0];
    expect(sent[0]).toBe('/rest/api/3/issue/PROJ-1/worklog');
    expect(sent[1]).toMatchObject({
      timeSpentSeconds: 3600,
      started: '2026-01-01T00:00:00.000+0000',
    });
    expect((sent[1] as { comment: { type: string } }).comment.type).toBe('doc');
    expect(wl).toMatchObject({
      id: '99',
      issue_id: '10001',
      time_spent_seconds: 3600,
      started: 's',
      created: 'cr',
    });
  });

  it('omits comment/started when not provided; falls back issue_id to the ref', async () => {
    client.post.mockResolvedValueOnce({ id: '100', timeSpentSeconds: 60 });
    const c = createJiraCommentsClient(client);
    const wl = await c.addWorklog('PROJ-7', { timeSpentSeconds: 60 });
    expect(client.post.mock.calls[0][1]).toEqual({ timeSpentSeconds: 60 });
    expect(wl.issue_id).toBe('PROJ-7');
    expect(wl.comment).toBeNull();
  });

  it('enforces the allowlist', async () => {
    client = stubClient(['ALLOWED']);
    const c = createJiraCommentsClient(client);
    await expect(c.addWorklog('OTHER-1', { timeSpentSeconds: 1 })).rejects.toThrow(ScopeError);
  });
});

describe('normalisation of minimal payloads', () => {
  it('normalises a comment with nothing set', async () => {
    client.post.mockResolvedValueOnce({});
    const c = createJiraCommentsClient(client);
    expect(await c.add('PROJ-1', 'x')).toEqual({
      id: '',
      body: '',
      author: null,
      created: '',
      updated: '',
    });
  });

  it('normalises a comment with `updated` falling back to `created`', async () => {
    client.get.mockResolvedValueOnce({ comments: [{ id: '1', body: 'b', created: 'c' }] });
    const c = createJiraCommentsClient(client);
    expect((await c.list('PROJ-1'))[0].updated).toBe('c');
  });

  it('normalises a worklog with nothing set', async () => {
    client.post.mockResolvedValueOnce({});
    const c = createJiraCommentsClient(client);
    expect(await c.addWorklog('PROJ-7', { timeSpentSeconds: 0 })).toEqual({
      id: '',
      issue_id: 'PROJ-7',
      time_spent_seconds: 0,
      comment: null,
      author: null,
      started: '',
      created: '',
    });
  });

  it('enforces the allowlist for getComments too', async () => {
    client = stubClient(['ALLOWED']);
    const c = createJiraCommentsClient(client);
    await expect(c.list('OTHER-1')).rejects.toThrow(ScopeError);
  });
});
