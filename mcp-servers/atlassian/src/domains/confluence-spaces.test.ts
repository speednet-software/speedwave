/**
 * Tests for the Confluence spaces domain client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createConfluenceSpacesClient } from './confluence-spaces.js';
import { ScopeError } from '../adf.js';
import type { AtlassianClient } from '../client.js';

function stubClient(spaceKeys: string[] = []) {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
    jiraProjectKeys: [] as string[],
    confluenceSpaceKeys: spaceKeys,
  } as unknown as AtlassianClient & { get: ReturnType<typeof vi.fn> };
}

const rawSpace = (over: Record<string, unknown> = {}) => ({
  id: '900',
  key: 'DEV',
  name: 'Development',
  type: 'global',
  status: 'current',
  ...over,
});

let client: ReturnType<typeof stubClient>;
beforeEach(() => {
  client = stubClient();
});

describe('list', () => {
  it('lists spaces, caps limit, passes keys filter, normalises', async () => {
    client.get.mockResolvedValueOnce({ results: [rawSpace()] });
    const c = createConfluenceSpacesClient(client);
    const res = await c.list({ keys: ['DEV', 'OPS'], limit: 999 });
    expect(client.get).toHaveBeenCalledWith('/wiki/api/v2/spaces', { limit: 100, keys: 'DEV,OPS' });
    expect(res[0]).toEqual({
      id: '900',
      key: 'DEV',
      name: 'Development',
      type: 'global',
      status: 'current',
    });
  });

  it('filters by the configured allowlist', async () => {
    client = stubClient(['DEV']);
    client.get.mockResolvedValueOnce({ results: [rawSpace(), rawSpace({ id: '2', key: 'OPS' })] });
    const c = createConfluenceSpacesClient(client);
    expect((await c.list()).map((s) => s.key)).toEqual(['DEV']);
  });

  it('handles a missing results array and default limit; omits keys when empty', async () => {
    client.get.mockResolvedValueOnce({});
    const c = createConfluenceSpacesClient(client);
    expect(await c.list({ keys: [] })).toEqual([]);
    expect(client.get).toHaveBeenCalledWith('/wiki/api/v2/spaces', { limit: 50 });
  });

  it('normalises a space with missing optional fields', async () => {
    client.get.mockResolvedValueOnce({ results: [{ id: '1', key: 'X', name: 'X' }] });
    const c = createConfluenceSpacesClient(client);
    expect((await c.list())[0]).toEqual({
      id: '1',
      key: 'X',
      name: 'X',
      type: undefined,
      status: undefined,
    });
  });
});

describe('getByKey', () => {
  it('looks a space up by key', async () => {
    client.get.mockResolvedValueOnce({ results: [rawSpace()] });
    const c = createConfluenceSpacesClient(client);
    const s = await c.getByKey('DEV');
    expect(client.get).toHaveBeenCalledWith('/wiki/api/v2/spaces', { keys: 'DEV', limit: 1 });
    expect(s.key).toBe('DEV');
  });

  it('throws when not found', async () => {
    client.get.mockResolvedValueOnce({ results: [] });
    const c = createConfluenceSpacesClient(client);
    await expect(c.getByKey('NOPE')).rejects.toThrow(/not found/i);
  });

  it('rejects up front when outside the allowlist', async () => {
    client = stubClient(['DEV']);
    const c = createConfluenceSpacesClient(client);
    await expect(c.getByKey('OPS')).rejects.toThrow(ScopeError);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('normalises a space with nothing set', async () => {
    client.get.mockResolvedValueOnce({ results: [{}] });
    const c = createConfluenceSpacesClient(client);
    expect(await c.getByKey('X')).toEqual({
      id: '',
      key: '',
      name: '',
      type: undefined,
      status: undefined,
    });
  });
});
