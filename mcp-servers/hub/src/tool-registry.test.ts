/**
 * Tool Registry Tests
 *
 * Tests for the central tool registry that provides Single Source of Truth
 * for all tool definitions across services.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
} from './tool-registry.js';
import { TIMEOUTS } from '../../shared/dist/index.js';

describe('tool-registry', () => {
  describe('TOOL_REGISTRY', () => {
    it('should contain all expected services', () => {
      const expectedServices = ['slack', 'sharepoint', 'redmine', 'gitlab', 'gemini', 'os'];
      for (const service of expectedServices) {
        expect(TOOL_REGISTRY[service]).toBeDefined();
        expect(Object.keys(TOOL_REGISTRY[service]).length).toBeGreaterThan(0);
      }
    });

    it('should have SERVICE_NAMES matching registry keys', () => {
      expect([...SERVICE_NAMES].sort()).toEqual(Object.keys(TOOL_REGISTRY).sort());
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

      // Verify known long-running tools are included
      expect(longTools).toContainEqual({ service: 'sharepoint', method: 'sync' });
      expect(longTools).toContainEqual({ service: 'sharepoint', method: 'syncDirectory' });
      expect(longTools).toContainEqual({ service: 'gemini', method: 'chat' });
      // presale removed (addon in v2, not built-in)
    });

    it('should not include standard timeout tools', () => {
      const longTools = getLongTimeoutTools();

      // Standard operations should not be in the list
      const hasStandardSlackTool = longTools.some(
        (t) => t.service === 'slack' && t.method === 'sendChannel'
      );
      expect(hasStandardSlackTool).toBe(false);

      const hasStandardRedmineTool = longTools.some(
        (t) => t.service === 'redmine' && t.method === 'listIssueIds'
      );
      expect(hasStandardRedmineTool).toBe(false);
    });

    it('should return consistent results (matches registry)', () => {
      const longTools = getLongTimeoutTools();

      // Verify all returned tools actually have timeoutClass: 'long' in registry
      for (const { service, method } of longTools) {
        const meta = getToolMetadata(service, method);
        expect(meta?.timeoutClass).toBe('long');
      }
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

    it('should detect gemini.chat as long', () => {
      expect(getRequiredTimeoutClass('const result = await gemini.chat({ prompt: "test" })')).toBe(
        'long'
      );
    });

    it('should return standard for regular code', () => {
      expect(getRequiredTimeoutClass('return 1 + 1')).toBe('standard');
    });

    it('should return standard for non-long-timeout service calls', () => {
      expect(getRequiredTimeoutClass('await redmine.listIssueIds()')).toBe('standard');
      expect(getRequiredTimeoutClass('await slack.sendChannel({ channel: "test" })')).toBe(
        'standard'
      );
    });

    it('should handle code with multiple tool calls (returns long if any is long)', () => {
      const code = `
        const issues = await redmine.listIssueIds();
        await sharepoint.sync({ local_path: "/test" });
        return issues;
      `;
      expect(getRequiredTimeoutClass(code)).toBe('long');
    });

    it('should handle whitespace variations in service.method pattern', () => {
      // With spaces around dot
      expect(getRequiredTimeoutClass('sharepoint . sync()')).toBe('long');
      expect(getRequiredTimeoutClass('sharepoint\n.\nsync()')).toBe('long');
    });
  });

  describe('getExecutionTimeout', () => {
    it('should return LONG_OPERATION_MS for code with long-timeout tools', () => {
      const result = getExecutionTimeout('await sharepoint.sync()', TIMEOUTS.EXECUTION_MS);

      expect(result.timeoutMs).toBe(TIMEOUTS.LONG_OPERATION_MS);
      expect(result.maxTimeoutMs).toBe(TIMEOUTS.LONG_OPERATION_MS);
      expect(result.timeoutClass).toBe('long');
    });

    it('should return default timeout for standard code', () => {
      const result = getExecutionTimeout('return 1 + 1', TIMEOUTS.EXECUTION_MS);

      expect(result.timeoutMs).toBe(TIMEOUTS.EXECUTION_MS);
      expect(result.maxTimeoutMs).toBe(TIMEOUTS.EXECUTION_MS);
      expect(result.timeoutClass).toBe('standard');
    });

    it('should respect custom default timeout for standard operations', () => {
      const customDefault = 60000;
      const result = getExecutionTimeout('await redmine.listIssueIds()', customDefault);

      expect(result.timeoutMs).toBe(customDefault);
      expect(result.maxTimeoutMs).toBe(TIMEOUTS.EXECUTION_MS);
      expect(result.timeoutClass).toBe('standard');
    });

    it('should ignore custom default for long operations', () => {
      const customDefault = 30000; // Even with short custom default
      const result = getExecutionTimeout('await gemini.chat({ prompt: "test" })', customDefault);

      // Long operations always use LONG_OPERATION_MS
      expect(result.timeoutMs).toBe(TIMEOUTS.LONG_OPERATION_MS);
      expect(result.maxTimeoutMs).toBe(TIMEOUTS.LONG_OPERATION_MS);
      expect(result.timeoutClass).toBe('long');
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

    it('should not pass timeout options when getTimeoutMs is not provided', async () => {
      const mockCallWorker = vi.fn().mockResolvedValue({ success: true });
      const bridge = buildServiceBridge('slack', mockCallWorker);

      await bridge.sendChannel({ channel: 'test' });

      // Fourth argument should be undefined when no getTimeoutMs provided
      expect(mockCallWorker).toHaveBeenCalledWith(
        'slack',
        'sendChannel',
        { channel: 'test' },
        undefined
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

    it('should call getTimeoutMs for each method invocation (remaining time tracking)', async () => {
      const mockCallWorker = vi.fn().mockResolvedValue({ success: true });
      let callCount = 0;
      const getTimeoutMs = vi.fn(() => {
        callCount++;
        // Simulate decreasing remaining time
        return 10000 - callCount * 1000;
      });
      const bridge = buildServiceBridge('slack', mockCallWorker, getTimeoutMs);

      // First call should get 9000ms remaining
      await bridge.sendChannel({ channel: 'test1' });
      expect(mockCallWorker).toHaveBeenLastCalledWith(
        'slack',
        'sendChannel',
        { channel: 'test1' },
        { timeoutMs: 9000 }
      );

      // Second call should get 8000ms remaining
      await bridge.listChannelIds();
      expect(mockCallWorker).toHaveBeenLastCalledWith(
        'slack',
        'listChannelIds',
        {},
        { timeoutMs: 8000 }
      );

      expect(getTimeoutMs).toHaveBeenCalledTimes(2);
    });

    it('should use metadata.timeoutMs when defined (per-tool timeout)', async () => {
      const mockCallWorker = vi.fn().mockResolvedValue({ success: true });
      // No getTimeoutMs provided - should use per-tool timeout from metadata
      const bridge = buildServiceBridge('sharepoint', mockCallWorker);

      // sharepoint.getFileFull has timeoutMs: TIMEOUTS.LONG_OPERATION_MS (600000ms)
      await bridge.getFileFull({ file_id: '/test.txt' });

      expect(mockCallWorker).toHaveBeenCalledWith(
        'sharepoint',
        'getFileFull',
        { file_id: '/test.txt' },
        { timeoutMs: 600000 } // LONG_OPERATION_MS = 10 min
      );
    });

    it('should use per-tool timeout even when remaining time is less', async () => {
      const mockCallWorker = vi.fn().mockResolvedValue({ success: true });
      // Remaining time is less than per-tool timeout
      const getTimeoutMs = vi.fn().mockReturnValue(30000); // 30s remaining
      const bridge = buildServiceBridge('sharepoint', mockCallWorker, getTimeoutMs);

      // sharepoint.getFileFull has timeoutMs: 600000ms (10 min) but only 30s remaining
      await bridge.getFileFull({ file_id: '/test.txt' });

      // Per-tool timeout takes precedence (allows long operations like getFileFull)
      expect(mockCallWorker).toHaveBeenCalledWith(
        'sharepoint',
        'getFileFull',
        { file_id: '/test.txt' },
        { timeoutMs: 600000 }
      );
    });

    it('should use per-tool timeout when remaining time is greater', async () => {
      const mockCallWorker = vi.fn().mockResolvedValue({ success: true });
      // Remaining time is greater than per-tool timeout
      const getTimeoutMs = vi.fn().mockReturnValue(900000); // 15 min remaining
      const bridge = buildServiceBridge('sharepoint', mockCallWorker, getTimeoutMs);

      // sharepoint.getFileFull has timeoutMs: 600000ms (10 min), 15 min remaining
      await bridge.getFileFull({ file_id: '/test.txt' });

      // Per-tool timeout takes precedence
      expect(mockCallWorker).toHaveBeenCalledWith(
        'sharepoint',
        'getFileFull',
        { file_id: '/test.txt' },
        { timeoutMs: 600000 }
      );
    });

    it('should use remaining time when tool has no per-tool timeout', async () => {
      const mockCallWorker = vi.fn().mockResolvedValue({ success: true });
      const getTimeoutMs = vi.fn().mockReturnValue(45000);
      const bridge = buildServiceBridge('slack', mockCallWorker, getTimeoutMs);

      // slack.sendChannel has no timeoutMs in metadata
      await bridge.sendChannel({ channel: 'test' });

      // Should use remaining time since no per-tool timeout
      expect(mockCallWorker).toHaveBeenCalledWith(
        'slack',
        'sendChannel',
        { channel: 'test' },
        { timeoutMs: 45000 }
      );
    });
  });

  describe('buildExecutorWrappers', () => {
    it('should generate wrappers for all service methods', () => {
      const mockBridge = {
        sendChannel: vi.fn(),
        listChannelIds: vi.fn(),
        getChannelMessages: vi.fn(),
        getUsers: vi.fn(),
      };
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
      // Complete redmine bridge with all required methods
      const mockBridge = {
        listIssueIds: vi.fn(),
        getIssueFull: vi.fn(),
        searchIssueIds: vi.fn(),
        createIssue: vi.fn(),
        updateIssue: vi.fn(),
        commentIssue: vi.fn(),
        listJournals: vi.fn(),
        updateJournal: vi.fn(),
        deleteJournal: vi.fn(),
        listTimeEntries: vi.fn(),
        createTimeEntry: vi.fn(),
        updateTimeEntry: vi.fn(),
        listUsers: vi.fn(),
        resolveUser: vi.fn(),
        getCurrentUser: vi.fn(),
        getMappings: vi.fn(),
        getConfig: vi.fn(),
        listProjectIds: vi.fn(),
        getProjectFull: vi.fn(),
        searchProjectIds: vi.fn(),
        listRelations: vi.fn(),
        createRelation: vi.fn(),
        deleteRelation: vi.fn(),
      };
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

      // Verify categories match metadata
      const createIssueCall = wrapWithAuditCalls.find((c) => c.tool === 'createIssue');
      expect(createIssueCall?.category).toBe('write');

      const listCall = wrapWithAuditCalls.find((c) => c.tool === 'listIssueIds');
      expect(listCall?.category).toBe('read');

      const deleteCall = wrapWithAuditCalls.find((c) => c.tool === 'deleteJournal');
      expect(deleteCall?.category).toBe('delete');
    });

    it('should call prepareParams and wrapBridgeCall', async () => {
      // Complete slack bridge with all required methods
      const mockBridge = {
        sendChannel: vi.fn().mockResolvedValue({ ok: true }),
        getChannelMessages: vi.fn(),
        listChannelIds: vi.fn(),
        getUsers: vi.fn(),
      };
      const mockWrapWithAudit = vi.fn((cat, svc, tool, fn) => fn);
      const mockPrepareParams = vi.fn((p) => ({ ...p, prepared: true }));
      const mockWrapBridgeCall = vi.fn(async (fn) => fn());

      const wrappers = buildExecutorWrappers(
        'slack',
        mockBridge,
        mockWrapWithAudit,
        mockPrepareParams,
        mockWrapBridgeCall
      );

      await wrappers.sendChannel({ channel: 'test', message: 'hello' });

      expect(mockPrepareParams).toHaveBeenCalled();
      expect(mockWrapBridgeCall).toHaveBeenCalled();
      expect(mockBridge.sendChannel).toHaveBeenCalledWith({
        channel: 'test',
        message: 'hello',
        prepared: true,
      });
    });

    it('should throw when bridge method is missing', () => {
      // Incomplete bridge - missing most methods
      const incompleteBridge = {
        sendChannel: vi.fn(),
        // Missing: listChannelIds, getChannelMessages, getUsers
      };
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

    it('should include available methods in error when bridge method is missing', () => {
      const incompleteBridge = {
        sendChannel: vi.fn(),
      };
      const mockWrapWithAudit = vi.fn((cat, svc, tool, fn) => fn);
      const mockPrepareParams = vi.fn((p) => p);
      const mockWrapBridgeCall = vi.fn((fn) => fn());

      try {
        buildExecutorWrappers(
          'slack',
          incompleteBridge,
          mockWrapWithAudit,
          mockPrepareParams,
          mockWrapBridgeCall
        );
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('slack.');
        expect((error as Error).message).toContain('sendChannel');
      }
    });
  });

  describe('validateRegistry', () => {
    it('should return empty array for valid registry', () => {
      const errors = validateRegistry();
      // If there are errors, log them for debugging
      if (errors.length > 0) {
        console.log('Registry validation errors:', errors);
      }
      expect(errors).toEqual([]);
    });

    it('should validate all tools have required fields', () => {
      // This test ensures all tools in registry have proper metadata
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

      expect(stats.services.slack).toBeGreaterThanOrEqual(4);
      expect(stats.services.redmine).toBeGreaterThanOrEqual(15);
      expect(stats.services.gitlab).toBeGreaterThanOrEqual(40);
      expect(stats.services.os).toBe(25);
      expect(stats.total).toBeGreaterThanOrEqual(95);
    });
  });

  describe('registry consistency with existing bridges', () => {
    it('should have all methods that were in http-bridge.ts', () => {
      // These are the methods that were manually defined in http-bridge.ts
      // This test ensures registry has them all

      // Slack methods
      const slackMethods = getServiceMethods('slack');
      expect(slackMethods).toContain('sendChannel');
      expect(slackMethods).toContain('listChannelIds');
      expect(slackMethods).toContain('getChannelMessages');
      expect(slackMethods).toContain('getUsers');

      // Redmine relation methods (the ones that caused the original bug)
      const redmineMethods = getServiceMethods('redmine');
      expect(redmineMethods).toContain('listRelations');
      expect(redmineMethods).toContain('createRelation');
      expect(redmineMethods).toContain('deleteRelation');

      // SharePoint methods
      const sharepointMethods = getServiceMethods('sharepoint');
      expect(sharepointMethods).toContain('listFileIds');
      expect(sharepointMethods).toContain('getFileFull');
      expect(sharepointMethods).toContain('sync');
      expect(sharepointMethods).toContain('getCurrentUser');

      // Gemini methods
      const geminiMethods = getServiceMethods('gemini');
      expect(geminiMethods).toContain('chat');
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
      expect(enabled.has('sharepoint')).toBe(false);
      expect(enabled.has('gemini')).toBe(false);
      expect(enabled.has('os')).toBe(false);
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

    it('returns empty set when ENABLED_SERVICES is empty string (enforcement)', () => {
      process.env.ENABLED_SERVICES = '';
      const enabled = getEnabledServices();
      expect(enabled.size).toBe(0);
      for (const svc of SERVICE_NAMES) {
        expect(enabled.has(svc)).toBe(false);
      }
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
      expect(disabled.has('notes')).toBe(false);
    });

    it('handles empty env var', () => {
      process.env.DISABLED_OS_SERVICES = '';
      const disabled = getDisabledOsCategories();
      expect(disabled.size).toBe(0);
    });

    it('parses all four categories', () => {
      process.env.DISABLED_OS_SERVICES = 'reminders,calendar,mail,notes';
      const disabled = getDisabledOsCategories();
      expect(disabled.size).toBe(4);
      expect(disabled.has('reminders')).toBe(true);
      expect(disabled.has('calendar')).toBe(true);
      expect(disabled.has('mail')).toBe(true);
      expect(disabled.has('notes')).toBe(true);
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
      const reminderTools = Object.entries(TOOL_REGISTRY['os'])
        .filter(([, meta]) => meta.osCategory === 'reminders')
        .map(([name]) => name);

      for (const tool of reminderTools) {
        expect(wrappers[tool]).toBeUndefined();
      }

      // Calendar/mail/notes tools should remain
      const calendarTools = Object.entries(TOOL_REGISTRY['os'])
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

    it('does not filter when disabledOsCategories is undefined', () => {
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
        mockWrapBridgeCall as never
      );

      expect(Object.keys(wrappers).length).toBe(osMethods.length);
    });
  });
});
