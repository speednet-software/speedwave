/**
 * Tests for the Jira issues domain client (search/CRUD/transitions/assignment),
 * including allowlist scope enforcement and response normalisation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createJiraIssuesClient } from './jira-issues.js';
import { ScopeError } from '../scope.js';
import type { AtlassianClient } from '../client.js';

/** Minimal AtlassianClient stub. */
function stubClient(projectKeys: string[] = []) {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
    uploadAttachment: vi.fn(),
    jiraProjectKeys: projectKeys,
    confluenceSpaceKeys: [] as string[],
  } as unknown as AtlassianClient & {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    uploadAttachment: ReturnType<typeof vi.fn>;
  };
}

/** A raw Jira issue payload as the REST API returns it. */
function rawIssue(over: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) {
  return {
    id: '10001',
    key: 'PROJ-1',
    self: 'https://acme.atlassian.net/rest/api/3/issue/10001',
    fields: {
      summary: 'Hello',
      description: { type: 'doc', version: 1, content: [] },
      status: { name: 'To Do' },
      issuetype: { name: 'Task' },
      project: { key: 'PROJ' },
      priority: { name: 'High' },
      labels: ['a', 'b'],
      assignee: { accountId: 'u1', displayName: 'Alice', active: true },
      reporter: { accountId: 'u2', displayName: 'Bob', active: true },
      created: '2026-01-01T00:00:00.000+0000',
      updated: '2026-01-02T00:00:00.000+0000',
      ...fields,
    },
    ...over,
  };
}

let client: ReturnType<typeof stubClient>;
beforeEach(() => {
  client = stubClient();
});

