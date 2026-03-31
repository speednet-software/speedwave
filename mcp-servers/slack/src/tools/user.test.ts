/**
 * User Tools Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGetUsers } from './user-tools.js';
import type { SlackClients } from '../client.js';

// Mock the client module
vi.mock('../client.js', async () => {
  const actual = await vi.importActual('../client.js');
  return {
    ...actual,
    getUsers: vi.fn(),
    formatSlackError: vi.fn((error: unknown) => {
      const e = error as { message?: string };
      return e.message || 'Unknown error';
    }),
  };
});

import * as client from '../client.js';

describe('user-tools', () => {
  let mockClients: SlackClients;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClients = {
      bot: {} as any,
      user: {} as any,
    };
  });

  describe('handleGetUsers', () => {
    it('returns user on valid email lookup', async () => {
      const mockUser = {
        user: {
          id: 'U1234567890',
          name: 'john.doe',
          real_name: 'John Doe',
          email: 'john.doe@example.com',
        },
      };
      vi.mocked(client.getUsers).mockResolvedValue(mockUser);

      const result = await handleGetUsers(mockClients, {
        email: 'john.doe@example.com',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockUser);
      expect(client.getUsers).toHaveBeenCalledWith(mockClients, {
        email: 'john.doe@example.com',
      });
    });

    it('returns user with minimal data', async () => {
      const mockUser = {
        user: {
          id: 'U9876543210',
          name: 'jane.smith',
        },
      };
      vi.mocked(client.getUsers).mockResolvedValue(mockUser);

      const result = await handleGetUsers(mockClients, {
        email: 'jane.smith@example.com',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockUser);
      const data = result.data as { user: { id: string; name: string } };
      expect(data?.user?.id).toBe('U9876543210');
      expect(data?.user?.name).toBe('jane.smith');
    });

    it('returns null when user not found', async () => {
      vi.mocked(client.getUsers).mockResolvedValue({ user: null });

      const result = await handleGetUsers(mockClients, {
        email: 'nonexistent@example.com',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ user: null });
      expect(client.getUsers).toHaveBeenCalledWith(mockClients, {
        email: 'nonexistent@example.com',
      });
    });

    it('handles authentication errors', async () => {
      const error = new Error('invalid_auth');
      vi.mocked(client.getUsers).mockRejectedValue(error);
      vi.mocked(client.formatSlackError).mockReturnValue(
        'Authentication failed. Check your Slack tokens. Configure this integration in the Speedwave Desktop app (Integrations tab).'
      );

      const result = await handleGetUsers(mockClients, {
        email: 'test@example.com',
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'LOOKUP_FAILED',
        message:
          'Authentication failed. Check your Slack tokens. Configure this integration in the Speedwave Desktop app (Integrations tab).',
      });
    });

    it('handles permission errors', async () => {
      const error = new Error('missing_scope');
      vi.mocked(client.getUsers).mockRejectedValue(error);
      vi.mocked(client.formatSlackError).mockReturnValue(
        'Permission denied. Your Slack tokens may not have sufficient permissions.'
      );

      const result = await handleGetUsers(mockClients, {
        email: 'test@example.com',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LOOKUP_FAILED');
      expect(result.error?.message).toContain('Permission denied');
    });

    it('handles network errors', async () => {
      const error = new Error('ECONNREFUSED');
      vi.mocked(client.getUsers).mockRejectedValue(error);
      vi.mocked(client.formatSlackError).mockReturnValue(
        'Network error. Cannot connect to Slack API.'
      );

      const result = await handleGetUsers(mockClients, {
        email: 'test@example.com',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LOOKUP_FAILED');
      expect(result.error?.message).toContain('Network error');
    });

    it('handles rate limit errors', async () => {
      const error = new Error('ratelimited');
      vi.mocked(client.getUsers).mockRejectedValue(error);
      vi.mocked(client.formatSlackError).mockReturnValue(
        'Rate limit exceeded. Please try again later.'
      );

      const result = await handleGetUsers(mockClients, {
        email: 'test@example.com',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LOOKUP_FAILED');
      expect(result.error?.message).toContain('Rate limit exceeded');
    });

    it('handles generic API errors', async () => {
      const error = new Error('Something went wrong');
      vi.mocked(client.getUsers).mockRejectedValue(error);
      vi.mocked(client.formatSlackError).mockReturnValue('Something went wrong');

      const result = await handleGetUsers(mockClients, {
        email: 'test@example.com',
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'LOOKUP_FAILED',
        message: 'Something went wrong',
      });
    });

    it('handles user lookup with special email formats', async () => {
      const testEmails = [
        'user+tag@example.com',
        'user.name@subdomain.example.com',
        'user_name@example.co.uk',
      ];

      for (const email of testEmails) {
        const mockUser = {
          user: {
            id: 'U123',
            name: 'testuser',
            email,
          },
        };
        vi.mocked(client.getUsers).mockResolvedValue(mockUser);

        const result = await handleGetUsers(mockClients, { email });

        expect(result.success).toBe(true);
        const data = result.data as { user: { email: string } };
        expect(data?.user?.email).toBe(email);
        expect(client.getUsers).toHaveBeenCalledWith(mockClients, { email });
      }
    });

    it('propagates all user fields from API response', async () => {
      const mockUser = {
        user: {
          id: 'U1234567890',
          name: 'complete.user',
          real_name: 'Complete User',
          email: 'complete.user@example.com',
        },
      };
      vi.mocked(client.getUsers).mockResolvedValue(mockUser);

      const result = await handleGetUsers(mockClients, {
        email: 'complete.user@example.com',
      });

      expect(result.success).toBe(true);
      const data = result.data as { user: Record<string, string> };
      expect(data?.user).toEqual({
        id: 'U1234567890',
        name: 'complete.user',
        real_name: 'Complete User',
        email: 'complete.user@example.com',
      });
    });
  });
});
