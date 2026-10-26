/**
 * Tests for the Jira issues domain client (search/CRUD/transitions/assignment),
 * including allowlist scope enforcement and response normalisation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createJiraIssuesClient, UnknownLinkRelationError } from './jira-issues.js';
import { markdownToAdf } from '../adf.js';
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
      description: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }],
      },
      status: { name: 'To Do' },
      issuetype: { name: 'Task' },
      project: { key: 'PROJ' },
      priority: { name: 'High' },
      labels: ['a', 'b'],
      components: [{ name: 'core' }, { name: 'ui' }],
      parent: {
        key: 'PROJ-100',
        fields: { summary: 'Epic', status: { name: 'In Progress' }, issuetype: { name: 'Epic' } },
      },
      issuelinks: [],
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
      issues: [rawIssue({}, { description: undefined })],
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
    const requested = (client.post.mock.calls[0][1] as { fields: string[] }).fields;
    expect(requested).not.toContain('description');
    expect(requested).toEqual(expect.arrayContaining(['parent', 'components', 'issuelinks']));
    expect(res.issues[0]).not.toHaveProperty('description');
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
    expect(issue).toEqual({
      key: 'PROJ-1',
      id: '10001',
      web_url: 'https://acme.atlassian.net/browse/PROJ-1',
      summary: 'Hello',
      description: 'Body',
      type: 'Task',
      status: 'To Do',
      project: 'PROJ',
      priority: 'High',
      labels: ['a', 'b'],
      components: ['core', 'ui'],
      parent: { key: 'PROJ-100', summary: 'Epic', type: 'Epic', status: 'In Progress' },
      links: [],
      assignee: { account_id: 'u1', name: 'Alice' },
      reporter: { account_id: 'u2', name: 'Bob' },
      created: '2026-01-01T00:00:00.000+0000',
      updated: '2026-01-02T00:00:00.000+0000',
    });
  });

  it('requests parent, components, links, issue type and description', async () => {
    client.get.mockResolvedValueOnce(rawIssue());
    const c = createJiraIssuesClient(client);
    await c.get('PROJ-1');
    const fields = (client.get.mock.calls[0][1] as { fields: string }).fields.split(',');
    expect(fields).toEqual(
      expect.arrayContaining(['parent', 'components', 'issuelinks', 'issuetype', 'description'])
    );
  });

  it('maps links with the relation read from this issue side', async () => {
    client.get.mockResolvedValueOnce(
      rawIssue(
        {},
        {
          issuelinks: [
            {
              id: '501',
              type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
              inwardIssue: {
                key: 'PROJ-7',
                fields: { summary: 'Blocker', status: { name: 'Open' } },
              },
            },
            {
              id: '502',
              type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
              outwardIssue: {
                key: 'PROJ-8',
                fields: { summary: 'Blocked', status: { name: 'Done' } },
              },
            },
          ],
        }
      )
    );
    const c = createJiraIssuesClient(client);
    expect((await c.get('PROJ-1')).links).toEqual([
      {
        id: '501',
        relation: 'is blocked by',
        issue: { key: 'PROJ-7', summary: 'Blocker', status: 'Open' },
      },
      {
        id: '502',
        relation: 'blocks',
        issue: { key: 'PROJ-8', summary: 'Blocked', status: 'Done' },
      },
    ]);
  });

  it('maps an empty link object to empty strings', async () => {
    client.get.mockResolvedValueOnce(rawIssue({}, { issuelinks: [{}] }));
    const c = createJiraIssuesClient(client);
    expect((await c.get('PROJ-1')).links).toEqual([
      { id: '', relation: '', issue: { key: '', summary: '', status: '' } },
    ]);
  });

  it('returns a null parent and empty components when the issue has neither', async () => {
    client.get.mockResolvedValueOnce(
      rawIssue({}, { parent: undefined, components: undefined, issuelinks: undefined })
    );
    const c = createJiraIssuesClient(client);
    const issue = await c.get('PROJ-1');
    expect(issue.parent).toBeNull();
    expect(issue.components).toEqual([]);
    expect(issue.links).toEqual([]);
  });

  it('renders a null description as an empty string', async () => {
    client.get.mockResolvedValueOnce(rawIssue({}, { description: null }));
    const c = createJiraIssuesClient(client);
    expect((await c.get('PROJ-1')).description).toBe('');
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

function sentFields(call: 'post' | 'put'): Record<string, unknown> {
  return (client[call].mock.calls[0][1] as { fields: Record<string, unknown> }).fields;
}

describe('create', () => {
  it('converts the Markdown description to ADF, maps the caller shape, then re-fetches', async () => {
    client.post.mockResolvedValueOnce({ key: 'PROJ-2' });
    client.get.mockResolvedValueOnce(rawIssue({ key: 'PROJ-2' }));
    const c = createJiraIssuesClient(client);
    const issue = await c.create({
      project: 'PROJ',
      type: 'Bug',
      summary: 'New',
      description: '# Title\n\n**bold**',
      priority: 'Low',
      labels: ['x'],
      assignee: 'u9',
      parent: 'PROJ-100',
      components: ['core', 'ui'],
    });
    expect(client.post.mock.calls[0][0]).toBe('/rest/api/3/issue');
    expect(sentFields('post')).toEqual({
      project: { key: 'PROJ' },
      summary: 'New',
      issuetype: { name: 'Bug' },
      description: markdownToAdf('# Title\n\n**bold**'),
      priority: { name: 'Low' },
      labels: ['x'],
      assignee: { accountId: 'u9' },
      parent: { key: 'PROJ-100' },
      components: [{ name: 'core' }, { name: 'ui' }],
    });
    expect(client.get).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-2', expect.anything());
    expect(issue.key).toBe('PROJ-2');
  });

  it('sends a numeric parent as an id', async () => {
    client.post.mockResolvedValueOnce({ key: 'PROJ-2' });
    client.get.mockResolvedValueOnce(rawIssue());
    const c = createJiraIssuesClient(client);
    await c.create({ project: 'PROJ', type: 'Sub-task', summary: 'S', parent: '10050' });
    expect(sentFields('post').parent).toEqual({ id: '10050' });
  });

  it('passes a raw ADF description through unchanged', async () => {
    client.post.mockResolvedValueOnce({ key: 'PROJ-3' });
    client.get.mockResolvedValueOnce(rawIssue({ key: 'PROJ-3' }));
    const adf = {
      type: 'doc' as const,
      version: 1 as const,
      content: [{ type: 'paragraph', content: [] }],
    };
    const c = createJiraIssuesClient(client);
    await c.create({ project: 'PROJ', type: 'Task', summary: 'S', description_adf: adf });
    expect(sentFields('post').description).toBe(adf);
  });

  it('rejects description together with description_adf before any request', async () => {
    const c = createJiraIssuesClient(client);
    await expect(
      c.create({
        project: 'PROJ',
        type: 'Task',
        summary: 'S',
        description: 'x',
        description_adf: { type: 'doc', version: 1, content: [] },
      })
    ).rejects.toThrow(/description.*description_adf/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('resolves assignee "me" through the myself endpoint', async () => {
    client.get.mockResolvedValueOnce({ accountId: 'self-1', displayName: 'Me' });
    client.post.mockResolvedValueOnce({ key: 'PROJ-5' });
    client.get.mockResolvedValueOnce(rawIssue({ key: 'PROJ-5' }));
    const c = createJiraIssuesClient(client);
    await c.create({ project: 'PROJ', type: 'Task', summary: 'S', assignee: 'me' });
    expect(client.get.mock.calls[0][0]).toBe('/rest/api/3/myself');
    expect(sentFields('post').assignee).toEqual({ accountId: 'self-1' });
  });

  it('omits optional fields when not provided', async () => {
    client.post.mockResolvedValueOnce({ key: 'PROJ-4' });
    client.get.mockResolvedValueOnce(rawIssue({ key: 'PROJ-4' }));
    const c = createJiraIssuesClient(client);
    await c.create({ project: 'PROJ', type: 'Task', summary: 'S' });
    expect(Object.keys(sentFields('post')).sort()).toEqual(['issuetype', 'project', 'summary']);
  });

  it('rejects creation outside the project allowlist before any request', async () => {
    client = stubClient(['ALLOWED']);
    const c = createJiraIssuesClient(client);
    await expect(c.create({ project: 'OTHER', type: 'Task', summary: 'S' })).rejects.toThrow(
      ScopeError
    );
    expect(client.post).not.toHaveBeenCalled();
  });

  it('rejects a parent outside the project allowlist before any request', async () => {
    client = stubClient(['PROJ']);
    const c = createJiraIssuesClient(client);
    await expect(
      c.create({ project: 'PROJ', type: 'Sub-task', summary: 'S', parent: 'OTHER-1' })
    ).rejects.toThrow(ScopeError);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('lets a client error propagate with its status intact', async () => {
    const failure = Object.assign(new Error('bad request'), { status: 400 });
    client.post.mockRejectedValueOnce(failure);
    const c = createJiraIssuesClient(client);
    await expect(c.create({ project: 'PROJ', type: 'Task', summary: 'S' })).rejects.toBe(failure);
  });
});

describe('update', () => {
  it('sends only the provided fields, then re-fetches', async () => {
    client.put.mockResolvedValueOnce(undefined);
    client.get.mockResolvedValueOnce(rawIssue());
    const c = createJiraIssuesClient(client);
    await c.update('PROJ-1', {
      summary: 'Renamed',
      description: 'b',
      priority: 'High',
      labels: [],
      type: 'Story',
      components: ['core'],
    });
    expect(client.put.mock.calls[0][0]).toBe('/rest/api/3/issue/PROJ-1');
    expect(sentFields('put')).toEqual({
      summary: 'Renamed',
      description: markdownToAdf('b'),
      priority: { name: 'High' },
      labels: [],
      issuetype: { name: 'Story' },
      components: [{ name: 'core' }],
    });
    expect(client.get).toHaveBeenCalledWith('/rest/api/3/issue/PROJ-1', expect.anything());
  });

  it('sends an empty fields object when nothing is provided', async () => {
    client.put.mockResolvedValueOnce(undefined);
    client.get.mockResolvedValueOnce(rawIssue());
    const c = createJiraIssuesClient(client);
    await c.update('PROJ-1', {});
    expect(client.put.mock.calls[0][1]).toEqual({ fields: {} });
  });

  it('clears components with an empty list', async () => {
    client.put.mockResolvedValueOnce(undefined);
    client.get.mockResolvedValueOnce(rawIssue());
    const c = createJiraIssuesClient(client);
    await c.update('PROJ-1', { components: [] });
    expect(sentFields('put')).toEqual({ components: [] });
  });

  it('detaches the parent with null and sets one with a key or id', async () => {
    client.put.mockResolvedValue(undefined);
    client.get.mockResolvedValue(rawIssue());
    const c = createJiraIssuesClient(client);
    await c.update('PROJ-1', { parent: null });
    await c.update('PROJ-1', { parent: 'PROJ-2' });
    await c.update('PROJ-1', { parent: '10077' });
    const parents = client.put.mock.calls.map(
      (call) => (call[1] as { fields: { parent: unknown } }).fields.parent
    );
    expect(parents).toEqual([null, { key: 'PROJ-2' }, { id: '10077' }]);
  });

  it('addresses the issue by numeric id when no allowlist is set', async () => {
    client.put.mockResolvedValueOnce(undefined);
    client.get.mockResolvedValueOnce(rawIssue());
    const c = createJiraIssuesClient(client);
    await c.update('10001', { summary: 'x' });
    expect(client.put.mock.calls[0][0]).toBe('/rest/api/3/issue/10001');
  });

  it('sets, resolves and clears the assignee', async () => {
    client.put.mockResolvedValue(undefined);
    client.get.mockImplementation(async (path: string) =>
      path === '/rest/api/3/myself' ? { accountId: 'self-1' } : rawIssue()
    );
    const c = createJiraIssuesClient(client);
    await c.update('PROJ-1', { assignee: 'u9' });
    await c.update('PROJ-1', { assignee: 'me' });
    await c.update('PROJ-1', { assignee: null });
    const assignees = client.put.mock.calls.map(
      (call) => (call[1] as { fields: { assignee: unknown } }).fields.assignee
    );
    expect(assignees).toEqual([{ accountId: 'u9' }, { accountId: 'self-1' }, null]);
  });

  it('passes a raw ADF description through unchanged', async () => {
    client.put.mockResolvedValueOnce(undefined);
    client.get.mockResolvedValueOnce(rawIssue());
    const adf = { type: 'doc' as const, version: 1 as const, content: [] };
    const c = createJiraIssuesClient(client);
    await c.update('PROJ-1', { description_adf: adf });
    expect(sentFields('put').description).toBe(adf);
  });

  it('rejects description together with description_adf before any request', async () => {
    const c = createJiraIssuesClient(client);
    await expect(
      c.update('PROJ-1', {
        description: 'x',
        description_adf: { type: 'doc', version: 1, content: [] },
      })
    ).rejects.toThrow(/description.*description_adf/);
    expect(client.put).not.toHaveBeenCalled();
  });

  it('enforces the allowlist on the issue and the parent before updating', async () => {
    client = stubClient(['ALLOWED']);
    const c = createJiraIssuesClient(client);
    await expect(c.update('OTHER-1', { summary: 'x' })).rejects.toThrow(ScopeError);
    await expect(c.update('ALLOWED-1', { parent: 'OTHER-2' })).rejects.toThrow(ScopeError);
    expect(client.put).not.toHaveBeenCalled();
  });

  it('rejects when the issue ref is a numeric ID and an allowlist is set (cannot derive key)', async () => {
    client = stubClient(['ALLOWED']);
    const c = createJiraIssuesClient(client);
    await expect(c.update('10001', { summary: 'x' })).rejects.toThrow(ScopeError);
  });

  it('enforces the allowlist on the re-fetched issue', async () => {
    client = stubClient(['ALLOWED']);
    client.put.mockResolvedValueOnce(undefined);
    client.get.mockResolvedValueOnce(rawIssue({ key: 'ALLOWED-1' }, { project: { key: 'OTHER' } }));
    const c = createJiraIssuesClient(client);
    await expect(c.update('ALLOWED-1', { summary: 'x' })).rejects.toThrow(ScopeError);
  });
});

describe('delete', () => {
  it('DELETEs the issue by key or id without deleteSubtasks', async () => {
    client.del.mockResolvedValue(undefined);
    const c = createJiraIssuesClient(client);
    await c.delete('PROJ-1');
    await c.delete('10001');
    expect(client.del.mock.calls).toEqual([
      ['/rest/api/3/issue/PROJ-1'],
      ['/rest/api/3/issue/10001'],
    ]);
  });

  it('enforces the allowlist before deleting', async () => {
    client = stubClient(['ALLOWED']);
    const c = createJiraIssuesClient(client);
    await expect(c.delete('OTHER-1')).rejects.toThrow(ScopeError);
    expect(client.del).not.toHaveBeenCalled();
  });
});

describe('link types and linking', () => {
  const linkTypes = {
    issueLinkTypes: [
      { id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
      { id: '2', name: 'Relates', inward: 'relates to', outward: 'relates to' },
    ],
  };

  it('lists link types', async () => {
    client.get.mockResolvedValueOnce(linkTypes);
    const c = createJiraIssuesClient(client);
    expect(await c.listLinkTypes()).toEqual([
      { id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
      { id: '2', name: 'Relates', inward: 'relates to', outward: 'relates to' },
    ]);
    expect(client.get).toHaveBeenCalledWith('/rest/api/3/issueLinkType');
  });

  it('lists nothing and normalises blanks when the response is empty', async () => {
    client.get.mockResolvedValueOnce({ issueLinkTypes: [{}] }).mockResolvedValueOnce({});
    const c = createJiraIssuesClient(client);
    expect(await c.listLinkTypes()).toEqual([{ id: '', name: '', inward: '', outward: '' }]);
    expect(await c.listLinkTypes()).toEqual([]);
  });

  it('links with this issue as the outward end when the relation is the outward text', async () => {
    client.get.mockResolvedValueOnce(linkTypes);
    client.post.mockResolvedValueOnce(undefined);
    const c = createJiraIssuesClient(client);
    await c.linkIssues('PROJ-1', 'blocks', 'PROJ-2');
    expect(client.post).toHaveBeenCalledWith('/rest/api/3/issueLink', {
      type: { name: 'Blocks' },
      outwardIssue: { key: 'PROJ-1' },
      inwardIssue: { key: 'PROJ-2' },
    });
  });

  it('links with this issue as the inward end when the relation is the inward text, case-insensitively', async () => {
    client.get.mockResolvedValueOnce(linkTypes);
    client.post.mockResolvedValueOnce(undefined);
    const c = createJiraIssuesClient(client);
    await c.linkIssues('PROJ-1', '  Is Blocked BY ', '10002');
    expect(client.post).toHaveBeenCalledWith('/rest/api/3/issueLink', {
      type: { name: 'Blocks' },
      inwardIssue: { key: 'PROJ-1' },
      outwardIssue: { id: '10002' },
    });
  });

  it('fetches the link types once per client instance', async () => {
    client.get.mockResolvedValueOnce(linkTypes);
    client.post.mockResolvedValue(undefined);
    const c = createJiraIssuesClient(client);
    await c.linkIssues('PROJ-1', 'blocks', 'PROJ-2');
    await c.linkIssues('PROJ-3', 'relates to', 'PROJ-4');
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledTimes(2);
  });

  it('refreshes the cache when listLinkTypes is called', async () => {
    client.get.mockResolvedValueOnce({ issueLinkTypes: [] }).mockResolvedValueOnce(linkTypes);
    client.post.mockResolvedValue(undefined);
    const c = createJiraIssuesClient(client);
    await c.listLinkTypes();
    await c.listLinkTypes();
    await c.linkIssues('PROJ-1', 'blocks', 'PROJ-2');
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed link type lookup', async () => {
    client.get.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(linkTypes);
    client.post.mockResolvedValue(undefined);
    const c = createJiraIssuesClient(client);
    await expect(c.linkIssues('PROJ-1', 'blocks', 'PROJ-2')).rejects.toThrow('down');
    await c.linkIssues('PROJ-1', 'blocks', 'PROJ-2');
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it('throws UnknownLinkRelationError listing the valid relations and sends nothing', async () => {
    client.get.mockResolvedValueOnce(linkTypes);
    const c = createJiraIssuesClient(client);
    const failure = await c.linkIssues('PROJ-1', 'duplicates', 'PROJ-2').catch((e) => e);
    expect(failure).toBeInstanceOf(UnknownLinkRelationError);
    expect(failure.relation).toBe('duplicates');
    expect(failure.available).toEqual(['blocks', 'is blocked by', 'relates to']);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('enforces the allowlist on both link ends before any request', async () => {
    client = stubClient(['PROJ']);
    const c = createJiraIssuesClient(client);
    await expect(c.linkIssues('OTHER-1', 'blocks', 'PROJ-2')).rejects.toThrow(ScopeError);
    await expect(c.linkIssues('PROJ-1', 'blocks', 'OTHER-2')).rejects.toThrow(ScopeError);
    expect(client.get).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });
});

describe('unlinkIssues', () => {
  it('DELETEs the link by id and encodes it', async () => {
    client.del.mockResolvedValueOnce(undefined);
    const c = createJiraIssuesClient(client);
    await c.unlinkIssues('501/x');
    expect(client.del).toHaveBeenCalledWith('/rest/api/3/issueLink/501%2Fx');
    expect(client.get).not.toHaveBeenCalled();
  });

  it('checks both link ends against the allowlist before deleting', async () => {
    client = stubClient(['PROJ']);
    client.get.mockResolvedValueOnce({
      id: '501',
      inwardIssue: { key: 'PROJ-1' },
      outwardIssue: { key: 'OTHER-2' },
    });
    const c = createJiraIssuesClient(client);
    await expect(c.unlinkIssues('501')).rejects.toThrow(ScopeError);
    expect(client.get).toHaveBeenCalledWith('/rest/api/3/issueLink/501');
    expect(client.del).not.toHaveBeenCalled();
  });

  it('deletes when both ends are allowed', async () => {
    client = stubClient(['PROJ']);
    client.get.mockResolvedValueOnce({
      id: '501',
      inwardIssue: { key: 'PROJ-1' },
      outwardIssue: { key: 'PROJ-2' },
    });
    client.del.mockResolvedValueOnce(undefined);
    const c = createJiraIssuesClient(client);
    await c.unlinkIssues('501');
    expect(client.del).toHaveBeenCalledWith('/rest/api/3/issueLink/501');
  });

  it('fails closed when the link ends cannot be read under an allowlist', async () => {
    client = stubClient(['PROJ']);
    client.get.mockResolvedValueOnce({});
    const c = createJiraIssuesClient(client);
    await expect(c.unlinkIssues('501')).rejects.toThrow(ScopeError);
    expect(client.del).not.toHaveBeenCalled();
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
    expect(await c.getMyself()).toEqual({ account_id: 'me', name: 'Me' });
  });
});

describe('normalisation edge cases', () => {
  it('derives project_key from the issue key when fields.project is missing', async () => {
    client.get.mockResolvedValueOnce(rawIssue({ key: 'ABC-7' }, { project: undefined }));
    const c = createJiraIssuesClient(client);
    expect((await c.get('ABC-7')).project).toBe('ABC');
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
      key: '',
      id: '',
      web_url: undefined,
      summary: '',
      type: '',
      status: '',
      project: '',
      priority: null,
      labels: [],
      components: [],
      parent: null,
      links: [],
      assignee: null,
      reporter: null,
      created: '',
      updated: '',
    });
  });

  it('normalises a user with nothing set', async () => {
    client.get.mockResolvedValueOnce({});
    const c = createJiraIssuesClient(client);
    expect(await c.getMyself()).toEqual({ account_id: '', name: '' });
  });

  it('normalises a transition with no `to`', async () => {
    client.get.mockResolvedValueOnce({ transitions: [{}] });
    const c = createJiraIssuesClient(client);
    expect(await c.getTransitions('PROJ-1')).toEqual([{ id: '', name: '', to_status: '' }]);
  });

  it('mapIssue derives project_key from a key with no hyphen as the whole key', async () => {
    client.post.mockResolvedValueOnce({ issues: [{ key: 'NOHYPHEN' }] });
    const c = createJiraIssuesClient(client);
    expect((await c.search({ jql: 'x' })).issues[0].project).toBe('NOHYPHEN');
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
      author: { account_id: 'u1', name: 'Alice' },
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
