import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withSetupGuidance } from '@speedwave/mcp-shared';
import {
  formatSlackError,
  SlackClients,
  SlackMessage,
  SlackChannel,
  initializeSlackClients,
  sendChannel,
  readChannel,
  getChannels,
  getUsers,
} from './client.js';
import { WebClient } from '@slack/web-api';
import fs from 'fs/promises';

// Mock WebClient constructor function
const mockWebClientInstance = {
  chat: {
    postMessage: vi.fn(),
  },
  conversations: {
    list: vi.fn(),
    history: vi.fn(),
  },
  users: {
    lookupByEmail: vi.fn(),
  },
};

// Mock @slack/web-api - use class for vitest 4.x compatibility
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function (this: typeof mockWebClientInstance) {
    Object.assign(this, mockWebClientInstance);
  }),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
  },
}));

describe('slack client', () => {
  describe('formatSlackError', () => {
    it('formats authentication errors', () => {
      const errors = [
        { data: { error: 'not_authed' } },
        { data: { error: 'invalid_auth' } },
        { data: { error: 'token_revoked' } },
      ];

      for (const error of errors) {
        const message = formatSlackError(error);
        expect(message).toContain('Authentication failed');
        expect(message).toBe(withSetupGuidance('Authentication failed. Check your Slack tokens.'));
      }
    });

    it('formats permission errors', () => {
      const errors = [
        { data: { error: 'missing_scope' } },
        { data: { error: 'restricted_action' } },
      ];

      for (const error of errors) {
        const message = formatSlackError(error);
        expect(message).toContain('Permission denied');
      }
    });

    it('formats channel not found error', () => {
      const error = { data: { error: 'channel_not_found' } };
      const message = formatSlackError(error);
      expect(message).toBe('Channel not found in Slack.');
    });

    it('formats user not found errors', () => {
      const errors = [
        { data: { error: 'users_not_found' } },
        { data: { error: 'user_not_found' } },
      ];

      for (const error of errors) {
        const message = formatSlackError(error);
        expect(message).toBe('User not found in Slack.');
      }
    });

    it('formats rate limit error', () => {
      const error = { data: { error: 'ratelimited' } };
      const message = formatSlackError(error);
      expect(message).toBe('Rate limit exceeded. Please try again later.');
    });

    it('formats network errors', () => {
      const errors = [{ message: 'getaddrinfo ENOTFOUND slack.com' }, { message: 'ECONNREFUSED' }];

      for (const error of errors) {
        const message = formatSlackError(error);
        expect(message).toContain('Network error');
      }
    });

    it('formats unknown Slack API errors', () => {
      const error = { data: { error: 'some_unknown_error' } };
      const message = formatSlackError(error);
      expect(message).toBe('Slack API error: some_unknown_error');
    });

    it('falls back to error message', () => {
      const error = { message: 'Something went wrong' };
      const message = formatSlackError(error);
      expect(message).toBe('Something went wrong');
    });

    it('returns default message when no details available', () => {
      const error = {};
      const message = formatSlackError(error);
      expect(message).toBe('Slack API error');
    });

    it('handles error property directly', () => {
      const error = { error: 'channel_not_found' };
      const message = formatSlackError(error);
      expect(message).toBe('Channel not found in Slack.');
    });
  });

  describe('initializeSlackClients', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      // Clear console.log and console.error spies
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('successfully initializes clients with valid tokens', async () => {
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce('xoxb-bot-token-123\n')
        .mockResolvedValueOnce('xoxp-user-token-456\n');

      const clients = await initializeSlackClients();

      expect(clients).not.toBeNull();
      expect(clients?.bot).toBeDefined();
      expect(clients?.user).toBeDefined();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('✅ Slack: Tokens loaded'));
    });

    it('returns null when bot token is empty', async () => {
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce('  \n')
        .mockResolvedValueOnce('xoxp-user-token-456\n');

      const result = await initializeSlackClients();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Slack tokens are empty or missing')
      );
    });

    it('returns null when user token is empty', async () => {
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce('xoxb-bot-token-123\n')
        .mockResolvedValueOnce('  \n');

      const result = await initializeSlackClients();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Slack tokens are empty or missing')
      );
    });

    it('returns null when tokens cannot be read', async () => {
      vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('ENOENT: no such file'));

      const result = await initializeSlackClients();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load Slack tokens')
      );
    });

    it('trims whitespace from tokens', async () => {
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce('  xoxb-bot-token-123  \n')
        .mockResolvedValueOnce('\txoxp-user-token-456\t\n');

      const clients = await initializeSlackClients();

      expect(clients).not.toBeNull();
      expect(WebClient).toHaveBeenCalledWith('xoxb-bot-token-123');
      expect(WebClient).toHaveBeenCalledWith('xoxp-user-token-456');
    });
  });

  describe('sendChannel', () => {
    let mockClients: SlackClients;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClients = {
        bot: {
          chat: { postMessage: vi.fn() },
          conversations: { list: vi.fn(), history: vi.fn() },
          users: { lookupByEmail: vi.fn() },
        } as any,
        user: {
          chat: { postMessage: vi.fn() },
          conversations: { list: vi.fn(), history: vi.fn() },
          users: { lookupByEmail: vi.fn() },
        } as any,
      };
    });

    it('sends message to channel by ID', async () => {
      const mockPostMessage = vi.fn().mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
        channel: 'C12345678',
      });
      mockClients.user.chat.postMessage = mockPostMessage;

      const result = await sendChannel(mockClients, {
        channel: 'C12345678',
        message: 'Hello, world!',
      });

      expect(result).toEqual({
        ok: true,
        ts: '1234567890.123456',
        channel: 'C12345678',
      });
      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C12345678',
        text: 'Hello, world!',
      });
    });

    it('sends message to channel by name', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [
          { id: 'C12345678', name: 'general', name_normalized: 'general' },
          { id: 'C87654321', name: 'random', name_normalized: 'random' },
        ],
      });
      const mockPostMessage = vi.fn().mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
        channel: 'C12345678',
      });

      mockClients.user.conversations.list = mockList;
      mockClients.user.chat.postMessage = mockPostMessage;

      const result = await sendChannel(mockClients, {
        channel: 'general',
        message: 'Hello, general!',
      });

      expect(result.ok).toBe(true);
      expect(result.channel).toBe('C12345678');
      expect(mockList).toHaveBeenCalledWith({
        types: 'public_channel,private_channel',
        limit: 1000,
      });
      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C12345678',
        text: 'Hello, general!',
      });
    });

    it('sends message to channel with # prefix', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [{ id: 'C12345678', name: 'general', name_normalized: 'general' }],
      });
      const mockPostMessage = vi.fn().mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
        channel: 'C12345678',
      });

      mockClients.user.conversations.list = mockList;
      mockClients.user.chat.postMessage = mockPostMessage;

      await sendChannel(mockClients, {
        channel: '#general',
        message: 'Hello!',
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C12345678',
        text: 'Hello!',
      });
    });

    it('throws error when channel not found', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [{ id: 'C12345678', name: 'general' }],
      });

      mockClients.user.conversations.list = mockList;

      await expect(
        sendChannel(mockClients, {
          channel: 'nonexistent',
          message: 'Hello!',
        })
      ).rejects.toThrow('Channel not found: nonexistent');
    });

    it('resolves channel by normalized name', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [{ id: 'C12345678', name: 'team-eng', name_normalized: 'team-eng' }],
      });
      const mockPostMessage = vi.fn().mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
        channel: 'C12345678',
      });

      mockClients.user.conversations.list = mockList;
      mockClients.user.chat.postMessage = mockPostMessage;

      await sendChannel(mockClients, {
        channel: 'team-eng',
        message: 'Hello!',
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'C12345678',
        text: 'Hello!',
      });
    });

    it('handles response without ok field', async () => {
      const mockPostMessage = vi.fn().mockResolvedValue({
        ts: '1234567890.123456',
        channel: 'C12345678',
      });
      mockClients.user.chat.postMessage = mockPostMessage;

      const result = await sendChannel(mockClients, {
        channel: 'C12345678',
        message: 'Hello!',
      });

      expect(result.ok).toBe(false);
    });

    it('recognizes DM channel IDs', async () => {
      const mockPostMessage = vi.fn().mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
        channel: 'D12345678',
      });
      mockClients.user.chat.postMessage = mockPostMessage;

      await sendChannel(mockClients, {
        channel: 'D12345678',
        message: 'Direct message',
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'D12345678',
        text: 'Direct message',
      });
    });

    it('recognizes group channel IDs', async () => {
      const mockPostMessage = vi.fn().mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
        channel: 'G12345678',
      });
      mockClients.user.chat.postMessage = mockPostMessage;

      await sendChannel(mockClients, {
        channel: 'G12345678',
        message: 'Group message',
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: 'G12345678',
        text: 'Group message',
      });
    });
  });

  describe('readChannel', () => {
    let mockClients: SlackClients;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClients = {
        bot: {
          chat: { postMessage: vi.fn() },
          conversations: { list: vi.fn(), history: vi.fn() },
          users: { lookupByEmail: vi.fn() },
        } as any,
        user: {
          chat: { postMessage: vi.fn() },
          conversations: { list: vi.fn(), history: vi.fn() },
          users: { lookupByEmail: vi.fn() },
        } as any,
      };
    });

    it('reads messages from channel by ID', async () => {
      const mockHistory = vi.fn().mockResolvedValue({
        messages: [
          {
            user: 'U123',
            text: 'Hello',
            ts: '1234567890.123456',
            type: 'message',
          },
          {
            user: 'U456',
            text: 'Hi there',
            ts: '1234567891.123456',
            type: 'message',
            username: 'bot_user',
          },
        ],
      });

      mockClients.user.conversations.history = mockHistory;

      const result = await readChannel(mockClients, {
        channel: 'C12345678',
      });

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toEqual({
        user: 'U123',
        text: 'Hello',
        ts: '1234567890.123456',
        type: 'message',
        username: undefined,
      });
      expect(result.messages[1]).toEqual({
        user: 'U456',
        text: 'Hi there',
        ts: '1234567891.123456',
        type: 'message',
        username: 'bot_user',
      });
      expect(mockHistory).toHaveBeenCalledWith({
        channel: 'C12345678',
        limit: 20,
      });
    });

    it('reads messages from channel by name', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [{ id: 'C12345678', name: 'general' }],
      });
      const mockHistory = vi.fn().mockResolvedValue({
        messages: [],
      });

      mockClients.user.conversations.list = mockList;
      mockClients.user.conversations.history = mockHistory;

      await readChannel(mockClients, {
        channel: 'general',
        limit: 50,
      });

      expect(mockHistory).toHaveBeenCalledWith({
        channel: 'C12345678',
        limit: 50,
      });
    });

    it('uses default limit of 20', async () => {
      const mockHistory = vi.fn().mockResolvedValue({ messages: [] });
      mockClients.user.conversations.history = mockHistory;

      await readChannel(mockClients, {
        channel: 'C12345678',
      });

      expect(mockHistory).toHaveBeenCalledWith({
        channel: 'C12345678',
        limit: 20,
      });
    });

    it('clamps limit to minimum of 1', async () => {
      const mockHistory = vi.fn().mockResolvedValue({ messages: [] });
      mockClients.user.conversations.history = mockHistory;

      await readChannel(mockClients, {
        channel: 'C12345678',
        limit: -5,
      });

      expect(mockHistory).toHaveBeenCalledWith({
        channel: 'C12345678',
        limit: 1,
      });
    });

    it('clamps limit to maximum of 100', async () => {
      const mockHistory = vi.fn().mockResolvedValue({ messages: [] });
      mockClients.user.conversations.history = mockHistory;

      await readChannel(mockClients, {
        channel: 'C12345678',
        limit: 200,
      });

      expect(mockHistory).toHaveBeenCalledWith({
        channel: 'C12345678',
        limit: 100,
      });
    });

    it('handles messages with missing fields', async () => {
      const mockHistory = vi.fn().mockResolvedValue({
        messages: [
          {
            // Missing user, text, ts fields
            type: 'message',
          },
          {
            user: null,
            text: null,
            ts: null,
          },
        ],
      });

      mockClients.user.conversations.history = mockHistory;

      const result = await readChannel(mockClients, {
        channel: 'C12345678',
      });

      expect(result.messages[0]).toEqual({
        user: 'unknown',
        text: '',
        ts: '',
        type: 'message',
        username: undefined,
      });
      expect(result.messages[1]).toEqual({
        user: 'unknown',
        text: '',
        ts: '',
        type: 'message',
        username: undefined,
      });
    });

    it('handles empty messages array', async () => {
      const mockHistory = vi.fn().mockResolvedValue({
        messages: [],
      });

      mockClients.user.conversations.history = mockHistory;

      const result = await readChannel(mockClients, {
        channel: 'C12345678',
      });

      expect(result.messages).toEqual([]);
    });

    it('handles missing messages array', async () => {
      const mockHistory = vi.fn().mockResolvedValue({});

      mockClients.user.conversations.history = mockHistory;

      const result = await readChannel(mockClients, {
        channel: 'C12345678',
      });

      expect(result.messages).toEqual([]);
    });
  });

  describe('getChannels', () => {
    let mockClients: SlackClients;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClients = {
        bot: {
          chat: { postMessage: vi.fn() },
          conversations: { list: vi.fn(), history: vi.fn() },
          users: { lookupByEmail: vi.fn() },
        } as any,
        user: {
          chat: { postMessage: vi.fn() },
          conversations: { list: vi.fn(), history: vi.fn() },
          users: { lookupByEmail: vi.fn() },
        } as any,
      };
    });

    it('returns list of channels user is member of', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [
          {
            id: 'C12345',
            name: 'general',
            is_channel: true,
            is_private: false,
            is_member: true,
            num_members: 50,
          },
          {
            id: 'C67890',
            name: 'random',
            is_channel: true,
            is_private: false,
            is_member: true,
            num_members: 30,
          },
          {
            id: 'C11111',
            name: 'not-member',
            is_channel: true,
            is_private: false,
            is_member: false,
            num_members: 10,
          },
        ],
      });

      mockClients.user.conversations.list = mockList;

      const result = await getChannels(mockClients);

      expect(result.channels).toHaveLength(2);
      expect(result.channels[0]).toEqual({
        id: 'C12345',
        name: 'general',
        is_channel: true,
        is_private: false,
        is_member: true,
        num_members: 50,
      });
      expect(result.channels[1]).toEqual({
        id: 'C67890',
        name: 'random',
        is_channel: true,
        is_private: false,
        is_member: true,
        num_members: 30,
      });
      expect(mockList).toHaveBeenCalledWith({
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 1000,
      });
    });

    it('filters out channels user is not member of', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [
          {
            id: 'C12345',
            name: 'general',
            is_channel: true,
            is_private: false,
            is_member: false,
          },
        ],
      });

      mockClients.user.conversations.list = mockList;

      const result = await getChannels(mockClients);

      expect(result.channels).toHaveLength(0);
    });

    it('handles private channels', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [
          {
            id: 'G12345',
            name: 'private-channel',
            is_channel: false,
            is_private: true,
            is_member: true,
            num_members: 5,
          },
        ],
      });

      mockClients.user.conversations.list = mockList;

      const result = await getChannels(mockClients);

      expect(result.channels[0]).toEqual({
        id: 'G12345',
        name: 'private-channel',
        is_channel: false,
        is_private: true,
        is_member: true,
        num_members: 5,
      });
    });

    it('handles channels with missing fields', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [
          {
            // Missing all fields except is_member
            is_member: true,
          },
          {
            id: null,
            name: null,
            is_channel: null,
            is_private: null,
            is_member: true,
          },
        ],
      });

      mockClients.user.conversations.list = mockList;

      const result = await getChannels(mockClients);

      // These channels pass the is_member filter, so they will be included
      expect(result.channels[0]).toEqual({
        id: '',
        name: '',
        is_channel: false,
        is_private: false,
        is_member: true,
        num_members: undefined,
      });
      expect(result.channels[1]).toEqual({
        id: '',
        name: '',
        is_channel: false,
        is_private: false,
        is_member: true,
        num_members: undefined,
      });
    });

    it('handles empty channels array', async () => {
      const mockList = vi.fn().mockResolvedValue({
        channels: [],
      });

      mockClients.user.conversations.list = mockList;

      const result = await getChannels(mockClients);

      expect(result.channels).toEqual([]);
    });

    it('handles missing channels array', async () => {
      const mockList = vi.fn().mockResolvedValue({});

      mockClients.user.conversations.list = mockList;

      const result = await getChannels(mockClients);

      expect(result.channels).toEqual([]);
    });
  });

  describe('getUsers', () => {
    let mockClients: SlackClients;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClients = {
        bot: {
          chat: { postMessage: vi.fn() },
          conversations: { list: vi.fn(), history: vi.fn() },
          users: { lookupByEmail: vi.fn() },
        } as any,
        user: {
          chat: { postMessage: vi.fn() },
          conversations: { list: vi.fn(), history: vi.fn() },
          users: { lookupByEmail: vi.fn() },
        } as any,
      };
    });

    it('returns user by email', async () => {
      const mockLookup = vi.fn().mockResolvedValue({
        user: {
          id: 'U12345',
          name: 'john.doe',
          real_name: 'John Doe',
          profile: {
            email: 'john.doe@example.com',
          },
        },
      });

      mockClients.user.users.lookupByEmail = mockLookup;

      const result = await getUsers(mockClients, {
        email: 'john.doe@example.com',
      });

      expect(result.user).toEqual({
        id: 'U12345',
        name: 'john.doe',
        real_name: 'John Doe',
        email: 'john.doe@example.com',
      });
      expect(mockLookup).toHaveBeenCalledWith({
        email: 'john.doe@example.com',
      });
    });

    it('returns null when user not found', async () => {
      const mockLookup = vi.fn().mockRejectedValue({
        data: { error: 'users_not_found' },
      });

      mockClients.user.users.lookupByEmail = mockLookup;

      const result = await getUsers(mockClients, {
        email: 'nonexistent@example.com',
      });

      expect(result.user).toBeNull();
    });

    it('returns null when user object is missing', async () => {
      const mockLookup = vi.fn().mockResolvedValue({});

      mockClients.user.users.lookupByEmail = mockLookup;

      const result = await getUsers(mockClients, {
        email: 'test@example.com',
      });

      expect(result.user).toBeNull();
    });

    it('handles user with missing optional fields', async () => {
      const mockLookup = vi.fn().mockResolvedValue({
        user: {
          id: 'U12345',
          name: 'john.doe',
          // Missing real_name and profile
        },
      });

      mockClients.user.users.lookupByEmail = mockLookup;

      const result = await getUsers(mockClients, {
        email: 'john.doe@example.com',
      });

      expect(result.user).toEqual({
        id: 'U12345',
        name: 'john.doe',
        real_name: undefined,
        email: undefined,
      });
    });

    it('handles user with empty fields', async () => {
      const mockLookup = vi.fn().mockResolvedValue({
        user: {
          id: null,
          name: null,
          real_name: null,
          profile: {},
        },
      });

      mockClients.user.users.lookupByEmail = mockLookup;

      const result = await getUsers(mockClients, {
        email: 'test@example.com',
      });

      expect(result.user).toEqual({
        id: '',
        name: '',
        real_name: null,
        email: undefined,
      });
    });

    it('throws error for other API errors', async () => {
      const mockLookup = vi.fn().mockRejectedValue({
        data: { error: 'invalid_auth' },
      });

      mockClients.user.users.lookupByEmail = mockLookup;

      await expect(
        getUsers(mockClients, {
          email: 'test@example.com',
        })
      ).rejects.toEqual({
        data: { error: 'invalid_auth' },
      });
    });

    it('throws error for network errors', async () => {
      const mockLookup = vi.fn().mockRejectedValue(new Error('Network error'));

      mockClients.user.users.lookupByEmail = mockLookup;

      await expect(
        getUsers(mockClients, {
          email: 'test@example.com',
        })
      ).rejects.toThrow('Network error');
    });
  });
});