describe('search (enhanced JQL)', () => {
  it('POSTs to /rest/api/3/search/jql with capped maxResults and returns normalised issues + cursor', async () => {
    client.post.mockResolvedValueOnce({
      issues: [rawIssue()],
      nextPageToken: 'tok2',
      isLast: false,
    });
    const c = createJiraIssuesClient(client);
    const res = await c.search({ jql: 'ORDER BY created DESC', maxResults: 999 });
    expect(client.post).toHaveBeenCalledWith(
      '/rest/api/3/search/jql',
      expect.objectContaining({ jql: 'ORDER BY created DESC', maxResults: 100 }),
      { retryable: true }
    );
    expect(res.issues[0].key).toBe('PROJ-1');
    expect(res.issues[0].web_url).toBe('https://acme.atlassian.net/browse/PROJ-1');
    expect(res.next_page_token).toBe('tok2');
    expect(res.is_last).toBe(false);
  });

  it('passes nextPageToken through and defaults maxResults to 50', async () => {
    client.post.mockResolvedValueOnce({ issues: [], nextPageToken: null });
    const c = createJiraIssuesClient(client);
    const res = await c.search({ jql: 'x', nextPageToken: 'cursor' });
    expect(client.post).toHaveBeenCalledWith(
      '/rest/api/3/search/jql',
      expect.objectContaining({ maxResults: 50, nextPageToken: 'cursor' }),
      { retryable: true }
    );
    expect(res.is_last).toBe(true);
    expect(res.next_page_token).toBeNull();
  });

  it('floors a fractional maxResults at 1', async () => {
    client.post.mockResolvedValueOnce({ issues: [] });
    const c = createJiraIssuesClient(client);
    await c.search({ jql: 'x', maxResults: 0.5 });
    expect(client.post).toHaveBeenCalledWith(
      '/rest/api/3/search/jql',
      expect.objectContaining({ maxResults: 1 }),
      { retryable: true }
    );
  });

  it('defaults maxResults to 50 when given 0 (not a floor to 1)', async () => {
    client.post.mockResolvedValueOnce({ issues: [] });
    const c = createJiraIssuesClient(client);
    await c.search({ jql: 'x', maxResults: 0 });
    expect(client.post).toHaveBeenCalledWith(
      '/rest/api/3/search/jql',
      expect.objectContaining({ maxResults: 50 }),
      { retryable: true }
    );
  });

  it('treats a missing issues array as empty', async () => {
    client.post.mockResolvedValueOnce({});
    const c = createJiraIssuesClient(client);
    const res = await c.search({ jql: 'x' });
    expect(res.issues).toEqual([]);
    expect(res.is_last).toBe(true);
  });

  it('filters out result issues whose project is outside the allowlist', async () => {
    client = stubClient(['PROJ']);
    client.post.mockResolvedValueOnce({
      issues: [rawIssue(), rawIssue({ key: 'OTHER-9' }, { project: { key: 'OTHER' } })],
      isLast: true,
    });
    const c = createJiraIssuesClient(client);
    const res = await c.search({ jql: 'project in (PROJ, OTHER)' });
    expect(res.issues.map((i) => i.key)).toEqual(['PROJ-1']);
  });

  it('passes results through unchanged when no allowlist is configured', async () => {
    client.post.mockResolvedValueOnce({
      issues: [rawIssue(), rawIssue({ key: 'OTHER-9' }, { project: { key: 'OTHER' } })],
      isLast: true,
    });
    const c = createJiraIssuesClient(client);
    expect((await c.search({ jql: 'x' })).issues).toHaveLength(2);
  });

  it('does not re-page when unrestricted, even if the single page filters to zero (no allowlist configured)', async () => {
    client.post.mockResolvedValueOnce({ issues: [], nextPageToken: 'tok2', isLast: false });
    const c = createJiraIssuesClient(client);
    const res = await c.search({ jql: 'x' });
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ issues: [], next_page_token: 'tok2', is_last: false });
  });

  it('skips past an all-excluded page instead of leaking its is_last/cursor to the caller', async () => {
    client = stubClient(['PROJ']);
    client.post
      .mockResolvedValueOnce({
        issues: [rawIssue({ key: 'OTHER-9' }, { project: { key: 'OTHER' } })],
        nextPageToken: 'tok2',
        isLast: false,
      })
      .mockResolvedValueOnce({ issues: [rawIssue()], nextPageToken: null, isLast: true });
    const c = createJiraIssuesClient(client);
    const res = await c.search({ jql: 'project in (PROJ, OTHER)' });
    expect(client.post).toHaveBeenCalledTimes(2);
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      '/rest/api/3/search/jql',
      expect.objectContaining({ nextPageToken: 'tok2' }),
      { retryable: true }
    );
    expect(res.issues.map((i) => i.key)).toEqual(['PROJ-1']);
    expect(res.is_last).toBe(true);
    expect(res.next_page_token).toBeNull();
  });

  it('hides the existence of out-of-allowlist-only matches once the upstream stream truly ends', async () => {
    client = stubClient(['PROJ']);
    client.post.mockResolvedValueOnce({
      issues: [rawIssue({ key: 'OTHER-9' }, { project: { key: 'OTHER' } })],
      nextPageToken: null,
      isLast: true,
    });
    const c = createJiraIssuesClient(client);
    const res = await c.search({ jql: 'project = OTHER' });
    expect(res).toEqual({ issues: [], next_page_token: null, is_last: true });
  });

  it('bounds re-paging at MAX_SEARCH_CONTINUATION_PAGES worth of all-excluded pages', async () => {
    client = stubClient(['PROJ']);
    client.post.mockImplementation(async () => ({
      issues: [rawIssue({ key: 'OTHER-9' }, { project: { key: 'OTHER' } })],
      nextPageToken: 'tok-more',
      isLast: false,
    }));
    const c = createJiraIssuesClient(client);
    const res = await c.search({ jql: 'project = OTHER' });
    expect(client.post).toHaveBeenCalledTimes(5);
    expect(res).toEqual({ issues: [], next_page_token: 'tok-more', is_last: false });
  });
});

describe('get', () => {
  it('fetches and normalises a single issue', async () => {
    client.get.mockResolvedValueOnce(rawIssue());
    const c = createJiraIssuesClient(client);
    const issue = await c.get('PROJ-1');
    expect(client.get).toHaveBeenCalledWith(
      '/rest/api/3/issue/PROJ-1',
      expect.objectContaining({ fields: expect.any(String) })
    );
    expect(issue).toMatchObject({
      id: '10001',
      key: 'PROJ-1',
      summary: 'Hello',
      status: 'To Do',
      issue_type: 'Task',
      project_key: 'PROJ',
      priority: 'High',
      labels: ['a', 'b'],
    });
    expect(issue.assignee).toEqual({
      account_id: 'u1',
      display_name: 'Alice',
      email_address: undefined,
      active: true,
    });
  });

  it('enforces the project allowlist on the fetched issue', async () => {
    client = stubClient(['ALLOWED']);
    client.get.mockResolvedValueOnce(rawIssue({}, { project: { key: 'OTHER' } }));
    const c = createJiraIssuesClient(client);
    await expect(c.get('OTHER-9')).rejects.toThrow(ScopeError);
  });

  it('encodes the issue key', async () => {
    client.get.mockResolvedValueOnce(rawIssue());
    const c = createJiraIssuesClient(client);
    await c.get('PROJ 1');
    expect(client.get).toHaveBeenCalledWith('/rest/api/3/issue/PROJ%201', expect.anything());
  });
});

