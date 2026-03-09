/**
 * Chat Tools Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleChat } from './chat-tools.js';
import { GeminiClient, ChatParams } from '../client.js';

describe('chat-tools', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const createMockClient = () => ({
    chat: vi.fn(),
  });

  describe('handleChat', () => {
    describe('configuration validation', () => {
      it('returns error when client is null', async () => {
        const result = await handleChat(null, { prompt: 'test' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('NOT_CONFIGURED');
        expect(result.error?.message).toContain('speedwave setup gemini');
      });
    });

    describe('input validation', () => {
      it('returns error when prompt is missing', async () => {
        const mockClient = createMockClient() as unknown as GeminiClient;
        const result = await handleChat(mockClient, {} as ChatParams);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_INPUT');
        expect(result.error?.message).toContain('prompt is required');
      });

      it('returns error when prompt is not a string', async () => {
        const mockClient = createMockClient() as unknown as GeminiClient;
        const result = await handleChat(mockClient, { prompt: 123 } as unknown as ChatParams);

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_INPUT');
        expect(result.error?.message).toContain('must be a string');
      });

      it('returns error when prompt is empty string', async () => {
        const mockClient = createMockClient() as unknown as GeminiClient;
        const result = await handleChat(mockClient, { prompt: '' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('INVALID_INPUT');
      });

      it('accepts valid prompt', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockResolvedValue('Response');

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'What is TypeScript?',
        });

        expect(result.success).toBe(true);
        expect(mockClient.chat).toHaveBeenCalledWith({ prompt: 'What is TypeScript?' });
      });
    });

    describe('successful chat responses', () => {
      it('returns chat response successfully with minimal params', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockResolvedValue('TypeScript is a typed superset of JavaScript');

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'What is TypeScript?',
        });

        expect(result.success).toBe(true);
        expect(result.data).toBe('TypeScript is a typed superset of JavaScript');
        expect(mockClient.chat).toHaveBeenCalledWith({ prompt: 'What is TypeScript?' });
      });

      it('passes all parameters to client.chat', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockResolvedValue('Analysis result');

        const params: ChatParams = {
          prompt: 'Analyze this code',
          context: 'function test() { return true; }',
          useGrounding: true,
          outputFormat: 'json',
        };

        const result = await handleChat(mockClient as unknown as GeminiClient, params);

        expect(result.success).toBe(true);
        expect(result.data).toBe('Analysis result');
        expect(mockClient.chat).toHaveBeenCalledWith(params);
      });

      it('handles context parameter correctly', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockResolvedValue('Context analyzed');

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'Summarize this',
          context: 'Long text content here...',
        });

        expect(result.success).toBe(true);
        expect(mockClient.chat).toHaveBeenCalledWith({
          prompt: 'Summarize this',
          context: 'Long text content here...',
        });
      });

      it('handles useGrounding parameter correctly', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockResolvedValue('Current information');

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'Latest news about AI',
          useGrounding: true,
        });

        expect(result.success).toBe(true);
        expect(mockClient.chat).toHaveBeenCalledWith({
          prompt: 'Latest news about AI',
          useGrounding: true,
        });
      });

      it('handles outputFormat parameter correctly', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockResolvedValue('{"result": "data"}');

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'Get data',
          outputFormat: 'json',
        });

        expect(result.success).toBe(true);
        expect(mockClient.chat).toHaveBeenCalledWith({
          prompt: 'Get data',
          outputFormat: 'json',
        });
      });

      it('handles markdown output format', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockResolvedValue('# Result\n\nContent');

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'Format as markdown',
          outputFormat: 'markdown',
        });

        expect(result.success).toBe(true);
        expect(result.data).toBe('# Result\n\nContent');
      });
    });

    describe('error handling', () => {
      it('handles generic API errors', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockRejectedValue(new Error('Unknown API error'));

        vi.spyOn(GeminiClient, 'formatError').mockReturnValue('Unknown API error');

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'test',
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('GEMINI_ERROR');
        expect(result.error?.message).toBe('Unknown API error');
      });

      it('handles rate limit errors', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockRejectedValue(new Error('Rate limit exceeded'));

        vi.spyOn(GeminiClient, 'formatError').mockReturnValue(
          'Rate limit exceeded. Please try again later.'
        );

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'test',
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('GEMINI_ERROR');
        expect(result.error?.message).toContain('Rate limit exceeded');
      });

      it('handles quota exceeded errors', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockRejectedValue(new Error('Quota exceeded'));

        vi.spyOn(GeminiClient, 'formatError').mockReturnValue(
          'Daily quota exceeded for this model. Try again tomorrow or use a different model.'
        );

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'test',
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('GEMINI_ERROR');
        expect(result.error?.message).toContain('quota exceeded');
      });

      it('handles invalid API key errors', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockRejectedValue(new Error('401 Unauthorized'));

        vi.spyOn(GeminiClient, 'formatError').mockReturnValue(
          'Authentication failed. Check your Gemini API key. Run: speedwave setup gemini'
        );

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'test',
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('GEMINI_ERROR');
        expect(result.error?.message).toContain('Authentication failed');
      });

      it('handles network errors', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockRejectedValue(new Error('ECONNREFUSED'));

        vi.spyOn(GeminiClient, 'formatError').mockReturnValue(
          'Network error. Cannot connect to Gemini API.'
        );

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'test',
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('GEMINI_ERROR');
        expect(result.error?.message).toContain('Network error');
      });

      it('handles client not initialized error', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockRejectedValue(new Error('Gemini client not initialized'));

        vi.spyOn(GeminiClient, 'formatError').mockReturnValue(
          'Gemini not configured. Run: speedwave setup gemini'
        );

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'test',
        });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('GEMINI_ERROR');
        expect(result.error?.message).toContain('not configured');
      });

      it('logs errors to console', async () => {
        const mockClient = createMockClient();
        const testError = new Error('Test error');
        mockClient.chat.mockRejectedValue(testError);

        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(GeminiClient, 'formatError').mockReturnValue('Test error');

        await handleChat(mockClient as unknown as GeminiClient, { prompt: 'test' });

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('chat error:'), testError);

        consoleSpy.mockRestore();
      });
    });

    describe('edge cases', () => {
      it('handles empty response from client', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockResolvedValue('');

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'test',
        });

        expect(result.success).toBe(true);
        expect(result.data).toBe('');
      });

      it('handles whitespace-only response from client', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockResolvedValue('   \n\t  ');

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'test',
        });

        expect(result.success).toBe(true);
        expect(result.data).toBe('   \n\t  ');
      });

      it('handles very long response from client', async () => {
        const mockClient = createMockClient();
        const longResponse = 'x'.repeat(100000);
        mockClient.chat.mockResolvedValue(longResponse);

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'test',
        });

        expect(result.success).toBe(true);
        expect(result.data).toBe(longResponse);
      });

      it('handles special characters in prompt', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockResolvedValue('Response');

        const specialPrompt = 'Test with "quotes", newlines\n, and \ttabs';
        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: specialPrompt,
        });

        expect(result.success).toBe(true);
        expect(mockClient.chat).toHaveBeenCalledWith({ prompt: specialPrompt });
      });

      it('handles unicode characters in prompt', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockResolvedValue('Response with emojis');

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'What is przyczłap? 🤔',
        });

        expect(result.success).toBe(true);
        expect(mockClient.chat).toHaveBeenCalledWith({ prompt: 'What is przyczłap? 🤔' });
      });

      it('handles null values in optional parameters', async () => {
        const mockClient = createMockClient();
        mockClient.chat.mockResolvedValue('Response');

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'test',
          context: undefined,
          useGrounding: undefined,
          outputFormat: undefined,
        });

        expect(result.success).toBe(true);
      });
    });

    describe('formatError integration', () => {
      it('uses GeminiClient.formatError for error formatting', async () => {
        const mockClient = createMockClient();
        const originalError = new Error('Raw API error message');
        mockClient.chat.mockRejectedValue(originalError);

        const formatErrorSpy = vi
          .spyOn(GeminiClient, 'formatError')
          .mockReturnValue('Formatted error message');

        const result = await handleChat(mockClient as unknown as GeminiClient, {
          prompt: 'test',
        });

        expect(formatErrorSpy).toHaveBeenCalledWith(originalError);
        expect(result.success).toBe(false);
        expect(result.error?.message).toBe('Formatted error message');
      });
    });
  });
});
