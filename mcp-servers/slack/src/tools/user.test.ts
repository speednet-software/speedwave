/**
 * User Tools Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withSetupGuidance, RefreshLock } from '@speedwave/mcp-shared';
import {
  handleGetUsers,
  handleFindUsers,
  handleGetCurrentUser,
  createUserTools,
} from './user-tools.js';
import type { SlackClients } from '../client.js';

// Mock the client module
vi.mock('../client.js', async () => {
  const actual = await vi.importActual('../client.js');
  return {
    ...actual,
    getUsers: vi.fn(),
    getCurrentUser: vi.fn(),
    formatSlackError: vi.fn((error: unknown) => {
      const e = error as { message?: string };
      return e.message || 'Unknown error';
    }),
  };
});

// Mock the user-directory boundary — its machinery has its own test file.
vi.mock('../user-directory.js', () => ({
  searchUsers: vi.fn(),
}));

import * as client from '../client.js';
import { searchUsers } from '../user-directory.js';

/** Helper: clients object representing "tokens missing" — replaces null. */
function unconfiguredClients(): SlackClients {
  return {
    user: {} as any,
    tokenState: { accessToken: '' },
    lock: new RefreshLock(),
    _tokensStatus: 'missing',
  };
}

describe('user-tools', () => {
  let mockClients: SlackClients;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClients = {
      user: {} as any,
      tokenState: { accessToken: '' },
      lock: new RefreshLock(),
      _tokensStatus: 'present',
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
        withSetupGuidance('Authentication failed. Check your Slack tokens.')
      );

      const result = await handleGetUsers(mockClients, {
        email: 'test@example.com',
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'LOOKUP_FAILED',
        message: withSetupGuidance('Authentication failed. Check your Slack tokens.'),
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

  describe('handleFindUsers', () => {
    let mockClients: SlackClients;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClients = {
        user: {} as never,
        tokenState: { accessToken: 'xoxp-test' },
        lock: new RefreshLock(),
        _tokensStatus: 'present',
      };
    });

    it('returns matching users with a count', async () => {
      const hits = [
        { id: 'U1', name: 'pkowalski', real_name: 'Paweł Kowalski' },
        { id: 'U2', name: 'pnowak', real_name: 'Paweł Nowak' },
      ];
      vi.mocked(searchUsers).mockResolvedValue(hits);

      const result = await handleFindUsers(mockClients, { query: 'pawel' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ users: hits, count: 2 });
      expect(searchUsers).toHaveBeenCalledWith(mockClients, { query: 'pawel' });
    });

    it('returns an empty list for no match', async () => {
      vi.mocked(searchUsers).mockResolvedValue([]);

      const result = await handleFindUsers(mockClients, { query: 'zzz' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ users: [], count: 0 });
    });

    it('maps directory failures to SEARCH_FAILED', async () => {
      vi.mocked(searchUsers).mockRejectedValue(new Error('slack down'));
      vi.mocked(client.formatSlackError).mockReturnValue('slack down');

      const result = await handleFindUsers(mockClients, { query: 'pawel' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SEARCH_FAILED');
    });
  });

  describe('handleGetCurrentUser', () => {
    it('returns the resolved identity on success', async () => {
      const me = { id: 'U1', name: 'pawel', real_name: 'Paweł Kowalski', team_id: 'T1' };
      vi.mocked(client.getCurrentUser).mockResolvedValue(me);

      const result = await handleGetCurrentUser(mockClients, {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(me);
      expect(client.getCurrentUser).toHaveBeenCalledWith(mockClients);
    });

    it('maps failures to LOOKUP_FAILED', async () => {
      vi.mocked(client.getCurrentUser).mockRejectedValue(new Error('invalid_auth'));
      vi.mocked(client.formatSlackError).mockReturnValue(
        withSetupGuidance('Authentication failed. Check your Slack tokens.')
      );

      const result = await handleGetCurrentUser(mockClients, {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LOOKUP_FAILED');
      expect(result.error?.message).toContain('Authentication failed');
    });
  });
});

describe('createUserTools (null clients — not configured)', () => {
  it('returns all three tool definitions when clients are null', () => {
    const tools = createUserTools(unconfiguredClients());
    expect(tools.map((t) => t.tool.name)).toEqual(['getUsers', 'findUsers', 'getCurrentUser']);
  });

  it('findUsers handler returns NOT_CONFIGURED error when clients are null', async () => {
    const tools = createUserTools(unconfiguredClients());
    const result = await tools[1].handler({ query: 'pawel' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.code).toBe('NOT_CONFIGURED');
  });

  it('getUsers handler returns NOT_CONFIGURED error when clients are null', async () => {
    const tools = createUserTools(unconfiguredClients());
    const getUsersHandler = tools[0].handler;

    const result = await getUsersHandler({ email: 'alice@example.com' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.code).toBe('NOT_CONFIGURED');
    expect(parsed.message).toBeTruthy();
  });

  it('getCurrentUser handler returns NOT_CONFIGURED error when clients are null', async () => {
    const tools = createUserTools(unconfiguredClients());
    const getCurrentUserHandler = tools[2].handler;

    const result = await getCurrentUserHandler({});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.code).toBe('NOT_CONFIGURED');
  });
});

describe('createUserTools (with clients — configured path)', () => {
  let mockClients: SlackClients;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClients = {
      user: {} as any,
      tokenState: { accessToken: '' },
      lock: new RefreshLock(),
      _tokensStatus: 'present',
    };
  });

  it('getUsers handler routes to handler when clients are configured', async () => {
    const mockUser = {
      user: {
        id: 'U1234567890',
        name: 'alice',
        real_name: 'Alice',
        email: 'alice@example.com',
      },
    };
    vi.mocked(client.getUsers).mockResolvedValue(mockUser);

    const tools = createUserTools(mockClients);
    const getUsersHandler = tools[0].handler;

    const result = await getUsersHandler({ email: 'alice@example.com' });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.user.id).toBe('U1234567890');
  });

  it('getCurrentUser handler routes to handler when clients are configured', async () => {
    const me = { id: 'U1234567890', name: 'alice', team_id: 'T1' };
    vi.mocked(client.getCurrentUser).mockResolvedValue(me);

    const tools = createUserTools(mockClients);
    const getCurrentUserHandler = tools[2].handler;

    const result = await getCurrentUserHandler({});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.id).toBe('U1234567890');
  });
});
