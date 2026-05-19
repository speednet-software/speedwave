/**
 * Label Tools Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage } from '@speedwave/mcp-shared';
import { createLabelTools } from './label-tools.js';
import type { GitHubClient } from '../client.js';

type MockClient = {
  listLabels: Mock;
  createLabel: Mock;
};

const createMockClient = (): MockClient => ({
  listLabels: vi.fn(),
  createLabel: vi.fn(),
});

const findHandler = (tools: ReturnType<typeof createLabelTools>, name: string) =>
  tools.find((t) => t.tool.name === name)!.handler;

const json = (data: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

const notConfigured = {
  content: [{ type: 'text', text: `Error: ${notConfiguredMessage('GitHub')}` }],
  isError: true,
};

describe('label-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes exactly listLabels and createLabel', () => {
    expect(createLabelTools(null).map((t) => t.tool.name)).toEqual(['listLabels', 'createLabel']);
  });

  it('eagerly loads listLabels and defers createLabel', () => {
    const tools = createLabelTools(null);
    expect(tools.find((t) => t.tool.name === 'listLabels')!.tool._meta).toEqual({
      deferLoading: false,
    });
    expect(tools.find((t) => t.tool.name === 'createLabel')!.tool._meta).toEqual({
      deferLoading: true,
    });
  });

  describe('unconfigured client', () => {
    it('returns not-configured error for listLabels', async () => {
      const handler = findHandler(createLabelTools(null), 'listLabels');
      const result = await handler({ owner: 'octocat', repo: 'hello-world' });
      expect(result).toEqual(notConfigured);
    });

    it('returns not-configured error for createLabel', async () => {
      const handler = findHandler(createLabelTools(null), 'createLabel');
      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        name: 'bug',
        color: 'FF0000',
      });
      expect(result).toEqual(notConfigured);
    });
  });

  describe('listLabels', () => {
    it('returns mapped labels with count and an undefined limit', async () => {
      const client = createMockClient();
      client.listLabels.mockResolvedValue([
        { id: 1, name: 'bug', color: 'd73a4a', description: "Something isn't working" },
        { id: 2, name: 'docs', color: '0075ca', description: undefined },
      ]);
      const handler = findHandler(
        createLabelTools(client as unknown as GitHubClient),
        'listLabels'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world' });

      expect(result).toEqual(
        json({
          labels: [
            { id: 1, name: 'bug', color: 'd73a4a', description: "Something isn't working" },
            { id: 2, name: 'docs', color: '0075ca', description: undefined },
          ],
          count: 2,
        })
      );
      expect(client.listLabels).toHaveBeenCalledWith('octocat', 'hello-world', {
        limit: undefined,
      });
    });

    it('forwards the limit option', async () => {
      const client = createMockClient();
      client.listLabels.mockResolvedValue([]);
      const handler = findHandler(
        createLabelTools(client as unknown as GitHubClient),
        'listLabels'
      );

      await handler({ owner: 'octocat', repo: 'hello-world', limit: 10 });

      expect(client.listLabels).toHaveBeenCalledWith('octocat', 'hello-world', { limit: 10 });
    });

    it('returns an empty list with count 0', async () => {
      const client = createMockClient();
      client.listLabels.mockResolvedValue([]);
      const handler = findHandler(
        createLabelTools(client as unknown as GitHubClient),
        'listLabels'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world' });

      expect(result).toEqual(json({ labels: [], count: 0 }));
    });

    it('returns an error result when the client throws', async () => {
      const client = createMockClient();
      client.listLabels.mockRejectedValue(new Error('label list fail'));
      const handler = findHandler(
        createLabelTools(client as unknown as GitHubClient),
        'listLabels'
      );

      const result = await handler({ owner: 'octocat', repo: 'hello-world' });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: label list fail' }],
        isError: true,
      });
    });

    it('maps a 404 error via the client formatter', async () => {
      const client = createMockClient();
      client.listLabels.mockRejectedValue({ status: 404 });
      const handler = findHandler(
        createLabelTools(client as unknown as GitHubClient),
        'listLabels'
      );

      const result = await handler({ owner: 'octocat', repo: 'missing' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Resource not found');
    });
  });

  describe('createLabel', () => {
    it('passes required params and returns the mapped label', async () => {
      const client = createMockClient();
      client.createLabel.mockResolvedValue({
        id: 9,
        name: 'bug',
        color: 'FF0000',
        description: undefined,
      });
      const handler = findHandler(
        createLabelTools(client as unknown as GitHubClient),
        'createLabel'
      );

      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        name: 'bug',
        color: 'FF0000',
      });

      expect(result).toEqual(json({ id: 9, name: 'bug', color: 'FF0000', description: undefined }));
      expect(client.createLabel).toHaveBeenCalledWith('octocat', 'hello-world', {
        name: 'bug',
        color: 'FF0000',
      });
    });

    it('forwards a leading-# color and a description', async () => {
      const client = createMockClient();
      client.createLabel.mockResolvedValue({
        id: 10,
        name: 'documentation',
        color: 'FFA500',
        description: 'Docs',
      });
      const handler = findHandler(
        createLabelTools(client as unknown as GitHubClient),
        'createLabel'
      );

      await handler({
        owner: 'octocat',
        repo: 'hello-world',
        name: 'documentation',
        color: '#FFA500',
        description: 'Docs',
      });

      expect(client.createLabel).toHaveBeenCalledWith('octocat', 'hello-world', {
        name: 'documentation',
        color: '#FFA500',
        description: 'Docs',
      });
    });

    it('returns an error result on a 422 validation error', async () => {
      const client = createMockClient();
      client.createLabel.mockRejectedValue({ status: 422, message: 'already_exists' });
      const handler = findHandler(
        createLabelTools(client as unknown as GitHubClient),
        'createLabel'
      );

      const result = await handler({
        owner: 'octocat',
        repo: 'hello-world',
        name: 'bug',
        color: 'FF0000',
      });

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: GitHub validation error: already_exists' }],
        isError: true,
      });
    });
  });
});
