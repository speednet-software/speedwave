/**
 * Tests for the Confluence page-content tools.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const stub = {
  addComment: vi.fn(),
  getComments: vi.fn(),
  addLabels: vi.fn(),
  getLabels: vi.fn(),
  listAttachments: vi.fn(),
};
vi.mock('../domains/confluence-content.js', () => ({ createConfluenceContentClient: () => stub }));

import { createConfluenceContentTools } from './confluence-content-tools.js';
import type { AtlassianClient } from '../client.js';

const FAKE_CLIENT = {} as AtlassianClient;
function handlerFor(name: string) {
  const def = createConfluenceContentTools(FAKE_CLIENT).find((d) => d.tool.name === name);
  if (!def) throw new Error(`tool ${name} not found`);
  return def.handler;
}
function payload(result: { content: Array<{ text: string }>; isError?: true }): unknown {
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

beforeEach(() => Object.values(stub).forEach((m) => m.mockReset()));

describe('definitions', () => {
  it('exposes the 5 expected tools, all deferred', () => {
    const defs = createConfluenceContentTools(FAKE_CLIENT);
    expect(defs.map((d) => d.tool.name)).toEqual([
      'addPageComment',
      'getPageComments',
      'addPageLabels',
      'getPageLabels',
      'listAttachments',
    ]);
    for (const { tool } of defs) {
      expect(tool._meta).toEqual({ deferLoading: true });
      expect(tool.outputSchema?.required).toContain('success');
    }
  });
});

describe('unconfigured', () => {
  it('lists all tools but every handler errors', async () => {
    for (const { handler } of createConfluenceContentTools(null))
      expect((await handler({} as never)).isError).toBe(true);
  });
});

describe('addPageComment', () => {
  it('passes bodyText as text body', async () => {
    stub.addComment.mockResolvedValueOnce({ id: '1' });
    await handlerFor('addPageComment')({ pageId: 'p1', bodyText: 'hi' });
    expect(stub.addComment).toHaveBeenCalledWith('p1', { text: 'hi' });
  });
  it('passes bodyStorage as storage body', async () => {
    stub.addComment.mockResolvedValueOnce({ id: '2' });
    await handlerFor('addPageComment')({ pageId: 'p1', bodyStorage: '<p>x</p>' });
    expect(stub.addComment).toHaveBeenCalledWith('p1', { storage: '<p>x</p>' });
  });
  it('defaults to an empty text body', async () => {
    stub.addComment.mockResolvedValueOnce({ id: '3' });
    await handlerFor('addPageComment')({ pageId: 'p1' });
    expect(stub.addComment).toHaveBeenCalledWith('p1', { text: '' });
  });
  it('wraps the result under `comment` and surfaces errors', async () => {
    stub.addComment.mockResolvedValueOnce({ id: '4' });
    expect(payload(await handlerFor('addPageComment')({ pageId: 'p1', bodyText: 'x' }))).toEqual({
      comment: { id: '4' },
    });
    stub.addComment.mockRejectedValueOnce(new Error('boom'));
    expect((await handlerFor('addPageComment')({ pageId: 'p1', bodyText: 'x' })).isError).toBe(
      true
    );
  });
});

describe('getPageComments', () => {
  it('forwards limit and wraps the list', async () => {
    stub.getComments.mockResolvedValueOnce([{ id: '1' }]);
    expect(payload(await handlerFor('getPageComments')({ pageId: 'p1', limit: 5 }))).toEqual({
      comments: [{ id: '1' }],
    });
    expect(stub.getComments).toHaveBeenCalledWith('p1', { limit: 5 });
  });
});

describe('addPageLabels', () => {
  it('forwards labels and wraps the result', async () => {
    stub.addLabels.mockResolvedValueOnce([{ name: 'docs' }]);
    expect(payload(await handlerFor('addPageLabels')({ pageId: 'p1', labels: ['docs'] }))).toEqual({
      labels: [{ name: 'docs' }],
    });
    expect(stub.addLabels).toHaveBeenCalledWith('p1', ['docs']);
  });
});

describe('getPageLabels', () => {
  it('forwards limit and wraps the list', async () => {
    stub.getLabels.mockResolvedValueOnce([{ name: 'docs' }]);
    expect(payload(await handlerFor('getPageLabels')({ pageId: 'p1', limit: 10 }))).toEqual({
      labels: [{ name: 'docs' }],
    });
    expect(stub.getLabels).toHaveBeenCalledWith('p1', { limit: 10 });
  });
});

describe('listAttachments', () => {
  it('forwards limit and wraps the list', async () => {
    stub.listAttachments.mockResolvedValueOnce([{ id: 'a1' }]);
    expect(payload(await handlerFor('listAttachments')({ pageId: 'p1', limit: 5 }))).toEqual({
      attachments: [{ id: 'a1' }],
    });
    expect(stub.listAttachments).toHaveBeenCalledWith('p1', { limit: 5 });
  });
});
