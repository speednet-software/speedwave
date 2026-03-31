/**
 * Channel Tools Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleSendChannel,
  handleGetChannelMessages,
  handleListChannelIds,
} from './channel-tools.js';
import type { SlackClients } from '../client.js';

// Mock the client module
vi.mock('../client.js', async () => {
  const actual = await vi.importActual('../client.js');
  return {
    ...actual,
    sendChannel: vi.fn(),
    readChannel: vi.fn(),
    getChannels: vi.fn(),
    formatSlackError: vi.fn((error: unknown) => {
      const e = error as { message?: string };
      return e.message || 'Unknown error';
    }),
  };
});

import * as client from '../client.js';

describe('channel-tools', () => {
  let mockClients: SlackClients;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClients = {
      bot: {} as any,
      user: {} as any,
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
        'Authentication failed. Check your Slack tokens. Configure this integration in the Speedwave Desktop app (Integrations tab).'
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
      vi.mocked(client.readChannel).mockResolvedValue({ messages: mockMessages });

      const result = await handleGetChannelMessages(mockClients, {
        channel: '#general',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ messages: mockMessages });
      expect(client.readChannel).toHaveBeenCalledWith(mockClients, {
        channel: '#general',
      });
    });

    it('gets messages with custom limit', async () => {
      const mockMessages = Array.from({ length: 50 }, (_, i) => ({
        user: `U${i}`,
        text: `Message ${i}`,
        ts: `${1234567890 + i}.123456`,
        type: 'message',
      }));
      vi.mocked(client.readChannel).mockResolvedValue({ messages: mockMessages });

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
      vi.mocked(client.readChannel).mockResolvedValue({ messages: mockMessages });

      const result = await handleGetChannelMessages(mockClients, {
        channel: '#general',
        oldest: '1234567880.000000',
        latest: '1234567900.000000',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ messages: mockMessages });
      expect(client.readChannel).toHaveBeenCalledWith(mockClients, {
        channel: '#general',
        oldest: '1234567880.000000',
        latest: '1234567900.000000',
      });
    });

    it('returns empty array when no messages found', async () => {
      vi.mocked(client.readChannel).mockResolvedValue({ messages: [] });

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
        'Authentication failed. Check your Slack tokens. Configure this integration in the Speedwave Desktop app (Integrations tab).'
      );

      const result = await handleListChannelIds(mockClients, {});

      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'LIST_FAILED',
        message:
          'Authentication failed. Check your Slack tokens. Configure this integration in the Speedwave Desktop app (Integrations tab).',
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
