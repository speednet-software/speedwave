/**
 * Tests for the Confluence page tools.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { META_KEYS } from '@speedwave/mcp-shared';

const stub = {
  search: vi.fn(),
  get: vi.fn(),
  getByTitle: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  getChildren: vi.fn(),
};
vi.mock('../domains/confluence-pages.js', () => ({ createConfluencePagesClient: () => stub }));

import { createConfluencePageTools } from './confluence-page-tools.js';
import type { AtlassianClient } from '../client.js';

const FAKE_CLIENT = {} as AtlassianClient;
function handlerFor(name: string) {
  const def = createConfluencePageTools(FAKE_CLIENT).find((d) => d.tool.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def.handler;
}
function payload(result: { content: Array<{ text: string }>; isError?: true }): unknown {
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

beforeEach(() => Object.values(stub).forEach((m) => m.mockReset()));

describe('definitions', () => {
  it('exposes the 6 expected tools', () => {
    expect(createConfluencePageTools(FAKE_CLIENT).map((d) => d.tool.name)).toEqual([
      'searchPages',
      'getPage',
      'getPageByTitle',
      'createPage',
      'updatePage',
      'getPageChildren',
    ]);
  });
  it('searchPages and getPage are shown upfront', () => {
    const byName = Object.fromEntries(
      createConfluencePageTools(FAKE_CLIENT).map((d) => [d.tool.name, d.tool])
    );
    expect(byName.searchPages._meta).toEqual({ [META_KEYS.DEFER_LOADING]: false });
    expect(byName.getPage._meta).toEqual({ [META_KEYS.DEFER_LOADING]: false });
    expect(byName.createPage._meta).toEqual({ [META_KEYS.DEFER_LOADING]: true });
  });
});

describe('unconfigured', () => {
  it('lists all tools but every handler errors', async () => {
    for (const { handler } of createConfluencePageTools(null))
      expect((await handler({} as never)).isError).toBe(true);
  });
});

describe('searchPages', () => {
  it('forwards cql/limit and wraps the list', async () => {
    stub.search.mockResolvedValueOnce([{ id: '1' }]);
    expect(payload(await handlerFor('searchPages')({ cql: 'type=page', limit: 10 }))).toEqual({
      pages: [{ id: '1' }],
    });
    expect(stub.search).toHaveBeenCalledWith({ cql: 'type=page', limit: 10 });
  });
  it('surfaces errors', async () => {
    stub.search.mockRejectedValueOnce(new Error('bad cql'));
    expect((await handlerFor('searchPages')({ cql: 'x' })).isError).toBe(true);
  });
});

describe('getPage', () => {
  it('forwards includeBody and wraps the page', async () => {
    stub.get.mockResolvedValueOnce({ id: '1' });
    expect(payload(await handlerFor('getPage')({ pageId: '1', includeBody: true }))).toEqual({
      page: { id: '1' },
    });
    expect(stub.get).toHaveBeenCalledWith('1', { includeBody: true });
  });
  it('works without includeBody', async () => {
    stub.get.mockResolvedValueOnce({ id: '1' });
    await handlerFor('getPage')({ pageId: '1' });
    expect(stub.get).toHaveBeenCalledWith('1', { includeBody: undefined });
  });
});

describe('getPageByTitle', () => {
  it('forwards space/title/includeBody', async () => {
    stub.getByTitle.mockResolvedValueOnce({ id: '1' });
    await handlerFor('getPageByTitle')({ spaceKey: 'DEV', title: 'T', includeBody: true });
    expect(stub.getByTitle).toHaveBeenCalledWith('DEV', 'T', { includeBody: true });
  });
});

describe('createPage', () => {
  it('passes bodyText as text body and forwards parentId', async () => {
    stub.create.mockResolvedValueOnce({ id: '9' });
    await handlerFor('createPage')({
      spaceKey: 'DEV',
      title: 'T',
      bodyText: 'hi',
      parentId: '100',
    });
    expect(stub.create).toHaveBeenCalledWith({
      spaceKey: 'DEV',
      title: 'T',
      body: { text: 'hi' },
      parentId: '100',
    });
  });
  it('passes bodyStorage as storage body', async () => {
    stub.create.mockResolvedValueOnce({ id: '10' });
    await handlerFor('createPage')({ spaceKey: 'DEV', title: 'T', bodyStorage: '<p>x</p>' });
    expect(stub.create.mock.calls[0][0].body).toEqual({ storage: '<p>x</p>' });
  });
  it('defaults to an empty text body when neither given', async () => {
    stub.create.mockResolvedValueOnce({ id: '11' });
    await handlerFor('createPage')({ spaceKey: 'DEV', title: 'T' });
    expect(stub.create.mock.calls[0][0].body).toEqual({ text: '' });
  });
});

describe('updatePage', () => {
  it('forwards title and a storage body', async () => {
    stub.update.mockResolvedValueOnce({ id: '9', version: 4 });
    await handlerFor('updatePage')({ pageId: '9', title: 'New', bodyStorage: '<p>x</p>' });
    expect(stub.update).toHaveBeenCalledWith('9', { title: 'New', body: { storage: '<p>x</p>' } });
  });
  it('forwards a text body', async () => {
    stub.update.mockResolvedValueOnce({ id: '9' });
    await handlerFor('updatePage')({ pageId: '9', bodyText: 't' });
    expect(stub.update.mock.calls[0][1].body).toEqual({ text: 't' });
  });
  it('passes body as undefined when no body field is given', async () => {
    stub.update.mockResolvedValueOnce({ id: '9' });
    await handlerFor('updatePage')({ pageId: '9', title: 'Only Rename' });
    expect(stub.update).toHaveBeenCalledWith('9', { title: 'Only Rename', body: undefined });
  });
});

describe('getPageChildren', () => {
  it('forwards limit and wraps the list', async () => {
    stub.getChildren.mockResolvedValueOnce([{ id: 'c1' }]);
    expect(payload(await handlerFor('getPageChildren')({ pageId: '1', limit: 5 }))).toEqual({
      pages: [{ id: 'c1' }],
    });
    expect(stub.getChildren).toHaveBeenCalledWith('1', { limit: 5 });
  });
});
