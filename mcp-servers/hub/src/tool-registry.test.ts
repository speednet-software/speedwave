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
    // Skip the up-to-7 s production backoff (1+2+4 s delays) so tests don't wait
    // every time discovery returns zero tools. The retry logic itself is
    // covered by a dedicated test in this file.
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
      process.env.ENABLED_SERVICES = 'slack,presale';

      await initializeRegistry();

      expect([...SERVICE_NAMES]).toContain('presale');
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
});
