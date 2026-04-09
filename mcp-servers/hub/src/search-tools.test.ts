/**
 * Comprehensive tests for search-tools.ts
 * Baseline tests to ensure behavior is preserved during refactoring
 *
 * Tests cover:
 * - searchTools: query matching, service filtering, detail levels, deferred loading
 * - getServiceTools: retrieving all tools for a service
 * - getToolMetadata: retrieving specific tool metadata
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { searchTools, getServiceTools, getToolMetadata } from './search-tools.js';
import { resetServiceCaches } from './tool-registry.js';
import { populateRegistryWithMockTools, _resetRegistryForTesting } from './test-helpers.js';

describe('searchTools', () => {
  const savedEnabledServices = process.env.ENABLED_SERVICES;

  beforeEach(() => {
    _resetRegistryForTesting();
    populateRegistryWithMockTools();
    resetServiceCaches();
    process.env.ENABLED_SERVICES = 'slack,sharepoint,redmine,gitlab,os';
  });

  afterEach(() => {
    if (savedEnabledServices === undefined) {
      delete process.env.ENABLED_SERVICES;
    } else {
      process.env.ENABLED_SERVICES = savedEnabledServices;
    }
    resetServiceCaches();
  });

  describe('query matching', () => {
    it('matches by tool name (case-insensitive)', async () => {
      const result = await searchTools({
        query: 'sendchannel',
        detailLevel: 'names_only',
      });

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.some((m) => m.tool.toLowerCase().includes('sendchannel'))).toBe(true);
    });

    it('matches by tool name with uppercase', async () => {
      const result = await searchTools({
        query: 'SENDCHANNEL',
        detailLevel: 'names_only',
      });

      expect(result.matches.length).toBeGreaterThan(0);
    });

    it('matches by description', async () => {
      // Mock descriptions contain "Slack channel", so search for that
      const result = await searchTools({
        query: 'Slack channel',
        detailLevel: 'with_descriptions',
      });

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.some((m) => m.description?.includes('Slack channel'))).toBe(true);
    });

    it('matches by name substring', async () => {
      const result = await searchTools({
        query: 'pipeline',
        detailLevel: 'names_only',
        service: 'gitlab',
      });

      expect(result.matches.length).toBeGreaterThan(0);
    });

    it('wildcard query (*) returns all tools', async () => {
      const result = await searchTools({
        query: '*',
        detailLevel: 'names_only',
      });

      // Should return all tools from all services (including os with 25 tools)
      expect(result.matches.length).toBeGreaterThan(75);
      expect(result.total).toBe(result.matches.length);
    });

    it('empty query returns all tools', async () => {
      const result = await searchTools({
        query: '',
        detailLevel: 'names_only',
      });

      expect(result.matches.length).toBeGreaterThan(75);
    });

    it('returns empty array for non-matching query', async () => {
      const result = await searchTools({
        query: 'xyznonexistent123',
        detailLevel: 'names_only',
      });

      expect(result.matches).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe('service filtering', () => {
    it('filters by single service - slack', async () => {
      const result = await searchTools({
        query: '*',
        detailLevel: 'names_only',
        service: 'slack',
      });

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.every((m) => m.service === 'slack')).toBe(true);
    });

    it('filters by single service - gitlab', async () => {
      const result = await searchTools({
        query: '*',
        detailLevel: 'names_only',
        service: 'gitlab',
      });

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.every((m) => m.service === 'gitlab')).toBe(true);
    });

    it('filters by single service - redmine', async () => {
      const result = await searchTools({
        query: '*',
        detailLevel: 'names_only',
        service: 'redmine',
      });

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.every((m) => m.service === 'redmine')).toBe(true);
    });

    it('returns empty for unknown service', async () => {
      const result = await searchTools({
        query: '*',
        detailLevel: 'names_only',
        service: 'unknownservice',
      });

      expect(result.matches).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('searches all services when service not specified', async () => {
      const result = await searchTools({
        query: '*',
        detailLevel: 'names_only',
      });

      const services = new Set(result.matches.map((m) => m.service));
      expect(services.size).toBeGreaterThan(1);
      expect(services.has('slack')).toBe(true);
      expect(services.has('gitlab')).toBe(true);
    });
  });

  describe('detail levels', () => {
    it('names_only returns minimal data', async () => {
      const result = await searchTools({
        query: 'sendChannel',
        detailLevel: 'names_only',
        service: 'slack',
      });

      expect(result.matches.length).toBeGreaterThan(0);
      const match = result.matches[0];

      // Should have basic fields
      expect(match.tool).toBeDefined();
      expect(match.service).toBeDefined();
      expect(typeof match.deferLoading).toBe('boolean');

      // Should NOT have detailed fields
      expect(match.description).toBeUndefined();
      expect(match.inputSchema).toBeUndefined();
      expect(match.outputSchema).toBeUndefined();
      expect(match.example).toBeUndefined();
    });

    it('with_descriptions includes description', async () => {
      const result = await searchTools({
        query: 'sendChannel',
        detailLevel: 'with_descriptions',
        service: 'slack',
      });

      expect(result.matches.length).toBeGreaterThan(0);
      const match = result.matches[0];

      // Should have description
      expect(match.description).toBeDefined();
      expect(typeof match.description).toBe('string');

      // Should NOT have schema fields
      expect(match.inputSchema).toBeUndefined();
      expect(match.outputSchema).toBeUndefined();
    });

    it('full_schema includes inputSchema and example', async () => {
      const result = await searchTools({
        query: 'sendChannel',
        detailLevel: 'full_schema',
        service: 'slack',
      });

      expect(result.matches.length).toBeGreaterThan(0);
      const match = result.matches[0];

      expect(match.description).toBeDefined();
      expect(match.inputSchema).toBeDefined();
      expect('example' in match).toBe(true);
    });
  });

  describe('deferred loading', () => {
    it('includes deferred tools by default', async () => {
      const result = await searchTools({
        query: '*',
        detailLevel: 'names_only',
      });

      // Should have both deferred and non-deferred tools
      const hasDeferred = result.matches.some((m) => m.deferLoading === true);
      const hasNonDeferred = result.matches.some((m) => m.deferLoading === false);

      expect(hasDeferred).toBe(true);
      expect(hasNonDeferred).toBe(true);
    });

    it('excludes deferred when includeDeferred=false', async () => {
      const result = await searchTools({
        query: '*',
        detailLevel: 'names_only',
        includeDeferred: false,
      });

      // Should only have non-deferred tools
      expect(result.matches.every((m) => m.deferLoading === false)).toBe(true);
      expect(result.matches.length).toBeGreaterThan(0);
    });

    it('includeDeferred=true behaves same as default', async () => {
      const resultDefault = await searchTools({
        query: '*',
        detailLevel: 'names_only',
      });

      const resultExplicit = await searchTools({
        query: '*',
        detailLevel: 'names_only',
        includeDeferred: true,
      });

      expect(resultDefault.total).toBe(resultExplicit.total);
    });
  });

  describe('result structure', () => {
    it('returns correct result structure', async () => {
      const result = await searchTools({
        query: 'slack',
        detailLevel: 'names_only',
      });

      expect(result).toHaveProperty('matches');
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('query');
      expect(result).toHaveProperty('detail_level');

      expect(Array.isArray(result.matches)).toBe(true);
      expect(typeof result.total).toBe('number');
      expect(result.query).toBe('slack');
      expect(result.detail_level).toBe('names_only');
    });

    it('tool path format is service/toolName', async () => {
      const result = await searchTools({
        query: 'sendChannel',
        detailLevel: 'names_only',
        service: 'slack',
      });

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0].tool).toMatch(/^slack\/.+$/);
    });

    it('matches have required fields', async () => {
      const result = await searchTools({
        query: '*',
        detailLevel: 'names_only',
      });

      for (const match of result.matches) {
        expect(match.tool).toBeDefined();
        expect(match.service).toBeDefined();
        expect(typeof match.deferLoading).toBe('boolean');
      }
    });
  });
});

describe('getServiceTools', () => {
  it('returns all tools for valid service - slack', () => {
    const tools = getServiceTools('slack');

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.service === 'slack')).toBe(true);
  });

  it('returns all tools for valid service - gitlab', () => {
    const tools = getServiceTools('gitlab');

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });

  it('returns all tools for valid service - redmine', () => {
    const tools = getServiceTools('redmine');

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });

  it('returns all tools for valid service - sharepoint', () => {
    const tools = getServiceTools('sharepoint');

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });

  it('returns all tools for valid service - os', () => {
    const tools = getServiceTools('os');

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(25);
    expect(tools.every((t) => t.service === 'os')).toBe(true);
  });

  it('returns empty array for unknown service', () => {
    const tools = getServiceTools('unknownservice');

    expect(tools).toEqual([]);
  });

  it('returned tools have required metadata fields', () => {
    const tools = getServiceTools('slack');

    expect(tools.length).toBeGreaterThan(0);
    const tool = tools[0];

    expect(tool).toHaveProperty('name');
    expect(tool).toHaveProperty('description');
    expect(tool).toHaveProperty('keywords');
    expect(tool).toHaveProperty('inputSchema');
    expect(tool).toHaveProperty('service');
  });
});

describe('getToolMetadata', () => {
  it('returns metadata for existing tool', () => {
    const metadata = getToolMetadata('slack', 'sendChannel');

    expect(metadata).toBeDefined();
    expect(metadata?.name).toBe('sendChannel');
    expect(metadata?.service).toBe('slack');
  });

  it('returns undefined for unknown tool', () => {
    const metadata = getToolMetadata('slack', 'nonexistentTool');

    expect(metadata).toBeUndefined();
  });

  it('returns undefined for unknown service', () => {
    const metadata = getToolMetadata('unknownservice', 'sendChannel');

    expect(metadata).toBeUndefined();
  });

  it('returned metadata has all required fields', () => {
    const metadata = getToolMetadata('slack', 'sendChannel');

    expect(metadata).toBeDefined();
    expect(metadata).toHaveProperty('name');
    expect(metadata).toHaveProperty('description');
    expect(metadata).toHaveProperty('keywords');
    expect(metadata).toHaveProperty('inputSchema');
    expect(metadata).toHaveProperty('service');
  });

  it('tool metadata keywords is an array', () => {
    const metadata = getToolMetadata('slack', 'sendChannel');

    expect(Array.isArray(metadata?.keywords)).toBe(true);
  });

  it('inputSchema has correct structure', () => {
    const metadata = getToolMetadata('slack', 'sendChannel');

    expect(metadata?.inputSchema).toHaveProperty('type');
    expect(metadata?.inputSchema).toHaveProperty('properties');
  });
});

describe('tool counts per service (regression)', () => {
  it('slack has expected number of tools', () => {
    const tools = getServiceTools('slack');
    expect(tools.length).toBe(4);
  });

  it('sharepoint has expected number of tools', () => {
    const tools = getServiceTools('sharepoint');
    expect(tools.length).toBe(5); // listFileIds, getFileFull, downloadFile, uploadFile, getCurrentUser
  });

  it('os has expected number of tools', () => {
    const tools = getServiceTools('os');
    expect(tools.length).toBe(25); // 5 reminders + 6 calendar + 7 mail + 7 notes
  });

  // Note: gitlab and redmine counts may vary - these tests verify minimum counts
  it('gitlab has at least 40 tools', () => {
    const tools = getServiceTools('gitlab');
    expect(tools.length).toBeGreaterThanOrEqual(40);
  });

  it('redmine has at least 15 tools', () => {
    const tools = getServiceTools('redmine');
    expect(tools.length).toBeGreaterThanOrEqual(15);
  });
});

describe('searchTools ENABLED_SERVICES filtering', () => {
  const originalEnabled = process.env.ENABLED_SERVICES;
  const originalDisabled = process.env.DISABLED_OS_SERVICES;

  beforeEach(() => {
    _resetRegistryForTesting();
    populateRegistryWithMockTools();
    resetServiceCaches();
  });

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.ENABLED_SERVICES;
    else process.env.ENABLED_SERVICES = originalEnabled;
    if (originalDisabled === undefined) delete process.env.DISABLED_OS_SERVICES;
    else process.env.DISABLED_OS_SERVICES = originalDisabled;
    resetServiceCaches();
  });

  it('excludes disabled services from wildcard search', async () => {
    process.env.ENABLED_SERVICES = 'slack,os';
    const result = await searchTools({ query: '*', detailLevel: 'names_only' });
    const services = new Set(result.matches.map((m) => m.service));
    expect(services.has('slack')).toBe(true);
    expect(services.has('os')).toBe(true);
    expect(services.has('redmine')).toBe(false);
    expect(services.has('gitlab')).toBe(false);
    expect(services.has('sharepoint')).toBe(false);
  });

  it('excludes disabled OS categories from search results', async () => {
    process.env.ENABLED_SERVICES = 'os';
    process.env.DISABLED_OS_SERVICES = 'reminders,mail';
    const result = await searchTools({ query: '*', detailLevel: 'names_only' });
    const services = new Set(result.matches.map((m) => m.service));
    expect(services.has('os')).toBe(true);

    // No reminder or mail tools should appear
    for (const match of result.matches) {
      if (match.service === 'os') {
        expect(match.tool.toLowerCase()).not.toMatch(/reminder/);
        expect(match.tool.toLowerCase()).not.toMatch(/^(send|get|list|search|move|delete)mail/i);
      }
    }
  });

  it('returns no tools when ENABLED_SERVICES is not set (fail-closed)', async () => {
    delete process.env.ENABLED_SERVICES;
    const result = await searchTools({ query: '*', detailLevel: 'names_only' });
    expect(result.matches).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('returns no tools when ENABLED_SERVICES is empty', async () => {
    process.env.ENABLED_SERVICES = '';
    const result = await searchTools({ query: '*', detailLevel: 'names_only' });
    expect(result.matches).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('excludes disabled OS categories with service filter', async () => {
    process.env.ENABLED_SERVICES = 'os';
    process.env.DISABLED_OS_SERVICES = 'reminders';
    const result = await searchTools({ query: '*', detailLevel: 'names_only', service: 'os' });
    const toolNames = result.matches.map((m) => m.tool.toLowerCase());

    // No reminder tools should appear
    expect(toolNames.some((t) => t.includes('reminder'))).toBe(false);

    // Calendar, mail, notes tools should still appear
    expect(toolNames.some((t) => t.includes('calendar') || t.includes('event'))).toBe(true);
    expect(toolNames.some((t) => t.includes('mail') || t.includes('email'))).toBe(true);
    expect(toolNames.some((t) => t.includes('note'))).toBe(true);
  });

  it('returns only enabled service tools', async () => {
    process.env.ENABLED_SERVICES = 'slack';
    delete process.env.DISABLED_OS_SERVICES;
    const result = await searchTools({ query: '*', detailLevel: 'names_only' });
    const services = new Set(result.matches.map((m) => m.service));

    expect(services.size).toBe(1);
    expect(services.has('slack')).toBe(true);
    expect(services.has('redmine')).toBe(false);
    expect(services.has('gitlab')).toBe(false);
    expect(services.has('sharepoint')).toBe(false);
    expect(services.has('os')).toBe(false);
  });
});
