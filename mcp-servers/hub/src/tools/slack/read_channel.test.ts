import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './read_channel.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Slack Read Channel Tool
//
// Purpose: Test reading message history from Slack channels
// - Verify metadata (name, category, service, schema)
// - Test successful read scenarios
// - Test parameter validation
// - Test error handling
// - Test edge cases (limit clamping, defaults)
//═══════════════════════════════════════════════════════════════════════════════

describe('slack/read_channel', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('getChannelMessages');
    });

    it('should have correct category', () => {
      expect(metadata.category).toBe('read');
    });

    it('should have correct service', () => {
      expect(metadata.service).toBe('slack');
    });

    it('should have non-empty description', () => {
      expect(metadata.description).toBeTruthy();
      expect(typeof metadata.description).toBe('string');
      expect(metadata.description.length).toBeGreaterThan(0);
    });

    it('should have keywords array', () => {
      expect(Array.isArray(metadata.keywords)).toBe(true);
      expect(metadata.keywords.length).toBeGreaterThan(0);
      expect(metadata.keywords).toContain('slack');
      expect(metadata.keywords).toContain('read');
      expect(metadata.keywords).toContain('message');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['channel']);
    });

    it('should define channel in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const channelSchema = properties.channel;
      expect(channelSchema).toBeDefined();
      expect(channelSchema.type).toBe('string');
      expect(channelSchema.description).toBeTruthy();
    });

    it('should define limit in schema as optional', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const limitSchema = properties.limit;
      expect(limitSchema).toBeDefined();
      expect(limitSchema.type).toBe('number');
      expect(limitSchema.description).toBeTruthy();
      expect(metadata.inputSchema.required).not.toContain('limit');
    });

    it('should have valid outputSchema', () => {
      expect(metadata.outputSchema).toBeDefined();
      const outputSchema = metadata.outputSchema!;
      expect(outputSchema.type).toBe('object');
      expect(outputSchema.properties).toBeDefined();
      const outputProps = outputSchema.properties as Record<string, { type: string }>;
      expect(outputProps.success).toEqual({ type: 'boolean' });
      expect(outputSchema.required).toEqual(['success']);
    });

    it('should have example code', () => {
      expect(metadata.example).toBeTruthy();
      expect(typeof metadata.example).toBe('string');
      expect(metadata.example).toContain('slack.getChannelMessages');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.channel).toBeDefined();
      });
    });

    it('should have deferLoading enabled', () => {
      expect(metadata.deferLoading).toBe(true);
    });
  });

  describe('execute - success cases', () => {
    let mockSlack: { readChannel: ReturnType<typeof vi.fn> };

    const sampleMessages = [
      { user: 'U001', text: 'Hello everyone!', timestamp: '1234567890.000001' },
      { user: 'U002', text: 'Hi there!', timestamp: '1234567890.000002' },
    ];

    beforeEach(() => {
      mockSlack = {
        readChannel: vi.fn().mockResolvedValue({ messages: sampleMessages }),
      };
    });

    it('should read messages from channel by name', async () => {
      const params = { channel: '#general' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.messages).toEqual(sampleMessages);
      expect(mockSlack.readChannel).toHaveBeenCalledWith({ channel: '#general', limit: 20 });
      expect(mockSlack.readChannel).toHaveBeenCalledTimes(1);
    });

    it('should read messages from channel by ID', async () => {
      const params = { channel: 'C0123ABC456' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(result.messages).toEqual(sampleMessages);
      expect(mockSlack.readChannel).toHaveBeenCalledWith({ channel: 'C0123ABC456', limit: 20 });
    });

    it('should use custom limit', async () => {
      const params = { channel: '#general', limit: 50 };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.readChannel).toHaveBeenCalledWith({ channel: '#general', limit: 50 });
    });

    it('should default to 20 messages when no limit specified', async () => {
      const params = { channel: '#general' };

      await execute(params, { slack: mockSlack } as any);

      expect(mockSlack.readChannel).toHaveBeenCalledWith({ channel: '#general', limit: 20 });
    });

    it('should return empty array when no messages', async () => {
      mockSlack.readChannel.mockResolvedValue({});

      const params = { channel: '#empty-channel' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(result.messages).toEqual([]);
    });
  });

  describe('execute - parameter validation', () => {
    let mockSlack: { readChannel: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockSlack = {
        readChannel: vi.fn().mockResolvedValue({ messages: [] }),
      };
    });

    it('should fail when channel is missing', async () => {
      const params = {} as { channel: string };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: channel');
      expect(mockSlack.readChannel).not.toHaveBeenCalled();
    });

    it('should fail when channel is empty string', async () => {
      const params = { channel: '' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: channel');
      expect(mockSlack.readChannel).not.toHaveBeenCalled();
    });

    it('should fail when channel is null', async () => {
      const params = { channel: null as unknown as string };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: channel');
      expect(mockSlack.readChannel).not.toHaveBeenCalled();
    });

    it('should fail when channel is undefined', async () => {
      const params = { channel: undefined as unknown as string };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: channel');
      expect(mockSlack.readChannel).not.toHaveBeenCalled();
    });
  });

  describe('execute - limit clamping', () => {
    let mockSlack: { readChannel: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockSlack = {
        readChannel: vi.fn().mockResolvedValue({ messages: [] }),
      };
    });

    it('should clamp limit to maximum of 100', async () => {
      const params = { channel: '#general', limit: 500 };

      await execute(params, { slack: mockSlack } as any);

      expect(mockSlack.readChannel).toHaveBeenCalledWith({ channel: '#general', limit: 100 });
    });

    it('should clamp limit to minimum of 1', async () => {
      const params = { channel: '#general', limit: 0 };

      await execute(params, { slack: mockSlack } as any);

      expect(mockSlack.readChannel).toHaveBeenCalledWith({ channel: '#general', limit: 1 });
    });

    it('should clamp negative limit to 1', async () => {
      const params = { channel: '#general', limit: -10 };

      await execute(params, { slack: mockSlack } as any);

      expect(mockSlack.readChannel).toHaveBeenCalledWith({ channel: '#general', limit: 1 });
    });

    it('should accept limit at boundary 1', async () => {
      const params = { channel: '#general', limit: 1 };

      await execute(params, { slack: mockSlack } as any);

      expect(mockSlack.readChannel).toHaveBeenCalledWith({ channel: '#general', limit: 1 });
    });

    it('should accept limit at boundary 100', async () => {
      const params = { channel: '#general', limit: 100 };

      await execute(params, { slack: mockSlack } as any);

      expect(mockSlack.readChannel).toHaveBeenCalledWith({ channel: '#general', limit: 100 });
    });
  });

  describe('execute - error scenarios', () => {
    let mockSlack: { readChannel: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockSlack = {
        readChannel: vi.fn(),
      };
    });

    it('should handle Error thrown', async () => {
      const error = new Error('channel_not_found');
      mockSlack.readChannel.mockRejectedValue(error);

      const params = { channel: '#nonexistent' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('channel_not_found');
    });

    it('should handle non-Error thrown as Unknown error', async () => {
      mockSlack.readChannel.mockRejectedValue({ code: 'rate_limited' });

      const params = { channel: '#general' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle string thrown as Unknown error', async () => {
      mockSlack.readChannel.mockRejectedValue('connection_failed');

      const params = { channel: '#general' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle undefined thrown as Unknown error', async () => {
      mockSlack.readChannel.mockRejectedValue(undefined);

      const params = { channel: '#general' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockSlack.readChannel.mockRejectedValue(error);

      const params = { channel: '#general' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });

    it('should handle permission denied error', async () => {
      const error = new Error('not_in_channel');
      mockSlack.readChannel.mockRejectedValue(error);

      const params = { channel: '#private' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('not_in_channel');
    });
  });

  describe('execute - edge cases', () => {
    let mockSlack: { readChannel: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockSlack = {
        readChannel: vi.fn().mockResolvedValue({ messages: [] }),
      };
    });

    it('should handle channel name without hash prefix', async () => {
      const params = { channel: 'general' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.readChannel).toHaveBeenCalledWith({ channel: 'general', limit: 20 });
    });

    it('should handle channel with hyphenated name', async () => {
      const params = { channel: '#dev-ops-alerts' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.readChannel).toHaveBeenCalledWith({
        channel: '#dev-ops-alerts',
        limit: 20,
      });
    });

    it('should handle response with messages array containing no messages field', async () => {
      mockSlack.readChannel.mockResolvedValue({ other: 'data' });

      const params = { channel: '#general' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(result.messages).toEqual([]);
    });
  });
});
