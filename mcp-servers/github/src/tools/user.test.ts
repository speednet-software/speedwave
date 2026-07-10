/**
 * Tests for GitHub User Tools
 *
 * Coverage: getCurrentUser (1 tool)
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage, META_KEYS } from '@speedwave/mcp-shared';
import { createUserTools } from './user-tools.js';
import type { GitHubClient } from '../client.js';

type MockClient = {
  getCurrentUser: Mock;
};

function createMockClient(): MockClient {
  return {
    getCurrentUser: vi.fn(),
  };
}

const NOT_CONFIGURED = {
  content: [{ type: 'text', text: `Error: ${notConfiguredMessage('GitHub')}` }],
  isError: true,
};

describe('User Tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  describe('unconfigured client', () => {
    it('returns 1 tool when client is null', () => {
      const tools = createUserTools(null);
      expect(tools).toHaveLength(1);
      expect(tools.map((t) => t.tool.name)).toEqual(['getCurrentUser']);
    });

    it('returns error for getCurrentUser when client is null', async () => {
      const tools = createUserTools(null);
      const handler = tools.find((t) => t.tool.name === 'getCurrentUser')?.handler;
      expect(handler).toBeDefined();
      expect(await handler!({})).toEqual(NOT_CONFIGURED);
    });
  });

  describe('tool definitions', () => {
    it('is eager-loaded and requires no params', () => {
      const tools = createUserTools(mockClient as unknown as GitHubClient);
      expect(tools).toHaveLength(1);
      const tool = tools[0].tool;
      expect(tool.name).toBe('getCurrentUser');
      expect(tool._meta?.[META_KEYS.DEFER_LOADING]).toBe(false);
      expect(tool.inputSchema.required).toBeUndefined();
    });
  });

  describe('getCurrentUser', () => {
    it('returns the authenticated user', async () => {
      const user = {
        login: 'octocat',
        name: 'The Octocat',
        email: 'octocat@github.com',
        html_url: 'https://github.com/octocat',
      };
      mockClient.getCurrentUser.mockResolvedValue(user);

      const tools = createUserTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getCurrentUser')?.handler;
      const result = await handler!({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(user, null, 2) }],
      });
      expect(mockClient.getCurrentUser).toHaveBeenCalledWith();
    });

    it('returns a user with no name or email', async () => {
      const user = { login: 'octocat', html_url: 'https://github.com/octocat' };
      mockClient.getCurrentUser.mockResolvedValue(user);

      const tools = createUserTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getCurrentUser')?.handler;
      const result = await handler!({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(user, null, 2) }],
      });
    });

    it('returns error when authentication fails', async () => {
      mockClient.getCurrentUser.mockRejectedValue(new Error('Bad credentials'));

      const tools = createUserTools(mockClient as unknown as GitHubClient);
      const handler = tools.find((t) => t.tool.name === 'getCurrentUser')?.handler;
      const result = await handler!({});

      expect(result).toMatchObject({ isError: true });
      expect((result as { content: Array<{ text: string }> }).content[0].text).toContain('Error:');
    });
  });
});
