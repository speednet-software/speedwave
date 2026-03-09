import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './get_channels.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Slack Get Channels Tool
//
// Purpose: Test listing channels the user is a member of
// - Verify metadata (name, category, service, schema)
// - Test successful listing scenarios
// - Test error handling
// - Test edge cases
//═══════════════════════════════════════════════════════════════════════════════

describe('slack/get_channels', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('listChannelIds');
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
      expect(metadata.keywords).toContain('channels');
      expect(metadata.keywords).toContain('list');
    });

    it('should have valid inputSchema with no required properties', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toBeUndefined();
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
      expect(metadata.example).toContain('slack.listChannelIds');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
      });
    });

    it('should have deferLoading disabled', () => {
      expect(metadata.deferLoading).toBe(false);
    });
  });

  describe('execute - success cases', () => {
    let mockSlack: { getChannels: ReturnType<typeof vi.fn> };

    const sampleChannels = [
      { id: 'C001', name: 'general', is_private: false, is_member: true },
      { id: 'C002', name: 'engineering', is_private: false, is_member: true },
      { id: 'C003', name: 'secret-ops', is_private: true, is_member: true },
    ];

    beforeEach(() => {
      mockSlack = {
        getChannels: vi.fn().mockResolvedValue({ channels: sampleChannels }),
      };
    });

    it('should list all channels', async () => {
      const result = await execute({}, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.channels).toEqual(sampleChannels);
      expect(mockSlack.getChannels).toHaveBeenCalledWith({});
      expect(mockSlack.getChannels).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no channels', async () => {
      mockSlack.getChannels.mockResolvedValue({});

      const result = await execute({}, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(result.channels).toEqual([]);
    });

    it('should return empty array when channels field is missing', async () => {
      mockSlack.getChannels.mockResolvedValue({ other: 'data' });

      const result = await execute({}, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(result.channels).toEqual([]);
    });

    it('should handle single channel', async () => {
      const singleChannel = [
        { id: 'C001', name: 'only-channel', is_private: false, is_member: true },
      ];
      mockSlack.getChannels.mockResolvedValue({ channels: singleChannel });

      const result = await execute({}, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(result.channels).toEqual(singleChannel);
    });

    it('should handle large number of channels', async () => {
      const manyChannels = Array.from({ length: 100 }, (_, i) => ({
        id: `C${i.toString().padStart(3, '0')}`,
        name: `channel-${i}`,
        is_private: i % 3 === 0,
        is_member: true,
      }));
      mockSlack.getChannels.mockResolvedValue({ channels: manyChannels });

      const result = await execute({}, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(result.channels).toHaveLength(100);
    });
  });

  describe('execute - error scenarios', () => {
    let mockSlack: { getChannels: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockSlack = {
        getChannels: vi.fn(),
      };
    });

    it('should handle Error thrown', async () => {
      const error = new Error('token_revoked');
      mockSlack.getChannels.mockRejectedValue(error);

      const result = await execute({}, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('token_revoked');
    });

    it('should handle non-Error thrown as Unknown error', async () => {
      mockSlack.getChannels.mockRejectedValue({ code: 'invalid_auth' });

      const result = await execute({}, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle string thrown as Unknown error', async () => {
      mockSlack.getChannels.mockRejectedValue('api_error');

      const result = await execute({}, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle undefined thrown as Unknown error', async () => {
      mockSlack.getChannels.mockRejectedValue(undefined);

      const result = await execute({}, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockSlack.getChannels.mockRejectedValue(error);

      const result = await execute({}, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });

    it('should handle network error', async () => {
      const error = new Error('ECONNREFUSED');
      mockSlack.getChannels.mockRejectedValue(error);

      const result = await execute({}, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
    });

    it('should handle rate limit error', async () => {
      const error = new Error('rate_limited');
      mockSlack.getChannels.mockRejectedValue(error);

      const result = await execute({}, { slack: mockSlack } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('rate_limited');
    });
  });

  describe('execute - edge cases', () => {
    let mockSlack: { getChannels: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockSlack = {
        getChannels: vi.fn().mockResolvedValue({ channels: [] }),
      };
    });

    it('should pass empty object as params to service', async () => {
      await execute({}, { slack: mockSlack } as any);

      expect(mockSlack.getChannels).toHaveBeenCalledWith({});
    });

    it('should ignore extra params passed', async () => {
      await execute({ extra: 'ignored' } as any, { slack: mockSlack } as any);

      expect(mockSlack.getChannels).toHaveBeenCalledWith({});
    });

    it('should handle channels with special characters in names', async () => {
      const channels = [
        { id: 'C001', name: 'dev-ops-2024', is_private: false, is_member: true },
        { id: 'C002', name: 'team_alpha', is_private: true, is_member: true },
      ];
      mockSlack.getChannels.mockResolvedValue({ channels });

      const result = await execute({}, { slack: mockSlack } as any);

      expect(result.success).toBe(true);
      expect(result.channels).toEqual(channels);
    });
  });
});
