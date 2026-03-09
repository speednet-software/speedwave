import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './send_channel.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Slack Send Channel Tool
//
// Purpose: Test sending messages to Slack channels
// - Verify metadata (name, category, service, schema)
// - Test successful message sending scenarios
// - Test parameter validation
// - Test error handling
// - Test edge cases
//═══════════════════════════════════════════════════════════════════════════════

describe('slack/send_channel', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('sendChannel');
    });

    it('should have correct category', () => {
      expect(metadata.category).toBe('write');
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
      expect(metadata.keywords).toContain('send');
      expect(metadata.keywords).toContain('message');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['channel', 'message']);
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

    it('should define message in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const messageSchema = properties.message;
      expect(messageSchema).toBeDefined();
      expect(messageSchema.type).toBe('string');
      expect(messageSchema.description).toBeTruthy();
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
      expect(metadata.example).toContain('slack.sendChannel');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.channel).toBeDefined();
        expect(example.input.message).toBeDefined();
      });
    });

    it('should have deferLoading disabled', () => {
      expect(metadata.deferLoading).toBe(false);
    });
  });

  describe('execute - success cases', () => {
    let mockSlack: { sendChannel: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockSlack = {
        sendChannel: vi.fn().mockResolvedValue({ ts: '1234567890.123456' }),
      };
    });

    it('should send message to channel by name', async () => {
      const params = {
        channel: '#general',
        message: 'Hello team!',
      };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.timestamp).toBe('1234567890.123456');
      expect(mockSlack.sendChannel).toHaveBeenCalledWith(params);
      expect(mockSlack.sendChannel).toHaveBeenCalledTimes(1);
    });

    it('should send message to channel by ID', async () => {
      const params = {
        channel: 'C0123ABC456',
        message: 'Deployment completed!',
      };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(result.timestamp).toBe('1234567890.123456');
      expect(mockSlack.sendChannel).toHaveBeenCalledWith(params);
    });

    it('should use ISO timestamp when response has no ts', async () => {
      mockSlack.sendChannel.mockResolvedValue({});

      const params = {
        channel: '#general',
        message: 'Hello!',
      };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(result.timestamp).toBeTruthy();
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should send message with emoji', async () => {
      const params = {
        channel: '#general',
        message: 'Release complete! :rocket:',
      };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.sendChannel).toHaveBeenCalledWith(params);
    });

    it('should send multiline message', async () => {
      const params = {
        channel: '#engineering',
        message: 'Line 1\nLine 2\nLine 3',
      };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.sendChannel).toHaveBeenCalledWith(params);
    });
  });

  describe('execute - parameter validation', () => {
    let mockSlack: { sendChannel: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockSlack = {
        sendChannel: vi.fn().mockResolvedValue({ ts: '1234567890.123456' }),
      };
    });

    it('should fail when channel is missing', async () => {
      const params = {
        message: 'Hello!',
      } as { channel: string; message: string };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: channel, message');
      expect(mockSlack.sendChannel).not.toHaveBeenCalled();
    });

    it('should fail when message is missing', async () => {
      const params = {
        channel: '#general',
      } as { channel: string; message: string };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: channel, message');
      expect(mockSlack.sendChannel).not.toHaveBeenCalled();
    });

    it('should fail when both parameters are missing', async () => {
      const params = {} as { channel: string; message: string };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: channel, message');
      expect(mockSlack.sendChannel).not.toHaveBeenCalled();
    });

    it('should fail when channel is empty string', async () => {
      const params = {
        channel: '',
        message: 'Hello!',
      };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: channel, message');
      expect(mockSlack.sendChannel).not.toHaveBeenCalled();
    });

    it('should fail when message is empty string', async () => {
      const params = {
        channel: '#general',
        message: '',
      };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: channel, message');
      expect(mockSlack.sendChannel).not.toHaveBeenCalled();
    });

    it('should fail when channel is null', async () => {
      const params = {
        channel: null as unknown as string,
        message: 'Hello!',
      };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: channel, message');
      expect(mockSlack.sendChannel).not.toHaveBeenCalled();
    });

    it('should fail when message is null', async () => {
      const params = {
        channel: '#general',
        message: null as unknown as string,
      };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: channel, message');
      expect(mockSlack.sendChannel).not.toHaveBeenCalled();
    });

    it('should fail when channel is undefined', async () => {
      const params = {
        channel: undefined as unknown as string,
        message: 'Hello!',
      };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: channel, message');
      expect(mockSlack.sendChannel).not.toHaveBeenCalled();
    });

    it('should fail when message is undefined', async () => {
      const params = {
        channel: '#general',
        message: undefined as unknown as string,
      };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required fields: channel, message');
      expect(mockSlack.sendChannel).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockSlack: { sendChannel: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockSlack = {
        sendChannel: vi.fn(),
      };
    });

    it('should handle Error thrown', async () => {
      const error = new Error('channel_not_found');
      mockSlack.sendChannel.mockRejectedValue(error);

      const params = { channel: '#nonexistent', message: 'Hello!' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('channel_not_found');
    });

    it('should handle non-Error thrown as Unknown error', async () => {
      mockSlack.sendChannel.mockRejectedValue({ code: 'rate_limited' });

      const params = { channel: '#general', message: 'Hello!' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle string thrown as Unknown error', async () => {
      mockSlack.sendChannel.mockRejectedValue('connection_failed');

      const params = { channel: '#general', message: 'Hello!' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle undefined thrown as Unknown error', async () => {
      mockSlack.sendChannel.mockRejectedValue(undefined);

      const params = { channel: '#general', message: 'Hello!' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockSlack.sendChannel.mockRejectedValue(error);

      const params = { channel: '#general', message: 'Hello!' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });

    it('should handle permission denied error', async () => {
      const error = new Error('not_in_channel');
      mockSlack.sendChannel.mockRejectedValue(error);

      const params = { channel: '#restricted', message: 'Hello!' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('not_in_channel');
    });

    it('should handle network error', async () => {
      const error = new Error('Connection timeout');
      mockSlack.sendChannel.mockRejectedValue(error);

      const params = { channel: '#general', message: 'Hello!' };
      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection timeout');
    });
  });

  describe('execute - edge cases', () => {
    let mockSlack: { sendChannel: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockSlack = {
        sendChannel: vi.fn().mockResolvedValue({ ts: '1234567890.123456' }),
      };
    });

    it('should handle channel name without hash prefix', async () => {
      const params = { channel: 'general', message: 'Hello!' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.sendChannel).toHaveBeenCalledWith(params);
    });

    it('should handle very long message', async () => {
      const params = { channel: '#general', message: 'A'.repeat(10000) };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.sendChannel).toHaveBeenCalledWith(params);
    });

    it('should handle message with special characters', async () => {
      const params = { channel: '#general', message: '<script>alert("xss")</script> & "quotes"' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.sendChannel).toHaveBeenCalledWith(params);
    });

    it('should handle message with Slack formatting', async () => {
      const params = { channel: '#general', message: '*bold* _italic_ ~strikethrough~ `code`' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.sendChannel).toHaveBeenCalledWith(params);
    });

    it('should handle message with user mentions', async () => {
      const params = { channel: '#general', message: 'Hey <@U0123ABC> check this out' };

      const result = await execute(params, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(mockSlack.sendChannel).toHaveBeenCalledWith(params);
    });
  });
});