describe('create', () => {
  it('builds the fields payload (ADF description), then re-fetches the created issue', async () => {
    client.post.mockResolvedValueOnce({ key: 'PROJ-2' });
    client.get.mockResolvedValueOnce(rawIssue({ key: 'PROJ-2' }));
    const c = createJiraIssuesClient(client);
    const issue = await c.create({
      projectKey: 'PROJ',
      summary: 'New',
      issueType: 'Bug',
      body: 'line1\nline2',
      priority: 'Low',
      labels: ['x'],
      assigneeAccountId: 'u9',
    });
    const sent = client.post.mock.calls[0][1] as { fields: Record<string, unknown> };
    expect(sent.fields).toMatchObject({
      project: { key: 'PROJ' },
      summary: 'New',
      issuetype: { name: 'Bug' },
      priority: { name: 'Low' },
      labels: ['x'],
      assignee: { accountId: 'u9' },
    });
    expect(sent.fields.description).toMatchObject({ type: 'doc', version: 1 });
    expect(issue.key).toBe('PROJ-2');
  });

  it('passes a raw ADF body through unchanged', async () => {
    client.post.mockResolvedValueOnce({ key: 'PROJ-3' });
    client.get.mockResolvedValueOnce(rawIssue({ key: 'PROJ-3' }));
    const adf = {
      type: 'doc' as const,
      version: 1 as const,
      content: [{ type: 'paragraph', content: [] }],
    };
    const c = createJiraIssuesClient(client);
    await c.create({ projectKey: 'PROJ', summary: 'S', issueType: 'Task', body: adf });
    const sent = client.post.mock.calls[0][1] as { fields: { description: unknown } };
    expect(sent.fields.description).toBe(adf);
  });

  it('omits optional fields when not provided', async () => {
    client.post.mockResolvedValueOnce({ key: 'PROJ-4' });
    client.get.mockResolvedValueOnce(rawIssue({ key: 'PROJ-4' }));
    const c = createJiraIssuesClient(client);
    await c.create({ projectKey: 'PROJ', summary: 'S', issueType: 'Task' });
    const sent = client.post.mock.calls[0][1] as { fields: Record<string, unknown> };
    expect(sent.fields).not.toHaveProperty('description');
    expect(sent.fields).not.toHaveProperty('priority');
    expect(sent.fields).not.toHaveProperty('labels');
    expect(sent.fields).not.toHaveProperty('assignee');
  });

  it('rejects creation outside the project allowlist before any request', async () => {
    client = stubClient(['ALLOWED']);
    const c = createJiraIssuesClient(client);
    await expect(
      c.create({ projectKey: 'OTHER', summary: 'S', issueType: 'Task' })
    ).rejects.toThrow(ScopeError);
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe('update', () => {
  it('sends only the provided fields, then re-fetches', async () => {
    client.put.mockResolvedValueOnce(undefined);
    client.get.mockResolvedValueOnce(rawIssue());
    const c = createJiraIssuesClient(client);
    await c.update('PROJ-1', { summary: 'Renamed', body: 'b', priority: 'High', labels: [] });
    const sent = client.put.mock.calls[0][1] as { fields: Record<string, unknown> };
    expect(sent.fields).toMatchObject({
      summary: 'Renamed',
      priority: { name: 'High' },
      labels: [],
    });
    expect(sent.fields.description).toMatchObject({ type: 'doc' });
  });

  it('sends an empty fields object when nothing is provided', async () => {
    client.put.mockResolvedValueOnce(undefined);
    client.get.mockResolvedValueOnce(rawIssue());
    const c = createJiraIssuesClient(client);
    await c.update('PROJ-1', {});
    expect(client.put.mock.calls[0][1]).toEqual({ fields: {} });
  });

  it('enforces the allowlist from the issue key before updating', async () => {
    client = stubClient(['ALLOWED']);
    const c = createJiraIssuesClient(client);
    await expect(c.update('OTHER-1', { summary: 'x' })).rejects.toThrow(ScopeError);
    expect(client.put).not.toHaveBeenCalled();
  });

  it('rejects when the issue ref is a numeric ID and an allowlist is set (cannot derive key)', async () => {
    client = stubClient(['ALLOWED']);
    const c = createJiraIssuesClient(client);
    await expect(c.update('10001', { summary: 'x' })).rejects.toThrow(ScopeError);
  });

  it('sends an assignee field when assigneeAccountId is provided', async () => {
    client.put.mockResolvedValueOnce(undefined);
    client.get.mockResolvedValueOnce(rawIssue());
    const c = createJiraIssuesClient(client);
    await c.update('PROJ-1', { assigneeAccountId: 'u9' });
    const sent = client.put.mock.calls[0][1] as { fields: Record<string, unknown> };
    expect(sent.fields).toMatchObject({ assignee: { accountId: 'u9' } });
  });

  it('omits the assignee field when assigneeAccountId is not provided', async () => {
    client.put.mockResolvedValueOnce(undefined);
    client.get.mockResolvedValueOnce(rawIssue());
    const c = createJiraIssuesClient(client);
    await c.update('PROJ-1', { summary: 'x' });
    const sent = client.put.mock.calls[0][1] as { fields: Record<string, unknown> };
    expect(sent.fields).not.toHaveProperty('assignee');
  });
});

describe('transitions & assignment', () => {
  it('lists transitions', async () => {
    client.get.mockResolvedValueOnce({
      transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress' } }],
    });
    const c = createJiraIssuesClient(client);
    expect(await c.getTransitions('PROJ-1')).toEqual([
      { id: '11', name: 'Start', to_status: 'In Progress' },
    ]);
  });

  it('handles a missing transitions array', async () => {
    client.get.mockResolvedValueOnce({});
    const c = createJiraIssuesClient(client);
    expect(await c.getTransitions('PROJ-1')).toEqual([]);
  });

  it('performs a transition by id', async () => {
    client.post.mockResolvedValueOnce(undefined);
    const c = createJiraIssuesClient(client);
    await c.transition('PROJ-1', '21');
    expect(client.post).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1/transitions', {
      transition: { id: '21' },
    });
  });

  it('assigns an issue to an account', async () => {
    client.put.mockResolvedValueOnce(undefined);
    const c = createJiraIssuesClient(client);
    await c.assign('PROJ-1', 'u5');
    expect(client.put).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1/assignee', {
      accountId: 'u5',
    });
  });

  it('unassigns with null', async () => {
    client.put.mockResolvedValueOnce(undefined);
    const c = createJiraIssuesClient(client);
    await c.assign('PROJ-1', null);
    expect(client.put).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1/assignee', {
      accountId: null,
    });
  });

  it('enforces the allowlist on transition and assign', async () => {
    client = stubClient(['ALLOWED']);
    const c = createJiraIssuesClient(client);
    await expect(c.transition('OTHER-1', '1')).rejects.toThrow(ScopeError);
    await expect(c.assign('OTHER-1', null)).rejects.toThrow(ScopeError);
  });
});

