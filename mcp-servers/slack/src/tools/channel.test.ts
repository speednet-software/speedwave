/**
 * Channel Tools Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withSetupGuidance, RefreshLock } from '@speedwave/mcp-shared';
import {
  handleSendChannel,
  handleGetChannelMessages,
  handleGetThreadMessages,
  handleListChannelIds,
  createChannelTools,
} from './channel-tools.js';
import type { SlackClients } from '../client.js';

// Mock the client module
vi.mock('../client.js', async () => {
  const actual = await vi.importActual('../client.js');
  return {
    ...actual,
    sendChannel: vi.fn(),
    readChannel: vi.fn(),
    readThread: vi.fn(),
    getChannels: vi.fn(),
    formatSlackError: vi.fn((error: unknown) => {
      const e = error as { message?: string };
      return e.message || 'Unknown error';
    }),
  };
});

// Mock the user-directory boundary — its machinery has its own test file;
// here we only verify the handlers route messages through enrichment.
vi.mock('../user-directory.js', () => ({
  enrichMessagesWithAuthors: vi.fn(async (_clients: unknown, msgs: unknown[]) => msgs),
}));

import * as client from '../client.js';
import { enrichMessagesWithAuthors } from '../user-directory.js';
import { WebClient } from '@slack/web-api';

/** Helper: clients object representing "tokens missing" — replaces null. */
function unconfiguredClients(): SlackClients {
  return {
    user: new WebClient('xoxp-not-configured'),
    tokenState: { accessToken: '' },
    lock: new RefreshLock(),
    _tokensStatus: 'missing',
  };
}

