import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Tool } from '@speedwave/mcp-shared';
import type { ToolMetadata } from './hub-types.js';
import type { ToolPolicy } from './hub-tool-policy.js';
import {
  toCamelCase,
  discoverServiceTools,
  mergeToolWithPolicy,
  buildSkeletonFromPolicy,
  validateMergeResult,
  discoverAndMergeService,
  initializeWorker,
  fetchAllTools,
} from './tool-discovery.js';

// Mock auth-tokens
import { getAuthToken } from './auth-tokens.js';
vi.mock('./auth-tokens.js', () => ({
  getAuthToken: vi.fn(() => null),
}));

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
          category: 'write',
          keywords: ['slack', 'send'],
        },
      ];

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 'test-id',
            result: { tools: mockTools },
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

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

    it('returns empty array on non-ok response', async () => {
      process.env.WORKER_SLACK_URL = 'http://mcp-slack:3001';
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      vi.stubGlobal('fetch', mockFetch);

      const tools = await discoverServiceTools('slack');
      expect(tools).toEqual([]);
    });

    it('returns empty array on JSON-RPC error', async () => {
      process.env.WORKER_SLACK_URL = 'http://mcp-slack:3001';
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 'test-id',
            error: { code: -32603, message: 'Internal error' },
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const tools = await discoverServiceTools('slack');
      expect(tools).toEqual([]);
    });

    it('sends Authorization: Bearer header when auth token exists', async () => {
      process.env.WORKER_SLACK_URL = 'http://mcp-slack:3001';
      vi.mocked(getAuthToken).mockReturnValue('discovery-secret');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ jsonrpc: '2.0', id: 'x', result: { tools: [] } }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await discoverServiceTools('slack');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-03-26',
            Authorization: 'Bearer discovery-secret',
          }),
        })
      );

      vi.mocked(getAuthToken).mockReturnValue(null as unknown as undefined);
    });
  });

  describe('mergeToolWithPolicy', () => {
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
      category: 'write',
      keywords: ['redmine', 'issue', 'create'],
      example: 'await redmine.createIssue({ project_id: "foo", subject: "bar" })',
      outputSchema: { type: 'object', properties: { id: { type: 'number' } } },
      inputExamples: [{ description: 'Minimal', input: { project_id: 'foo', subject: 'bar' } }],
    };

    const basePolicy: ToolPolicy = {
      category: 'write',
      deferLoading: false,
    };

    it('produces correct ToolMetadata from worker + policy', () => {
      const result = mergeToolWithPolicy(baseTool, basePolicy, 'redmine', 'createIssue');

      expect(result.name).toBe('createIssue');
      expect(result.description).toBe('Create a new Redmine issue');
      expect(result.service).toBe('redmine');
      expect(result.category).toBe('write');
      expect(result.deferLoading).toBe(false);
      expect(result.keywords).toEqual(['redmine', 'issue', 'create']);
      expect(result.example).toBe(baseTool.example);
      expect(result.outputSchema).toEqual(baseTool.outputSchema);
      expect(result.inputExamples).toEqual(baseTool.inputExamples);
      expect(result.inputSchema).toEqual(baseTool.inputSchema);
    });

    it('uses policy category (hub-authoritative) regardless of worker category', () => {
      const tool: Tool = { ...baseTool, category: 'delete' };
      const result = mergeToolWithPolicy(tool, basePolicy, 'redmine', 'createIssue');
      expect(result.category).toBe('write'); // policy.category, not tool.category
    });

    it('uses policy category when worker has none', () => {
      const tool: Tool = { ...baseTool, category: undefined };
      const result = mergeToolWithPolicy(tool, basePolicy, 'redmine', 'createIssue');
      expect(result.category).toBe('write');
    });

    it('includes policy-only fields (timeoutClass, timeoutMs, osCategory)', () => {
      const policy: ToolPolicy = {
        category: 'read',
        deferLoading: false,
        timeoutClass: 'long',
        timeoutMs: 600_000,
        osCategory: 'reminders',
      };
      const result = mergeToolWithPolicy(baseTool, policy, 'os', 'createReminder');
      expect(result.timeoutClass).toBe('long');
      expect(result.timeoutMs).toBe(600_000);
      expect(result.osCategory).toBe('reminders');
    });

    it('defaults keywords to empty array when worker has none', () => {
      const tool: Tool = { ...baseTool, keywords: undefined };
      const result = mergeToolWithPolicy(tool, basePolicy, 'redmine', 'createIssue');
      expect(result.keywords).toEqual([]);
    });

    it('defaults example to empty string when worker has none', () => {
      const tool: Tool = { ...baseTool, example: undefined };
      const result = mergeToolWithPolicy(tool, basePolicy, 'redmine', 'createIssue');
      expect(result.example).toBe('');
    });
  });

  describe('buildSkeletonFromPolicy', () => {
    it('creates minimal metadata from policy', () => {
      const policy: ToolPolicy = { category: 'read', deferLoading: true };
      const result = buildSkeletonFromPolicy('redmine', 'listIssueIds', policy);

      expect(result.name).toBe('listIssueIds');
      expect(result.service).toBe('redmine');
      expect(result.category).toBe('read');
      expect(result.deferLoading).toBe(true);
      expect(result.description).toContain('listIssueIds');
      expect(result.description).not.toContain('not yet available');
      expect(result.keywords).toEqual([]);
      expect(result.inputSchema).toEqual({ type: 'object', properties: {} });
    });

    it('preserves osCategory from policy', () => {
      const policy: ToolPolicy = {
        category: 'write',
        deferLoading: false,
        timeoutMs: 30_000,
        osCategory: 'calendar',
      };
      const result = buildSkeletonFromPolicy('os', 'createEvent', policy);
      expect(result.osCategory).toBe('calendar');
      expect(result.timeoutMs).toBe(30_000);
    });
  });

  describe('discoverAndMergeService (plugin)', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('accepts all worker tools for plugin services', async () => {
      process.env.WORKER_PRESALE_URL = 'http://mcp-presale:4010';

      const mockTools: Tool[] = [
        {
          name: 'search_customers',
          description: 'Search CRM customers',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          category: 'read',
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
          category: 'write',
        },
      ];

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 'test-id',
            result: { tools: mockTools },
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await discoverAndMergeService('presale');

      expect(Object.keys(result)).toHaveLength(2);
      expect(result['searchCustomers']).toBeDefined();
      expect(result['searchCustomers'].category).toBe('read');
      expect(result['searchCustomers'].service).toBe('presale');
      expect(result['createOrder']).toBeDefined();
      expect(result['createOrder'].category).toBe('write');
    });

    it('returns empty result for plugin with no worker tools', async () => {
      process.env.WORKER_PRESALE_URL = 'http://mcp-presale:4010';

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 'test-id',
            result: { tools: [] },
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await discoverAndMergeService('presale');
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('defaults plugin tool category to read when not set', async () => {
      process.env.WORKER_PRESALE_URL = 'http://mcp-presale:4010';

      const mockTools: Tool[] = [
        {
          name: 'get_status',
          description: 'Get status',
          inputSchema: { type: 'object', properties: {} },
          // no category
        },
      ];

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 'test-id',
            result: { tools: mockTools },
          }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await discoverAndMergeService('presale');
      expect(result['getStatus'].category).toBe('read');
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
      category: 'write',
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

    it('detects invalid category', () => {
      const errors = validateMergeResult('redmine', 'createIssue', {
        ...validMetadata,
        category: 'invalid' as 'read',
      });
      expect(errors.some((e) => e.includes('invalid category'))).toBe(true);
    });
  });

  describe('initializeWorker', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('sends initialize request then notifications/initialized', async () => {
      const fetchCalls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];

      const mockFetch = vi.fn().mockImplementation((url: string, opts: RequestInit) => {
        fetchCalls.push({
          url,
          body: opts.body as string,
          headers: opts.headers as Record<string, string>,
        });
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            jsonrpc: '2.0',
            id: '1',
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'test-worker', version: '1.0.0' },
            },
          }),
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      await initializeWorker('http://mcp-test:3001', headers);

      expect(fetchCalls).toHaveLength(2);

      // First call: initialize request
      const initBody = JSON.parse(fetchCalls[0].body);
      expect(initBody.method).toBe('initialize');
      expect(initBody.params.protocolVersion).toBe('2025-03-26');
      expect(initBody.params.clientInfo.name).toBe('speedwave-hub');
      expect(initBody.id).toBeDefined();

      // Second call: notifications/initialized notification (no id)
      const notifBody = JSON.parse(fetchCalls[1].body);
      expect(notifBody.method).toBe('notifications/initialized');
      expect(notifBody.id).toBeUndefined();
    });

    it('returns session ID from Mcp-Session-Id header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({
          'content-type': 'application/json',
          'Mcp-Session-Id': 'session-abc-123',
        }),
        json: async () => ({
          jsonrpc: '2.0',
          id: '1',
          result: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            serverInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const headers = { 'Content-Type': 'application/json' };
      const sessionId = await initializeWorker('http://mcp-test:3001', headers);

      expect(sessionId).toBe('session-abc-123');

      // Second call should include the session ID
      const notifHeaders = mockFetch.mock.calls[1][1].headers;
      expect(notifHeaders['Mcp-Session-Id']).toBe('session-abc-123');
    });

    it('returns undefined when server does not provide session ID', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          jsonrpc: '2.0',
          id: '1',
          result: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            serverInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const headers = { 'Content-Type': 'application/json' };
      const sessionId = await initializeWorker('http://mcp-test:3001', headers);

      expect(sessionId).toBeUndefined();

      // Second call should NOT include Mcp-Session-Id
      const notifHeaders = mockFetch.mock.calls[1][1].headers;
      expect(notifHeaders).not.toHaveProperty('Mcp-Session-Id');
    });

    it('propagates error when initialize request fails', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
      vi.stubGlobal('fetch', mockFetch);

      const headers = { 'Content-Type': 'application/json' };

      await expect(initializeWorker('http://mcp-test:3001', headers)).rejects.toThrow(
        'Connection refused'
      );
    });
  });

  describe('fetchAllTools', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('returns tools from a single page when no nextCursor', async () => {
      const tools: Tool[] = [
        {
          name: 'list_issues',
          description: 'List issues',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'create_issue',
          description: 'Create issue',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ jsonrpc: '2.0', id: '1', result: { tools } }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const headers = { 'Content-Type': 'application/json' };
      const result = await fetchAllTools('http://mcp-test:3001', headers);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('list_issues');
      expect(result[1].name).toBe('create_issue');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('follows pagination cursors across multiple pages', async () => {
      const page1Tools: Tool[] = [
        {
          name: 'tool_a',
          description: 'Tool A',
          inputSchema: { type: 'object', properties: {} },
        },
      ];
      const page2Tools: Tool[] = [
        {
          name: 'tool_b',
          description: 'Tool B',
          inputSchema: { type: 'object', properties: {} },
        },
      ];
      const page3Tools: Tool[] = [
        {
          name: 'tool_c',
          description: 'Tool C',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        callCount++;
        const body = JSON.parse(opts.body as string);

        if (callCount === 1) {
          expect(body.params).toEqual({});
          return Promise.resolve({
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({
              jsonrpc: '2.0',
              id: body.id,
              result: { tools: page1Tools, nextCursor: 'cursor-page-2' },
            }),
          });
        } else if (callCount === 2) {
          expect(body.params.cursor).toBe('cursor-page-2');
          return Promise.resolve({
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({
              jsonrpc: '2.0',
              id: body.id,
              result: { tools: page2Tools, nextCursor: 'cursor-page-3' },
            }),
          });
        } else {
          expect(body.params.cursor).toBe('cursor-page-3');
          return Promise.resolve({
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({
              jsonrpc: '2.0',
              id: body.id,
              result: { tools: page3Tools },
            }),
          });
        }
      });
      vi.stubGlobal('fetch', mockFetch);

      const headers = { 'Content-Type': 'application/json' };
      const result = await fetchAllTools('http://mcp-test:3001', headers);

      expect(result).toHaveLength(3);
      expect(result.map((t) => t.name)).toEqual(['tool_a', 'tool_b', 'tool_c']);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('returns empty array when worker returns no tools', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ jsonrpc: '2.0', id: '1', result: { tools: [] } }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const headers = { 'Content-Type': 'application/json' };
      const result = await fetchAllTools('http://mcp-test:3001', headers);

      expect(result).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when result has no tools field', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ jsonrpc: '2.0', id: '1', result: {} }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const headers = { 'Content-Type': 'application/json' };
      const result = await fetchAllTools('http://mcp-test:3001', headers);

      expect(result).toEqual([]);
    });

    it('propagates error when fetch fails', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.stubGlobal('fetch', mockFetch);

      const headers = { 'Content-Type': 'application/json' };
      await expect(fetchAllTools('http://mcp-test:3001', headers)).rejects.toThrow('Network error');
    });
  });
});