describe('getMyself', () => {
  it('returns the normalised current account', async () => {
    client.get.mockResolvedValueOnce({
      accountId: 'me',
      displayName: 'Me',
      emailAddress: 'me@x.com',
      active: true,
    });
    const c = createJiraIssuesClient(client);
    expect(await c.getMyself()).toEqual({
      account_id: 'me',
      display_name: 'Me',
      email_address: 'me@x.com',
      active: true,
    });
  });
});

describe('normalisation edge cases', () => {
  it('derives project_key from the issue key when fields.project is missing', async () => {
    client.get.mockResolvedValueOnce(rawIssue({ key: 'ABC-7' }, { project: undefined }));
    const c = createJiraIssuesClient(client);
    expect((await c.get('ABC-7')).project_key).toBe('ABC');
  });

  it('omits web_url when the self URL is unparseable', async () => {
    client.get.mockResolvedValueOnce(rawIssue({ self: 'not a url' }));
    const c = createJiraIssuesClient(client);
    expect((await c.get('PROJ-1')).web_url).toBeUndefined();
  });

  it('handles null assignee/reporter', async () => {
    client.get.mockResolvedValueOnce(rawIssue({}, { assignee: null, reporter: null }));
    const c = createJiraIssuesClient(client);
    const issue = await c.get('PROJ-1');
    expect(issue.assignee).toBeNull();
    expect(issue.reporter).toBeNull();
  });

  it('handles a completely empty raw issue', async () => {
    client.post.mockResolvedValueOnce({ issues: [{}] });
    const c = createJiraIssuesClient(client);
    const issue = (await c.search({ jql: 'x' })).issues[0];
    expect(issue).toEqual({
      id: '',
      key: '',
      summary: '',
      description: null,
      status: '',
      issue_type: '',
      project_key: '',
      priority: undefined,
      labels: [],
      assignee: null,
      reporter: null,
      created: '',
      updated: '',
      web_url: undefined,
    });
  });

  it('normalises a user with nothing set', async () => {
    client.get.mockResolvedValueOnce({});
    const c = createJiraIssuesClient(client);
    expect(await c.getMyself()).toEqual({
      account_id: '',
      display_name: '',
      email_address: undefined,
      active: true,
    });
  });

  it('normalises a transition with no `to`', async () => {
    client.get.mockResolvedValueOnce({ transitions: [{}] });
    const c = createJiraIssuesClient(client);
    expect(await c.getTransitions('PROJ-1')).toEqual([{ id: '', name: '', to_status: '' }]);
  });

  it('mapIssue derives project_key from a key with no hyphen as the whole key', async () => {
    client.post.mockResolvedValueOnce({ issues: [{ key: 'NOHYPHEN' }] });
    const c = createJiraIssuesClient(client);
    expect((await c.search({ jql: 'x' })).issues[0].project_key).toBe('NOHYPHEN');
  });
});

