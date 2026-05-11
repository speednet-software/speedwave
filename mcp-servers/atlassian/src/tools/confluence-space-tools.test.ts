/**
 * Tests for the Confluence space tools.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const stub = { list: vi.fn(), getByKey: vi.fn() };
vi.mock('../domains/confluence-spaces.js', () => ({ createConfluenceSpacesClient: () => stub }));

import { createConfluenceSpaceTools } from './confluence-space-tools.js';
import type { AtlassianClient } from '../client.js';

const FAKE_CLIENT = {} as AtlassianClient;
function handlerFor(name: string) {
  const def = createConfluenceSpaceTools(FAKE_CLIENT).find((d) => d.tool.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def.handler;
}
function payload(result: { content: Array<{ text: string }>; isError?: true }): unknown {
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

beforeEach(() => Object.values(stub).forEach((m) => m.mockReset()));

describe('definitions', () => {
  it('exposes the 2 expected tools', () => {
    expect(createConfluenceSpaceTools(FAKE_CLIENT).map((d) => d.tool.name)).toEqual([
      'listSpaces',
      'getSpace',
    ]);
  });

  it('listSpaces is shown upfront; getSpace defers loading; all declare required fields', () => {
    const byName = Object.fromEntries(
      createConfluenceSpaceTools(FAKE_CLIENT).map((d) => [d.tool.name, d.tool])
    );
    expect(byName.listSpaces._meta).toEqual({ deferLoading: false });
    expect(byName.getSpace._meta).toEqual({ deferLoading: true });
    for (const { tool } of createConfluenceSpaceTools(FAKE_CLIENT)) {
      expect(tool.keywords?.length).toBeGreaterThan(0);
      expect(tool.outputSchema?.required).toContain('success');
      expect(tool.inputExamples?.length).toBeGreaterThan(0);
    }
  });
});

describe('unconfigured client', () => {
  it('lists all tools but every handler errors', async () => {
    const defs = createConfluenceSpaceTools(null);
    expect(defs).toHaveLength(2);
    for (const { handler } of defs) {
      const res = await handler({} as never);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/not configured|configure/i);
    }
  });
});

describe('listSpaces handler', () => {
  it('forwards keys/limit and wraps the list', async () => {
    stub.list.mockResolvedValueOnce([{ key: 'DEV' }]);
    expect(payload(await handlerFor('listSpaces')({ keys: ['DEV'], limit: 5 }))).toEqual({
      spaces: [{ key: 'DEV' }],
    });
    expect(stub.list).toHaveBeenCalledWith({ keys: ['DEV'], limit: 5 });
  });

  it('works with no params', async () => {
    stub.list.mockResolvedValueOnce([]);
    await handlerFor('listSpaces')({});
    expect(stub.list).toHaveBeenCalledWith({ keys: undefined, limit: undefined });
  });

  it('surfaces a domain error', async () => {
    stub.list.mockRejectedValueOnce(new Error('boom'));
    expect((await handlerFor('listSpaces')({})).isError).toBe(true);
  });
});

describe('getSpace handler', () => {
  it('wraps the space under `space`', async () => {
    stub.getByKey.mockResolvedValueOnce({ key: 'DEV', name: 'Development' });
    expect(payload(await handlerFor('getSpace')({ spaceKey: 'DEV' }))).toEqual({
      space: { key: 'DEV', name: 'Development' },
    });
    expect(stub.getByKey).toHaveBeenCalledWith('DEV');
  });

  it('surfaces a domain error', async () => {
    stub.getByKey.mockRejectedValueOnce(new Error('not found'));
    expect((await handlerFor('getSpace')({ spaceKey: 'X' })).isError).toBe(true);
  });
});