describe('channel-tools', () => {
  let mockClients: SlackClients;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClients = {
      user: {} as any,
      tokenState: { accessToken: 'xoxp-test' },
      lock: new RefreshLock(),
      _tokensStatus: 'present',
    };
  });

  describe('handleSendChannel', () => {
    it('sends message successfully', async () => {
      const mockResult = { ok: true, ts: '1234567890.123456', channel: 'C1234567890' };
      vi.mocked(client.sendChannel).mockResolvedValue(mockResult);

      const result = await handleSendChannel(mockClients, {
        channel: '#general',
        message: 'Hello, world!',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResult);
      expect(client.sendChannel).toHaveBeenCalledWith(mockClients, {
        channel: '#general',
        message: 'Hello, world!',
      });
    });

    it('sends message to channel by ID', async () => {
      const mockResult = { ok: true, ts: '1234567890.123456', channel: 'C1234567890' };
      vi.mocked(client.sendChannel).mockResolvedValue(mockResult);

      const result = await handleSendChannel(mockClients, {
        channel: 'C1234567890',
        message: 'Test message',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResult);
      expect(client.sendChannel).toHaveBeenCalledWith(mockClients, {
        channel: 'C1234567890',
        message: 'Test message',
      });
    });

    it('handles API errors', async () => {
      const error = new Error('channel_not_found');
      vi.mocked(client.sendChannel).mockRejectedValue(error);
      vi.mocked(client.formatSlackError).mockReturnValue('Channel not found in Slack.');

      const result = await handleSendChannel(mockClients, {
        channel: '#nonexistent',
        message: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'SEND_FAILED',
        message: 'Channel not found in Slack.',
      });
    });

    it('handles network errors', async () => {
      const error = new Error('Network error');
      vi.mocked(client.sendChannel).mockRejectedValue(error);
      vi.mocked(client.formatSlackError).mockReturnValue('Network error');

      const result = await handleSendChannel(mockClients, {
        channel: '#general',
        message: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'SEND_FAILED',
        message: 'Network error',
      });
    });

    it('handles authentication errors', async () => {
      const error = new Error('invalid_auth');
      vi.mocked(client.sendChannel).mockRejectedValue(error);
      vi.mocked(client.formatSlackError).mockReturnValue(
        withSetupGuidance('Authentication failed. Check your Slack tokens.')
      );

      const result = await handleSendChannel(mockClients, {
        channel: '#general',
        message: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SEND_FAILED');
      expect(result.error?.message).toContain('Authentication failed');
    });
  });

  describe('handleGetChannelMessages', () => {
    it('gets messages successfully with default limit', async () => {
      const mockMessages = [
        { user: 'U123', text: 'Hello', ts: '1234567890.123456', type: 'message' },
        { user: 'U456', text: 'World', ts: '1234567891.123456', type: 'message' },
      ];
      vi.mocked(client.readChannel).mockResolvedValue({ messages: mockMessages, has_more: false });

      const result = await handleGetChannelMessages(mockClients, {
        channel: '#general',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ messages: mockMessages, has_more: false });
      expect(client.readChannel).toHaveBeenCalledWith(mockClients, {
        channel: '#general',
      });
    });

    it('routes messages through author enrichment and returns the author field', async () => {
      const mockMessages = [
        { user: 'U123', text: 'Hello', ts: '1.0', type: 'message' },
        { user: 'UX', text: 'World', ts: '2.0', type: 'message' },
      ];
      vi.mocked(client.readChannel).mockResolvedValue({ messages: mockMessages, has_more: false });
      vi.mocked(enrichMessagesWithAuthors).mockImplementationOnce(async (_c, msgs) => {
        msgs[0].author = 'Paweł Kowalski';
        return msgs;
      });

      const result = await handleGetChannelMessages(mockClients, { channel: '#general' });

      expect(enrichMessagesWithAuthors).toHaveBeenCalledWith(mockClients, mockMessages);
      const data = result.data as { messages: { author?: string; user: string }[] };
      expect(data.messages[0].author).toBe('Paweł Kowalski');
      // Unresolvable ID stays raw — the read still succeeds.
      expect(data.messages[1].author).toBeUndefined();
      expect(data.messages[1].user).toBe('UX');
    });

    it('gets messages with custom limit', async () => {
      const mockMessages = Array.from({ length: 50 }, (_, i) => ({
        user: `U${i}`,
        text: `Message ${i}`,
        ts: `${1234567890 + i}.123456`,
        type: 'message',
      }));
      vi.mocked(client.readChannel).mockResolvedValue({ messages: mockMessages, has_more: false });

      const result = await handleGetChannelMessages(mockClients, {
        channel: '#general',
        limit: 50,
      });

      expect(result.success).toBe(true);
      expect((result.data as { messages: unknown[] })?.messages).toHaveLength(50);
      expect(client.readChannel).toHaveBeenCalledWith(mockClients, {
        channel: '#general',
        limit: 50,
      });
    });

    it('gets messages with time range filters', async () => {
      const mockMessages = [
        { user: 'U123', text: 'Recent', ts: '1234567890.123456', type: 'message' },
      ];
      vi.mocked(client.readChannel).mockResolvedValue({ messages: mockMessages, has_more: false });

      const result = await handleGetChannelMessages(mockClients, {
        channel: '#general',
        oldest: '1234567880.000000',
        latest: '1234567900.000000',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ messages: mockMessages, has_more: false });
      expect(client.readChannel).toHaveBeenCalledWith(mockClients, {
        channel: '#general',
        oldest: '1234567880.000000',
        latest: '1234567900.000000',
      });
    });

    it('returns empty array when no messages found', async () => {
      vi.mocked(client.readChannel).mockResolvedValue({ messages: [], has_more: false });

      const result = await handleGetChannelMessages(mockClients, {
        channel: '#general',
      });

      expect(result.success).toBe(true);
      expect((result.data as { messages: unknown[] })?.messages).toEqual([]);
    });

    it('handles channel not found error', async () => {
      const error = new Error('channel_not_found');
      vi.mocked(client.readChannel).mockRejectedValue(error);
      vi.mocked(client.formatSlackError).mockReturnValue('Channel not found in Slack.');

      const result = await handleGetChannelMessages(mockClients, {
        channel: '#nonexistent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'READ_FAILED',
        message: 'Channel not found in Slack.',
      });
    });

    it('handles permission errors', async () => {
      const error = new Error('missing_scope');
      vi.mocked(client.readChannel).mockRejectedValue(error);
      vi.mocked(client.formatSlackError).mockReturnValue(
        'Permission denied. Your Slack tokens may not have sufficient permissions.'
      );

      const result = await handleGetChannelMessages(mockClients, {
        channel: '#private-channel',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('READ_FAILED');
      expect(result.error?.message).toContain('Permission denied');
    });

    it('handles rate limit errors', async () => {
      const error = new Error('ratelimited');
      vi.mocked(client.readChannel).mockRejectedValue(error);
      vi.mocked(client.formatSlackError).mockReturnValue(
        'Rate limit exceeded. Please try again later.'
      );

      const result = await handleGetChannelMessages(mockClients, {
        channel: '#general',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('READ_FAILED');
      expect(result.error?.message).toContain('Rate limit exceeded');
    });
  });

  describe('handleGetThreadMessages', () => {
    it('routes thread messages through author enrichment', async () => {
      const mockMessages = [{ user: 'U123', text: 'parent', ts: '1.0', type: 'message' }];
      vi.mocked(client.readThread).mockResolvedValue({ messages: mockMessages, has_more: false });

      await handleGetThreadMessages(mockClients, { channel: 'C1', thread_ts: '1.0' });

      expect(enrichMessagesWithAuthors).toHaveBeenCalledWith(mockClients, mockMessages);
    });

    it('gets thread messages successfully', async () => {
      const mockPage = {
        messages: [
          { user: 'U1', text: 'parent', ts: '1.0', type: 'message', reply_count: 2 },
          { user: 'U2', text: 'reply', ts: '1.1', type: 'message', thread_ts: '1.0' },
        ],
        has_more: false,
      };
      vi.mocked(client.readThread).mockResolvedValue(mockPage);

      const result = await handleGetThreadMessages(mockClients, {
        channel: '#general',
        thread_ts: '1.0',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockPage);
      expect(client.readThread).toHaveBeenCalledWith(mockClients, {
        channel: '#general',
        thread_ts: '1.0',
      });
    });

    it('forwards cursor and limit', async () => {
      vi.mocked(client.readThread).mockResolvedValue({ messages: [], has_more: false });

      await handleGetThreadMessages(mockClients, {
        channel: 'C1',
        thread_ts: '1.0',
        limit: 10,
        cursor: 'cur-2',
      });

      expect(client.readThread).toHaveBeenCalledWith(mockClients, {
        channel: 'C1',
        thread_ts: '1.0',
        limit: 10,
        cursor: 'cur-2',
      });
    });

    it('returns READ_FAILED on errors', async () => {
      vi.mocked(client.readThread).mockRejectedValue(new Error('thread_not_found'));

      const result = await handleGetThreadMessages(mockClients, {
        channel: '#general',
        thread_ts: '9.9',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('READ_FAILED');
    });
  });

  describe('handleListChannelIds', () => {
    it('lists all channels successfully', async () => {
      const mockChannels = [
        { id: 'C123', name: 'general', is_channel: true, is_private: false, is_member: true },
        { id: 'C456', name: 'random', is_channel: true, is_private: false, is_member: true },
        { id: 'C789', name: 'private', is_channel: true, is_private: true, is_member: true },
      ];
      vi.mocked(client.getChannels).mockResolvedValue({ channels: mockChannels });

      const result = await handleListChannelIds(mockClients, {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        channels: [
          { id: 'C123', name: 'general', is_private: false },
          { id: 'C456', name: 'random', is_private: false },
          { id: 'C789', name: 'private', is_private: true },
        ],
        count: 3,
      });
      expect(client.getChannels).toHaveBeenCalledWith(mockClients, { types: undefined });
    });

    it('returns empty list when no channels found', async () => {
      vi.mocked(client.getChannels).mockResolvedValue({ channels: [] });

      const result = await handleListChannelIds(mockClients, {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        channels: [],
        count: 0,
      });
    });

    it('handles undefined channels in response', async () => {
      vi.mocked(client.getChannels).mockResolvedValue({ channels: undefined as any });

      const result = await handleListChannelIds(mockClients, {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        channels: [],
        count: 0,
      });
    });

    it('handles API errors', async () => {
      const error = new Error('invalid_auth');
      vi.mocked(client.getChannels).mockRejectedValue(error);
      vi.mocked(client.formatSlackError).mockReturnValue(
        withSetupGuidance('Authentication failed. Check your Slack tokens.')
      );

      const result = await handleListChannelIds(mockClients, {});

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'LIST_FAILED',
        message: withSetupGuidance('Authentication failed. Check your Slack tokens.'),
      });
    });

    it('handles network errors', async () => {
      const error = new Error('ECONNREFUSED');
      vi.mocked(client.getChannels).mockRejectedValue(error);
      vi.mocked(client.formatSlackError).mockReturnValue(
        'Network error. Cannot connect to Slack API.'
      );

      const result = await handleListChannelIds(mockClients, {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('LIST_FAILED');
      expect(result.error?.message).toContain('Network error');
    });

    it('filters and maps channel data correctly', async () => {
      const mockChannels = [
        {
          id: 'C123',
          name: 'general',
          is_channel: true,
          is_private: false,
          is_member: true,
          num_members: 42,
        },
      ];
      vi.mocked(client.getChannels).mockResolvedValue({ channels: mockChannels });

      const result = await handleListChannelIds(mockClients, {});

      expect(result.success).toBe(true);
      const data = result.data as {
        channels: Array<{ id: string; name: string; is_private: boolean }>;
      };
      expect(data?.channels[0]).toEqual({
        id: 'C123',
        name: 'general',
        is_private: false,
      });
      // Verify num_members is not included in the output
      expect(data?.channels[0]).not.toHaveProperty('num_members');
    });

    it('passes types parameter to getChannels', async () => {
      vi.mocked(client.getChannels).mockResolvedValue({ channels: [] });

      await handleListChannelIds(mockClients, { types: 'public_channel' });

      expect(client.getChannels).toHaveBeenCalledWith(mockClients, { types: 'public_channel' });
    });
  });
});

describe('createChannelTools (null clients — not configured)', () => {
  it('returns four tool definitions when clients are null', () => {
    const tools = createChannelTools(unconfiguredClients());
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.tool.name)).toEqual([
      'sendChannel',
      'getChannelMessages',
      'getThreadMessages',
      'listChannelIds',
    ]);
  });

  it('getThreadMessages handler returns NOT_CONFIGURED error when clients are null', async () => {
    const tools = createChannelTools(unconfiguredClients());
    const threadHandler = tools.find((t) => t.tool.name === 'getThreadMessages')!.handler;

    const result = await threadHandler({ channel: '#general', thread_ts: '1.0' });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.code).toBe('NOT_CONFIGURED');
  });

  it('sendChannel handler returns NOT_CONFIGURED error when clients are null', async () => {
    const tools = createChannelTools(unconfiguredClients());
    const sendHandler = tools.find((t) => t.tool.name === 'sendChannel')!.handler;

    const result = await sendHandler({ channel: '#general', message: 'hi' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.code).toBe('NOT_CONFIGURED');
    expect(parsed.message).toBeTruthy();
  });

  it('getChannelMessages handler returns NOT_CONFIGURED error when clients are null', async () => {
    const tools = createChannelTools(unconfiguredClients());
    const readHandler = tools.find((t) => t.tool.name === 'getChannelMessages')!.handler;

    const result = await readHandler({ channel: '#general' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.code).toBe('NOT_CONFIGURED');
  });

  it('listChannelIds handler returns NOT_CONFIGURED error when clients are null', async () => {
    const tools = createChannelTools(unconfiguredClients());
    const listHandler = tools.find((t) => t.tool.name === 'listChannelIds')!.handler;

    const result = await listHandler({});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.code).toBe('NOT_CONFIGURED');
  });
});

describe('createChannelTools (with clients — configured path)', () => {
  let mockClients: SlackClients;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClients = {
      user: {} as any,
      tokenState: { accessToken: 'xoxp-test' },
      lock: new RefreshLock(),
      _tokensStatus: 'present',
    };
  });

  it('sendChannel handler routes to handler when clients are configured', async () => {
    const mockResult = { ok: true, ts: '1234567890.123456', channel: 'C1234567890' };
    vi.mocked(client.sendChannel).mockResolvedValue(mockResult);

    const tools = createChannelTools(mockClients);
    const sendHandler = tools.find((t) => t.tool.name === 'sendChannel')!.handler;

    const result = await sendHandler({ channel: '#general', message: 'Hello!' });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed).toEqual(mockResult);
  });

  it('getChannelMessages handler routes to handler when clients are configured', async () => {
    const mockMessages = [{ user: 'U123', text: 'Hi', ts: '12345.67890', type: 'message' }];
    vi.mocked(client.readChannel).mockResolvedValue({ messages: mockMessages, has_more: false });

    const tools = createChannelTools(mockClients);
    const readHandler = tools.find((t) => t.tool.name === 'getChannelMessages')!.handler;

    const result = await readHandler({ channel: '#general' });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.messages).toEqual(mockMessages);
  });

  it('listChannelIds handler routes to handler when clients are configured', async () => {
    const mockChannels = [
      { id: 'C123', name: 'general', is_channel: true, is_private: false, is_member: true },
    ];
    vi.mocked(client.getChannels).mockResolvedValue({ channels: mockChannels });

    const tools = createChannelTools(mockClients);
    const listHandler = tools.find((t) => t.tool.name === 'listChannelIds')!.handler;

    const result = await listHandler({});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.channels).toHaveLength(1);
  });
});