describe('addAttachment', () => {
  const rawAttachment = {
    id: '20001',
    filename: 'bug.png',
    size: 1234,
    mimeType: 'image/png',
    created: '2026-07-02T00:00:00.000+0000',
    content: 'https://acme.atlassian.net/secure/attachment/20001/bug.png',
    author: { accountId: 'u1', displayName: 'Alice', active: true },
  };

  it('uploads via client.uploadAttachment and normalises the first returned attachment', async () => {
    client.uploadAttachment.mockResolvedValueOnce([rawAttachment]);
    const c = createJiraIssuesClient(client);
    const data = Buffer.from('png-bytes');
    const res = await c.addAttachment('PROJ-1', {
      filename: 'bug.png',
      data,
      contentType: 'image/png',
    });
    expect(client.uploadAttachment).toHaveBeenCalledWith('PROJ-1', 'bug.png', data, 'image/png');
    expect(res).toEqual({
      id: '20001',
      filename: 'bug.png',
      size: 1234,
      mime_type: 'image/png',
      created: '2026-07-02T00:00:00.000+0000',
      url: 'https://acme.atlassian.net/secure/attachment/20001/bug.png',
      author: { account_id: 'u1', display_name: 'Alice', email_address: undefined, active: true },
    });
  });

  it('accepts a non-array response (defensive) and normalises it', async () => {
    client.uploadAttachment.mockResolvedValueOnce(rawAttachment);
    const c = createJiraIssuesClient(client);
    const res = await c.addAttachment('PROJ-1', {
      filename: 'bug.png',
      data: Buffer.from('x'),
      contentType: 'image/png',
    });
    expect(res.id).toBe('20001');
  });

  it('normalises an empty attachment payload to safe defaults', async () => {
    client.uploadAttachment.mockResolvedValueOnce([]);
    const c = createJiraIssuesClient(client);
    const res = await c.addAttachment('PROJ-1', {
      filename: 'x',
      data: Buffer.from('x'),
      contentType: 'application/octet-stream',
    });
    expect(res).toEqual({
      id: '',
      filename: '',
      size: undefined,
      mime_type: undefined,
      created: undefined,
      url: undefined,
      author: null,
    });
  });

  it('enforces the project allowlist and does not upload for a disallowed issue key', async () => {
    const restricted = stubClient(['ALLOWED']);
    const c = createJiraIssuesClient(restricted);
    await expect(
      c.addAttachment('OTHER-9', {
        filename: 'x',
        data: Buffer.from('x'),
        contentType: 'image/png',
      })
    ).rejects.toBeInstanceOf(ScopeError);
    expect(restricted.uploadAttachment).not.toHaveBeenCalled();
  });
});

describe('deleteAttachment', () => {
  it('DELETEs the attachment endpoint by ID', async () => {
    client.del.mockResolvedValueOnce(undefined);
    const c = createJiraIssuesClient(client);
    await c.deleteAttachment('10475');
    expect(client.del).toHaveBeenCalledWith('/rest/api/3/attachment/10475');
  });

  it('URL-encodes the attachment ID', async () => {
    client.del.mockResolvedValueOnce(undefined);
    const c = createJiraIssuesClient(client);
    await c.deleteAttachment('a/b');
    expect(client.del).toHaveBeenCalledWith('/rest/api/3/attachment/a%2Fb');
  });

  it('fails closed (ScopeError) when a project allowlist is configured and does not call the API', async () => {
    const restricted = stubClient(['ALLOWED']);
    const c = createJiraIssuesClient(restricted);
    await expect(c.deleteAttachment('10475')).rejects.toBeInstanceOf(ScopeError);
    expect(restricted.del).not.toHaveBeenCalled();
  });
});
