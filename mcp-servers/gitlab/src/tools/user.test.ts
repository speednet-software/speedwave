/**
 * Comprehensive tests for user-tools.ts
 * Tests the getCurrentUser tool.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { notConfiguredMessage, META_KEYS } from '@speedwave/mcp-shared';
import { createUserTools } from './user-tools.js';
import type { GitLabClient } from '../client.js';

type MockClient = {
  getCurrentUser: Mock;
};

describe('user-tools', () => {
  let mockClient: MockClient;

  beforeEach(() => {
    mockClient = { getCurrentUser: vi.fn() };
  });

  describe('getCurrentUser', () => {
    it('resolves the authenticated user successfully', async () => {
      const mockUser = {
        id: 42,
        username: 'jane.doe',
        name: 'Jane Doe',
        email: 'jane@example.com',
        web_url: 'https://gitlab.example.com/jane.doe',
      };

      mockClient.getCurrentUser.mockResolvedValue(mockUser);

      const tools = createUserTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getCurrentUser')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockUser, null, 2) }],
      });
      expect(mockClient.getCurrentUser).toHaveBeenCalled();
    });

    it('resolves a user with no public email', async () => {
      const mockUser = {
        id: 7,
        username: 'bot-user',
        name: 'Bot User',
        web_url: 'https://gitlab.example.com/bot-user',
      };

      mockClient.getCurrentUser.mockResolvedValue(mockUser);

      const tools = createUserTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getCurrentUser')?.handler;

      const result = await handler!({});

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(mockUser, null, 2) }],
      });
    });

    it('ignores unexpected extra parameters (no input required)', async () => {
      mockClient.getCurrentUser.mockResolvedValue({
        id: 1,
        username: 'x',
        name: 'X',
        web_url: 'https://gitlab.example.com/x',
      });

      const tools = createUserTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getCurrentUser')?.handler;

      const result = await handler!({ unexpected: 'value' } as unknown as Record<string, never>);

      expect(result.content[0].text).toContain('"id": 1');
    });

    it('handles authentication errors', async () => {
      mockClient.getCurrentUser.mockRejectedValue(new Error('401 Unauthorized'));

      const tools = createUserTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getCurrentUser')?.handler;

      const result = await handler!({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Authentication failed');
    });

    it('handles unexpected non-Error rejections', async () => {
      mockClient.getCurrentUser.mockRejectedValue('unexpected string rejection');

      const tools = createUserTools(mockClient as unknown as GitLabClient);
      const handler = tools.find((t) => t.tool.name === 'getCurrentUser')?.handler;

      const result = await handler!({});

      expect(result.isError).toBe(true);
    });

    it('returns "not configured" error when client is null', async () => {
      const tools = createUserTools(null);
      const handler = tools.find((t) => t.tool.name === 'getCurrentUser')?.handler;

      expect(handler).toBeDefined();
      const result = await handler!({});

      expect(result).toEqual({
        content: [{ type: 'text', text: `Error: ${notConfiguredMessage('GitLab')}` }],
        isError: true,
      });
      expect(mockClient.getCurrentUser).not.toHaveBeenCalled();
    });

    it('returns exactly one tool', () => {
      const tools = createUserTools(mockClient as unknown as GitLabClient);
      expect(tools).toHaveLength(1);
      expect(tools.map((t) => t.tool.name)).toEqual(['getCurrentUser']);
    });

    it('declares user-scoped identity metadata pointing at itself', () => {
      const tools = createUserTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getCurrentUser')?.tool;

      expect(tool).toBeDefined();
      const meta = tool!._meta as Record<string, unknown>;
      expect(meta[META_KEYS.DEFER_LOADING]).toBe(true);
      expect(meta[META_KEYS.USER_SCOPED]).toBe(true);
      expect(meta[META_KEYS.CURRENT_USER_TOOL]).toBe('getCurrentUser');
    });

    it('has a valid tool definition (annotations, keywords, example, schema)', () => {
      const tools = createUserTools(mockClient as unknown as GitLabClient);
      const tool = tools.find((t) => t.tool.name === 'getCurrentUser')?.tool;

      expect(tool).toBeDefined();
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.annotations?.destructiveHint).toBe(false);
      expect(tool?.keywords).toEqual(
        expect.arrayContaining(['gitlab', 'user', 'me', 'whoami', 'identity'])
      );
      expect(tool?.example).toContain('getCurrentUser');
      expect(tool?.inputSchema.type).toBe('object');
      expect(tool?.inputSchema.properties).toEqual({});
      expect(tool?.outputSchema?.properties).toHaveProperty('success');
    });
  });
});
