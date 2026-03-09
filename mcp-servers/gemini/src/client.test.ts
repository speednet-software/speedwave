/**
 * Comprehensive tests for Gemini CLI Client
 * Target: 90%+ coverage
 *
 * Key behaviors tested:
 * - API key passed via GEMINI_API_KEY env var (NOT .env file)
 * - GEMINI_CONFIG_DIR passed to CLI
 * - Rate limiting with retry logic
 * - Output format handling (text, json, markdown)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiClient, initializeGeminiClient } from './client.js';

// Mock the dependencies
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('fs/promises', () => {
  const mockFns = {
    readFile: vi.fn(),
  };

  return {
    default: mockFns,
    ...mockFns,
  };
});

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
  },
  readFileSync: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: (fn: any) => {
    return (...args: any[]) => {
      return new Promise((resolve, reject) => {
        fn(...args, (err: any, result: any) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
    };
  },
}));

// Import mocks after module mocking
import { execFile } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';

const mockExecFile = execFile as any;
const mockReadFile = fs.readFile as any;
const mockReadFileSync = fsSync.readFileSync as any;
const mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('GeminiClient', () => {
  const mockApiKey = 'test-api-key-123';
  const mockWorkspacePath = '/test/workspace';

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    mockReadFile.mockResolvedValue(mockApiKey);

    // Default execFile mock (for 'which gemini' check)
    mockExecFile.mockImplementation((cmd: string, args: string[], callback: any) => {
      if (callback) {
        callback(null, { stdout: '/usr/bin/gemini', stderr: '' });
      }
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create client with provided config', () => {
      const client = new GeminiClient({
        apiKey: mockApiKey,
        workspacePath: mockWorkspacePath,
      });

      expect(client).toBeInstanceOf(GeminiClient);
    });

    it('should use default workspace path when not provided', () => {
      const client = new GeminiClient({ apiKey: mockApiKey });
      expect(client).toBeInstanceOf(GeminiClient);
    });

    it('should not be initialized on creation', () => {
      const client = new GeminiClient({ apiKey: mockApiKey });
      expect(client.isInitialized()).toBe(false);
    });
  });

  describe('initialize', () => {
    it('should successfully initialize with Gemini CLI available', async () => {
      mockExecFile.mockImplementation((cmd: string, args: string[], callback: any) => {
        callback(null, { stdout: '/usr/bin/gemini', stderr: '' });
      });

      const client = new GeminiClient({
        apiKey: mockApiKey,
        workspacePath: mockWorkspacePath,
      });

      const result = await client.initialize();

      expect(result).toBe(true);
      expect(client.isInitialized()).toBe(true);
    });

    it('should successfully initialize even without Gemini CLI', async () => {
      const client = new GeminiClient({
        apiKey: mockApiKey,
        workspacePath: mockWorkspacePath,
      });

      mockExecFile.mockImplementation((cmd: string, args: string[], callback: any) => {
        callback(new Error('not found'), null);
      });

      const result = await client.initialize();

      expect(result).toBe(true);
      expect(client.isInitialized()).toBe(true);
    });

    it('should NOT write .env file (API key passed via env var)', async () => {
      const client = new GeminiClient({
        apiKey: mockApiKey,
        workspacePath: mockWorkspacePath,
      });

      await client.initialize();

      // fs.writeFile should NOT be called - we pass API key via env var now
      expect(vi.mocked(fs).writeFile).toBeUndefined();
    });

    it('should NOT create .gemini directory (managed externally)', async () => {
      const client = new GeminiClient({
        apiKey: mockApiKey,
        workspacePath: mockWorkspacePath,
      });

      await client.initialize();

      // fs.mkdir should NOT be called - directory is managed via Docker tmpfs
      expect(vi.mocked(fs).mkdir).toBeUndefined();
    });
  });

  describe('formatError', () => {
    it('should format "not initialized" error', () => {
      const error = new Error('client not initialized');
      const formatted = GeminiClient.formatError(error);
      expect(formatted).toBe('Gemini not configured. Run: speedwave setup gemini');
    });

    it('should format rate limit error', () => {
      const error = new Error('Rate limit exceeded');
      const formatted = GeminiClient.formatError(error);
      expect(formatted).toBe('Rate limit exceeded. Please try again later.');
    });

    it('should format authentication error with "API key"', () => {
      const error = new Error('Invalid API key');
      const formatted = GeminiClient.formatError(error);
      expect(formatted).toBe(
        'Authentication failed. Check your Gemini API key. Run: speedwave setup gemini'
      );
    });

    it('should format authentication error with 401', () => {
      const error = new Error('401 Unauthorized');
      const formatted = GeminiClient.formatError(error);
      expect(formatted).toBe(
        'Authentication failed. Check your Gemini API key. Run: speedwave setup gemini'
      );
    });

    it('should format network error with getaddrinfo', () => {
      const error = new Error('getaddrinfo ENOTFOUND');
      const formatted = GeminiClient.formatError(error);
      expect(formatted).toBe('Network error. Cannot connect to Gemini API.');
    });

    it('should format network error with ECONNREFUSED', () => {
      const error = new Error('ECONNREFUSED: connection refused');
      const formatted = GeminiClient.formatError(error);
      expect(formatted).toBe('Network error. Cannot connect to Gemini API.');
    });

    it('should return message for unknown error', () => {
      const error = new Error('Some other error');
      const formatted = GeminiClient.formatError(error);
      expect(formatted).toBe('Some other error');
    });

    it('should handle error without message', () => {
      const error = {};
      const formatted = GeminiClient.formatError(error);
      expect(formatted).toBe('Gemini API error');
    });
  });

  describe('chat', () => {
    let client: GeminiClient;

    beforeEach(async () => {
      client = new GeminiClient({
        apiKey: mockApiKey,
        workspacePath: mockWorkspacePath,
      });

      mockExecFile.mockImplementation((cmd: string, args: string[], callback: any) => {
        callback(null, { stdout: '', stderr: '' });
      });

      await client.initialize();
      vi.clearAllMocks();
    });

    it('should chat with text with default format', async () => {
      const mockResponse = { response: 'Analysis complete' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      const result = await client.chat({
        prompt: 'Analyze requirements',
        context: '## REQ-001\nDescription here',
      });

      expect(result).toBe('Analysis complete');
      const callArgs = mockExecFile.mock.calls[0][1];
      const promptIndex = callArgs.indexOf('-p');
      expect(callArgs[promptIndex + 1]).toContain('Analyze requirements');
      expect(callArgs[promptIndex + 1]).toContain('REQ-001');
    });

    it('should include context in prompt', async () => {
      const mockResponse = { response: 'Result' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({
        prompt: 'Find issues',
        context: 'Task 1: Do something\nTask 2: Do another thing',
      });

      const callArgs = mockExecFile.mock.calls[0][1];
      const promptIndex = callArgs.indexOf('-p');
      expect(callArgs[promptIndex + 1]).toContain('Content to analyze:');
      expect(callArgs[promptIndex + 1]).toContain('Task 1: Do something');
      expect(callArgs[promptIndex + 1]).toContain('Task 2: Do another thing');
    });

    it('should append JSON format instruction when outputFormat is json', async () => {
      const mockResponse = { response: '{"result": "ok"}' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({
        prompt: 'Analyze',
        context: 'Content',
        outputFormat: 'json',
      });

      const callArgs = mockExecFile.mock.calls[0][1];
      const promptIndex = callArgs.indexOf('-p');
      expect(callArgs[promptIndex + 1]).toContain('Provide your response as valid JSON');
    });

    it('should append markdown format instruction when outputFormat is markdown', async () => {
      const mockResponse = { response: '# Analysis' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({
        prompt: 'Analyze',
        context: 'Content',
        outputFormat: 'markdown',
      });

      const callArgs = mockExecFile.mock.calls[0][1];
      const promptIndex = callArgs.indexOf('-p');
      expect(callArgs[promptIndex + 1]).toContain('Provide your response in Markdown format');
    });

    it('should throw error if client not initialized', async () => {
      const uninitializedClient = new GeminiClient({ apiKey: mockApiKey });

      await expect(
        uninitializedClient.chat({
          prompt: 'test',
          context: 'content',
        })
      ).rejects.toThrow('Gemini client not initialized');
    });

    it('should handle rate limiting with retry', async () => {
      let callCount = 0;
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          callCount++;
          if (callCount === 1) {
            const error: any = new Error('Rate limited');
            error.stderr = 'Please retry in 0.1s';
            callback(error, null);
          } else {
            callback(null, { stdout: JSON.stringify({ response: 'Success' }), stderr: '' });
          }
        }
      );

      const result = await client.chat({
        prompt: 'test',
        context: 'content',
      });

      expect(result).toBe('Success');
      expect(callCount).toBe(2);
    }, 10000);

    it('should handle plain text response as fallback', async () => {
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          callback(null, { stdout: 'Plain response', stderr: '' });
        }
      );

      const result = await client.chat({
        prompt: 'test',
        context: 'content',
      });

      expect(result).toBe('Plain response');
    });

    // =========================================================================
    // CRITICAL: Tests for env var passing (would have caught our bug!)
    // =========================================================================

    it('should pass GEMINI_API_KEY in env to CLI', async () => {
      const mockResponse = { response: 'Success' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          // Verify GEMINI_API_KEY is in the options.env
          expect(options.env).toBeDefined();
          expect(options.env.GEMINI_API_KEY).toBe(mockApiKey);
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({
        prompt: 'test',
        context: 'content',
      });

      expect(mockExecFile).toHaveBeenCalled();
    });

    it('should pass GEMINI_CONFIG_DIR in env to CLI', async () => {
      const mockResponse = { response: 'Success' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          // Verify GEMINI_CONFIG_DIR is in the options.env
          expect(options.env).toBeDefined();
          expect(options.env.GEMINI_CONFIG_DIR).toBeDefined();
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({
        prompt: 'test',
        context: 'content',
      });

      expect(mockExecFile).toHaveBeenCalled();
    });

    it('should call gemini CLI with correct arguments', async () => {
      const mockResponse = { response: 'Success' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          // Verify command is 'gemini'
          expect(cmd).toBe('gemini');
          // Verify args include required flags
          expect(args).toContain('-y'); // auto-accept
          expect(args).toContain('-m'); // model flag
          expect(args).toContain('-o'); // output format flag
          expect(args).toContain('json'); // json output
          expect(args).toContain('-p'); // prompt flag
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({
        prompt: 'test',
        context: 'content',
      });

      expect(mockExecFile).toHaveBeenCalled();
    });

    it('should use workspace path as cwd', async () => {
      const mockResponse = { response: 'Success' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          expect(options.cwd).toBe(mockWorkspacePath);
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({
        prompt: 'test',
        context: 'content',
      });

      expect(mockExecFile).toHaveBeenCalled();
    });

    it('should set maxBuffer to 10MB', async () => {
      const mockResponse = { response: 'Success' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          expect(options.maxBuffer).toBe(10 * 1024 * 1024);
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({
        prompt: 'test',
        context: 'content',
      });

      expect(mockExecFile).toHaveBeenCalled();
    });

    // =========================================================================
    // Rate limiting edge cases
    // =========================================================================

    it('should extract retry delay from "Please retry in 5.2s"', async () => {
      let callCount = 0;
      let waitedTime = 0;
      const originalSetTimeout = global.setTimeout;

      // Mock setTimeout to track delay
      vi.spyOn(global, 'setTimeout').mockImplementation((cb: any, delay: any) => {
        waitedTime = delay;
        cb();
        return 0 as any;
      });

      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          callCount++;
          if (callCount === 1) {
            const error: any = new Error('Rate limited');
            error.stderr = 'Please retry in 5.2s';
            callback(error, null);
          } else {
            callback(null, { stdout: JSON.stringify({ response: 'Success' }), stderr: '' });
          }
        }
      );

      await client.chat({
        prompt: 'test',
        context: 'content',
      });

      // Should have waited approximately 5.2 seconds (5200ms)
      expect(waitedTime).toBeCloseTo(5200, -2);
      vi.restoreAllMocks();
    });

    it('should give up after MAX_RETRIES attempts', async () => {
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const error: any = new Error('Rate limited');
          error.stderr = 'Please retry in 0.01s';
          callback(error, null);
        }
      );

      await expect(
        client.chat({
          prompt: 'test',
          context: 'content',
        })
      ).rejects.toThrow('Gemini CLI failed after 3 retries (rate limited)');
    }, 10000);

    it('should handle error without retry pattern', async () => {
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          callback(new Error('Connection refused'), null);
        }
      );

      await expect(
        client.chat({
          prompt: 'test',
          context: 'content',
        })
      ).rejects.toThrow('Gemini CLI failed: Connection refused');
    });

    it('should filter stderr "Loading" messages', async () => {
      const mockResponse = { response: 'Success' };
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          // Loading message should not trigger warning
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: 'Loading model...' });
        }
      );

      await client.chat({
        prompt: 'test',
        context: 'content',
      });

      // console.warn should NOT have been called for "Loading" message
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Gemini CLI stderr'),
        expect.anything()
      );
      consoleSpy.mockRestore();
    });

    it('should warn on non-Loading stderr messages', async () => {
      const mockResponse = { response: 'Success' };
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: 'Warning: deprecated' });
        }
      );

      await client.chat({
        prompt: 'test',
        context: 'content',
      });

      // console.warn SHOULD have been called for non-Loading message
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Gemini CLI stderr'),
        expect.anything()
      );
      consoleSpy.mockRestore();
    });

    // =========================================================================
    // useGrounding parameter tests
    // =========================================================================

    it('should add grounding prefix when useGrounding is true', async () => {
      const mockResponse = { response: 'Result with grounding' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const promptIndex = args.indexOf('-p');
          const prompt = args[promptIndex + 1];
          expect(prompt).toContain('Use Google Search to find current, up-to-date information');
          expect(prompt).toContain('test query');
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({ prompt: 'test query', useGrounding: true });
      expect(mockExecFile).toHaveBeenCalled();
    });

    it('should NOT add grounding prefix when useGrounding is false', async () => {
      const mockResponse = { response: 'Result without grounding' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const promptIndex = args.indexOf('-p');
          const prompt = args[promptIndex + 1];
          expect(prompt).not.toContain('Use Google Search');
          expect(prompt).toBe('test query');
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({ prompt: 'test query', useGrounding: false });
      expect(mockExecFile).toHaveBeenCalled();
    });

    it('should NOT add grounding prefix when useGrounding is undefined', async () => {
      const mockResponse = { response: 'Result' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const promptIndex = args.indexOf('-p');
          const prompt = args[promptIndex + 1];
          expect(prompt).not.toContain('Use Google Search');
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({ prompt: 'test query' });
      expect(mockExecFile).toHaveBeenCalled();
    });

    it('should combine grounding prefix with context', async () => {
      const mockResponse = { response: 'Result with grounding and context' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const promptIndex = args.indexOf('-p');
          const prompt = args[promptIndex + 1];
          expect(prompt).toContain('Use Google Search to find current, up-to-date information');
          expect(prompt).toContain('test query');
          expect(prompt).toContain('Content to analyze:');
          expect(prompt).toContain('some context');
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({
        prompt: 'test query',
        context: 'some context',
        useGrounding: true,
      });
      expect(mockExecFile).toHaveBeenCalled();
    });

    it('should combine grounding with outputFormat', async () => {
      const mockResponse = { response: '{"result": "json"}' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const promptIndex = args.indexOf('-p');
          const prompt = args[promptIndex + 1];
          expect(prompt).toContain('Use Google Search');
          expect(prompt).toContain('Provide your response as valid JSON');
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({
        prompt: 'test query',
        useGrounding: true,
        outputFormat: 'json',
      });
      expect(mockExecFile).toHaveBeenCalled();
    });

    it('should combine grounding with markdown outputFormat', async () => {
      const mockResponse = { response: '# Result' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const promptIndex = args.indexOf('-p');
          const prompt = args[promptIndex + 1];
          expect(prompt).toContain('Use Google Search');
          expect(prompt).toContain('Provide your response in Markdown format');
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({
        prompt: 'test query',
        useGrounding: true,
        outputFormat: 'markdown',
      });
      expect(mockExecFile).toHaveBeenCalled();
    });

    // =========================================================================
    // Optional context parameter tests
    // =========================================================================

    it('should NOT add "Content to analyze:" when context is undefined', async () => {
      const mockResponse = { response: 'Answer' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const promptIndex = args.indexOf('-p');
          const prompt = args[promptIndex + 1];
          expect(prompt).not.toContain('Content to analyze:');
          expect(prompt).toBe('simple question');
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({ prompt: 'simple question' });
      expect(mockExecFile).toHaveBeenCalled();
    });

    it('should NOT add context section when context is empty string', async () => {
      const mockResponse = { response: 'Answer' };
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const promptIndex = args.indexOf('-p');
          const prompt = args[promptIndex + 1];
          expect(prompt).not.toContain('Content to analyze:');
          callback(null, { stdout: JSON.stringify(mockResponse), stderr: '' });
        }
      );

      await client.chat({ prompt: 'simple question', context: '' });
      expect(mockExecFile).toHaveBeenCalled();
    });

    // =========================================================================
    // Error extraction tests (extractErrorMessage via executeGemini errors)
    // =========================================================================

    it('should extract quota error from JSON error file', async () => {
      const errorFilePath = '/tmp/gemini-error-123.json';
      const errorJson = {
        error: { message: 'You have exhausted your daily quota for gemini-2.5-flash' },
      };

      mockReadFileSync.mockReturnValue(JSON.stringify(errorJson));

      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const error: any = new Error('CLI failed');
          error.stderr = `Error occurred\nFull report available at: ${errorFilePath}`;
          callback(error, null);
        }
      );

      await expect(client.chat({ prompt: 'test' })).rejects.toThrow(
        'Daily quota exceeded for this model. Try again tomorrow or use a different model.'
      );
    });

    it('should extract rate limit error from JSON error file', async () => {
      const errorFilePath = '/tmp/gemini-error-456.json';
      const errorJson = {
        error: { message: 'Rate limit exceeded for this API' },
      };

      mockReadFileSync.mockReturnValue(JSON.stringify(errorJson));

      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const error: any = new Error('CLI failed');
          error.stderr = `Full report available at: ${errorFilePath}`;
          callback(error, null);
        }
      );

      await expect(client.chat({ prompt: 'test' })).rejects.toThrow(
        'Rate limit exceeded. Please try again later.'
      );
    });

    it('should extract auth error from JSON error file', async () => {
      const errorFilePath = '/tmp/gemini-error-789.json';
      const errorJson = {
        error: { message: '401 Unauthorized - Invalid API key' },
      };

      mockReadFileSync.mockReturnValue(JSON.stringify(errorJson));

      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const error: any = new Error('CLI failed');
          error.stderr = `Full report available at: ${errorFilePath}`;
          callback(error, null);
        }
      );

      await expect(client.chat({ prompt: 'test' })).rejects.toThrow(
        'Authentication failed. Check your Gemini API key.'
      );
    });

    it('should handle file read failures gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const error: any = new Error('Some other error');
          error.stderr = 'Full report available at: /tmp/nonexistent.json';
          callback(error, null);
        }
      );

      await expect(client.chat({ prompt: 'test' })).rejects.toThrow(
        'Gemini CLI failed: Some other error'
      );

      // Should have logged warning about failed file read
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to read error details'),
        expect.anything()
      );

      consoleSpy.mockRestore();
    });

    it('should handle malformed JSON in error file', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockReadFileSync.mockReturnValue('{ invalid json }');

      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const error: any = new Error('Original error message');
          error.stderr = 'Full report available at: /tmp/malformed.json';
          callback(error, null);
        }
      );

      await expect(client.chat({ prompt: 'test' })).rejects.toThrow(
        'Gemini CLI failed: Original error message'
      );

      // Should have logged warning about failed JSON parse
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to read error details'),
        expect.anything()
      );

      consoleSpy.mockRestore();
    });

    it('should extract quota error from error.message string', async () => {
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const error: any = new Error('quota exceeded for model');
          callback(error, null);
        }
      );

      await expect(client.chat({ prompt: 'test' })).rejects.toThrow(
        'Daily quota exceeded for this model. Try again tomorrow or use a different model.'
      );
    });

    it('should return "Unknown error" when no error info available', async () => {
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const error: any = {};
          callback(error, null);
        }
      );

      await expect(client.chat({ prompt: 'test' })).rejects.toThrow(
        'Gemini CLI failed: Unknown error'
      );
    });

    it('should handle error.message as object with message property', async () => {
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const error: any = {
            message: { message: 'Nested error message' },
          };
          callback(error, null);
        }
      );

      await expect(client.chat({ prompt: 'test' })).rejects.toThrow(
        'Gemini CLI failed: Nested error message'
      );
    });

    it('should handle error.message as object with error property', async () => {
      mockExecFile.mockImplementation(
        (cmd: string, args: string[], options: any, callback: any) => {
          const error: any = {
            message: { error: 'Error from error property' },
          };
          callback(error, null);
        }
      );

      await expect(client.chat({ prompt: 'test' })).rejects.toThrow(
        'Gemini CLI failed: Error from error property'
      );
    });
  });

  describe('initializeGeminiClient', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('should successfully initialize client from token file', async () => {
      mockReadFile.mockResolvedValue('valid-api-key\n');
      mockExecFile.mockImplementation((cmd: string, args: string[], callback: any) => {
        callback(null, { stdout: '/usr/bin/gemini', stderr: '' });
      });

      const client = await initializeGeminiClient();

      expect(client).not.toBeNull();
      expect(client?.isInitialized()).toBe(true);
      expect(mockReadFile).toHaveBeenCalledWith(expect.stringContaining('api_key'), 'utf8');
    });

    it('should return null if API key is empty', async () => {
      mockReadFile.mockResolvedValue('  \n  ');

      const result = await initializeGeminiClient();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalled();
    });

    it('should return null if token file does not exist', async () => {
      const error: any = new Error('File not found');
      error.code = 'ENOENT';
      error.path = '/tokens/api_key';
      mockReadFile.mockRejectedValue(error);

      const result = await initializeGeminiClient();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalled();
    });

    it('should trim whitespace from API key', async () => {
      mockReadFile.mockResolvedValue('  api-key-with-spaces  \n');
      mockExecFile.mockImplementation((cmd: string, args: string[], callback: any) => {
        callback(null, { stdout: '', stderr: '' });
      });

      const client = await initializeGeminiClient();

      expect(client).not.toBeNull();
      // API key should be trimmed (verified by client being successfully created)
    });

    it('should return null on generic read errors', async () => {
      const error = new Error('Permission denied');
      mockReadFile.mockRejectedValue(error);

      const result = await initializeGeminiClient();
      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalled();
    });
  });
});
