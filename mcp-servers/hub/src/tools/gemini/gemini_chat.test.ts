import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metadata, execute } from './gemini_chat.js';

//═══════════════════════════════════════════════════════════════════════════════
// Tests for Gemini Chat Tool
//
// Purpose: Test Gemini AI chat/analysis functionality
// - Verify metadata (name, category, service, schema)
// - Test successful chat scenarios
// - Test parameter validation
// - Test error handling (Error, string, object, unexpected types)
// - Test edge cases
//═══════════════════════════════════════════════════════════════════════════════

describe('gemini/gemini_chat', () => {
  describe('metadata', () => {
    it('should have correct tool name', () => {
      expect(metadata.name).toBe('chat');
    });

    it('should have correct category', () => {
      expect(metadata.category).toBe('read');
    });

    it('should have correct service', () => {
      expect(metadata.service).toBe('gemini');
    });

    it('should have non-empty description', () => {
      expect(metadata.description).toBeTruthy();
      expect(typeof metadata.description).toBe('string');
      expect(metadata.description.length).toBeGreaterThan(0);
    });

    it('should have keywords array', () => {
      expect(Array.isArray(metadata.keywords)).toBe(true);
      expect(metadata.keywords.length).toBeGreaterThan(0);
      expect(metadata.keywords).toContain('gemini');
      expect(metadata.keywords).toContain('chat');
      expect(metadata.keywords).toContain('search');
    });

    it('should have valid inputSchema', () => {
      expect(metadata.inputSchema).toBeDefined();
      expect(metadata.inputSchema.type).toBe('object');
      expect(metadata.inputSchema.properties).toBeDefined();
      expect(metadata.inputSchema.required).toEqual(['prompt']);
    });

    it('should define prompt in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const promptSchema = properties.prompt;
      expect(promptSchema).toBeDefined();
      expect(promptSchema.type).toBe('string');
      expect(promptSchema.description).toBeTruthy();
    });

    it('should define context as optional in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const contextSchema = properties.context;
      expect(contextSchema).toBeDefined();
      expect(contextSchema.type).toBe('string');
      expect(metadata.inputSchema.required).not.toContain('context');
    });

    it('should define useGrounding as optional boolean in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      const groundingSchema = properties.useGrounding;
      expect(groundingSchema).toBeDefined();
      expect(groundingSchema.type).toBe('boolean');
      expect(metadata.inputSchema.required).not.toContain('useGrounding');
    });

    it('should define outputFormat as optional enum in schema', () => {
      const properties = metadata.inputSchema.properties as Record<
        string,
        { type: string; enum?: string[]; description: string }
      >;
      const formatSchema = properties.outputFormat;
      expect(formatSchema).toBeDefined();
      expect(formatSchema.type).toBe('string');
      expect(formatSchema.enum).toEqual(['text', 'json', 'markdown']);
      expect(metadata.inputSchema.required).not.toContain('outputFormat');
    });

    it('should have valid outputSchema', () => {
      expect(metadata.outputSchema).toBeDefined();
      const outputSchema = metadata.outputSchema!;
      expect(outputSchema.type).toBe('object');
      expect(outputSchema.properties).toBeDefined();
      const outputProps = outputSchema.properties as Record<string, { type: string }>;
      expect(outputProps.success.type).toBe('boolean');
      expect(outputSchema.required).toEqual(['success']);
    });

    it('should have example code', () => {
      expect(metadata.example).toBeTruthy();
      expect(typeof metadata.example).toBe('string');
      expect(metadata.example).toContain('gemini.chat');
    });

    it('should have input examples', () => {
      expect(Array.isArray(metadata.inputExamples)).toBe(true);
      const inputExamples = metadata.inputExamples!;
      expect(inputExamples.length).toBeGreaterThan(0);
      inputExamples.forEach((example) => {
        expect(example.description).toBeTruthy();
        expect(example.input).toBeDefined();
        expect(example.input.prompt).toBeDefined();
      });
    });

    it('should have deferLoading disabled', () => {
      expect(metadata.deferLoading).toBe(false);
    });

    it('should have timeoutClass set to long', () => {
      expect(metadata.timeoutClass).toBe('long');
    });
  });

  describe('execute - success cases', () => {
    let mockGemini: { chat: ReturnType<typeof vi.fn> };

    const sampleResult = {
      analysis: 'This is the answer to your question.',
      format: 'text',
    };

    beforeEach(() => {
      mockGemini = {
        chat: vi.fn().mockResolvedValue(sampleResult),
      };
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should handle simple prompt', async () => {
      const params = { prompt: 'What is TypeScript?' };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual(sampleResult);
      expect(mockGemini.chat).toHaveBeenCalledWith(params);
      expect(mockGemini.chat).toHaveBeenCalledTimes(1);
    });

    it('should handle prompt with context', async () => {
      const params = {
        prompt: 'Find gaps in these requirements',
        context: '## REQ-001\nUser login\n## REQ-002\nPassword reset',
      };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(true);
      expect(mockGemini.chat).toHaveBeenCalledWith(params);
    });

    it('should handle prompt with useGrounding enabled', async () => {
      const params = {
        prompt: 'Who won the latest Nobel Prize in Physics?',
        useGrounding: true,
      };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(true);
      expect(mockGemini.chat).toHaveBeenCalledWith(params);
    });

    it('should handle prompt with outputFormat', async () => {
      const params = {
        prompt: 'Summarize this document',
        context: 'Some document content...',
        outputFormat: 'markdown',
      };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(true);
      expect(mockGemini.chat).toHaveBeenCalledWith(params);
    });

    it('should handle all parameters together', async () => {
      const params = {
        prompt: 'Analyze this',
        context: 'Content to analyze',
        useGrounding: true,
        outputFormat: 'json',
      };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(true);
      expect(mockGemini.chat).toHaveBeenCalledWith(params);
    });

    it('should pass params directly to service', async () => {
      const params = { prompt: 'Test question' };

      await execute(params, { gemini: mockGemini } as any);

      expect(mockGemini.chat).toHaveBeenCalledWith(params);
    });
  });

  describe('execute - parameter validation', () => {
    let mockGemini: { chat: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGemini = {
        chat: vi.fn().mockResolvedValue({}),
      };
    });

    it('should fail when prompt is missing', async () => {
      const params = {} as { prompt: string };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: prompt');
      expect(mockGemini.chat).not.toHaveBeenCalled();
    });

    it('should fail when prompt is empty string', async () => {
      const params = { prompt: '' };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: prompt');
      expect(mockGemini.chat).not.toHaveBeenCalled();
    });

    it('should fail when prompt is null', async () => {
      const params = { prompt: null as unknown as string };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: prompt');
      expect(mockGemini.chat).not.toHaveBeenCalled();
    });

    it('should fail when prompt is undefined', async () => {
      const params = { prompt: undefined as unknown as string };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing required field: prompt');
      expect(mockGemini.chat).not.toHaveBeenCalled();
    });
  });

  describe('execute - error scenarios', () => {
    let mockGemini: { chat: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGemini = {
        chat: vi.fn(),
      };
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should handle Error thrown', async () => {
      const error = new Error('Gemini API quota exceeded');
      mockGemini.chat.mockRejectedValue(error);

      const params = { prompt: 'Test question' };
      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Gemini API quota exceeded');
    });

    it('should handle non-Error thrown objects with JSON.stringify', async () => {
      const error = { code: 'RATE_LIMITED', details: 'Too many requests' };
      mockGemini.chat.mockRejectedValue(error);

      const params = { prompt: 'Test question' };
      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('RATE_LIMITED');
      expect(result.error).toContain('Too many requests');
    });

    it('should handle string thrown errors', async () => {
      mockGemini.chat.mockRejectedValue('Service unavailable');

      const params = { prompt: 'Test question' };
      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Service unavailable');
    });

    it('should handle undefined thrown errors', async () => {
      mockGemini.chat.mockRejectedValue(undefined);

      const params = { prompt: 'Test question' };
      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unexpected error type: undefined');
    });

    it('should handle null thrown errors', async () => {
      mockGemini.chat.mockRejectedValue(null);

      const params = { prompt: 'Test question' };
      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unexpected error type: object');
    });

    it('should handle errors with empty message', async () => {
      const error = new Error('');
      mockGemini.chat.mockRejectedValue(error);

      const params = { prompt: 'Test question' };
      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('');
    });

    it('should handle network timeout error', async () => {
      const error = new Error('Request timeout after 30000ms');
      mockGemini.chat.mockRejectedValue(error);

      const params = { prompt: 'Complex analysis' };
      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Request timeout after 30000ms');
    });

    it('should handle number thrown errors', async () => {
      mockGemini.chat.mockRejectedValue(42);

      const params = { prompt: 'Test question' };
      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unexpected error type: number');
    });

    it('should log error to console on failure', async () => {
      const error = new Error('API error');
      mockGemini.chat.mockRejectedValue(error);

      const params = { prompt: 'Test question', context: 'Some context' };
      await execute(params, { gemini: mockGemini } as any);

      expect(console.error).toHaveBeenCalled();
    });

    it('should handle empty object thrown', async () => {
      mockGemini.chat.mockRejectedValue({});

      const params = { prompt: 'Test question' };
      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(false);
      expect(result.error).toBe('{}');
    });
  });

  describe('execute - edge cases', () => {
    let mockGemini: { chat: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockGemini = {
        chat: vi.fn().mockResolvedValue({ analysis: 'Result', format: 'text' }),
      };
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('should handle very long prompt', async () => {
      const params = { prompt: 'A'.repeat(10000) };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(true);
      expect(mockGemini.chat).toHaveBeenCalledWith(params);
    });

    it('should handle very long context', async () => {
      const params = {
        prompt: 'Analyze this',
        context: 'B'.repeat(50000),
      };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(true);
      expect(mockGemini.chat).toHaveBeenCalledWith(params);
    });

    it('should handle prompt with special characters', async () => {
      const params = { prompt: 'What is <html> & "quotes" in JS?' };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(true);
      expect(mockGemini.chat).toHaveBeenCalledWith(params);
    });

    it('should handle prompt with unicode characters', async () => {
      const params = { prompt: 'Co to jest przyczlap?' };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(true);
      expect(mockGemini.chat).toHaveBeenCalledWith(params);
    });

    it('should handle prompt with newlines', async () => {
      const params = { prompt: 'Line 1\nLine 2\nLine 3' };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(true);
      expect(mockGemini.chat).toHaveBeenCalledWith(params);
    });

    it('should handle useGrounding as false explicitly', async () => {
      const params = { prompt: 'Question', useGrounding: false };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(true);
      expect(mockGemini.chat).toHaveBeenCalledWith(params);
    });

    it('should handle outputFormat text', async () => {
      const params = { prompt: 'Question', outputFormat: 'text' };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(true);
      expect(mockGemini.chat).toHaveBeenCalledWith(params);
    });

    it('should handle outputFormat json', async () => {
      const params = { prompt: 'Question', outputFormat: 'json' };

      const result = await execute(params, { gemini: mockGemini } as any);

      expect(result.success).toBe(true);
      expect(mockGemini.chat).toHaveBeenCalledWith(params);
    });
  });
});
