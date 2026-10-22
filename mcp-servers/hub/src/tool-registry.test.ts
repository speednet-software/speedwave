/**
 * Tool Registry Tests
 *
 * Tests for the dynamic tool registry that merges worker metadata with hub policies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TOOL_REGISTRY,
  SERVICE_NAMES,
  getToolMetadata,
  getServiceMethods,
  getLongTimeoutTools,
  getRequiredTimeoutClass,
  getExecutionTimeout,
  buildServiceBridge,
  buildExecutorWrappers,
  getEnabledServices,
  getDisabledOsCategories,
  resetServiceCaches,
  validateRegistry,
  getRegistryStats,
  stopBackgroundRefresh,
  initializeRegistry,
  refreshServiceTools,
  _setDiscoveryRetryDelaysForTesting,
  _setEmptyRecheckBaseMsForTesting,
  CUSTOM_REFRESH_MS,
} from './tool-registry.js';
import { TIMEOUTS, LATEST_PROTOCOL_VERSION, type Tool } from '@speedwave/mcp-shared';
import type { ToolMetadata } from './hub-types.js';
import { populateRegistryWithMockTools, _resetRegistryForTesting } from './test-helpers.js';

vi.mock('./tool-discovery.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./tool-discovery.js')>();
  return {
    ...original,
    discoverAndMergeService: vi.fn().mockResolvedValue({}),
  };
});

describe('tool-registry', () => {
  beforeEach(() => {
    _resetRegistryForTesting();
    populateRegistryWithMockTools();
    _setDiscoveryRetryDelaysForTesting([0, 0, 0]);
  });

  afterEach(() => {
    stopBackgroundRefresh();
  });

  describe('TOOL_REGISTRY', () => {
    it('should contain all expected services', () => {
      const expectedServices = ['slack', 'sharepoint', 'redmine', 'gitlab', 'os'];
      for (const service of expectedServices) {
        expect(TOOL_REGISTRY[service]).toBeDefined();
        expect(Object.keys(TOOL_REGISTRY[service]).length).toBeGreaterThan(0);
      }
    });

    it('should have SERVICE_NAMES matching mock services after populate', () => {
      const expected = ['slack', 'sharepoint', 'redmine', 'gitlab', 'os'];
      expect([...SERVICE_NAMES].sort()).toEqual(expected.sort());
    });
  });

  describe('getToolMetadata', () => {
    it('should return metadata for existing tool', () => {
      const meta = getToolMetadata('redmine', 'createIssue');
      expect(meta).toBeDefined();
      expect(meta?.name).toBe('createIssue');
      expect(meta?.service).toBe('redmine');
    });

    it('should return undefined for non-existing tool', () => {
      expect(getToolMetadata('redmine', 'nonExistentTool')).toBeUndefined();
      expect(getToolMetadata('nonExistentService', 'createIssue')).toBeUndefined();
    });
  });

  describe('getServiceMethods', () => {
    it('should return all methods for a service', () => {
      const slackMethods = getServiceMethods('slack');
      expect(slackMethods).toContain('sendChannel');
      expect(slackMethods).toContain('listChannelIds');
      expect(slackMethods.length).toBeGreaterThanOrEqual(4);
    });

    it('should return empty array for non-existing service', () => {
      expect(getServiceMethods('nonExistentService')).toEqual([]);
    });
  });

  describe('getLongTimeoutTools', () => {
    it('should return tools with timeoutClass long', () => {
      const longTools = getLongTimeoutTools();
      expect(longTools).toContainEqual({ service: 'sharepoint', method: 'downloadFile' });
      expect(longTools).toContainEqual({ service: 'sharepoint', method: 'uploadFile' });
    });

    it('should not include standard timeout tools', () => {
      const longTools = getLongTimeoutTools();
      const hasStandardSlackTool = longTools.some(
        (t) => t.service === 'slack' && t.method === 'sendChannel'
      );
      expect(hasStandardSlackTool).toBe(false);
    });
  });

  describe('getRequiredTimeoutClass', () => {
    it('should detect sharepoint.downloadFile as long', () => {
      expect(getRequiredTimeoutClass('await sharepoint.downloadFile()')).toBe('long');
    });

    it('should detect sharepoint.uploadFile as long', () => {
      expect(getRequiredTimeoutClass('await sharepoint.uploadFile({ path: "/test" })')).toBe(
        'long'
      );
    });

    it('should return standard for regular code', () => {
      expect(getRequiredTimeoutClass('return 1 + 1')).toBe('standard');
    });

    it('should return standard for non-long-timeout service calls', () => {
      expect(getRequiredTimeoutClass('await redmine.listIssueIds()')).toBe('standard');
    });

    it('should handle code with multiple tool calls', () => {
      const code = `
        const issues = await redmine.listIssueIds();
        await sharepoint.downloadFile({ remote_path: "/test" });
        return issues;
      `;
      expect(getRequiredTimeoutClass(code)).toBe('long');
    });

    it('should handle whitespace variations', () => {
      expect(getRequiredTimeoutClass('sharepoint . downloadFile()')).toBe('long');
    });
  });

  describe('getExecutionTimeout', () => {
    it('should return LONG_OPERATION_MS for code with long-timeout tools', () => {
      const result = getExecutionTimeout('await sharepoint.downloadFile()', TIMEOUTS.EXECUTION_MS);
      expect(result.timeoutMs).toBe(TIMEOUTS.LONG_OPERATION_MS);
      expect(result.timeoutClass).toBe('long');
    });

    it('should return default timeout for standard code', () => {
      const result = getExecutionTimeout('return 1 + 1', TIMEOUTS.EXECUTION_MS);
      expect(result.timeoutMs).toBe(TIMEOUTS.EXECUTION_MS);
      expect(result.timeoutClass).toBe('standard');
    });
  });

  describe('buildServiceBridge', () => {
    it('should generate bridge with all service methods', () => {
      const mockCallWorker = vi.fn().mockResolvedValue({ success: true });
      const bridge = buildServiceBridge('slack', mockCallWorker);

      expect(Object.keys(bridge)).toContain('sendChannel');
      expect(Object.keys(bridge)).toContain('listChannelIds');
      expect(Object.keys(bridge)).toContain('getChannelMessages');
      expect(Object.keys(bridge)).toContain('getUsers');
    });

    it('should call worker with camelCase tool name', async () => {
      const mockCallWorker = vi.fn().mockResolvedValue({ success: true });
      const bridge = buildServiceBridge('redmine', mockCallWorker);

      await bridge.createRelation({ issue_id: 1, issue_to_id: 2 });

      expect(mockCallWorker).toHaveBeenCalledWith(
        'redmine',
        'createRelation',
        { issue_id: 1, issue_to_id: 2 },
        undefined
      );
    });

    it('should handle empty params', async () => {
      const mockCallWorker = vi.fn().mockResolvedValue({ ids: [] });
      const bridge = buildServiceBridge('redmine', mockCallWorker);

      await bridge.listIssueIds();

      expect(mockCallWorker).toHaveBeenCalledWith('redmine', 'listIssueIds', {}, undefined);
    });

    it('builds prototype-less bridges and wrappers that keep a __proto__ method as own data', async () => {
      const registry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
      const tools: Record<string, ToolMetadata> = Object.create(null);
      for (const name of ['__proto__', 'constructor']) {
        tools[name] = {
          ...registry.slack.sendChannel,
          name,
          workerToolName: `${name}_worker`,
          service: 'evil',
        };
      }
      registry.evil = tools;
      const mockCallWorker = vi.fn().mockResolvedValue({ ok: true });
      const bridge = buildServiceBridge('evil', mockCallWorker);
      expect(Object.getPrototypeOf(bridge)).toBeNull();
      expect(Object.keys(bridge).sort()).toEqual(['__proto__', 'constructor']);
      const wrappers = buildExecutorWrappers(
        'evil',
        bridge,
        (_s, _t, fn) => fn,
        (params) => params,
        (call) => call()
      );
      expect(Object.getPrototypeOf(wrappers)).toBeNull();
      await wrappers['__proto__']({ a: 1 });
      await wrappers.constructor({});
      expect(mockCallWorker.mock.calls.map((c) => c[1])).toEqual([
        '__proto___worker',
        'constructor_worker',
      ]);
      delete registry.evil;
    });

    it('should throw for unknown service', () => {
      const mockCallWorker = vi.fn();
      expect(() => buildServiceBridge('nonExistent', mockCallWorker)).toThrow(
        'Unknown service in registry'
      );
    });

    it('should pass timeout options when getTimeoutMs is provided', async () => {
      const mockCallWorker = vi.fn().mockResolvedValue({ success: true });
      const getTimeoutMs = vi.fn().mockReturnValue(5000);
      const bridge = buildServiceBridge('slack', mockCallWorker, getTimeoutMs);

      await bridge.sendChannel({ channel: 'test' });

      expect(getTimeoutMs).toHaveBeenCalled();
      expect(mockCallWorker).toHaveBeenCalledWith(
        'slack',
        'sendChannel',
        { channel: 'test' },
        { timeoutMs: 5000 }
      );
    });
  });

  describe('buildExecutorWrappers', () => {
    it('should generate wrappers for all service methods', () => {
      const slackMethods = getServiceMethods('slack');
      const mockBridge: Record<string, ReturnType<typeof vi.fn>> = {};
      for (const m of slackMethods) {
        mockBridge[m] = vi.fn();
      }
      const mockWrapWithAudit = vi.fn((svc, tool, fn) => fn);
      const mockPrepareParams = vi.fn((p) => p);
      const mockWrapBridgeCall = vi.fn((fn) => fn());

      const wrappers = buildExecutorWrappers(
        'slack',
        mockBridge,
        mockWrapWithAudit,
        mockPrepareParams,
        mockWrapBridgeCall
      );

      expect(Object.keys(wrappers)).toContain('sendChannel');
      expect(Object.keys(wrappers)).toContain('listChannelIds');
    });

    it('should pass service and tool name to wrapWithAudit', () => {
      const slackMethods = getServiceMethods('slack');
      const mockBridge: Record<string, ReturnType<typeof vi.fn>> = {};
      for (const m of slackMethods) {
        mockBridge[m] = vi.fn();
      }
      const wrapWithAuditCalls: Array<{ service: string; tool: string }> = [];
      const mockWrapWithAudit = vi.fn((svc, tool, fn) => {
        wrapWithAuditCalls.push({ service: svc, tool });
        return fn;
      });
      const mockPrepareParams = vi.fn((p) => p);
      const mockWrapBridgeCall = vi.fn((fn) => fn());

      buildExecutorWrappers(
        'slack',
        mockBridge,
        mockWrapWithAudit,
        mockPrepareParams,
        mockWrapBridgeCall
      );

      const sendCall = wrapWithAuditCalls.find((c) => c.tool === 'sendChannel');
      expect(sendCall?.service).toBe('slack');
    });

    it('should throw when bridge method is missing', () => {
      const incompleteBridge = { sendChannel: vi.fn() };
      const mockWrapWithAudit = vi.fn((svc, tool, fn) => fn);
      const mockPrepareParams = vi.fn((p) => p);
      const mockWrapBridgeCall = vi.fn((fn) => fn());

      expect(() =>
        buildExecutorWrappers(
          'slack',
          incompleteBridge,
          mockWrapWithAudit,
          mockPrepareParams,
          mockWrapBridgeCall
        )
      ).toThrow('Bridge method not found');
    });
  });

  describe('validateRegistry', () => {
    it('should return empty array for valid registry', () => {
      const errors = validateRegistry();
      expect(errors).toEqual([]);
    });

    it('should validate all tools have required fields', () => {
      for (const [service, tools] of Object.entries(TOOL_REGISTRY)) {
        for (const [methodName, metadata] of Object.entries(tools)) {
          expect(metadata.name).toBe(methodName);
          expect(metadata.service).toBe(service);
          expect(metadata.description).toBeTruthy();
          expect(metadata.inputSchema).toBeDefined();
        }
      }
    });
  });

  describe('getRegistryStats', () => {
    it('should return correct statistics', () => {
      const stats = getRegistryStats();
      expect(stats.services.slack).toBe(4);
      expect(stats.services.redmine).toBe(23);
      expect(stats.services.gitlab).toBe(46);
      expect(stats.services.sharepoint).toBe(5);
      expect(stats.services.os).toBe(26);
      expect(stats.total).toBe(104);
    });
  });

  describe('dynamic SERVICE_NAMES', () => {
    const savedEnabled = process.env.ENABLED_SERVICES;

    afterEach(() => {
      if (savedEnabled === undefined) {
        delete process.env.ENABLED_SERVICES;
      } else {
        process.env.ENABLED_SERVICES = savedEnabled;
      }
      resetServiceCaches();
      _resetRegistryForTesting();
      populateRegistryWithMockTools();
    });

    it('should include plugin services after initializeRegistry', async () => {
      _resetRegistryForTesting();
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack,example-plugin';

      await initializeRegistry();

      expect([...SERVICE_NAMES]).toContain('example-plugin');
      expect([...SERVICE_NAMES]).toContain('slack');
    });

    it('should reset SERVICE_NAMES to empty on _resetRegistryForTesting', () => {
      _resetRegistryForTesting();
      expect([...SERVICE_NAMES]).toEqual([]);
    });
  });

  describe('registry consistency with existing bridges', () => {
    it('should have all methods that were in http-bridge.ts', () => {
      const slackMethods = getServiceMethods('slack');
      expect(slackMethods).toContain('sendChannel');
      expect(slackMethods).toContain('listChannelIds');
      expect(slackMethods).toContain('getChannelMessages');
      expect(slackMethods).toContain('getUsers');

      const redmineMethods = getServiceMethods('redmine');
      expect(redmineMethods).toContain('listRelations');
      expect(redmineMethods).toContain('createRelation');
      expect(redmineMethods).toContain('deleteRelation');

      const sharepointMethods = getServiceMethods('sharepoint');
      expect(sharepointMethods).toContain('listFileIds');
      expect(sharepointMethods).toContain('getFileFull');
      expect(sharepointMethods).toContain('downloadFile');
      expect(sharepointMethods).toContain('uploadFile');
      expect(sharepointMethods).toContain('getCurrentUser');
    });
  });

  describe('getEnabledServices', () => {
    const originalEnv = process.env.ENABLED_SERVICES;

    beforeEach(() => {
      resetServiceCaches();
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.ENABLED_SERVICES;
      } else {
        process.env.ENABLED_SERVICES = originalEnv;
      }
      resetServiceCaches();
    });

    it('returns empty set when env var is not set (fail-closed)', () => {
      delete process.env.ENABLED_SERVICES;
      const enabled = getEnabledServices();
      expect(enabled.size).toBe(0);
    });

    it('returns only specified services when env var is set', () => {
      process.env.ENABLED_SERVICES = 'slack,gitlab';
      const enabled = getEnabledServices();
      expect(enabled.has('slack')).toBe(true);
      expect(enabled.has('gitlab')).toBe(true);
      expect(enabled.has('redmine')).toBe(false);
    });

    it('handles whitespace in env var values', () => {
      process.env.ENABLED_SERVICES = ' slack , gitlab ';
      const enabled = getEnabledServices();
      expect(enabled.has('slack')).toBe(true);
      expect(enabled.has('gitlab')).toBe(true);
      expect(enabled.size).toBe(2);
    });

    it('handles empty env var', () => {
      process.env.ENABLED_SERVICES = '';
      const enabled = getEnabledServices();
      expect(enabled.size).toBe(0);
    });
  });

  describe('getDisabledOsCategories', () => {
    const originalEnv = process.env.DISABLED_OS_SERVICES;

    beforeEach(() => {
      resetServiceCaches();
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.DISABLED_OS_SERVICES;
      } else {
        process.env.DISABLED_OS_SERVICES = originalEnv;
      }
      resetServiceCaches();
    });

    it('returns empty set when env var is not set', () => {
      delete process.env.DISABLED_OS_SERVICES;
      const disabled = getDisabledOsCategories();
      expect(disabled.size).toBe(0);
    });

    it('returns specified categories when env var is set', () => {
      process.env.DISABLED_OS_SERVICES = 'reminders,mail';
      const disabled = getDisabledOsCategories();
      expect(disabled.has('reminders')).toBe(true);
      expect(disabled.has('mail')).toBe(true);
      expect(disabled.has('calendar')).toBe(false);
    });
  });

  describe('buildExecutorWrappers with disabledOsCategories', () => {
    const mockWrapWithAudit = vi.fn(
      (_svc: string, _tool: string, fn: (p?: Record<string, unknown>) => Promise<unknown>) => fn
    );
    const mockPrepareParams = vi.fn(<T>(p: T) => p);
    const mockWrapBridgeCall = vi.fn(<T>(fn: () => Promise<T>) => fn());

    it('excludes OS tools with disabled categories', () => {
      const osMethods = getServiceMethods('os');
      const bridge: Record<string, () => Promise<unknown>> = {};
      for (const method of osMethods) {
        bridge[method] = vi.fn().mockResolvedValue({ ok: true });
      }

      const disabledOs = new Set(['reminders']);
      const wrappers = buildExecutorWrappers(
        'os',
        bridge,
        mockWrapWithAudit as never,
        mockPrepareParams,
        mockWrapBridgeCall as never,
        disabledOs
      );

      const osTools = TOOL_REGISTRY['os'];
      const reminderTools = Object.entries(osTools)
        .filter(([, meta]) => meta.osCategory === 'reminders')
        .map(([name]) => name);

      for (const tool of reminderTools) {
        expect(wrappers[tool]).toBeUndefined();
      }

      const calendarTools = Object.entries(osTools)
        .filter(([, meta]) => meta.osCategory === 'calendar')
        .map(([name]) => name);

      for (const tool of calendarTools) {
        expect(wrappers[tool]).toBeDefined();
      }
    });

    it('includes all OS tools when no categories disabled', () => {
      const osMethods = getServiceMethods('os');
      const bridge: Record<string, () => Promise<unknown>> = {};
      for (const method of osMethods) {
        bridge[method] = vi.fn().mockResolvedValue({ ok: true });
      }

      const wrappers = buildExecutorWrappers(
        'os',
        bridge,
        mockWrapWithAudit as never,
        mockPrepareParams,
        mockWrapBridgeCall as never,
        new Set()
      );

      expect(Object.keys(wrappers).length).toBe(osMethods.length);
    });
  });

  describe('graceful degradation', () => {
    const mockTool: ToolMetadata = {
      name: 'listItems',
      description: 'List items',
      keywords: ['list'],
      inputSchema: { type: 'object', properties: {} },
      example: '',
      service: 'redmine',
      deferLoading: false,
    };

    it('worker unavailable at startup → empty registry for that service', async () => {
      _resetRegistryForTesting();

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      vi.mocked(discoverAndMergeService).mockRejectedValueOnce(new Error('ECONNREFUSED'));

      process.env.ENABLED_SERVICES = 'redmine';
      await initializeRegistry();

      expect(TOOL_REGISTRY['redmine']).toBeDefined();
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(0);
    });

    it('worker returns after refresh → tools populated', async () => {
      _resetRegistryForTesting();

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      vi.mocked(discoverAndMergeService).mockRejectedValueOnce(new Error('ECONNREFUSED'));

      process.env.ENABLED_SERVICES = 'redmine';
      await initializeRegistry();
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(0);

      vi.mocked(discoverAndMergeService).mockResolvedValueOnce({ listItems: mockTool });
      await refreshServiceTools('redmine');
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(1);
      expect(TOOL_REGISTRY['redmine']['listItems'].name).toBe('listItems');
    });

    describe('through the real discovery path', () => {
      const savedWorkerUrl = process.env.WORKER_REDMINE_URL;
      let worker: { up: boolean; tools: Tool[]; hang: boolean };
      let fetchMock: ReturnType<typeof vi.fn>;

      const workerTool = (name: string): Tool => ({
        name,
        description: `${name} tool`,
        inputSchema: { type: 'object', properties: {} },
        _meta: { deferLoading: false },
      });

      const toolsListCalls = () =>
        fetchMock.mock.calls.filter(
          ([, init]) => JSON.parse(String(init?.body ?? '{}')).method === 'tools/list'
        ).length;

      beforeEach(async () => {
        _resetRegistryForTesting();
        process.env.ENABLED_SERVICES = 'redmine';
        process.env.WORKER_REDMINE_URL = 'http://mcp-redmine:3000';
        worker = { up: true, tools: [workerTool('list_items')], hang: false };
        fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
          if (worker.hang) return new Promise<Response>(() => {});
          if (!worker.up) {
            throw new TypeError('fetch failed', {
              cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
            });
          }
          const message = JSON.parse(String(init?.body ?? '{}'));
          const respond = (result: unknown) =>
            new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          if (message.method === 'initialize') {
            return respond({
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {},
              serverInfo: { name: 'mcp-redmine', version: '1.0.0' },
            });
          }
          if (message.method === 'notifications/initialized') {
            return new Response(null, { status: 202 });
          }
          return respond({ tools: worker.tools });
        });
        vi.stubGlobal('fetch', fetchMock);
        const actual =
          await vi.importActual<typeof import('./tool-discovery.js')>('./tool-discovery.js');
        const { discoverAndMergeService } = await import('./tool-discovery.js');
        vi.mocked(discoverAndMergeService).mockImplementation(actual.discoverAndMergeService);
      });

      afterEach(async () => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        const { discoverAndMergeService } = await import('./tool-discovery.js');
        vi.mocked(discoverAndMergeService).mockReset().mockResolvedValue({});
        if (savedWorkerUrl === undefined) delete process.env.WORKER_REDMINE_URL;
        else process.env.WORKER_REDMINE_URL = savedWorkerUrl;
        _setEmptyRecheckBaseMsForTesting(10_000);
      });

      it('worker refused during a background refresh → keeps last known tools', async () => {
        vi.useFakeTimers();
        await initializeRegistry();
        expect(Object.keys(TOOL_REGISTRY['redmine'])).toEqual(['listItems']);

        worker.up = false;
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
        warnSpy.mockRestore();

        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(Object.keys(TOOL_REGISTRY['redmine'])).toEqual(['listItems']);
        expect(TOOL_REGISTRY['redmine']['listItems'].name).toBe('listItems');
      });

      it('warns once when a worker starts failing and once when it recovers', async () => {
        await initializeRegistry();
        worker.up = false;
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await refreshServiceTools('redmine');
        await refreshServiceTools('redmine');
        const failing = warnSpy.mock.calls.filter((c) => String(c[0]).includes('Refresh failed'));
        expect(failing).toHaveLength(1);
        expect(String(failing[0][1])).toContain('fetch failed');

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        worker.up = true;
        await refreshServiceTools('redmine');
        await refreshServiceTools('redmine');
        const recovered = logSpy.mock.calls.filter((c) => String(c[0]).includes('reachable again'));
        expect(recovered).toHaveLength(1);
        expect(
          warnSpy.mock.calls.filter((c) => String(c[0]).includes('Refresh failed'))
        ).toHaveLength(1);
        logSpy.mockRestore();
        warnSpy.mockRestore();
      });

      it('an empty tools/list replaces the entry with no tools', async () => {
        await initializeRegistry();
        worker.tools = [];

        await refreshServiceTools('redmine');

        expect(TOOL_REGISTRY['redmine']).toEqual({});
      });

      it('a failure while the entry is empty arms the recheck, which restores the tools', async () => {
        _setEmptyRecheckBaseMsForTesting(5);
        await initializeRegistry();
        worker.tools = [];
        await refreshServiceTools('redmine');
        expect(TOOL_REGISTRY['redmine']).toEqual({});

        worker.up = false;
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await refreshServiceTools('redmine');
        warnSpy.mockRestore();
        const callsAfterFailure = fetchMock.mock.calls.length;

        worker.up = true;
        worker.tools = [workerTool('list_items'), workerTool('create_item')];
        await vi.waitFor(() =>
          expect(Object.keys(TOOL_REGISTRY['redmine']).sort()).toEqual(['createItem', 'listItems'])
        );
        expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFailure);
      });

      it('a refresh that is still running makes the next interval tick skip', async () => {
        vi.useFakeTimers();
        await initializeRegistry();
        expect(toolsListCalls()).toBe(1);

        worker.hang = true;
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
        const callsDuringHang = fetchMock.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

        expect(fetchMock.mock.calls.length).toBe(callsDuringHang);
        expect(Object.keys(TOOL_REGISTRY['redmine'])).toEqual(['listItems']);
      });

      it('startup with a dead worker completes with an empty entry and a pending recheck', async () => {
        _setEmptyRecheckBaseMsForTesting(5);
        worker.up = false;
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await initializeRegistry();

        expect(TOOL_REGISTRY['redmine']).toEqual({});
        expect(
          warnSpy.mock.calls.some((c) => String(c[0]).includes('discovery attempt 1 failed'))
        ).toBe(true);

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        worker.up = true;
        await vi.waitFor(() =>
          expect(Object.keys(TOOL_REGISTRY['redmine'])).toEqual(['listItems'])
        );
        expect(logSpy.mock.calls.some((c) => String(c[0]).includes('reachable again'))).toBe(true);
        logSpy.mockRestore();
        warnSpy.mockRestore();
      });
    });

    it('worker returns with different tools → registry replaced', async () => {
      _resetRegistryForTesting();

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      vi.mocked(discoverAndMergeService).mockResolvedValueOnce({ listItems: mockTool });

      process.env.ENABLED_SERVICES = 'redmine';
      await initializeRegistry();
      expect(TOOL_REGISTRY['redmine']['listItems']).toBeDefined();

      const newTool: ToolMetadata = { ...mockTool, name: 'createItem', service: 'redmine' };
      vi.mocked(discoverAndMergeService).mockResolvedValueOnce({ createItem: newTool });
      await refreshServiceTools('redmine');

      expect(TOOL_REGISTRY['redmine']['createItem']).toBeDefined();
      expect(TOOL_REGISTRY['redmine']['listItems']).toBeUndefined();
    });

    it('discoverWithStartupRetry logs String(error) when a non-Error is thrown', async () => {
      _resetRegistryForTesting();

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      vi.mocked(discoverAndMergeService).mockRejectedValueOnce('plain error string');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.ENABLED_SERVICES = 'redmine';
      await initializeRegistry();

      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(0);
      const warnCalls = warnSpy.mock.calls.map((c) => c.join(' '));
      expect(warnCalls.some((m) => m.includes('plain error string'))).toBe(true);
      warnSpy.mockRestore();
    });

    it('refreshServiceTools logs the raw error when a non-Error is thrown', async () => {
      _resetRegistryForTesting();

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      vi.mocked(discoverAndMergeService).mockResolvedValueOnce({ listItems: mockTool });
      process.env.ENABLED_SERVICES = 'redmine';
      await initializeRegistry();

      vi.mocked(discoverAndMergeService).mockRejectedValueOnce({ code: 42, msg: 'plain object' });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await refreshServiceTools('redmine');

      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(1);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('second call to initializeRegistry is a no-op (early return, line 147)', async () => {
      _resetRegistryForTesting();
      resetServiceCaches();

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      vi.mocked(discoverAndMergeService).mockResolvedValue({ listItems: mockTool });

      process.env.ENABLED_SERVICES = 'redmine';
      await initializeRegistry();

      const callCountAfterFirst = vi.mocked(discoverAndMergeService).mock.calls.length;

      await initializeRegistry();

      expect(vi.mocked(discoverAndMergeService).mock.calls.length).toBe(callCountAfterFirst);
    });
  });

  describe('getRegistry', () => {
    it('returns the same object as TOOL_REGISTRY', async () => {
      const { getRegistry } = await import('./tool-registry.js');
      const reg = getRegistry();
      expect(reg).toBe(TOOL_REGISTRY);
      expect(reg['slack']).toBeDefined();
    });
  });

  describe('initializeRegistry disables a service that is not in ENABLED_SERVICES', () => {
    const savedEnabled = process.env.ENABLED_SERVICES;

    afterEach(() => {
      if (savedEnabled === undefined) {
        delete process.env.ENABLED_SERVICES;
      } else {
        process.env.ENABLED_SERVICES = savedEnabled;
      }
      resetServiceCaches();
      _resetRegistryForTesting();
      populateRegistryWithMockTools();
    });

    it('sets empty registry for disabled services and skips discovery', async () => {
      _resetRegistryForTesting();
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack';

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      const mockDiscover = vi.mocked(discoverAndMergeService);
      mockDiscover.mockClear();
      mockDiscover.mockResolvedValue({});

      await initializeRegistry();

      expect(TOOL_REGISTRY['slack']).toBeDefined();
    });
  });

  describe('background refresh interval callback', () => {
    const savedEnabled = process.env.ENABLED_SERVICES;

    afterEach(() => {
      vi.useRealTimers();
      if (savedEnabled === undefined) {
        delete process.env.ENABLED_SERVICES;
      } else {
        process.env.ENABLED_SERVICES = savedEnabled;
      }
      resetServiceCaches();
      _resetRegistryForTesting();
      populateRegistryWithMockTools();
      stopBackgroundRefresh();
    });

    it('skips overlapping refresh when _refreshInProgress is true', async () => {
      _resetRegistryForTesting();
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack';

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      const mockDiscover = vi.mocked(discoverAndMergeService);
      mockDiscover.mockClear();

      const slackTool: ToolMetadata = {
        name: 'sendChannel',
        description: 'Send a channel message',
        keywords: [],
        inputSchema: { type: 'object', properties: {} },
        example: '',
        service: 'slack',
        deferLoading: false,
      };

      let resolveFirstRefresh: () => void;
      const firstRefreshPromise = new Promise<Record<string, ToolMetadata>>((resolve) => {
        resolveFirstRefresh = () => resolve({});
      });

      mockDiscover
        .mockResolvedValueOnce({ sendChannel: slackTool })
        .mockImplementationOnce(() => firstRefreshPromise)
        .mockResolvedValue({});

      vi.useFakeTimers();
      await initializeRegistry();

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

      resolveFirstRefresh!();
      await Promise.resolve();

      expect(TOOL_REGISTRY['slack']).toBeDefined();
      expect(mockDiscover).toHaveBeenCalledTimes(2);
    });

    it('runs without error when triggered', async () => {
      _resetRegistryForTesting();
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack';

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      const mockDiscover = vi.mocked(discoverAndMergeService);
      mockDiscover.mockClear();

      const slackTool: ToolMetadata = {
        name: 'sendChannel',
        description: 'Send a channel message',
        keywords: [],
        inputSchema: { type: 'object', properties: {} },
        example: '',
        service: 'slack',
        deferLoading: false,
      };
      mockDiscover.mockResolvedValueOnce({ sendChannel: slackTool }).mockResolvedValue({});

      await initializeRegistry();

      vi.useFakeTimers();

      await vi.runAllTimersAsync();

      expect(TOOL_REGISTRY['slack']).toBeDefined();
    });
  });

  describe('custom MCP refresh interval', () => {
    const savedEnabled = process.env.ENABLED_SERVICES;

    const tool = (service: string, name: string): ToolMetadata => ({
      name,
      description: `${name} tool`,
      keywords: [],
      inputSchema: { type: 'object', properties: {} },
      example: '',
      service,
      deferLoading: false,
    });

    afterEach(async () => {
      vi.useRealTimers();
      if (savedEnabled === undefined) delete process.env.ENABLED_SERVICES;
      else process.env.ENABLED_SERVICES = savedEnabled;
      const { discoverAndMergeService } = await import('./tool-discovery.js');
      vi.mocked(discoverAndMergeService).mockReset().mockResolvedValue({});
      resetServiceCaches();
      _resetRegistryForTesting();
      populateRegistryWithMockTools();
    });

    it('shows a newly allowed custom tool after one 30 s tick without refreshing built-ins', async () => {
      _resetRegistryForTesting();
      process.env.ENABLED_SERVICES = 'slack,custom-figma';
      let allowed = ['getFile'];
      const { discoverAndMergeService } = await import('./tool-discovery.js');
      const mockDiscover = vi.mocked(discoverAndMergeService);
      mockDiscover.mockReset().mockImplementation(async (service: string) => {
        if (service === 'slack') return { sendChannel: tool('slack', 'sendChannel') };
        return Object.fromEntries(allowed.map((name) => [name, tool('custom-figma', name)]));
      });

      vi.useFakeTimers();
      await initializeRegistry();
      expect(Object.keys(TOOL_REGISTRY['custom-figma'])).toEqual(['getFile']);
      mockDiscover.mockClear();

      allowed = ['getFile', 'postComment'];
      await vi.advanceTimersByTimeAsync(CUSTOM_REFRESH_MS + 1);

      expect(Object.keys(TOOL_REGISTRY['custom-figma']).sort()).toEqual(['getFile', 'postComment']);
      expect(mockDiscover.mock.calls.map(([service]) => service)).toEqual(['custom-figma']);
    });

    it('does not run a 30 s refresh when no custom service is enabled', async () => {
      _resetRegistryForTesting();
      process.env.ENABLED_SERVICES = 'slack';
      const { discoverAndMergeService } = await import('./tool-discovery.js');
      const mockDiscover = vi.mocked(discoverAndMergeService);
      mockDiscover.mockReset().mockResolvedValue({ sendChannel: tool('slack', 'sendChannel') });

      vi.useFakeTimers();
      await initializeRegistry();
      mockDiscover.mockClear();

      await vi.advanceTimersByTimeAsync(4 * CUSTOM_REFRESH_MS);

      expect(mockDiscover).not.toHaveBeenCalled();
    });

    it('skips a 30 s tick while another refresh is still running', async () => {
      _resetRegistryForTesting();
      process.env.ENABLED_SERVICES = 'custom-figma';
      const { discoverAndMergeService } = await import('./tool-discovery.js');
      const mockDiscover = vi.mocked(discoverAndMergeService);
      mockDiscover
        .mockReset()
        .mockResolvedValueOnce({ getFile: tool('custom-figma', 'getFile') })
        .mockImplementation(() => new Promise(() => {}));

      vi.useFakeTimers();
      await initializeRegistry();
      mockDiscover.mockClear();

      await vi.advanceTimersByTimeAsync(3 * CUSTOM_REFRESH_MS + 1);

      expect(mockDiscover).toHaveBeenCalledTimes(1);
      expect(Object.keys(TOOL_REGISTRY['custom-figma'])).toEqual(['getFile']);
    });
  });

  describe('buildExecutorWrappers additional coverage', () => {
    const mockWrapWithAudit = vi.fn(
      (_svc: string, _tool: string, fn: (p?: Record<string, unknown>) => Promise<unknown>) => fn
    );
    const mockPrepareParams = vi.fn(<T>(p: T) => p);
    const mockWrapBridgeCall = vi.fn(<T>(fn: () => Promise<T>) => fn());

    it('throws for unknown service', () => {
      expect(() =>
        buildExecutorWrappers(
          'nonexistentService',
          {},
          mockWrapWithAudit as never,
          mockPrepareParams,
          mockWrapBridgeCall as never
        )
      ).toThrow('Unknown service in registry: nonexistentService');
    });

    it('inner async wrapper calls prepareParams and wrapBridgeCall', async () => {
      const slackMethods = getServiceMethods('slack');
      const bridge: Record<string, ReturnType<typeof vi.fn>> = {};
      for (const m of slackMethods) {
        bridge[m] = vi.fn().mockResolvedValue({ ok: true });
      }

      const preparedParams: unknown[] = [];
      const capturePrepareFn = vi.fn(<T>(p: T) => {
        preparedParams.push(p);
        return p;
      });

      const bridgeCallArgs: unknown[] = [];
      const captureBridgeCallFn = vi.fn(<T>(fn: () => Promise<T>) => {
        bridgeCallArgs.push(fn);
        return fn();
      });

      const wrappers = buildExecutorWrappers(
        'slack',
        bridge,
        mockWrapWithAudit as never,
        capturePrepareFn,
        captureBridgeCallFn as never
      );

      await wrappers['sendChannel']?.({ channel: 'general' });

      expect(preparedParams.length).toBeGreaterThan(0);
      expect(bridgeCallArgs.length).toBeGreaterThan(0);
    });
  });

  describe('validateRegistry error branches', () => {
    afterEach(() => {
      _resetRegistryForTesting();
      populateRegistryWithMockTools();
    });

    it('reports error when metadata.name does not match the key', () => {
      const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
      mutableRegistry['testSvc'] = {
        listItems: {
          name: 'wrongName',
          description: 'List items',
          keywords: [],
          inputSchema: { type: 'object', properties: {} },
          example: '',
          service: 'testSvc',
          deferLoading: false,
        },
      };

      const errors = validateRegistry();
      expect(errors.some((e) => e.includes("metadata.name ('wrongName') does not match key"))).toBe(
        true
      );

      delete mutableRegistry['testSvc'];
    });

    it('reports error when metadata.service does not match the service key', () => {
      const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
      mutableRegistry['testSvc'] = {
        listItems: {
          name: 'listItems',
          description: 'List items',
          keywords: [],
          inputSchema: { type: 'object', properties: {} },
          example: '',
          service: 'wrongService',
          deferLoading: false,
        },
      };

      const errors = validateRegistry();
      expect(
        errors.some((e) => e.includes("metadata.service ('wrongService') does not match service"))
      ).toBe(true);

      delete mutableRegistry['testSvc'];
    });

    it('reports error for missing description', () => {
      const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
      mutableRegistry['testSvc'] = {
        listItems: {
          name: 'listItems',
          description: '',
          keywords: [],
          inputSchema: { type: 'object', properties: {} },
          example: '',
          service: 'testSvc',
          deferLoading: false,
        },
      };

      const errors = validateRegistry();
      expect(errors.some((e) => e.includes('missing description'))).toBe(true);

      delete mutableRegistry['testSvc'];
    });

    it('reports error for missing inputSchema', () => {
      const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
      mutableRegistry['testSvc'] = {
        listItems: {
          name: 'listItems',
          description: 'List items',
          keywords: [],
          inputSchema: null as never,
          example: '',
          service: 'testSvc',
          deferLoading: false,
        },
      };

      const errors = validateRegistry();
      expect(errors.some((e) => e.includes('missing inputSchema'))).toBe(true);

      delete mutableRegistry['testSvc'];
    });
  });

  describe('discoverWithStartupRetry', () => {
    it('retries discovery when first attempt returns zero tools', async () => {
      const { discoverAndMergeService } = await import('./tool-discovery.js');
      const mockDiscover = vi.mocked(discoverAndMergeService);

      _resetRegistryForTesting();
      mockDiscover.mockClear();
      _setDiscoveryRetryDelaysForTesting([0, 0, 0]);
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'gitlab';
      process.env.WORKER_GITLAB_URL = 'http://mcp-gitlab:3000';

      const toolsOnSecondAttempt: Record<string, ToolMetadata> = {
        listBranches: {
          name: 'listBranches',
          workerToolName: 'list_branches',
          description: 'List branches',
          keywords: ['git'],
          inputSchema: { type: 'object', properties: {} },
          example: '',
          service: 'gitlab',
        } as ToolMetadata,
      };

      mockDiscover.mockResolvedValueOnce({}).mockResolvedValueOnce(toolsOnSecondAttempt);

      await initializeRegistry();

      expect(mockDiscover).toHaveBeenCalledTimes(2);
      expect(Object.keys(TOOL_REGISTRY['gitlab'] ?? {}).length).toBe(1);
    });
  });

  describe('empty-registry exponential backoff', () => {
    const mockTool: ToolMetadata = {
      name: 'listItems',
      description: 'List items',
      keywords: ['list'],
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: {} },
      service: 'redmine',
      category: 'read',
      deferLoading: false,
    };

    it('computes 10s → 20s → 40s → 60s (cap) backoff', async () => {
      const { _emptyRecheckDelayMs } = await import('./tool-registry.js');
      expect(_emptyRecheckDelayMs(0)).toBe(10_000);
      expect(_emptyRecheckDelayMs(1)).toBe(20_000);
      expect(_emptyRecheckDelayMs(2)).toBe(40_000);
      expect(_emptyRecheckDelayMs(3)).toBe(60_000);
      expect(_emptyRecheckDelayMs(4)).toBe(60_000);
      expect(_emptyRecheckDelayMs(10)).toBe(60_000);
    });

    it('schedules retry chain with growing delay on persistent empty discovery', async () => {
      _resetRegistryForTesting();

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      vi.mocked(discoverAndMergeService).mockResolvedValue({});

      process.env.ENABLED_SERVICES = 'redmine';
      _setDiscoveryRetryDelaysForTesting([0, 0, 0]);
      _setEmptyRecheckBaseMsForTesting(5);
      await initializeRegistry();
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(0);

      const startupCalls = vi.mocked(discoverAndMergeService).mock.calls.length;

      await new Promise((r) => setTimeout(r, 20));
      expect(vi.mocked(discoverAndMergeService).mock.calls.length).toBeGreaterThanOrEqual(
        startupCalls + 1
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(vi.mocked(discoverAndMergeService).mock.calls.length).toBeGreaterThanOrEqual(
        startupCalls + 2
      );

      _setEmptyRecheckBaseMsForTesting(10_000);
    });

    it('drops the timer once discovery returns non-empty', async () => {
      _resetRegistryForTesting();

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      vi.mocked(discoverAndMergeService).mockResolvedValue({});

      process.env.ENABLED_SERVICES = 'redmine';
      _setDiscoveryRetryDelaysForTesting([0, 0, 0]);
      _setEmptyRecheckBaseMsForTesting(5);
      await initializeRegistry();
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(0);

      const recoveryTool: ToolMetadata = { ...mockTool, name: 'listItems', service: 'redmine' };
      vi.mocked(discoverAndMergeService).mockResolvedValueOnce({ listItems: recoveryTool });

      await new Promise((r) => setTimeout(r, 30));
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(1);

      const callsAfterRecovery = vi.mocked(discoverAndMergeService).mock.calls.length;
      await new Promise((r) => setTimeout(r, 100));
      expect(vi.mocked(discoverAndMergeService).mock.calls.length).toBe(callsAfterRecovery);

      _setEmptyRecheckBaseMsForTesting(10_000);
    });

    it('all services non-empty at init → no rechecks are scheduled', async () => {
      _resetRegistryForTesting();

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      const tool: ToolMetadata = { ...mockTool, name: 'listItems', service: 'redmine' };
      vi.mocked(discoverAndMergeService).mockResolvedValue({ listItems: tool });

      process.env.ENABLED_SERVICES = 'redmine';
      _setDiscoveryRetryDelaysForTesting([0, 0, 0]);
      _setEmptyRecheckBaseMsForTesting(5);
      await initializeRegistry();
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(1);

      const callsAfterInit = vi.mocked(discoverAndMergeService).mock.calls.length;
      await new Promise((r) => setTimeout(r, 50));
      expect(vi.mocked(discoverAndMergeService).mock.calls.length).toBe(callsAfterInit);

      _setEmptyRecheckBaseMsForTesting(10_000);
    });
  });
});
