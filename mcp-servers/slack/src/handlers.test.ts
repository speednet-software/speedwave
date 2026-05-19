/**
 * Slack Handlers Tests
 *
 * Integration-level tests for the createSlackHandlers factory.
 * Tests handler routing, parameter validation, error handling,
 * and edge cases at the handler level (not the lower-level client).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSlackHandlers, UserInfoError, ChannelResolutionError } from './handlers.js';
import type { WebClient } from '@slack/web-api';

// Mock the shared module (loadToken)
vi.mock('@speedwave/mcp-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@speedwave/mcp-shared')>();
  return {
    ...actual,
    loadToken: vi.fn(),
    ts: () => '[test]',
  };
});

import { loadToken } from '@speedwave/mcp-shared';

// Helper to create mock WebClient instances
function createMockWebClient(): WebClient {
  return {
    conversations: {
      members: vi.fn(),
      history: vi.fn(),
    },
    chat: {
      postMessage: vi.fn(),
    },
    auth: {
      test: vi.fn(),
    },
    users: {
      info: vi.fn(),
      lookupByEmail: vi.fn(),
    },
  } as unknown as WebClient;
}

describe('handlers', () => {
  let mockBot: WebClient;
  let mockUser: WebClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockBot = createMockWebClient();
    mockUser = createMockWebClient();
  });

  //=============================================================================
  // Factory: createSlackHandlers
  //=============================================================================

  describe('createSlackHandlers', () => {
    it('returns all four handler functions', () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      expect(handlers.handleSendChannel).toBeTypeOf('function');
      expect(handlers.handleReadChannel).toBeTypeOf('function');
      expect(handlers.handleGetChannels).toBeTypeOf('function');
      expect(handlers.handleGetUsers).toBeTypeOf('function');
    });

    it('returns handlers even when clients are null', () => {
      const handlers = createSlackHandlers(null);

      expect(handlers.handleSendChannel).toBeTypeOf('function');
      expect(handlers.handleReadChannel).toBeTypeOf('function');
      expect(handlers.handleGetChannels).toBeTypeOf('function');
      expect(handlers.handleGetUsers).toBeTypeOf('function');
    });
  });

  //=============================================================================
  // Not Configured (null clients)
  //=============================================================================

  describe('not configured (null clients)', () => {
    it('handleSendChannel returns not-configured error', async () => {
      const handlers = createSlackHandlers(null);
      const result = await handlers.handleSendChannel({ channel: '#general', message: 'hi' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not configured');
    });

    it('handleReadChannel returns not-configured error', async () => {
      const handlers = createSlackHandlers(null);
      const result = await handlers.handleReadChannel({ channel: '#general' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not configured');
    });

    it('handleGetChannels returns not-configured error', async () => {
      const handlers = createSlackHandlers(null);
      const result = await handlers.handleGetChannels({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not configured');
    });

    it('handleGetUsers returns not-configured error', async () => {
      const handlers = createSlackHandlers(null);
      const result = await handlers.handleGetUsers({ email: 'test@example.com' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not configured');
    });
  });

  //=============================================================================
  // handleSendChannel
  //=============================================================================

  describe('handleSendChannel', () => {
    it('validates missing channel parameter', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });
      const result = await handlers.handleSendChannel({ message: 'hello' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required fields');
    });

    it('validates missing message parameter', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });
      const result = await handlers.handleSendChannel({ channel: '#general' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required fields');
    });

    it('validates both channel and message missing', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });
      const result = await handlers.handleSendChannel({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required fields');
    });

    it('sends message successfully when channel ID is provided', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      // Mock bot membership check
      vi.mocked(mockBot.conversations.members).mockResolvedValue({
        ok: true,
        members: ['UBOTID123'],
      } as any);
      vi.mocked(mockBot.auth.test).mockResolvedValue({
        ok: true,
        user_id: 'UBOTID123',
      } as any);

      // Mock user sending message
      vi.mocked(mockUser.chat.postMessage).mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      } as any);

      const result = await handlers.handleSendChannel({
        channel: 'C12345ABC',
        message: 'Hello!',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Message sent');
      expect(result.content[0].text).toContain('1234567890.123456');
    });

    it('returns error when bot is not a channel member', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(mockBot.conversations.members).mockResolvedValue({
        ok: true,
        members: ['UOTHER999'],
      } as any);
      vi.mocked(mockBot.auth.test).mockResolvedValue({
        ok: true,
        user_id: 'UBOTID123',
      } as any);

      const result = await handlers.handleSendChannel({
        channel: 'C12345ABC',
        message: 'Hello!',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Access denied');
      expect(result.content[0].text).toContain('not a member');
    });

    it('returns error when conversations.members fails', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(mockBot.conversations.members).mockResolvedValue({
        ok: false,
      } as any);

      const result = await handlers.handleSendChannel({
        channel: 'C12345ABC',
        message: 'Hello!',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot access channel');
    });

    it('returns error when postMessage returns ok=false', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(mockBot.conversations.members).mockResolvedValue({
        ok: true,
        members: ['UBOTID123'],
      } as any);
      vi.mocked(mockBot.auth.test).mockResolvedValue({
        ok: true,
        user_id: 'UBOTID123',
      } as any);
      vi.mocked(mockUser.chat.postMessage).mockResolvedValue({
        ok: false,
        error: 'channel_not_found',
      } as any);

      const result = await handlers.handleSendChannel({
        channel: 'C12345ABC',
        message: 'Hello!',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to send message');
    });

    it('handles Slack API throwing an error', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(mockBot.conversations.members).mockRejectedValue(new Error('network_error'));

      const result = await handlers.handleSendChannel({
        channel: 'C12345ABC',
        message: 'Hello!',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error sending message');
    });

    it('handles rate limiting error from Slack API', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(mockBot.conversations.members).mockRejectedValue(new Error('A]ratelimited'));

      const result = await handlers.handleSendChannel({
        channel: 'C12345ABC',
        message: 'Hello!',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error sending message');
    });

    it('resolves channel name via users.conversations before sending', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      // Mock loadToken for channel resolution
      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      // Mock global fetch for channel resolution
      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            channels: [{ id: 'C99999', name: 'general', is_private: false, is_member: true }],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      vi.mocked(mockBot.conversations.members).mockResolvedValue({
        ok: true,
        members: ['UBOTID123'],
      } as any);
      vi.mocked(mockBot.auth.test).mockResolvedValue({
        ok: true,
        user_id: 'UBOTID123',
      } as any);
      vi.mocked(mockUser.chat.postMessage).mockResolvedValue({
        ok: true,
        ts: '1111111111.111111',
      } as any);

      const result = await handlers.handleSendChannel({
        channel: '#general',
        message: 'Hello!',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Message sent');
      // Verify the resolved channel ID was used
      expect(mockBot.conversations.members).toHaveBeenCalledWith({ channel: 'C99999' });

      vi.unstubAllGlobals();
    });

    it('returns error when channel name cannot be resolved', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            channels: [{ id: 'C11111', name: 'other-channel', is_private: false, is_member: true }],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleSendChannel({
        channel: '#nonexistent',
        message: 'Hello!',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error sending message');

      vi.unstubAllGlobals();
    });
  });

  //=============================================================================
  // handleReadChannel
  //=============================================================================

  describe('handleReadChannel', () => {
    it('validates missing channel parameter', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });
      const result = await handlers.handleReadChannel({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required field: channel');
    });

    it('reads channel history successfully', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            messages: [
              { user: 'U123', text: 'Hello', ts: '1700000000.000001', type: 'message' },
              { user: 'U456', text: 'World', ts: '1700000001.000001', type: 'message' },
            ],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      // Mock users.info for name resolution
      vi.mocked(mockBot.users.info).mockResolvedValue({
        ok: true,
        user: { real_name: 'Alice', name: 'alice', profile: { email: 'alice@test.com' } },
      } as any);

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Messages: 2');

      vi.unstubAllGlobals();
    });

    it('handles empty messages array', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, messages: [] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Messages: 0');

      vi.unstubAllGlobals();
    });

    it('handles API returning ok=false', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: false, error: 'channel_not_found' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error reading channel');

      vi.unstubAllGlobals();
    });

    it('handles API returning null messages', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, messages: null }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error reading channel');

      vi.unstubAllGlobals();
    });

    it('clamps limit to valid range (1-100)', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, messages: [] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await handlers.handleReadChannel({ channel: 'C12345ABC', limit: 500 });

      // Verify the fetch was called with limit=100 (clamped)
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain('limit=100');

      vi.unstubAllGlobals();
    });

    it('defaults limit to 20 when not provided', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, messages: [] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await handlers.handleReadChannel({ channel: 'C12345ABC' });

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain('limit=20');

      vi.unstubAllGlobals();
    });

    it('handles token file not found error', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockRejectedValue(new Error('Token file not found: /tokens/user_token'));

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error reading channel');
      expect(result.content[0].text).toContain('Token file not found');
    });

    it('gracefully handles user info fetch failure', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            messages: [{ user: 'U123', text: 'Hello', ts: '1700000000.000001', type: 'message' }],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      // User info lookup fails
      vi.mocked(mockBot.users.info).mockRejectedValue(new Error('users_not_found'));

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      // Should still succeed - user ID shown as fallback
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Messages: 1');

      vi.unstubAllGlobals();
    });

    it('displays real name from user cache', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            messages: [{ user: 'U123', text: 'Hello', ts: '1700000000.000001', type: 'message' }],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      vi.mocked(mockBot.users.info).mockResolvedValue({
        ok: true,
        user: { real_name: 'Alice Smith', name: 'alice', profile: {} },
      } as any);

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      expect(result.content[0].text).toContain('Alice Smith');

      vi.unstubAllGlobals();
    });

    it('handles malformed JSON response from fetch', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error reading channel');

      vi.unstubAllGlobals();
    });

    it('handles network error during fetch', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error reading channel');

      vi.unstubAllGlobals();
    });

    it('handles messages with missing fields gracefully', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            messages: [
              { type: 'message' }, // missing user, text, ts
              { user: 'U123' }, // missing text, ts
            ],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      vi.mocked(mockBot.users.info).mockResolvedValue({
        ok: true,
        user: { real_name: 'Bob', name: 'bob', profile: {} },
      } as any);

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Messages: 2');
      // Missing text should show fallback
      expect(result.content[0].text).toContain('(no text)');

      vi.unstubAllGlobals();
    });
  });

  //=============================================================================
  // handleGetChannels
  //=============================================================================

  describe('handleGetChannels', () => {
    it('lists channels successfully', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            channels: [
              { id: 'C111', name: 'general', is_private: false, is_member: true },
              { id: 'C222', name: 'private', is_private: true, is_member: true },
            ],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleGetChannels({});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Total channels: 2');
      expect(result.content[0].text).toContain('general');
      expect(result.content[0].text).toContain('private');

      vi.unstubAllGlobals();
    });

    it('handles empty channel list', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, channels: [] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleGetChannels({});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Total channels: 0');

      vi.unstubAllGlobals();
    });

    it('handles API returning ok=false', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: false, error: 'invalid_auth' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleGetChannels({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to list channels');

      vi.unstubAllGlobals();
    });

    it('handles null channels in response', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: false, channels: null }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleGetChannels({});

      expect(result.isError).toBe(true);

      vi.unstubAllGlobals();
    });

    it('handles token file not found', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockRejectedValue(new Error('Token file not found: /tokens/user_token'));

      const result = await handlers.handleGetChannels({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error listing channels');

      vi.unstubAllGlobals();
    });

    it('handles network error', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleGetChannels({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error listing channels');

      vi.unstubAllGlobals();
    });

    it('handles malformed JSON in response', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleGetChannels({});

      expect(result.isError).toBe(true);

      vi.unstubAllGlobals();
    });
  });

  //=============================================================================
  // handleGetUsers
  //=============================================================================

  describe('handleGetUsers', () => {
    it('validates missing email parameter', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });
      const result = await handlers.handleGetUsers({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required field: email');
    });

    it('validates invalid email format', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });
      const result = await handlers.handleGetUsers({ email: 'not-an-email' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid email format');
    });

    it('validates email with missing domain', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });
      const result = await handlers.handleGetUsers({ email: 'user@' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid email format');
    });

    it('returns user info on valid email lookup', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(mockBot.users.lookupByEmail).mockResolvedValue({
        ok: true,
        user: {
          id: 'U12345',
          name: 'john.doe',
          real_name: 'John Doe',
          profile: { email: 'john@example.com' },
        },
      } as any);

      const result = await handlers.handleGetUsers({ email: 'john@example.com' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('John Doe');
      expect(result.content[0].text).toContain('U12345');
    });

    it('returns error when user not found', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(mockBot.users.lookupByEmail).mockResolvedValue({
        ok: false,
        user: null,
      } as any);

      const result = await handlers.handleGetUsers({ email: 'notfound@example.com' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('User not found');
    });

    it('handles Slack API throwing an error', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(mockBot.users.lookupByEmail).mockRejectedValue(new Error('users_not_found'));

      const result = await handlers.handleGetUsers({ email: 'error@example.com' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error getting user info');
    });

    it('handles rate limit error from Slack API', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(mockBot.users.lookupByEmail).mockRejectedValue(new Error('ratelimited'));

      const result = await handlers.handleGetUsers({ email: 'ratelimited@example.com' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error getting user info');
    });

    it('handles non-Error thrown by API', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(mockBot.users.lookupByEmail).mockRejectedValue('string error');

      const result = await handlers.handleGetUsers({ email: 'test@example.com' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error getting user info');
    });
  });

  //=============================================================================
  // UserInfoError and ChannelResolutionError
  //=============================================================================

  describe('error classes', () => {
    it('UserInfoError includes userId', () => {
      const error = new UserInfoError('U12345');
      expect(error.message).toContain('U12345');
      expect(error.userId).toBe('U12345');
      expect(error.name).toBe('UserInfoError');
    });

    it('UserInfoError includes cause', () => {
      const cause = new Error('API timeout');
      const error = new UserInfoError('U12345', cause);
      expect(error.message).toContain('U12345');
      expect(error.message).toContain('API timeout');
      expect(error.cause).toBe(cause);
    });

    it('ChannelResolutionError includes channel input', () => {
      const error = new ChannelResolutionError('#general');
      expect(error.message).toContain('#general');
      expect(error.channelInput).toBe('#general');
      expect(error.name).toBe('ChannelResolutionError');
    });

    it('ChannelResolutionError includes cause', () => {
      const cause = new Error('network failure');
      const error = new ChannelResolutionError('#general', cause);
      expect(error.message).toContain('#general');
      expect(error.message).toContain('network failure');
      expect(error.cause).toBe(cause);
    });
  });

  //=============================================================================
  // User cache behavior
  //=============================================================================

  describe('user cache', () => {
    it('caches user info and avoids duplicate API calls', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      // First call - 2 messages from same user
      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            messages: [
              { user: 'U123', text: 'First', ts: '1700000000.000001', type: 'message' },
              { user: 'U123', text: 'Second', ts: '1700000001.000001', type: 'message' },
            ],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      vi.mocked(mockBot.users.info).mockResolvedValue({
        ok: true,
        user: { real_name: 'Alice', name: 'alice', profile: {} },
      } as any);

      await handlers.handleReadChannel({ channel: 'C12345ABC' });

      // users.info should only be called once for U123 (deduplication via Set)
      expect(mockBot.users.info).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });

    it('returns cached user info on second handleReadChannel call without re-fetching', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const messages = [{ user: 'U123', text: 'Hello', ts: '1700000000.000001', type: 'message' }];

      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, messages }),
      });
      vi.stubGlobal('fetch', mockFetch);

      vi.mocked(mockBot.users.info).mockResolvedValue({
        ok: true,
        user: { real_name: 'Alice', name: 'alice', profile: {} },
      } as any);

      // First call — populates cache
      await handlers.handleReadChannel({ channel: 'C12345ABC' });
      // Second call — should hit cache, not call users.info again
      await handlers.handleReadChannel({ channel: 'C12345ABC' });

      // users.info should only be called once across both reads (cache hit on second)
      expect(mockBot.users.info).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });
  });

  //=============================================================================
  // getUserInfo internal behavior
  //=============================================================================

  describe('getUserInfo internal behavior (via handleReadChannel)', () => {
    it('falls back to user ID as display name when users.info returns ok=false', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            messages: [{ user: 'U999', text: 'Hello', ts: '1700000000.000001', type: 'message' }],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      // API returns ok=false (no user data)
      vi.mocked(mockBot.users.info).mockResolvedValue({
        ok: false,
        user: undefined,
      } as any);

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      // Should still succeed — user ID shown as fallback
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Messages: 1');
      // Display name falls back to user ID since getUserInfo threw
      expect(result.content[0].text).toContain('U999');

      vi.unstubAllGlobals();
    });

    it('falls back to @username when user has name but no real_name', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            messages: [{ user: 'U123', text: 'Hi', ts: '1700000000.000001', type: 'message' }],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      // User has name but no real_name
      vi.mocked(mockBot.users.info).mockResolvedValue({
        ok: true,
        user: { name: 'bob', profile: {} },
      } as any);

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      expect(result.isError).toBeUndefined();
      // Should show @bob instead of real name
      expect(result.content[0].text).toContain('@bob');

      vi.unstubAllGlobals();
    });

    it('falls back to user ID when user info fetch throws non-UserInfoError', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            messages: [
              { user: 'U777', text: 'Error case', ts: '1700000000.000001', type: 'message' },
            ],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      // Throw a plain Error (not UserInfoError) from users.info
      vi.mocked(mockBot.users.info).mockRejectedValue(new Error('network timeout'));

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      // Should still succeed — user ID as fallback
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Messages: 1');

      vi.unstubAllGlobals();
    });

    it('shows (unknown time) for messages with no ts field', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            messages: [{ user: 'U123', text: 'No timestamp', type: 'message' }], // no ts
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      vi.mocked(mockBot.users.info).mockResolvedValue({
        ok: true,
        user: { real_name: 'Alice', name: 'alice', profile: {} },
      } as any);

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('(unknown time)');

      vi.unstubAllGlobals();
    });
  });

  //=============================================================================
  // resolveChannelId error wrapping
  //=============================================================================

  describe('resolveChannelId error wrapping', () => {
    it('wraps non-ChannelResolutionError from fetch into ChannelResolutionError', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      // fetch() itself throws a plain network error
      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleSendChannel({
        channel: '#general', // triggers resolveChannelId
        message: 'Hello!',
      });

      expect(result.isError).toBe(true);
      // The wrapping path converts it to ChannelResolutionError then Error sending message
      expect(result.content[0].text).toContain('Error sending message');
      expect(result.content[0].text).toContain('ECONNREFUSED');

      vi.unstubAllGlobals();
    });

    it('wraps loadToken failure (non-ChannelResolutionError) into ChannelResolutionError', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      // loadToken throws a plain Error, not a ChannelResolutionError
      vi.mocked(loadToken).mockRejectedValue(new Error('Token file missing'));

      const result = await handlers.handleSendChannel({
        channel: '#general', // triggers resolveChannelId
        message: 'Hello!',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error sending message');
      expect(result.content[0].text).toContain('Token file missing');
    });

    it('wraps non-Error value thrown from fetch in resolveChannelId', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      // fetch() throws a non-Error value (e.g. a string)
      const mockFetch = vi.fn().mockRejectedValue('non-error string failure');
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleSendChannel({
        channel: '#general',
        message: 'Hello!',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error sending message');

      vi.unstubAllGlobals();
    });

    it('resolveChannelId handles ok=false response (channels branch not taken)', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      // ok=false so the `if (result.ok && result.channels)` branch is not entered
      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: false, channels: [] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleSendChannel({
        channel: '#general',
        message: 'Hello!',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error sending message');

      vi.unstubAllGlobals();
    });

    it('resolveChannelId uses fallback count 0 when ok=true but channels is undefined', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      // ok=true but channels is undefined — triggers the `?? 0` fallback branch in the error message
      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, channels: undefined }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleSendChannel({
        channel: '#missing-channel',
        message: 'Hello!',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error sending message');

      vi.unstubAllGlobals();
    });
  });

  //=============================================================================
  // Non-Error thrown in catch blocks (ternary false branches)
  //=============================================================================

  describe('non-Error thrown in catch blocks', () => {
    it('handleSendChannel handles non-Error thrown by conversations.members', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      // Throw a non-Error object from conversations.members (after channel ID resolution)
      vi.mocked(mockBot.conversations.members).mockRejectedValue('non-error string');

      const result = await handlers.handleSendChannel({
        channel: 'C12345ABC', // channel ID — skips resolveChannelId
        message: 'Hello!',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error sending message');
      // String error is converted via String() not .message
      expect(result.content[0].text).toContain('non-error string');
    });

    it('handleReadChannel handles non-Error thrown by loadToken', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      // loadToken throws a non-Error value
      vi.mocked(loadToken).mockRejectedValue('plain-string-error');

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error reading channel');
      expect(result.content[0].text).toContain('plain-string-error');
    });

    it('handleGetChannels handles non-Error thrown by loadToken', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockRejectedValue('plain-string-error');

      const result = await handlers.handleGetChannels({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error listing channels');
      expect(result.content[0].text).toContain('plain-string-error');
    });

    it('handleGetUsers handles non-Error thrown by lookupByEmail', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(mockBot.users.lookupByEmail).mockRejectedValue('plain-string-error');

      const result = await handlers.handleGetUsers({ email: 'test@example.com' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error getting user info');
      expect(result.content[0].text).toContain('plain-string-error');
    });

    it('getUserInfo wraps non-Error thrown by users.info', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            messages: [{ user: 'U123', text: 'Hello', ts: '1700000000.000001', type: 'message' }],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      // users.info throws a non-Error value
      vi.mocked(mockBot.users.info).mockRejectedValue('non-error thrown from users.info');

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      // Should still succeed — getUserInfo failure is caught and swallowed, user ID shown as fallback
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Messages: 1');

      vi.unstubAllGlobals();
    });
  });

  //=============================================================================
  // handleGetChannels formatting branches
  //=============================================================================

  describe('handleGetChannels formatting branches', () => {
    it('shows private visibility for private channels', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            channels: [{ id: 'G123', name: 'secret', is_private: true, is_member: true }],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleGetChannels({});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('🔒 private');

      vi.unstubAllGlobals();
    });

    it('shows public visibility for public channels', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            channels: [{ id: 'C123', name: 'general', is_private: false, is_member: true }],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleGetChannels({});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('🌐 public');

      vi.unstubAllGlobals();
    });

    it('shows not-member status for channels user is not a member of', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      const mockFetch = vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            channels: [{ id: 'C999', name: 'other', is_private: false, is_member: false }],
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await handlers.handleGetChannels({});

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('❌ not member');

      vi.unstubAllGlobals();
    });
  });

  //=============================================================================
  // handleSendChannel result.error branch
  //=============================================================================

  describe('handleSendChannel postMessage result.error branch', () => {
    it('shows "Unknown error" when postMessage ok=false but no error field', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(mockBot.conversations.members).mockResolvedValue({
        ok: true,
        members: ['UBOTID123'],
      } as any);
      vi.mocked(mockBot.auth.test).mockResolvedValue({
        ok: true,
        user_id: 'UBOTID123',
      } as any);
      vi.mocked(mockUser.chat.postMessage).mockResolvedValue({
        ok: false,
        // No error field — forces the `|| 'Unknown error'` branch
      } as any);

      const result = await handlers.handleSendChannel({
        channel: 'C12345ABC',
        message: 'Hello!',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown error');
    });
  });

  //=============================================================================
  // Response truncation
  //=============================================================================

  describe('response truncation', () => {
    it('truncates response when total message content exceeds 100KB', async () => {
      const handlers = createSlackHandlers({ bot: mockBot, user: mockUser });

      vi.mocked(loadToken).mockResolvedValue('xoxp-user-token');

      // Create messages that together exceed 100KB
      // Each message text is ~1KB, and we send enough to exceed 100KB
      const bigText = 'x'.repeat(1024); // ~1KB per message
      const messages = Array.from({ length: 150 }, (_, i) => ({
        user: 'U123',
        text: bigText,
        ts: `${1700000000 + i}.000001`,
        type: 'message',
      }));

      const mockFetch = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, messages }),
      });
      vi.stubGlobal('fetch', mockFetch);

      vi.mocked(mockBot.users.info).mockResolvedValue({
        ok: true,
        user: { real_name: 'Alice', name: 'alice', profile: {} },
      } as any);

      const result = await handlers.handleReadChannel({ channel: 'C12345ABC' });

      expect(result.isError).toBeUndefined();
      // Should contain truncation notice
      expect(result.content[0].text).toContain('truncated');

      vi.unstubAllGlobals();
    });
  });
});
