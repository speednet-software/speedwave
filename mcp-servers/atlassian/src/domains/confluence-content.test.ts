/**
 * Tests for the Confluence page-content domain client (comments / labels /
 * attachments) including space-key scope enforcement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createConfluenceContentClient } from './confluence-content.js';
import { ScopeError } from '../scope.js';
import type { AtlassianClient } from '../client.js';

function stubClient(spaceKeys: string[] = []) {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
    jiraProjectKeys: [] as string[],
    confluenceSpaceKeys: spaceKeys,
  } as unknown as AtlassianClient & {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  };
}

let client: ReturnType<typeof stubClient>;
beforeEach(() => {
  client = stubClient();
});

describe('addComment', () => {
  it('POSTs a footer comment with a wrapped plain-text body and normalises', async () => {
    client.post.mockResolvedValueOnce({
      id: '50',
      pageId: '123',
      version: { number: 1, createdAt: 't' },
      body: { storage: { value: '<p>nice</p>' } },
    });
    const c = createConfluenceContentClient(client);
    const comment = await c.addComment('123', { text: 'a < b' });
    const sent = client.post.mock.calls[0];
    expect(sent[0]).toBe('/wiki/api/v2/footer-comments');
    expect(sent[1]).toEqual({
      pageId: '123',
      body: { representation: 'storage', value: '<p>a &lt; b</p>' },
    });
    expect(comment).toEqual({
      id: '50',
      page_id: '123',
      body_storage: '<p>nice</p>',
      version: 1,
      created_at: 't',
    });
  });

  it('passes a raw storage body through', async () => {
    client.post.mockResolvedValueOnce({ id: '51', pageId: '123', version: { number: 1 } });
    const c = createConfluenceContentClient(client);
    await c.addComment('123', { storage: '<p>raw</p>' });
    expect((client.post.mock.calls[0][1] as { body: { value: string } }).body.value).toBe(
      '<p>raw</p>'
    );
  });

  it('enforces the space allowlist by resolving the page space', async () => {
    client = stubClient(['DEV']);
    client.get
      .mockResolvedValueOnce({ spaceId: '900' }) // page
      .mockResolvedValueOnce({ key: 'OPS' }); // space
    const c = createConfluenceContentClient(client);
    await expect(c.addComment('123', { text: 'x' })).rejects.toThrow(ScopeError);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('allows the operation when the page space is in the allowlist', async () => {
    client = stubClient(['DEV']);
    client.get.mockResolvedValueOnce({ spaceId: '900' }).mockResolvedValueOnce({ key: 'DEV' });
    client.post.mockResolvedValueOnce({ id: '52', pageId: '123', version: { number: 1 } });
    const c = createConfluenceContentClient(client);
    await expect(c.addComment('123', { text: 'ok' })).resolves.toMatchObject({ id: '52' });
  });

  it('rejects with ScopeError when the space 404s (genuinely unresolvable) and an allowlist is set', async () => {
    client = stubClient(['DEV']);
    const notFound = Object.assign(new Error('not found'), { response: { status: 404 } });
    client.get.mockResolvedValueOnce({ spaceId: '900' }).mockRejectedValueOnce(notFound);
    const c = createConfluenceContentClient(client);
    await expect(c.addComment('123', { text: 'x' })).rejects.toThrow(ScopeError);
  });

  it('rethrows a non-404 space lookup failure instead of conflating it with scope denial', async () => {
    client = stubClient(['DEV']);
    client.get
      .mockResolvedValueOnce({ spaceId: '900' })
      .mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const c = createConfluenceContentClient(client);
    await expect(c.addComment('123', { text: 'x' })).rejects.toThrow(/space lookup failed/i);
  });

  it('includes the page and space IDs in a rethrown non-404 space lookup failure', async () => {
    client = stubClient(['DEV']);
    client.get
      .mockResolvedValueOnce({ spaceId: '900' })
      .mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const c = createConfluenceContentClient(client);
    await expect(c.addComment('123', { text: 'x' })).rejects.toThrow(/'900'.*'123'/s);
  });

  it('rejects when the page has no spaceId and an allowlist is set', async () => {
    client = stubClient(['DEV']);
    client.get.mockResolvedValueOnce({}); // page, no spaceId
    const c = createConfluenceContentClient(client);
    await expect(c.addComment('123', { text: 'x' })).rejects.toThrow(ScopeError);
  });
});

describe('getComments', () => {
  it('GETs footer comments with a capped limit and storage body', async () => {
    client.get.mockResolvedValueOnce({
      results: [
        {
          id: '1',
          pageId: '123',
          version: { number: 2 },
          body: { storage: { value: '<p>c</p>' } },
        },
      ],
    });
    const c = createConfluenceContentClient(client);
    const res = await c.getComments('123', { limit: 999 });
    expect(client.get).toHaveBeenCalledWith('/wiki/api/v2/pages/123/footer-comments', {
      limit: 100,
      'body-format': 'storage',
    });
    expect(res[0]).toMatchObject({ id: '1', page_id: '123', body_storage: '<p>c</p>', version: 2 });
  });

  it('handles a missing results array and default limit', async () => {
    client.get.mockResolvedValueOnce({});
    const c = createConfluenceContentClient(client);
    expect(await c.getComments('123')).toEqual([]);
    expect(client.get).toHaveBeenCalledWith('/wiki/api/v2/pages/123/footer-comments', {
      limit: 25,
      'body-format': 'storage',
    });
  });

  it('enforces the space allowlist before reading comments', async () => {
    client = stubClient(['DEV']);
    client.get.mockResolvedValueOnce({ spaceId: '900' }).mockResolvedValueOnce({ key: 'OPS' });
    const c = createConfluenceContentClient(client);
    await expect(c.getComments('123')).rejects.toThrow(ScopeError);
  });
});

describe('addLabels', () => {
  it('POSTs the labels via the v1 endpoint and normalises', async () => {
    client.post.mockResolvedValueOnce({ results: [{ id: '7', name: 'docs', prefix: 'global' }] });
    const c = createConfluenceContentClient(client);
    const res = await c.addLabels('123', ['docs', 'wip']);
    const sent = client.post.mock.calls[0];
    expect(sent[0]).toBe('/wiki/rest/api/content/123/label');
    expect(sent[1]).toEqual([
      { prefix: 'global', name: 'docs' },
      { prefix: 'global', name: 'wip' },
    ]);
    expect(res).toEqual([{ id: '7', name: 'docs', prefix: 'global' }]);
  });

  it('handles a missing results array', async () => {
    client.post.mockResolvedValueOnce({});
    const c = createConfluenceContentClient(client);
    expect(await c.addLabels('123', ['x'])).toEqual([]);
  });
});

describe('getLabels', () => {
  it('GETs labels with a capped limit and normalises', async () => {
    client.get.mockResolvedValueOnce({ results: [{ id: '7', name: 'docs' }] });
    const c = createConfluenceContentClient(client);
    const res = await c.getLabels('123', { limit: 999 });
    expect(client.get).toHaveBeenCalledWith('/wiki/api/v2/pages/123/labels', { limit: 100 });
    expect(res).toEqual([{ id: '7', name: 'docs', prefix: undefined }]);
  });

  it('handles a missing results array and default limit', async () => {
    client.get.mockResolvedValueOnce({});
    const c = createConfluenceContentClient(client);
    expect(await c.getLabels('123')).toEqual([]);
    expect(client.get).toHaveBeenCalledWith('/wiki/api/v2/pages/123/labels', { limit: 50 });
  });

  it('enforces the space allowlist before reading labels', async () => {
    client = stubClient(['DEV']);
    client.get.mockResolvedValueOnce({ spaceId: '900' }).mockResolvedValueOnce({ key: 'OPS' });
    const c = createConfluenceContentClient(client);
    await expect(c.getLabels('123')).rejects.toThrow(ScopeError);
  });
});

describe('listAttachments', () => {
  it('GETs attachments with a capped limit and normalises', async () => {
    client.get.mockResolvedValueOnce({
      results: [
        {
          id: 'a1',
          title: 'file.png',
          mediaType: 'image/png',
          fileSize: 1024,
          pageId: '123',
          _links: { download: '/dl' },
        },
      ],
    });
    const c = createConfluenceContentClient(client);
    const res = await c.listAttachments('123', { limit: 999 });
    expect(client.get).toHaveBeenCalledWith('/wiki/api/v2/pages/123/attachments', { limit: 100 });
    expect(res[0]).toEqual({
      id: 'a1',
      title: 'file.png',
      media_type: 'image/png',
      file_size: 1024,
      page_id: '123',
      download_url: '/dl',
    });
  });

  it('handles a missing results array, default limit, and falls back page_id', async () => {
    client.get.mockResolvedValueOnce({ results: [{ id: 'a2', title: 't' }] });
    const c = createConfluenceContentClient(client);
    const res = await c.listAttachments('123');
    expect(client.get).toHaveBeenCalledWith('/wiki/api/v2/pages/123/attachments', { limit: 50 });
    expect(res[0]).toEqual({
      id: 'a2',
      title: 't',
      media_type: undefined,
      file_size: undefined,
      page_id: '123',
      download_url: undefined,
    });
  });

  it('enforces the space allowlist before listing attachments', async () => {
    client = stubClient(['DEV']);
    client.get.mockResolvedValueOnce({ spaceId: '900' }).mockResolvedValueOnce({ key: 'OPS' });
    const c = createConfluenceContentClient(client);
    await expect(c.listAttachments('123')).rejects.toThrow(ScopeError);
  });
});

describe('space-allowlist enforcement', () => {
  it('is skipped (single GET) when confluenceSpaceKeys is empty', async () => {
    client.get.mockResolvedValueOnce({ results: [] }); // getLabels
    const c = createConfluenceContentClient(client);
    await c.getLabels('123');
    // Only the getLabels GET — no extra page/space lookups.
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('allows the operation when the page-space resolves into the allowlist', async () => {
    client = stubClient(['DEV']);
    client.get.mockResolvedValueOnce({ spaceId: '900' }).mockResolvedValueOnce({ key: 'DEV' });
    client.post.mockResolvedValueOnce({ results: [{ id: '7', name: 'docs' }] });
    const c = createConfluenceContentClient(client);
    await expect(c.addLabels('123', ['docs'])).resolves.toEqual([
      { id: '7', name: 'docs', prefix: undefined },
    ]);
  });
});

describe('normalisation of minimal payloads', () => {
  it('normalises a comment with nothing set (page_id falls back to the ref)', async () => {
    client.post.mockResolvedValueOnce({});
    const c = createConfluenceContentClient(client);
    expect(await c.addComment('p9', { text: 'x' })).toEqual({
      id: '',
      page_id: 'p9',
      body_storage: '',
      version: 1,
      created_at: undefined,
    });
  });

  it('normalises a comment with a createdAt timestamp', async () => {
    client.get.mockResolvedValueOnce({
      results: [{ id: '1', version: { number: 2, createdAt: 'ts' } }],
    });
    const c = createConfluenceContentClient(client);
    expect((await c.getComments('p1'))[0].created_at).toBe('ts');
  });

  it('normalises a label with nothing set', async () => {
    client.post.mockResolvedValueOnce({ results: [{}] });
    const c = createConfluenceContentClient(client);
    expect(await c.addLabels('p1', ['x'])).toEqual([{ id: '', name: '', prefix: undefined }]);
  });

  it('normalises an attachment with nothing set (page_id from the ref)', async () => {
    client.get.mockResolvedValueOnce({ results: [{}] });
    const c = createConfluenceContentClient(client);
    expect((await c.listAttachments('p3'))[0]).toEqual({
      id: '',
      title: '',
      media_type: undefined,
      file_size: undefined,
      page_id: 'p3',
      download_url: undefined,
    });
  });
});
