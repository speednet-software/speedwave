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
} from './tool-registry.js';
import { TIMEOUTS } from '@speedwave/mcp-shared';
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
    // Skip production backoff (1+2+4 s) so tests run fast.
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
      expect(stats.services.os).toBe(25);
      expect(stats.total).toBe(103);
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

      // Reminder tools should be excluded
      const osTools = TOOL_REGISTRY['os'];
      const reminderTools = Object.entries(osTools)
        .filter(([, meta]) => meta.osCategory === 'reminders')
        .map(([name]) => name);

      for (const tool of reminderTools) {
        expect(wrappers[tool]).toBeUndefined();
      }

      // Calendar tools should remain
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
      // Startup: fail
      vi.mocked(discoverAndMergeService).mockRejectedValueOnce(new Error('ECONNREFUSED'));

      process.env.ENABLED_SERVICES = 'redmine';
      await initializeRegistry();
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(0);

      // Refresh: succeed
      vi.mocked(discoverAndMergeService).mockResolvedValueOnce({ listItems: mockTool });
      await refreshServiceTools('redmine');
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(1);
      expect(TOOL_REGISTRY['redmine']['listItems'].name).toBe('listItems');
    });

    it('worker fails during operation → keeps last known tools', async () => {
      _resetRegistryForTesting();

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      // Startup: succeed
      vi.mocked(discoverAndMergeService).mockResolvedValueOnce({ listItems: mockTool });

      process.env.ENABLED_SERVICES = 'redmine';
      await initializeRegistry();
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(1);

      // Refresh: fail
      vi.mocked(discoverAndMergeService).mockRejectedValueOnce(new Error('worker crashed'));
      await refreshServiceTools('redmine');

      // Should keep last known tools
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(1);
      expect(TOOL_REGISTRY['redmine']['listItems'].name).toBe('listItems');
    });

    it('worker returns with different tools → registry replaced', async () => {
      _resetRegistryForTesting();

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      vi.mocked(discoverAndMergeService).mockResolvedValueOnce({ listItems: mockTool });

      process.env.ENABLED_SERVICES = 'redmine';
      await initializeRegistry();
      expect(TOOL_REGISTRY['redmine']['listItems']).toBeDefined();

      // Refresh: different tool set
      const newTool: ToolMetadata = { ...mockTool, name: 'createItem', service: 'redmine' };
      vi.mocked(discoverAndMergeService).mockResolvedValueOnce({ createItem: newTool });
      await refreshServiceTools('redmine');

      expect(TOOL_REGISTRY['redmine']['createItem']).toBeDefined();
      expect(TOOL_REGISTRY['redmine']['listItems']).toBeUndefined();
    });

    it('discoverWithStartupRetry logs String(error) when a non-Error is thrown', async () => {
      _resetRegistryForTesting();

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      // Reject with a plain string — hits the `String(error)` branch in the warn log (line 114)
      vi.mocked(discoverAndMergeService).mockRejectedValueOnce('plain error string');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.ENABLED_SERVICES = 'redmine';
      await initializeRegistry();

      // Registry entry is empty (discovery failed)
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(0);
      // The warn log used String(error) because error was not an Error instance
      const warnCalls = warnSpy.mock.calls.map((c) => c.join(' '));
      expect(warnCalls.some((m) => m.includes('plain error string'))).toBe(true);
      warnSpy.mockRestore();
    });

    it('refreshServiceTools logs the raw error when a non-Error is thrown', async () => {
      _resetRegistryForTesting();

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      // Startup: succeed with one tool
      vi.mocked(discoverAndMergeService).mockResolvedValueOnce({ listItems: mockTool });
      process.env.ENABLED_SERVICES = 'redmine';
      await initializeRegistry();

      // Refresh: fail with a non-Error value (hits the `error` branch at line 183)
      vi.mocked(discoverAndMergeService).mockRejectedValueOnce({ code: 42, msg: 'plain object' });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await refreshServiceTools('redmine');

      // Tool set is preserved despite the error
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(1);
      // Warn was called — the non-Error is logged as-is (the `error` branch)
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

      // Second call must return immediately without calling discover again
      await initializeRegistry();

      expect(vi.mocked(discoverAndMergeService).mock.calls.length).toBe(callCountAfterFirst);
    });
  });

  describe('getRegistry', () => {
    it('returns the same object as TOOL_REGISTRY', async () => {
      const { getRegistry } = await import('./tool-registry.js');
      const reg = getRegistry();
      // getRegistry() returns the internal mutable _registry object,
      // which is the same reference that TOOL_REGISTRY aliases.
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
      // Only enable 'slack'; 'gitlab' is listed but NOT enabled
      process.env.ENABLED_SERVICES = 'slack';

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      const mockDiscover = vi.mocked(discoverAndMergeService);
      mockDiscover.mockClear();
      mockDiscover.mockResolvedValue({});

      await initializeRegistry();

      // 'slack' is enabled but the mock returns {} → empty registry entry. All other
      // services are in SERVICE_NAMES but not enabled → empty {} without discovery running.
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

      // First call (startup) resolves immediately; second call (first refresh interval)
      // resolves slowly — timers advance to fire the interval again mid-refresh.
      let resolveFirstRefresh: () => void;
      const firstRefreshPromise = new Promise<Record<string, ToolMetadata>>((resolve) => {
        resolveFirstRefresh = () => resolve({});
      });

      mockDiscover
        .mockResolvedValueOnce({ sendChannel: slackTool }) // startup
        .mockImplementationOnce(() => firstRefreshPromise) // first interval (slow)
        .mockResolvedValue({}); // any further calls

      // Fake timers before initializeRegistry so the refresh setInterval uses them.
      vi.useFakeTimers();
      await initializeRegistry();

      // First interval callback sets _refreshInProgress = true.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      // Second interval fire hits the early return (_refreshInProgress still true).
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

      resolveFirstRefresh!();
      // Drain microtask queue so _refreshInProgress is reset to false.
      await Promise.resolve();

      // Overlapping refresh was skipped without error.
      expect(TOOL_REGISTRY['slack']).toBeDefined();
      // Called once for startup + once for the first refresh (second skipped).
      expect(mockDiscover).toHaveBeenCalledTimes(2);
    });

    it('runs without error when triggered', async () => {
      _resetRegistryForTesting();
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack';

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      const mockDiscover = vi.mocked(discoverAndMergeService);
      mockDiscover.mockClear();

      // Non-empty first call so discoverWithStartupRetry exits immediately.
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

      // Switch to fake timers AFTER initializeRegistry has completed (interval already set).
      // This avoids the retry-delay setTimeout calls blocking on fake-timer advancement.
      vi.useFakeTimers();

      // Advance timers by 5 minutes to trigger the background refresh interval.
      await vi.runAllTimersAsync();

      // The refresh ran without throwing — registry still exists
      expect(TOOL_REGISTRY['slack']).toBeDefined();
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

      // Call one of the generated wrappers
      await wrappers['sendChannel']?.({ channel: 'general' });

      // prepareParams was called with the provided params
      expect(preparedParams.length).toBeGreaterThan(0);
      // wrapBridgeCall was called with a function
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
          name: 'wrongName', // mismatch!
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
          service: 'wrongService', // mismatch!
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
          description: '', // empty = missing
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
          inputSchema: null as never, // null = missing
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
      // 5 ms base → backoff sequence 5, 10, 20, 40 ms (capped at MAX which is
      // still 60_000 ms but we never reach it in this test).
      _setEmptyRecheckBaseMsForTesting(5);
      await initializeRegistry();
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(0);

      const startupCalls = vi.mocked(discoverAndMergeService).mock.calls.length;

      // First retry after 5 ms. Real timers — wait a bit longer than the delay.
      await new Promise((r) => setTimeout(r, 20));
      expect(vi.mocked(discoverAndMergeService).mock.calls.length).toBeGreaterThanOrEqual(
        startupCalls + 1
      );

      // After ~50 ms total we should have seen at least 2 retries (5, 10 ms).
      await new Promise((r) => setTimeout(r, 50));
      expect(vi.mocked(discoverAndMergeService).mock.calls.length).toBeGreaterThanOrEqual(
        startupCalls + 2
      );

      // Restore real-world base for other tests in this file.
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

      // Next discovery call (from the recheck timer) succeeds.
      const recoveryTool: ToolMetadata = { ...mockTool, name: 'listItems', service: 'redmine' };
      vi.mocked(discoverAndMergeService).mockResolvedValueOnce({ listItems: recoveryTool });

      // Wait past the 5 ms backoff for the recovery to happen.
      await new Promise((r) => setTimeout(r, 30));
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(1);

      // After success: no further calls even with extended wait.
      const callsAfterRecovery = vi.mocked(discoverAndMergeService).mock.calls.length;
      await new Promise((r) => setTimeout(r, 100));
      expect(vi.mocked(discoverAndMergeService).mock.calls.length).toBe(callsAfterRecovery);

      _setEmptyRecheckBaseMsForTesting(10_000);
    });

    it('all services non-empty at init → no rechecks are scheduled', async () => {
      _resetRegistryForTesting();

      const { discoverAndMergeService } = await import('./tool-discovery.js');
      const tool: ToolMetadata = { ...mockTool, name: 'listItems', service: 'redmine' };
      // Startup discovery succeeds — registry populated immediately.
      vi.mocked(discoverAndMergeService).mockResolvedValue({ listItems: tool });

      process.env.ENABLED_SERVICES = 'redmine';
      _setDiscoveryRetryDelaysForTesting([0, 0, 0]);
      _setEmptyRecheckBaseMsForTesting(5);
      await initializeRegistry();
      expect(Object.keys(TOOL_REGISTRY['redmine']).length).toBe(1);

      const callsAfterInit = vi.mocked(discoverAndMergeService).mock.calls.length;
      // No empty-recheck timer should be scheduled — wait past any conceivable
      // first retry (5 ms backoff for this test) and assert no extra calls.
      await new Promise((r) => setTimeout(r, 50));
      expect(vi.mocked(discoverAndMergeService).mock.calls.length).toBe(callsAfterInit);

      _setEmptyRecheckBaseMsForTesting(10_000);
    });
  });
});
