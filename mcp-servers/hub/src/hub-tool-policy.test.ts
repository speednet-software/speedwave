import { describe, it, expect } from 'vitest';
import type { Tool } from '@speedwave/mcp-shared';
import {
  TOOL_POLICIES,
  SUPPORTED_SERVICES,
  getToolPolicy,
  getServicePolicies,
  getPluginToolPolicy,
} from './hub-tool-policy.js';

describe('hub-tool-policy', () => {
  describe('SUPPORTED_SERVICES', () => {
    it('contains all 5 services', () => {
      expect(SUPPORTED_SERVICES).toEqual(['slack', 'sharepoint', 'redmine', 'gitlab', 'os']);
    });
  });

  describe('TOOL_POLICIES', () => {
    it('contains all supported services', () => {
      for (const service of SUPPORTED_SERVICES) {
        expect(TOOL_POLICIES[service]).toBeDefined();
        expect(Object.keys(TOOL_POLICIES[service]).length).toBeGreaterThan(0);
      }
    });

    it('has correct tool counts per service', () => {
      expect(Object.keys(TOOL_POLICIES['slack']).length).toBe(4);
      expect(Object.keys(TOOL_POLICIES['sharepoint']).length).toBe(5);
      expect(Object.keys(TOOL_POLICIES['redmine']).length).toBe(23);
      expect(Object.keys(TOOL_POLICIES['gitlab']).length).toBe(46);
      expect(Object.keys(TOOL_POLICIES['os']).length).toBe(25);
    });

    it('every tool has a valid category', () => {
      const validCategories = ['read', 'write', 'delete'];
      for (const [service, tools] of Object.entries(TOOL_POLICIES)) {
        for (const [name, policy] of Object.entries(tools)) {
          expect(validCategories).toContain(policy.category);
          expect(typeof policy.deferLoading).toBe('boolean');
          // Validate no undefined category
          expect(policy.category).toBeTruthy();
        }
      }
    });

    it('no duplicate tool names within a service', () => {
      for (const [service, tools] of Object.entries(TOOL_POLICIES)) {
        const names = Object.keys(tools);
        const unique = new Set(names);
        expect(unique.size).toBe(names.length);
      }
    });

    it('osCategory only present for os service', () => {
      for (const [service, tools] of Object.entries(TOOL_POLICIES)) {
        for (const [name, policy] of Object.entries(tools)) {
          if (service === 'os') {
            expect(policy.osCategory).toBeDefined();
            expect(['reminders', 'calendar', 'mail', 'notes']).toContain(policy.osCategory);
          } else {
            expect(policy.osCategory).toBeUndefined();
          }
        }
      }
    });

    it('all OS tools have timeoutMs: 30_000', () => {
      for (const [name, policy] of Object.entries(TOOL_POLICIES['os'])) {
        expect(policy.timeoutMs).toBe(30_000);
      }
    });

    it('sharepoint file transfer tools have timeoutClass: long', () => {
      expect(TOOL_POLICIES['sharepoint']['downloadFile'].timeoutClass).toBe('long');
      expect(TOOL_POLICIES['sharepoint']['uploadFile'].timeoutClass).toBe('long');
    });

    it('sharepoint getFileFull has LONG_OPERATION_MS timeout', () => {
      expect(TOOL_POLICIES['sharepoint']['getFileFull'].timeoutMs).toBe(600_000);
    });
  });

  describe('getToolPolicy', () => {
    it('returns policy for existing tool', () => {
      const policy = getToolPolicy('redmine', 'createIssue');
      expect(policy).toBeDefined();
      expect(policy?.category).toBe('write');
      expect(policy?.deferLoading).toBe(false);
    });

    it('returns undefined for non-existing tool', () => {
      expect(getToolPolicy('redmine', 'nonExistent')).toBeUndefined();
    });

    it('returns undefined for non-existing service', () => {
      expect(getToolPolicy('nonExistent', 'createIssue')).toBeUndefined();
    });

    it('handles name collisions correctly (getCurrentUser in both redmine and sharepoint)', () => {
      const redminePolicy = getToolPolicy('redmine', 'getCurrentUser');
      expect(redminePolicy).toBeDefined();
      expect(redminePolicy?.category).toBe('read');

      const sharepointPolicy = getToolPolicy('sharepoint', 'getCurrentUser');
      expect(sharepointPolicy).toBeDefined();
      expect(sharepointPolicy?.category).toBe('read');
    });
  });

  describe('getServicePolicies', () => {
    it('returns all policies for a service', () => {
      const slackPolicies = getServicePolicies('slack');
      expect(Object.keys(slackPolicies)).toEqual(
        expect.arrayContaining(['sendChannel', 'getChannelMessages', 'listChannelIds', 'getUsers'])
      );
    });

    it('returns empty object for non-existing service', () => {
      expect(getServicePolicies('nonExistent')).toEqual({});
    });
  });

  describe('getPluginToolPolicy', () => {
    it('defaults to read category when no worker tool provided', () => {
      const policy = getPluginToolPolicy();
      expect(policy.category).toBe('read');
      expect(policy.deferLoading).toBe(false);
    });

    it('defaults to read when worker tool has no category', () => {
      const tool: Tool = {
        name: 'search_customers',
        description: 'Search CRM customers',
        inputSchema: { type: 'object', properties: {} },
      };
      const policy = getPluginToolPolicy(tool);
      expect(policy.category).toBe('read');
    });

    it('uses worker tool category when provided as read', () => {
      const tool: Tool = {
        name: 'list_orders',
        description: 'List orders',
        inputSchema: { type: 'object', properties: {} },
        category: 'read',
      };
      const policy = getPluginToolPolicy(tool);
      expect(policy.category).toBe('read');
    });

    it('uses worker tool category when provided as write', () => {
      const tool: Tool = {
        name: 'create_order',
        description: 'Create an order',
        inputSchema: { type: 'object', properties: {} },
        category: 'write',
      };
      const policy = getPluginToolPolicy(tool);
      expect(policy.category).toBe('write');
    });

    it('uses worker tool category when provided as delete', () => {
      const tool: Tool = {
        name: 'delete_order',
        description: 'Delete an order',
        inputSchema: { type: 'object', properties: {} },
        category: 'delete',
      };
      const policy = getPluginToolPolicy(tool);
      expect(policy.category).toBe('delete');
    });

    it('always sets deferLoading to false for plugin tools', () => {
      const tool: Tool = {
        name: 'test_tool',
        description: 'Test tool',
        inputSchema: { type: 'object', properties: {} },
        category: 'write',
      };
      const policy = getPluginToolPolicy(tool);
      expect(policy.deferLoading).toBe(false);
    });
  });
});
