/**
 * Comprehensive tests for handlers.ts
 * Testing all MCP handler functions with 90%+ coverage
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { createCodeExecutorHandlers } from './handlers.js';
import * as searchToolsModule from './search-tools.js';
import * as executorModule from './executor.js';
import * as toolRegistryModule from './tool-registry.js';
import { TIMEOUTS } from '@speedwave/mcp-shared';
import { populateRegistryWithMockTools, _resetRegistryForTesting } from './test-helpers.js';

// Helper factory for mock execute results
function createMockExecuteResult(data: unknown, executionMs = 100) {
  return {
    success: true as const,
    data,
    metadata: {
      timestamp: '2024-01-01T00:00:00.000Z',
      executionMs,
      service: 'code-executor',
    },
  };
}

// Mock the dependencies
vi.mock('./search-tools.js');
vi.mock('./executor.js');
vi.mock('./tool-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof toolRegistryModule>();
  return {
    ...actual,
    // Override getExecutionTimeout to use actual implementation
    getExecutionTimeout: actual.getExecutionTimeout,
    getLongTimeoutTools: actual.getLongTimeoutTools,
    getRequiredTimeoutClass: actual.getRequiredTimeoutClass,
  };
});

describe('createCodeExecutorHandlers', () => {
  const mockConfig = {
    timeoutMs: 10000,
  };

  beforeAll(() => {
    _resetRegistryForTesting();
    populateRegistryWithMockTools();
  });

  afterAll(() => {
    toolRegistryModule.stopBackgroundRefresh();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleSearchTools', () => {
    it('should search tools with minimal params (query only)', async () => {
      const mockResults = {
        matches: [
          {
            tool: 'slack/sendChannel',
            service: 'slack',
            deferLoading: false,
          },
        ],
        total: 1,
        query: 'slack',
        detail_level: 'names_only',
      };

      vi.mocked(searchToolsModule.searchTools).mockResolvedValue(mockResults);

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleSearchTools({ query: 'slack' });

      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({
        type: 'text',
        text: JSON.stringify(mockResults),
      });
      expect(result.isError).toBeUndefined();
      expect(searchToolsModule.searchTools).toHaveBeenCalledWith({
        query: 'slack',
        detailLevel: 'names_only',
        service: undefined,
        includeDeferred: undefined,
      });
    });

    it('should search tools with all params', async () => {
      const mockResults = {
        matches: [
          {
            tool: 'slack/sendChannel',
            service: 'slack',
            deferLoading: false,
            description: 'Send a message to a Slack channel',
            inputSchema: { type: 'object', properties: {} },
            outputSchema: { type: 'object', properties: {} },
            example: 'example code',
            inputExamples: [],
          },
        ],
        total: 1,
        query: 'send',
        detail_level: 'full_schema',
      };

      vi.mocked(searchToolsModule.searchTools).mockResolvedValue(mockResults);

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleSearchTools({
        query: 'send',
        detail_level: 'full_schema',
        service: 'slack',
        include_deferred: false,
      });

      expect(result.content[0].text).toBe(JSON.stringify(mockResults));
      expect(searchToolsModule.searchTools).toHaveBeenCalledWith({
        query: 'send',
        detailLevel: 'full_schema',
        service: 'slack',
        includeDeferred: false,
      });
    });

    it('should handle detail_level: with_descriptions', async () => {
      const mockResults = {
        matches: [
          {
            tool: 'slack/sendChannel',
            service: 'slack',
            deferLoading: false,
            description: 'Send a message to a Slack channel',
          },
        ],
        total: 1,
        query: 'slack',
        detail_level: 'with_descriptions',
      };

      vi.mocked(searchToolsModule.searchTools).mockResolvedValue(mockResults);

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleSearchTools({
        query: 'slack',
        detail_level: 'with_descriptions',
      });

      expect(result.content[0].text).toBe(JSON.stringify(mockResults));
      expect(searchToolsModule.searchTools).toHaveBeenCalledWith({
        query: 'slack',
        detailLevel: 'with_descriptions',
        service: undefined,
        includeDeferred: undefined,
      });
    });

    it('should handle wildcard search', async () => {
      const mockResults = {
        matches: [
          {
            tool: 'slack/sendChannel',
            service: 'slack',
            deferLoading: false,
          },
          {
            tool: 'redmine/listIssueIds',
            service: 'redmine',
            deferLoading: false,
          },
        ],
        total: 2,
        query: '*',
        detail_level: 'names_only',
      };

      vi.mocked(searchToolsModule.searchTools).mockResolvedValue(mockResults);

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleSearchTools({ query: '*' });

      expect(result.content[0].text).toBe(JSON.stringify(mockResults));
      expect(searchToolsModule.searchTools).toHaveBeenCalledWith({
        query: '*',
        detailLevel: 'names_only',
        service: undefined,
        includeDeferred: undefined,
      });
    });

    it('should handle empty results', async () => {
      const mockResults = {
        matches: [],
        total: 0,
        query: 'nonexistent',
        detail_level: 'names_only',
      };

      vi.mocked(searchToolsModule.searchTools).mockResolvedValue(mockResults);

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleSearchTools({ query: 'nonexistent' });

      expect(result.content[0].text).toBe(JSON.stringify(mockResults));
      expect(result.isError).toBeUndefined();
    });

    it('should handle Error instance thrown by searchTools', async () => {
      vi.mocked(searchToolsModule.searchTools).mockRejectedValue(
        new Error('Database connection failed')
      );

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleSearchTools({ query: 'slack' });

      expect(result.content[0].text).toBe('Error searching tools: Database connection failed');
      expect(result.isError).toBe(true);
    });

    it('should handle non-Error exception from searchTools', async () => {
      vi.mocked(searchToolsModule.searchTools).mockRejectedValue('string error');

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleSearchTools({ query: 'slack' });

      expect(result.content[0].text).toBe('Error searching tools: Unknown error');
      expect(result.isError).toBe(true);
    });

    it('should handle null/undefined service parameter', async () => {
      const mockResults = {
        matches: [],
        total: 0,
        query: 'test',
        detail_level: 'names_only',
      };

      vi.mocked(searchToolsModule.searchTools).mockResolvedValue(mockResults);

      const handlers = createCodeExecutorHandlers(mockConfig);
      await handlers.handleSearchTools({ query: 'test', service: undefined });

      expect(searchToolsModule.searchTools).toHaveBeenCalledWith({
        query: 'test',
        detailLevel: 'names_only',
        service: undefined,
        includeDeferred: undefined,
      });
    });
  });

  describe('handleExecuteCode', () => {
    it('should execute code successfully with string result', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(
        createMockExecuteResult('Hello, World!')
      );

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({
        code: 'return "Hello, World!"',
      });

      expect(result.content[0].text).toBe('Hello, World!');
      expect(result.isError).toBeUndefined();
      expect(executorModule.executeCode).toHaveBeenCalledWith({
        code: 'return "Hello, World!"',
        timeoutMs: mockConfig.timeoutMs,
      });
    });

    it('should execute code successfully with object result', async () => {
      const mockData = { message: 'success', count: 42 };

      vi.mocked(executorModule.executeCode).mockResolvedValue(
        createMockExecuteResult(mockData, 150)
      );

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({
        code: 'return { message: "success", count: 42 }',
      });

      expect(result.content[0].text).toBe(JSON.stringify(mockData));
      expect(result.isError).toBeUndefined();
    });

    it('should handle custom timeout_ms parameter', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(createMockExecuteResult('done', 50));

      const handlers = createCodeExecutorHandlers(mockConfig);
      await handlers.handleExecuteCode({
        code: 'return "done"',
        timeout_ms: 5000,
      });

      expect(executorModule.executeCode).toHaveBeenCalledWith({
        code: 'return "done"',
        timeoutMs: 5000,
      });
    });

    it('should enforce maximum timeout at EXECUTION_MS for standard operations', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(createMockExecuteResult('done', 50));

      const handlers = createCodeExecutorHandlers(mockConfig);
      await handlers.handleExecuteCode({
        code: 'return "done"',
        timeout_ms: 200000, // Try to exceed EXECUTION_MS
      });

      expect(executorModule.executeCode).toHaveBeenCalledWith({
        code: 'return "done"',
        timeoutMs: TIMEOUTS.EXECUTION_MS, // Capped at EXECUTION_MS (120000)
      });
    });

    it('should use config timeout when timeout_ms not provided', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(createMockExecuteResult('done', 50));

      const handlers = createCodeExecutorHandlers(mockConfig);
      await handlers.handleExecuteCode({
        code: 'return "done"',
      });

      expect(executorModule.executeCode).toHaveBeenCalledWith({
        code: 'return "done"',
        timeoutMs: mockConfig.timeoutMs,
      });
    });

    it('should handle execution failure with error result', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue({
        success: false,
        error: {
          code: 'SYNTAX_ERROR',
          message: 'Unexpected token',
          retryable: false,
        },
      });

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({
        code: 'invalid syntax {',
      });

      expect(result.content[0].text).toBe('Execution error: Unexpected token');
      expect(result.isError).toBe(true);
    });

    it('should handle execution failure without error message', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue({
        success: false,
        error: {
          code: 'UNKNOWN',
          message: '',
          retryable: false,
        },
      });

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({
        code: 'bad code',
      });

      expect(result.content[0].text).toBe('Execution error: Unknown error');
      expect(result.isError).toBe(true);
    });

    it('should handle execution failure with no error object', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue({
        success: false,
      } as any);

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({
        code: 'bad code',
      });

      expect(result.content[0].text).toBe('Execution error: Unknown error');
      expect(result.isError).toBe(true);
    });

    it('should handle Error exception from executeCode', async () => {
      vi.mocked(executorModule.executeCode).mockRejectedValue(
        new Error('VM initialization failed')
      );

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({
        code: 'return "test"',
      });

      expect(result.content[0].text).toBe('Execution failed: VM initialization failed');
      expect(result.isError).toBe(true);
    });

    it('should handle non-Error exception from executeCode', async () => {
      vi.mocked(executorModule.executeCode).mockRejectedValue('unknown error');

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({
        code: 'return "test"',
      });

      expect(result.content[0].text).toBe('Execution failed: Unknown error');
      expect(result.isError).toBe(true);
    });

    it('should handle array result', async () => {
      const mockData = [1, 2, 3, 4, 5];

      vi.mocked(executorModule.executeCode).mockResolvedValue(
        createMockExecuteResult(mockData, 50)
      );

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({
        code: 'return [1, 2, 3, 4, 5]',
      });

      expect(result.content[0].text).toBe(JSON.stringify(mockData));
    });

    it('should handle null result', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(createMockExecuteResult(null, 50));

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({
        code: 'return null',
      });

      expect(result.content[0].text).toBe('null');
    });

    it('should handle undefined result', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(
        createMockExecuteResult(undefined, 50)
      );

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({
        code: 'return undefined',
      });

      // undefined is converted to "null" to avoid MCP validation errors
      // (JSON.stringify(undefined) returns undefined, not a string!)
      expect(result.content[0].text).toBe('null');
    });

    it('should handle number result', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(createMockExecuteResult(42, 50));

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({
        code: 'return 42',
      });

      expect(result.content[0].text).toBe('42');
    });

    it('should handle boolean result', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(createMockExecuteResult(true, 50));

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({
        code: 'return true',
      });

      expect(result.content[0].text).toBe('true');
    });

    it('should use Math.min to select smaller timeout', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(createMockExecuteResult('done', 50));

      const customConfig = { timeoutMs: 70000 };
      const handlers = createCodeExecutorHandlers(customConfig);

      // Custom timeout is smaller, should use custom
      await handlers.handleExecuteCode({
        code: 'return "done"',
        timeout_ms: 5000,
      });
      expect(executorModule.executeCode).toHaveBeenLastCalledWith({
        code: 'return "done"',
        timeoutMs: 5000,
      });

      // Max timeout is smaller, should cap at 120000
      await handlers.handleExecuteCode({
        code: 'return "done"',
        timeout_ms: 150000,
      });
      expect(executorModule.executeCode).toHaveBeenLastCalledWith({
        code: 'return "done"',
        timeoutMs: TIMEOUTS.EXECUTION_MS,
      });
    });
  });

  describe('edge cases and integration', () => {
    it('should handle multiple handler calls independently', async () => {
      const mockSearchResult = {
        matches: [],
        total: 0,
        query: 'test',
        detail_level: 'names_only',
      };

      const mockExecuteResult = createMockExecuteResult('executed', 50);

      vi.mocked(searchToolsModule.searchTools).mockResolvedValue(mockSearchResult);
      vi.mocked(executorModule.executeCode).mockResolvedValue(mockExecuteResult);

      const handlers = createCodeExecutorHandlers(mockConfig);

      const searchResult = await handlers.handleSearchTools({ query: 'test' });
      const executeResult = await handlers.handleExecuteCode({ code: 'return "test"' });

      expect(searchResult.content[0].text).toBe(JSON.stringify(mockSearchResult));
      expect(executeResult.content[0].text).toBe('executed');
    });

    it('should create handlers with different configs', () => {
      const config1 = { timeoutMs: 5000 };
      const config2 = { timeoutMs: 20000 };

      const handlers1 = createCodeExecutorHandlers(config1);
      const handlers2 = createCodeExecutorHandlers(config2);

      expect(handlers1).toHaveProperty('handleSearchTools');
      expect(handlers1).toHaveProperty('handleExecuteCode');
      expect(handlers2).toHaveProperty('handleSearchTools');
      expect(handlers2).toHaveProperty('handleExecuteCode');
    });

    it('should handle concurrent handler calls', async () => {
      vi.mocked(searchToolsModule.searchTools).mockResolvedValue({
        matches: [],
        total: 0,
        query: 'test',
        detail_level: 'names_only',
      });

      vi.mocked(executorModule.executeCode).mockResolvedValue(createMockExecuteResult('done', 50));

      const handlers = createCodeExecutorHandlers(mockConfig);

      const results = await Promise.all([
        handlers.handleSearchTools({ query: 'test' }),
        handlers.handleExecuteCode({ code: 'return "test"' }),
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].content[0].type).toBe('text');
      expect(results[1].content[0].type).toBe('text');
    });

    it('should preserve handler functionality after errors', async () => {
      const handlers = createCodeExecutorHandlers(mockConfig);

      // First call fails
      vi.mocked(executorModule.executeCode).mockRejectedValueOnce(new Error('First error'));
      const firstResult = await handlers.handleExecuteCode({ code: 'bad' });
      expect(firstResult.isError).toBe(true);

      // Second call succeeds
      vi.mocked(executorModule.executeCode).mockResolvedValueOnce(
        createMockExecuteResult('success', 50)
      );
      const secondResult = await handlers.handleExecuteCode({ code: 'good' });
      expect(secondResult.isError).toBeUndefined();
    });
  });

  describe('type handling and edge cases', () => {
    it('should handle params with extra unknown properties in searchTools', async () => {
      vi.mocked(searchToolsModule.searchTools).mockResolvedValue({
        matches: [],
        total: 0,
        query: 'test',
        detail_level: 'names_only',
      });

      const handlers = createCodeExecutorHandlers(mockConfig);
      await handlers.handleSearchTools({
        query: 'test',
        detail_level: 'names_only',
        extra_param: 'should be ignored',
      } as any);

      expect(searchToolsModule.searchTools).toHaveBeenCalledWith({
        query: 'test',
        detailLevel: 'names_only',
        service: undefined,
        includeDeferred: undefined,
      });
    });

    it('should handle params with extra unknown properties in executeCode', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(createMockExecuteResult('done', 50));

      const handlers = createCodeExecutorHandlers(mockConfig);
      await handlers.handleExecuteCode({
        code: 'return "test"',
        extra_param: 'should be ignored',
      } as any);

      expect(executorModule.executeCode).toHaveBeenCalledWith({
        code: 'return "test"',
        timeoutMs: mockConfig.timeoutMs,
      });
    });

    it('should reject zero timeout with error', async () => {
      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({
        code: 'return "test"',
        timeout_ms: 0,
      });

      // Zero timeout should return validation error
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timeout_ms must be positive');
      expect(executorModule.executeCode).not.toHaveBeenCalled();
    });

    it('should reject negative timeout with error', async () => {
      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({
        code: 'return "test"',
        timeout_ms: -100,
      });

      // Negative timeout should return validation error
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timeout_ms must be positive');
      expect(executorModule.executeCode).not.toHaveBeenCalled();
    });

    it('should reject non-numeric timeout with error', async () => {
      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({
        code: 'return "test"',
        timeout_ms: 'invalid',
      });

      // Non-numeric timeout should return validation error
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timeout_ms must be a valid number');
      expect(executorModule.executeCode).not.toHaveBeenCalled();
    });

    it('should floor float timeout values', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(createMockExecuteResult('done', 50));

      const handlers = createCodeExecutorHandlers(mockConfig);
      await handlers.handleExecuteCode({
        code: 'return "test"',
        timeout_ms: 5000.7,
      });

      // Float timeout should be floored to integer
      expect(executorModule.executeCode).toHaveBeenCalledWith({
        code: 'return "test"',
        timeoutMs: 5000,
      });
    });

    it('should handle very large config timeout', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(createMockExecuteResult('done', 50));

      const largeConfig = { timeoutMs: 999999 };
      const handlers = createCodeExecutorHandlers(largeConfig);
      await handlers.handleExecuteCode({
        code: 'return "test"',
      });

      // Should still cap at 120000
      expect(executorModule.executeCode).toHaveBeenCalledWith({
        code: 'return "test"',
        timeoutMs: TIMEOUTS.EXECUTION_MS,
      });
    });
  });

  describe('long-running operation detection', () => {
    it('should use extended timeout for sharepoint.downloadFile() operations', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(
        createMockExecuteResult({ downloaded: true }, 150000)
      );

      const handlers = createCodeExecutorHandlers(mockConfig);
      await handlers.handleExecuteCode({
        code: 'await sharepoint.downloadFile({ remote_path: "/doc.pdf", local_path: "/path" })',
      });

      // Should use LONG_OPERATION_MS (300000) as default for downloadFile operations
      expect(executorModule.executeCode).toHaveBeenCalledWith({
        code: 'await sharepoint.downloadFile({ remote_path: "/doc.pdf", local_path: "/path" })',
        timeoutMs: TIMEOUTS.LONG_OPERATION_MS,
      });
    });

    it('should use extended timeout for sharepoint.uploadFile() operations', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(
        createMockExecuteResult({ uploaded: true }, 150000)
      );

      const handlers = createCodeExecutorHandlers(mockConfig);
      await handlers.handleExecuteCode({
        code: 'await sharepoint.uploadFile({ local_path: "/path", remote_path: "/dest" })',
      });

      // Should use LONG_OPERATION_MS (300000) as default for uploadFile operations
      expect(executorModule.executeCode).toHaveBeenCalledWith({
        code: 'await sharepoint.uploadFile({ local_path: "/path", remote_path: "/dest" })',
        timeoutMs: TIMEOUTS.LONG_OPERATION_MS,
      });
    });

    it('should use standard timeout for regular operations', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(
        createMockExecuteResult({ issues: [] }, 500)
      );

      const handlers = createCodeExecutorHandlers(mockConfig);
      await handlers.handleExecuteCode({
        code: 'await redmine.listIssueIds({ status: "open" })',
      });

      // Should use standard EXECUTION_MS (config default) for regular operations
      expect(executorModule.executeCode).toHaveBeenCalledWith({
        code: 'await redmine.listIssueIds({ status: "open" })',
        timeoutMs: mockConfig.timeoutMs,
      });
    });

    it('should allow custom timeout for file transfer operations up to LONG_OPERATION_MS', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(
        createMockExecuteResult({ downloaded: true }, 200000)
      );

      const handlers = createCodeExecutorHandlers(mockConfig);
      await handlers.handleExecuteCode({
        code: 'await sharepoint.downloadFile({ remote_path: "/doc.pdf", local_path: "/path" })',
        timeout_ms: 250000,
      });

      // Should use custom timeout (250000) since it's under LONG_OPERATION_MS (600000)
      expect(executorModule.executeCode).toHaveBeenCalledWith({
        code: 'await sharepoint.downloadFile({ remote_path: "/doc.pdf", local_path: "/path" })',
        timeoutMs: 250000,
      });
    });

    it('should cap file transfer operation timeout at LONG_OPERATION_MS', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(
        createMockExecuteResult({ downloaded: true }, 250000)
      );

      const handlers = createCodeExecutorHandlers(mockConfig);
      await handlers.handleExecuteCode({
        code: 'await sharepoint.downloadFile({ remote_path: "/doc.pdf", local_path: "/path" })',
        timeout_ms: 700000, // Try to exceed LONG_OPERATION_MS (600000)
      });

      // Should cap at LONG_OPERATION_MS (600000)
      expect(executorModule.executeCode).toHaveBeenCalledWith({
        code: 'await sharepoint.downloadFile({ remote_path: "/doc.pdf", local_path: "/path" })',
        timeoutMs: TIMEOUTS.LONG_OPERATION_MS,
      });
    });

    it('should detect file transfer with different whitespace patterns', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(
        createMockExecuteResult({ downloaded: true }, 150000)
      );

      const handlers = createCodeExecutorHandlers(mockConfig);

      // Test with various whitespace patterns (registry-based detection uses flexible regex)
      const testCases = [
        'sharepoint.downloadFile({ remote_path: "/doc.pdf" })',
        'sharepoint .downloadFile({ remote_path: "/doc.pdf" })',
        'sharepoint. downloadFile({ remote_path: "/doc.pdf" })',
      ];

      for (const code of testCases) {
        await handlers.handleExecuteCode({ code });
        expect(executorModule.executeCode).toHaveBeenLastCalledWith({
          code,
          timeoutMs: TIMEOUTS.LONG_OPERATION_MS,
        });
      }
    });

    it('should use timeout from registry SSOT (tool metadata declares timeoutClass)', async () => {
      // This test verifies the SOLID refactoring: timeout class comes from tool metadata
      // not from hardcoded regex patterns in handlers.ts
      vi.mocked(executorModule.executeCode).mockResolvedValue(
        createMockExecuteResult({ result: 'ok' })
      );

      const handlers = createCodeExecutorHandlers(mockConfig);

      // Tools with timeoutClass: 'long' in their metadata should get extended timeout
      // sharepoint.downloadFile has timeoutClass: 'long'
      await handlers.handleExecuteCode({ code: 'sharepoint.downloadFile({})' });
      expect(executorModule.executeCode).toHaveBeenLastCalledWith({
        code: 'sharepoint.downloadFile({})',
        timeoutMs: TIMEOUTS.LONG_OPERATION_MS,
      });

      // Regular tools without timeoutClass: 'long' should use standard timeout
      await handlers.handleExecuteCode({ code: 'redmine.listIssueIds({})' });
      expect(executorModule.executeCode).toHaveBeenLastCalledWith({
        code: 'redmine.listIssueIds({})',
        timeoutMs: mockConfig.timeoutMs,
      });
    });
  });

  describe('parameter type validation', () => {
    it('returns error when search_tools query is not a string', async () => {
      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleSearchTools({ query: 123 } as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('query parameter must be a string');
    });

    it('returns error when search_tools query is missing', async () => {
      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleSearchTools({} as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('query parameter must be a string');
    });

    it('returns error when search_tools query is null', async () => {
      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleSearchTools({ query: null } as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('query parameter must be a string');
    });

    it('returns error when search_tools query is an object', async () => {
      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleSearchTools({ query: { nested: true } } as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('query parameter must be a string');
    });

    it('returns error when execute_code code is not a string', async () => {
      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({ code: 42 } as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('code parameter must be a string');
    });

    it('returns error when execute_code code is missing', async () => {
      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({} as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('code parameter must be a string');
    });

    it('returns error when execute_code code is null', async () => {
      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({ code: null } as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('code parameter must be a string');
    });

    it('returns error when execute_code code is an array', async () => {
      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({ code: ['line1', 'line2'] } as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('code parameter must be a string');
    });

    it('ignores non-string detail_level (defaults to names_only)', async () => {
      vi.mocked(searchToolsModule.searchTools).mockResolvedValue({
        matches: [],
        total: 0,
        query: 'test',
        detail_level: 'names_only',
      });
      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleSearchTools({ query: 'test', detail_level: 123 } as any);
      expect(result.isError).toBeUndefined();
      expect(searchToolsModule.searchTools).toHaveBeenCalledWith(
        expect.objectContaining({ detailLevel: 'names_only' })
      );
    });

    it('ignores non-string service param', async () => {
      vi.mocked(searchToolsModule.searchTools).mockResolvedValue({
        matches: [],
        total: 0,
        query: 'test',
        detail_level: 'names_only',
      });
      const handlers = createCodeExecutorHandlers(mockConfig);
      await handlers.handleSearchTools({ query: 'test', service: 42 } as any);
      expect(searchToolsModule.searchTools).toHaveBeenCalledWith(
        expect.objectContaining({ service: undefined })
      );
    });

    it('ignores non-boolean include_deferred param', async () => {
      vi.mocked(searchToolsModule.searchTools).mockResolvedValue({
        matches: [],
        total: 0,
        query: 'test',
        detail_level: 'names_only',
      });
      const handlers = createCodeExecutorHandlers(mockConfig);
      await handlers.handleSearchTools({ query: 'test', include_deferred: 'yes' } as any);
      expect(searchToolsModule.searchTools).toHaveBeenCalledWith(
        expect.objectContaining({ includeDeferred: undefined })
      );
    });
  });

  describe('MCP content array passthrough', () => {
    it('should pass through multi-item content array (text + image)', async () => {
      const mcpContent = [
        { type: 'text', text: 'Screenshot taken' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      ];

      vi.mocked(executorModule.executeCode).mockResolvedValue(createMockExecuteResult(mcpContent));

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({ code: 'return screenshot' });

      expect(result.content).toEqual(mcpContent);
      expect(result.content).toHaveLength(2);
      expect(result.content[0].type).toBe('text');
      expect(result.content[1].type).toBe('image');
    });

    it('should pass through single image content item', async () => {
      const mcpContent = [{ type: 'image', data: 'base64data', mimeType: 'image/jpeg' }];

      vi.mocked(executorModule.executeCode).mockResolvedValue(createMockExecuteResult(mcpContent));

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({ code: 'return img' });

      expect(result.content).toEqual(mcpContent);
    });

    it('should pass through resource content items', async () => {
      const mcpContent = [{ type: 'resource', text: 'resource data' }];

      vi.mocked(executorModule.executeCode).mockResolvedValue(createMockExecuteResult(mcpContent));

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({ code: 'return res' });

      expect(result.content).toEqual(mcpContent);
    });

    it('should NOT pass through arrays of non-MCP objects', async () => {
      const regularArray = [
        { id: 1, name: 'issue' },
        { id: 2, name: 'bug' },
      ];

      vi.mocked(executorModule.executeCode).mockResolvedValue(
        createMockExecuteResult(regularArray)
      );

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({ code: 'return issues' });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe(JSON.stringify(regularArray));
    });

    it('should NOT pass through empty arrays', async () => {
      vi.mocked(executorModule.executeCode).mockResolvedValue(createMockExecuteResult([]));

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({ code: 'return []' });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe('[]');
    });

    it('should NOT pass through arrays with unknown type values', async () => {
      const unknownTypes = [{ type: 'custom', data: 'something' }];

      vi.mocked(executorModule.executeCode).mockResolvedValue(
        createMockExecuteResult(unknownTypes)
      );

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({ code: 'return data' });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe(JSON.stringify(unknownTypes));
    });

    it('should pass through text-only content arrays unchanged', async () => {
      const textOnlyContent = [{ type: 'text', text: 'just text' }];

      vi.mocked(executorModule.executeCode).mockResolvedValue(
        createMockExecuteResult(textOnlyContent)
      );

      const handlers = createCodeExecutorHandlers(mockConfig);
      const result = await handlers.handleExecuteCode({ code: 'return data' });

      expect(result.content).toEqual(textOnlyContent);
    });
  });

  describe('timeout validation edge cases', () => {
    it.each([NaN, Infinity, -Infinity])(
      'should reject %s timeout with error',
      async (invalidValue) => {
        const handlers = createCodeExecutorHandlers(mockConfig);
        const result = await handlers.handleExecuteCode({
          code: 'return "test"',
          timeout_ms: invalidValue,
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('timeout_ms must be a valid number');
        expect(executorModule.executeCode).not.toHaveBeenCalled();
      }
    );
  });
});
