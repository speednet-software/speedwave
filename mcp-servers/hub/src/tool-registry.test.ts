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
  getToolCategory,
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
} from './tool-registry.js';
import { TOOL_POLICIES, SUPPORTED_SERVICES } from './hub-tool-policy.js';
import { TIMEOUTS } from '@speedwave/mcp-shared';
import { populateRegistryFromPolicies, _resetRegistryForTesting } from './test-helpers.js';

describe('tool-registry', () => {
  beforeEach(() => {
    _resetRegistryForTesting();
    populateRegistryFromPolicies();
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

    it('should have SERVICE_NAMES matching SUPPORTED_SERVICES after reset', () => {
      expect([...SERVICE_NAMES].sort()).toEqual([...SUPPORTED_SERVICES].sort());
    });
  });

  describe('getToolMetadata', () => {
    it('should return metadata for existing tool', () => {
      const meta = getToolMetadata('redmine', 'createIssue');
      expect(meta).toBeDefined();
      expect(meta?.name).toBe('createIssue');
      expect(meta?.service).toBe('redmine');
      expect(meta?.category).toBe('write');
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

  describe('getToolCategory', () => {
    it('should return correct category for tools', () => {
      expect(getToolCategory('redmine', 'listIssueIds')).toBe('read');
      expect(getToolCategory('redmine', 'createIssue')).toBe('write');
      expect(getToolCategory('redmine', 'deleteJournal')).toBe('delete');
    });

    it('should return "read" as default for unknown tools', () => {
      expect(getToolCategory('redmine', 'nonExistent')).toBe('read');
    });
  });

  describe('getLongTimeoutTools', () => {
    it('should return tools with timeoutClass long', () => {
      const longTools = getLongTimeoutTools();
      expect(longTools).toContainEqual({ service: 'sharepoint', method: 'sync' });
      expect(longTools).toContainEqual({ service: 'sharepoint', method: 'syncDirectory' });
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
    it('should detect sharepoint.sync as long', () => {
      expect(getRequiredTimeoutClass('await sharepoint.sync()')).toBe('long');
    });

    it('should detect sharepoint.syncDirectory as long', () => {
      expect(getRequiredTimeoutClass('await sharepoint.syncDirectory({ path: "/test" })')).toBe(
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
        await sharepoint.sync({ local_path: "/test" });
        return issues;
      `;
      expect(getRequiredTimeoutClass(code)).toBe('long');
    });

    it('should handle whitespace variations', () => {
      expect(getRequiredTimeoutClass('sharepoint . sync()')).toBe('long');
    });
  });

  describe('getExecutionTimeout', () => {
    it('should return LONG_OPERATION_MS for code with long-timeout tools', () => {
      const result = getExecutionTimeout('await sharepoint.sync()', TIMEOUTS.EXECUTION_MS);
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
      const mockWrapWithAudit = vi.fn((cat, svc, tool, fn) => fn);
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

    it('should use category from metadata', () => {
      const redmineMethods = getServiceMethods('redmine');
      const mockBridge: Record<string, ReturnType<typeof vi.fn>> = {};
      for (const m of redmineMethods) {
        mockBridge[m] = vi.fn();
      }
      const wrapWithAuditCalls: Array<{ category: string; service: string; tool: string }> = [];
      const mockWrapWithAudit = vi.fn((cat, svc, tool, fn) => {
        wrapWithAuditCalls.push({ category: cat, service: svc, tool });
        return fn;
      });
      const mockPrepareParams = vi.fn((p) => p);
      const mockWrapBridgeCall = vi.fn((fn) => fn());

      buildExecutorWrappers(
        'redmine',
        mockBridge,
        mockWrapWithAudit,
        mockPrepareParams,
        mockWrapBridgeCall
      );

      const createIssueCall = wrapWithAuditCalls.find((c) => c.tool === 'createIssue');
      expect(createIssueCall?.category).toBe('write');
      const listCall = wrapWithAuditCalls.find((c) => c.tool === 'listIssueIds');
      expect(listCall?.category).toBe('read');
      const deleteCall = wrapWithAuditCalls.find((c) => c.tool === 'deleteJournal');
      expect(deleteCall?.category).toBe('delete');
    });

    it('should throw when bridge method is missing', () => {
      const incompleteBridge = { sendChannel: vi.fn() };
      const mockWrapWithAudit = vi.fn((cat, svc, tool, fn) => fn);
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
          expect(['read', 'write', 'delete']).toContain(metadata.category);
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
      populateRegistryFromPolicies();
    });

    it('should include plugin services after initializeRegistry', async () => {
      _resetRegistryForTesting();
      resetServiceCaches();
      process.env.ENABLED_SERVICES = 'slack,presale';

      await initializeRegistry();

      expect([...SERVICE_NAMES]).toContain('presale');
      expect([...SERVICE_NAMES]).toContain('slack');
      expect([...SERVICE_NAMES]).toContain('sharepoint');
    });

    it('should reset SERVICE_NAMES to built-in on _resetRegistryForTesting', () => {
      // After the above test, reset should restore to built-in
      _resetRegistryForTesting();
      expect([...SERVICE_NAMES]).toEqual([...SUPPORTED_SERVICES]);
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
      expect(sharepointMethods).toContain('sync');
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
      (
        _cat: string,
        _svc: string,
        _tool: string,
        fn: (p?: Record<string, unknown>) => Promise<unknown>
      ) => fn
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
      const reminderTools = Object.entries(TOOL_POLICIES['os'])
        .filter(([, meta]) => meta.osCategory === 'reminders')
        .map(([name]) => name);

      for (const tool of reminderTools) {
        expect(wrappers[tool]).toBeUndefined();
      }

      // Calendar tools should remain
      const calendarTools = Object.entries(TOOL_POLICIES['os'])
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
});
