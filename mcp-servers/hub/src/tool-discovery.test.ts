import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Tool } from '@speedwave/mcp-shared';
import { LATEST_PROTOCOL_VERSION } from '@speedwave/mcp-shared';
import type { ToolMetadata } from './hub-types.js';
import {
  toCamelCase,
  discoverServiceTools,
  initializeWorker,
  fetchAllTools,
  MAX_PAGINATION_PAGES,
  mergeToolWithMeta,
  validateMergeResult,
  discoverAndMergeService,
} from './tool-discovery.js';

// Mock auth-tokens
import { getAuthToken } from './auth-tokens.js';
vi.mock('./auth-tokens.js', () => ({
  getAuthToken: vi.fn(() => null),
}));

/**
 * Create a mock fetch Response with proper headers support for parseResponse().
 * @param body - JSON body to return
 * @param options - Additional response options (ok, status, headers)
 */
function mockJsonResponse(
  body: unknown,
  options: { ok?: boolean; status?: number; sessionId?: string } = {}
) {
  const { ok = true, status = 200, sessionId } = options;
  const headerMap: Record<string, string> = {
    'content-type': 'application/json',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  };
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: {
      get: (name: string) => headerMap[name.toLowerCase()] ?? null,
    },
  };
}

/**
 * Create a mock fetch function that handles the 3-call sequence:
 * 1. initialize -> success
 * 2. notifications/initialized -> 204
 * 3. tools/list -> tools response
 * @param tools - Tools to return from tools/list
 * @param sessionId - Optional session ID to return from initialize
 */
function createMcpMockFetch(tools: Tool[], sessionId?: string) {
  let callIndex = 0;
  return vi.fn().mockImplementation(() => {
    callIndex++;
    if (callIndex === 1) {
      // initialize response
      return Promise.resolve(
        mockJsonResponse(
          {
            jsonrpc: '2.0',
            id: 'init-id',
            result: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'worker', version: '1.0.0' },
            },
          },
          { sessionId }
        )
      );
    }
    if (callIndex === 2) {
      // notifications/initialized (204-like, no JSON body needed but mock returns ok)
      return Promise.resolve(mockJsonResponse(null, { status: 204 }));
    }
    // tools/list response
    return Promise.resolve(
      mockJsonResponse({
        jsonrpc: '2.0',
        id: 'tools-id',
        result: { tools },
      })
    );
  });
}

describe('tool-discovery', () => {
  describe('toCamelCase', () => {
    it('converts snake_case to camelCase', () => {
      expect(toCamelCase('create_issue')).toBe('createIssue');
      expect(toCamelCase('list_mr_ids')).toBe('listMrIds');
      expect(toCamelCase('get_commit_diff')).toBe('getCommitDiff');
    });

    it('handles single-word names', () => {
      expect(toCamelCase('sync')).toBe('sync');
    });

    it('handles already camelCase', () => {
      expect(toCamelCase('createIssue')).toBe('createIssue');
    });

    it('handles uppercase letters after underscore', () => {
      expect(toCamelCase('get_MR_changes')).toBe('getMRChanges');
    });

    it('handles digits after underscore', () => {
      expect(toCamelCase('get_v2_api')).toBe('getV2Api');
    });
  });

  describe('discoverServiceTools', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('returns empty array when no worker URL configured', async () => {
      delete process.env.WORKER_SLACK_URL;
      const tools = await discoverServiceTools('slack');
      expect(tools).toEqual([]);
    });

    it('returns tools from worker on success', async () => {
      process.env.WORKER_SLACK_URL = 'http://mcp-slack:3001';

      const mockTools: Tool[] = [
        {
          name: 'send_channel',
          description: 'Send a message',
          inputSchema: { type: 'object', properties: { channel: { type: 'string' } } },
          annotations: { readOnlyHint: false, destructiveHint: false },
          keywords: ['slack', 'send'],
        },
      ];

      vi.stubGlobal('fetch', createMcpMockFetch(mockTools));

      const tools = await discoverServiceTools('slack');
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('send_channel');
    });

    it('returns empty array on fetch error', async () => {
      process.env.WORKER_SLACK_URL = 'http://mcp-slack:3001';
      const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
      vi.stubGlobal('fetch', mockFetch);

      const tools = await discoverServiceTools('slack');
      expect(tools).toEqual([]);
    });

    it('returns empty array on JSON-RPC error in tools/list', async () => {
      process.env.WORKER_SLACK_URL = 'http://mcp-slack:3001';

      let callIndex = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callIndex++;
        if (callIndex <= 2) {
          // initialize + notification calls succeed
          return Promise.resolve(
            mockJsonResponse({
              jsonrpc: '2.0',
              id: 'init',
              result: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {},
                serverInfo: { name: 'w', version: '1.0.0' },
              },
            })
          );
        }
        // tools/list returns error
        return Promise.resolve(
          mockJsonResponse({
            jsonrpc: '2.0',
            id: 'test-id',
            error: { code: -32603, message: 'Internal error' },
          })
        );
      });
      vi.stubGlobal('fetch', mockFetch);

      const tools = await discoverServiceTools('slack');
      expect(tools).toEqual([]);
    });

    it('sends Authorization: Bearer header when auth token exists', async () => {
      process.env.WORKER_SLACK_URL = 'http://mcp-slack:3001';
      vi.mocked(getAuthToken).mockReturnValue('discovery-secret');

      const mockFetch = createMcpMockFetch([]);
      vi.stubGlobal('fetch', mockFetch);

      await discoverServiceTools('slack');

      // First call is initialize — should have auth header
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer discovery-secret',
          }),
        })
      );

      vi.mocked(getAuthToken).mockReturnValue(null as unknown as undefined);
    });
  });

  describe('mergeToolWithMeta', () => {
    const baseTool: Tool = {
      name: 'create_issue',
      description: 'Create a new Redmine issue',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          subject: { type: 'string' },
        },
        required: ['project_id', 'subject'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      keywords: ['redmine', 'issue', 'create'],
      example: 'await redmine.createIssue({ project_id: "foo", subject: "bar" })',
      outputSchema: { type: 'object', properties: { id: { type: 'number' } } },
      inputExamples: [{ description: 'Minimal', input: { project_id: 'foo', subject: 'bar' } }],
    };

    it('produces correct ToolMetadata from worker tool with _meta', () => {
      const tool: Tool = {
        ...baseTool,
        _meta: { deferLoading: false },
      };
      const result = mergeToolWithMeta(tool, 'redmine', 'createIssue');

      expect(result.name).toBe('createIssue');
      expect(result.description).toBe('Create a new Redmine issue');
      expect(result.service).toBe('redmine');
      expect(result.deferLoading).toBe(false);
      expect(result.keywords).toEqual(['redmine', 'issue', 'create']);
      expect(result.example).toBe(baseTool.example);
      expect(result.outputSchema).toEqual(baseTool.outputSchema);
      expect(result.inputExamples).toEqual(baseTool.inputExamples);
      expect(result.inputSchema).toEqual(baseTool.inputSchema);
    });

    it('reads timeoutClass, timeoutMs, osCategory from _meta', () => {
      const tool: Tool = {
        ...baseTool,
        _meta: {
          deferLoading: false,
          timeoutClass: 'long',
          timeoutMs: 600_000,
          osCategory: 'reminders',
        },
      };
      const result = mergeToolWithMeta(tool, 'os', 'createReminder');
      expect(result.timeoutClass).toBe('long');
      expect(result.timeoutMs).toBe(600_000);
      expect(result.osCategory).toBe('reminders');
    });

    it('defaults deferLoading to true when _meta is absent', () => {
      const result = mergeToolWithMeta(baseTool, 'redmine', 'createIssue');
      expect(result.deferLoading).toBe(true);
    });

    it('defaults deferLoading to true when _meta has no deferLoading', () => {
      const tool: Tool = { ...baseTool, _meta: { timeoutClass: 'standard' } };
      const result = mergeToolWithMeta(tool, 'redmine', 'createIssue');
      expect(result.deferLoading).toBe(true);
    });

    it('defaults keywords to empty array when worker has none', () => {
      const tool: Tool = { ...baseTool, keywords: undefined };
      const result = mergeToolWithMeta(tool, 'redmine', 'createIssue');
      expect(result.keywords).toEqual([]);
    });

    it('defaults example to empty string when worker has none', () => {
      const tool: Tool = { ...baseTool, example: undefined };
      const result = mergeToolWithMeta(tool, 'redmine', 'createIssue');
      expect(result.example).toBe('');
    });

    it('ignores invalid _meta types and uses defaults', () => {
      const tool: Tool = {
        ...baseTool,
        _meta: {
          deferLoading: 'yes' as unknown,
          timeoutClass: 42 as unknown,
          timeoutMs: -100,
          osCategory: 'invalid' as unknown,
        } as Record<string, unknown>,
      };
      const result = mergeToolWithMeta(tool, 'redmine', 'createIssue');
      expect(result.deferLoading).toBe(true); // default when invalid
      expect(result.timeoutClass).toBeUndefined(); // ignored
      expect(result.timeoutMs).toBeUndefined(); // negative is invalid
      expect(result.osCategory).toBeUndefined(); // invalid category
    });
  });

  describe('discoverAndMergeService', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('accepts all worker tools from any service', async () => {
      process.env.WORKER_PRESALE_URL = 'http://mcp-presale:4010';

      const mockTools: Tool[] = [
        {
          name: 'search_customers',
          description: 'Search CRM customers',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
          keywords: ['crm', 'customer'],
        },
        {
          name: 'create_order',
          description: 'Create a new order',
          inputSchema: {
            type: 'object',
            properties: { customer_id: { type: 'string' } },
            required: ['customer_id'],
          },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        },
      ];

      vi.stubGlobal('fetch', createMcpMockFetch(mockTools));

      const result = await discoverAndMergeService('presale');

      expect(Object.keys(result)).toHaveLength(2);
      expect(result['searchCustomers']).toBeDefined();
      expect(result['searchCustomers'].service).toBe('presale');
      expect(result['createOrder']).toBeDefined();
      expect(result['createOrder'].service).toBe('presale');
    });

    it('returns empty result when worker has no tools', async () => {
      process.env.WORKER_PRESALE_URL = 'http://mcp-presale:4010';

      vi.stubGlobal('fetch', createMcpMockFetch([]));

      const result = await discoverAndMergeService('presale');
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('accepts tools without annotations', async () => {
      process.env.WORKER_PRESALE_URL = 'http://mcp-presale:4010';

      const mockTools: Tool[] = [
        {
          name: 'get_status',
          description: 'Get status',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      vi.stubGlobal('fetch', createMcpMockFetch(mockTools));

      const result = await discoverAndMergeService('presale');
      expect(result['getStatus']).toBeDefined();
      expect(result['getStatus'].service).toBe('presale');
    });

    it('reads _meta fields from worker tools', async () => {
      process.env.WORKER_REDMINE_URL = 'http://mcp-redmine:3003';

      const mockTools: Tool[] = [
        {
          name: 'create_issue',
          description: 'Create a Redmine issue',
          inputSchema: { type: 'object', properties: { subject: { type: 'string' } } },
          _meta: { deferLoading: false, timeoutClass: 'standard' },
        },
      ];

      vi.stubGlobal('fetch', createMcpMockFetch(mockTools));

      const result = await discoverAndMergeService('redmine');
      expect(result['createIssue']).toBeDefined();
      expect(result['createIssue'].deferLoading).toBe(false);
      expect(result['createIssue'].timeoutClass).toBe('standard');
    });

    it('defaults deferLoading to true when _meta is absent', async () => {
      process.env.WORKER_SLACK_URL = 'http://mcp-slack:3001';

      const mockTools: Tool[] = [
        {
          name: 'send_channel',
          description: 'Send a message',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      vi.stubGlobal('fetch', createMcpMockFetch(mockTools));

      const result = await discoverAndMergeService('slack');
      expect(result['sendChannel']).toBeDefined();
      expect(result['sendChannel'].deferLoading).toBe(true);
    });

    it('ignores invalid _meta types and applies defaults', async () => {
      process.env.WORKER_SLACK_URL = 'http://mcp-slack:3001';

      const mockTools: Tool[] = [
        {
          name: 'send_channel',
          description: 'Send a message',
          inputSchema: { type: 'object', properties: {} },
          _meta: {
            deferLoading: 'yes' as unknown,
            timeoutClass: 123 as unknown,
          } as Record<string, unknown>,
        },
      ];

      vi.stubGlobal('fetch', createMcpMockFetch(mockTools));

      const result = await discoverAndMergeService('slack');
      expect(result['sendChannel']).toBeDefined();
      expect(result['sendChannel'].deferLoading).toBe(true); // default
      expect(result['sendChannel'].timeoutClass).toBeUndefined(); // ignored
    });
  });

  describe('validateMergeResult', () => {
    const validMetadata: ToolMetadata = {
      name: 'createIssue',
      description: 'Create a new issue',
      keywords: ['issue'],
      inputSchema: { type: 'object', properties: {} },
      example: '',
      service: 'redmine',
      deferLoading: false,
    };

    it('returns empty errors for valid metadata', () => {
      expect(validateMergeResult('redmine', 'createIssue', validMetadata)).toEqual([]);
    });

    it('detects missing name', () => {
      const errors = validateMergeResult('redmine', 'createIssue', {
        ...validMetadata,
        name: '',
      });
      expect(errors.some((e) => e.includes('missing name'))).toBe(true);
    });

    it('detects name mismatch', () => {
      const errors = validateMergeResult('redmine', 'createIssue', {
        ...validMetadata,
        name: 'wrongName',
      });
      expect(errors.some((e) => e.includes('name mismatch'))).toBe(true);
    });

    it('detects missing description', () => {
      const errors = validateMergeResult('redmine', 'createIssue', {
        ...validMetadata,
        description: '',
      });
      expect(errors.some((e) => e.includes('missing description'))).toBe(true);
    });

    it('detects service mismatch', () => {
      const errors = validateMergeResult('redmine', 'createIssue', {
        ...validMetadata,
        service: 'gitlab',
      });
      expect(errors.some((e) => e.includes('service mismatch'))).toBe(true);
    });
  });

  describe('initializeWorker', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('sends initialize and notifications/initialized', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockJsonResponse({
            jsonrpc: '2.0',
            id: 'init',
            result: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {},
              serverInfo: { name: 'w', version: '1.0.0' },
            },
          })
        )
        .mockResolvedValueOnce(mockJsonResponse(null, { status: 204 }));
      vi.stubGlobal('fetch', mockFetch);

      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      await initializeWorker('http://mcp-test:3001', headers);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      // First call: initialize
      const initBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(initBody.method).toBe('initialize');
      expect(initBody.params.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
      // Second call: notifications/initialized
      const notifBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(notifBody.method).toBe('notifications/initialized');
    });

    it('returns session ID from response header', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockJsonResponse(
            {
              jsonrpc: '2.0',
              id: 'init',
              result: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {},
                serverInfo: { name: 'w', version: '1.0.0' },
              },
            },
            { sessionId: '550e8400-e29b-41d4-a716-446655440000' }
          )
        )
        .mockResolvedValueOnce(mockJsonResponse(null));
      vi.stubGlobal('fetch', mockFetch);

      const sessionId = await initializeWorker('http://mcp-test:3001', {
        'Content-Type': 'application/json',
      });

      expect(sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('returns undefined when no session header', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockJsonResponse({
            jsonrpc: '2.0',
            id: 'init',
            result: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {},
              serverInfo: { name: 'w', version: '1.0.0' },
            },
          })
        )
        .mockResolvedValueOnce(mockJsonResponse(null));
      vi.stubGlobal('fetch', mockFetch);

      const sessionId = await initializeWorker('http://mcp-test:3001', {
        'Content-Type': 'application/json',
      });

      expect(sessionId).toBeUndefined();
    });

    it('includes session ID in notifications/initialized when present', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockJsonResponse(
            {
              jsonrpc: '2.0',
              id: 'init',
              result: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {},
                serverInfo: { name: 'w', version: '1.0.0' },
              },
            },
            { sessionId: 'abc-session' }
          )
        )
        .mockResolvedValueOnce(mockJsonResponse(null));
      vi.stubGlobal('fetch', mockFetch);

      await initializeWorker('http://mcp-test:3001', { 'Content-Type': 'application/json' });

      // Second call should include session header
      const notifHeaders = mockFetch.mock.calls[1][1].headers;
      expect(notifHeaders['Mcp-Session-Id']).toBe('abc-session');
    });

    it('throws when initialize returns JSON-RPC error', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockJsonResponse({
          jsonrpc: '2.0',
          id: 'init',
          error: { code: -32600, message: 'Invalid Request' },
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      await expect(
        initializeWorker('http://mcp-test:3001', { 'Content-Type': 'application/json' })
      ).rejects.toThrow('Worker initialize failed: [-32600] Invalid Request');

      // Should NOT send notifications/initialized after error
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('logs warning when notifications/initialized returns non-ok status', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockJsonResponse({
            jsonrpc: '2.0',
            id: 'init',
            result: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {},
              serverInfo: { name: 'w', version: '1.0.0' },
            },
          })
        )
        .mockResolvedValueOnce(mockJsonResponse(null, { ok: false, status: 500 }));
      vi.stubGlobal('fetch', mockFetch);

      // Should not throw — notification failures are logged, not thrown
      const sessionId = await initializeWorker('http://mcp-test:3001', {
        'Content-Type': 'application/json',
      });

      expect(sessionId).toBeUndefined();
      const notifWarns = warnSpy.mock.calls
        .map((c) => c.join(' '))
        .filter((msg) => msg.includes('notifications/initialized returned 500'));
      expect(notifWarns).toHaveLength(1);

      warnSpy.mockRestore();
    });

    it('does not log when notifications/initialized returns ok', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockJsonResponse({
            jsonrpc: '2.0',
            id: 'init',
            result: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {},
              serverInfo: { name: 'w', version: '1.0.0' },
            },
          })
        )
        .mockResolvedValueOnce(mockJsonResponse(null, { ok: true, status: 204 }));
      vi.stubGlobal('fetch', mockFetch);

      await initializeWorker('http://mcp-test:3001', { 'Content-Type': 'application/json' });

      const notifWarns = warnSpy.mock.calls
        .map((c) => c.join(' '))
        .filter((msg) => msg.includes('notifications/initialized'));
      expect(notifWarns).toHaveLength(0);

      warnSpy.mockRestore();
    });
  });

  describe('fetchAllTools', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('fetches single page of tools', async () => {
      const tools: Tool[] = [
        {
          name: 'tool_a',
          description: 'Tool A',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(mockJsonResponse({ jsonrpc: '2.0', id: 'x', result: { tools } }));
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchAllTools('http://mcp-test:3001', {
        'Content-Type': 'application/json',
      });

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('tool_a');
    });

    it('follows pagination cursor across multiple pages', async () => {
      const page1Tools: Tool[] = [
        { name: 'tool_1', description: 'Tool 1', inputSchema: { type: 'object', properties: {} } },
      ];
      const page2Tools: Tool[] = [
        { name: 'tool_2', description: 'Tool 2', inputSchema: { type: 'object', properties: {} } },
      ];

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockJsonResponse({
            jsonrpc: '2.0',
            id: 'p1',
            result: { tools: page1Tools, nextCursor: 'cursor-1' },
          })
        )
        .mockResolvedValueOnce(
          mockJsonResponse({
            jsonrpc: '2.0',
            id: 'p2',
            result: { tools: page2Tools },
          })
        );
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchAllTools('http://mcp-test:3001', {
        'Content-Type': 'application/json',
      });

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('tool_1');
      expect(result[1].name).toBe('tool_2');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Second call should include cursor
      const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body2.params.cursor).toBe('cursor-1');
    });

    it('throws on non-ok response', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(mockJsonResponse(null, { ok: false, status: 500 }));
      vi.stubGlobal('fetch', mockFetch);

      await expect(
        fetchAllTools('http://mcp-test:3001', { 'Content-Type': 'application/json' })
      ).rejects.toThrow('Worker returned 500');
    });

    it('throws on JSON-RPC error', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        mockJsonResponse({
          jsonrpc: '2.0',
          id: 'x',
          error: { code: -32603, message: 'Internal error' },
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      await expect(
        fetchAllTools('http://mcp-test:3001', { 'Content-Type': 'application/json' })
      ).rejects.toThrow('Internal error');
    });

    it('returns empty array when worker has no tools', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockJsonResponse({ jsonrpc: '2.0', id: 'x', result: { tools: [] } })
        );
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchAllTools('http://mcp-test:3001', {
        'Content-Type': 'application/json',
      });

      expect(result).toEqual([]);
    });

    it('breaks after MAX_PAGINATION_PAGES and returns partial results', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Every page returns a nextCursor to simulate infinite pagination
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve(
          mockJsonResponse({
            jsonrpc: '2.0',
            id: 'page',
            result: {
              tools: [
                {
                  name: 'tool_x',
                  description: 'X',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
              nextCursor: 'next',
            },
          })
        );
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await fetchAllTools('http://mcp-test:3001', {
        'Content-Type': 'application/json',
      });

      // Should have exactly MAX_PAGINATION_PAGES tools (1 per page)
      expect(result).toHaveLength(MAX_PAGINATION_PAGES);
      expect(mockFetch).toHaveBeenCalledTimes(MAX_PAGINATION_PAGES);

      // Should have logged a warning
      const paginationWarns = warnSpy.mock.calls
        .map((c) => c.join(' '))
        .filter((msg) => msg.includes('Pagination limit reached'));
      expect(paginationWarns).toHaveLength(1);
      expect(paginationWarns[0]).toContain(`${MAX_PAGINATION_PAGES} pages`);

      warnSpy.mockRestore();
    });

    it('MAX_PAGINATION_PAGES is a positive number', () => {
      expect(MAX_PAGINATION_PAGES).toBeGreaterThan(0);
      expect(Number.isInteger(MAX_PAGINATION_PAGES)).toBe(true);
    });
  });
});
