/** Tests for searchTools, getServiceTools, getToolMetadata in search-tools.ts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { searchTools, getServiceTools, getToolMetadata } from './search-tools.js';
import { resetServiceCaches, TOOL_REGISTRY, _setServiceNamesForTesting } from './tool-registry.js';
import {
  populateRegistryWithMockTools,
  _resetRegistryForTesting,
  buildMockToolMetadata,
} from './test-helpers.js';
import type { ToolMetadata } from './hub-types.js';

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

  describe('lowercased field caching', () => {
    it('returns identical results across repeated searches of the same registry', async () => {
      const first = await searchTools({ query: 'send', detailLevel: 'names_only' });
      const second = await searchTools({ query: 'send', detailLevel: 'names_only' });

      expect(second.matches).toEqual(first.matches);
    });

    it('does not re-lowercase a tool name/description on a repeated search', async () => {
      const tool = TOOL_REGISTRY['slack']['sendChannel'];
      const toLowerCaseSpy = vi.spyOn(String.prototype, 'toLowerCase');
      const callsForTool = () =>
        toLowerCaseSpy.mock.contexts.filter(
          (ctx) => String(ctx) === tool.name || String(ctx) === tool.description
        ).length;

      await searchTools({ query: 'send', detailLevel: 'names_only', service: 'slack' });
      const callsAfterFirst = callsForTool();
      await searchTools({ query: 'send', detailLevel: 'names_only', service: 'slack' });

      expect(callsAfterFirst).toBeGreaterThan(0);
      expect(callsForTool()).toBe(callsAfterFirst);

      toLowerCaseSpy.mockRestore();
    });
  });
});

describe('searchTools edge cases', () => {
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
    _resetRegistryForTesting();
    populateRegistryWithMockTools();
  });

  it('skips a service that has an empty tool list', async () => {
    // Add an enabled service with zero tools — searchTools should skip it.
    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, unknown>>;
    mutableRegistry['emptysvc'] = {};
    // Must also add to SERVICE_NAMES so the service appears in servicesToSearch
    _setServiceNamesForTesting(['slack', 'sharepoint', 'redmine', 'gitlab', 'os', 'emptysvc']);
    process.env.ENABLED_SERVICES = 'slack,emptysvc';
    resetServiceCaches();

    const result = await searchTools({ query: '*', detailLevel: 'names_only' });

    // Only slack tools should appear, not emptysvc (emptysvc has no tools → continue branch hit)
    expect(result.matches.every((m) => m.service !== 'emptysvc')).toBe(true);
    expect(result.matches.some((m) => m.service === 'slack')).toBe(true);

    delete mutableRegistry['emptysvc'];
    _setServiceNamesForTesting(['slack', 'sharepoint', 'redmine', 'gitlab', 'os']);
  });

  it('matches a tool by keyword when name and description do not match', async () => {
    // Insert a tool whose name/description don't contain 'xkeyword', but keywords does.
    const mutableRegistry = TOOL_REGISTRY as Record<
      string,
      Record<
        string,
        {
          name: string;
          description: string;
          keywords: string[];
          inputSchema: object;
          example: string;
          service: string;
          deferLoading: boolean;
        }
      >
    >;
    mutableRegistry['slack']['keywordTool'] = {
      name: 'keywordTool',
      description: 'A tool without the special term in its description',
      keywords: ['xkeyword', 'special-alias'],
      inputSchema: { type: 'object', properties: {} },
      example: '',
      service: 'slack',
      deferLoading: false,
    };

    const result = await searchTools({
      query: 'xkeyword',
      detailLevel: 'names_only',
      service: 'slack',
    });

    // Should match via keywords even though 'xkeyword' is not in name or description
    expect(result.matches.some((m) => m.tool === 'slack/keywordTool')).toBe(true);

    delete mutableRegistry['slack']['keywordTool'];
  });

  it('uses true as deferLoading fallback when tool has deferLoading undefined', async () => {
    // Insert a tool with deferLoading === undefined so the `?? true` branch is hit.
    const mutableRegistry = TOOL_REGISTRY as Record<
      string,
      Record<
        string,
        {
          name: string;
          description: string;
          keywords: string[];
          inputSchema: object;
          example: string;
          service: string;
          deferLoading?: boolean;
        }
      >
    >;
    mutableRegistry['slack']['undeferredTool'] = {
      name: 'undeferredTool',
      description: 'Tool with no deferLoading field',
      keywords: [],
      inputSchema: { type: 'object', properties: {} },
      example: '',
      service: 'slack',
      // deferLoading intentionally omitted
    };

    const result = await searchTools({
      query: 'undeferredTool',
      detailLevel: 'names_only',
      service: 'slack',
    });

    expect(result.matches.length).toBe(1);
    // The `?? true` branch returns true when deferLoading is undefined
    expect(result.matches[0].deferLoading).toBe(true);

    delete mutableRegistry['slack']['undeferredTool'];
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
    // Isolate from the host environment: a real DISABLED_OS_SERVICES would filter os tools.
    delete process.env.DISABLED_OS_SERVICES;
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

describe('searchTools tokenized multi-word query', () => {
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

  it('matches a natural-language phrase whose tokens are split across description', async () => {
    // "Send a message to a Slack channel" — every token of the query appears.
    const result = await searchTools({
      query: 'send message slack channel',
      detailLevel: 'names_only',
      service: 'slack',
    });

    expect(result.matches.some((m) => m.tool === 'slack/sendChannel')).toBe(true);
  });

  it('tolerates one non-matching token for queries of 4+ tokens', async () => {
    // "zzznomatch logged hours redmine" — "zzznomatch" appears nowhere, but the
    // other 3 (of 4) content tokens do, and 4-token queries allow one miss.
    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
    mutableRegistry['redmine']['listTimeEntries'] = {
      ...mutableRegistry['redmine']['listTimeEntries'],
      description: 'List redmine hours logged',
    };

    const result = await searchTools({
      query: 'zzznomatch logged hours redmine',
      detailLevel: 'names_only',
      service: 'redmine',
    });

    expect(result.matches.some((m) => m.tool === 'redmine/listTimeEntries')).toBe(true);
  });

  it('requires every token to match for queries under 4 tokens', async () => {
    // "slack nonexistentword" — one of two tokens matches nothing, so no result.
    const result = await searchTools({
      query: 'slack nonexistentword',
      detailLevel: 'names_only',
      service: 'slack',
    });

    expect(result.matches).toEqual([]);
  });

  it('ranks exact-name match before description-only match', async () => {
    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
    mutableRegistry['slack']['messages'] = buildMockToolMetadata('slack', 'messages', {
      description: 'Unrelated tool that happens to mention messages in passing',
      deferLoading: true,
    });

    const result = await searchTools({
      query: 'messages',
      detailLevel: 'names_only',
      service: 'slack',
    });

    const names = result.matches.map((m) => m.tool);
    const exactIdx = names.indexOf('slack/messages');
    const descIdx = names.indexOf('slack/getChannelMessages');
    expect(exactIdx).toBeGreaterThanOrEqual(0);
    expect(descIdx).toBeGreaterThanOrEqual(0);
    expect(exactIdx).toBeLessThan(descIdx);

    delete mutableRegistry['slack']['messages'];
  });

  it('ranks name-prefix match before keyword-only match', async () => {
    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
    mutableRegistry['slack']['issueSomething'] = buildMockToolMetadata('slack', 'issueSomething', {
      description: 'A tool whose name starts with the query token',
      deferLoading: true,
    });
    mutableRegistry['slack']['keywordOnlyTool'] = buildMockToolMetadata(
      'slack',
      'keywordOnlyTool',
      {
        description: 'Unrelated description',
        keywords: ['issue'],
        deferLoading: true,
      }
    );

    const result = await searchTools({
      query: 'issue',
      detailLevel: 'names_only',
      service: 'slack',
    });

    const names = result.matches.map((m) => m.tool);
    const prefixIdx = names.indexOf('slack/issueSomething');
    const keywordIdx = names.indexOf('slack/keywordOnlyTool');
    expect(prefixIdx).toBeGreaterThanOrEqual(0);
    expect(keywordIdx).toBeGreaterThanOrEqual(0);
    expect(prefixIdx).toBeLessThan(keywordIdx);

    delete mutableRegistry['slack']['issueSomething'];
    delete mutableRegistry['slack']['keywordOnlyTool'];
  });

  it('boosts userScoped tools to the front of their tier for self-reference queries', async () => {
    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
    mutableRegistry['redmine']['getCurrentUser'] = {
      ...mutableRegistry['redmine']['getCurrentUser'],
      description: 'Get current Redmine user issues',
      userScoped: true,
    };

    const result = await searchTools({
      query: 'my issues',
      detailLevel: 'names_only',
      service: 'redmine',
    });

    const names = result.matches.map((m) => m.tool);
    expect(names[0]).toBe('redmine/getCurrentUser');
  });

  it('does not boost when query has no self-reference token', async () => {
    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
    mutableRegistry['redmine']['getCurrentUser'] = {
      ...mutableRegistry['redmine']['getCurrentUser'],
      description: 'Get current Redmine user issues',
      userScoped: true,
    };
    mutableRegistry['redmine']['issueSomething2'] = buildMockToolMetadata(
      'redmine',
      'issueSomething2',
      {
        description: 'A tool whose name starts with issues',
        deferLoading: true,
      }
    );

    const result = await searchTools({
      query: 'issue',
      detailLevel: 'names_only',
      service: 'redmine',
    });

    const names = result.matches.map((m) => m.tool);
    // Name-prefix match ranks ahead of the (unboosted) userScoped description match
    expect(names.indexOf('redmine/issueSomething2')).toBeLessThan(
      names.indexOf('redmine/getCurrentUser')
    );

    delete mutableRegistry['redmine']['issueSomething2'];
  });

  it('recognizes Polish self-reference tokens (moje/mnie)', async () => {
    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
    mutableRegistry['redmine']['getCurrentUser'] = {
      ...mutableRegistry['redmine']['getCurrentUser'],
      description: 'Get current Redmine user issues zadania',
      userScoped: true,
    };

    const result = await searchTools({
      query: 'moje zadania',
      detailLevel: 'names_only',
      service: 'redmine',
    });

    expect(result.matches.some((m) => m.tool === 'redmine/getCurrentUser')).toBe(true);
  });

  it('a query consisting only of self-reference tokens ("my") matches only userScoped tools', async () => {
    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
    mutableRegistry['redmine']['getCurrentUser'] = {
      ...mutableRegistry['redmine']['getCurrentUser'],
      userScoped: true,
    };

    const result = await searchTools({
      query: 'my',
      detailLevel: 'names_only',
      service: 'redmine',
    });

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((m) => m.tool === 'redmine/getCurrentUser')).toBe(true);
  });

  it('a query consisting only of self-reference tokens ("moje") matches only userScoped tools', async () => {
    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
    mutableRegistry['redmine']['getCurrentUser'] = {
      ...mutableRegistry['redmine']['getCurrentUser'],
      userScoped: true,
    };

    const result = await searchTools({
      query: 'moje',
      detailLevel: 'names_only',
      service: 'redmine',
    });

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((m) => m.tool === 'redmine/getCurrentUser')).toBe(true);
  });

  it('a self-reference-only query returns no matches when no tool in the service is userScoped', async () => {
    const result = await searchTools({
      query: 'my',
      detailLevel: 'names_only',
      service: 'gitlab',
    });

    expect(result.matches).toEqual([]);
  });

  it('sorts a non-boosted tool after a boosted tool regardless of comparator call order', async () => {
    // Both tools match 'zzzsharedterm' at the same tier, so only selfBoost decides order;
    // 'aaa...' sorts first alphabetically, forcing comparator to see non-boosted as `a`.
    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
    mutableRegistry['redmine']['aaaPlainTool'] = buildMockToolMetadata('redmine', 'aaaPlainTool', {
      description: 'Handles zzzsharedterm but is not userScoped',
      deferLoading: true,
    });
    mutableRegistry['redmine']['getCurrentUser'] = {
      ...mutableRegistry['redmine']['getCurrentUser'],
      description: 'Get current user for zzzsharedterm',
      userScoped: true,
    };

    const result = await searchTools({
      query: 'my zzzsharedterm',
      detailLevel: 'names_only',
      service: 'redmine',
    });

    const names = result.matches.map((m) => m.tool);
    expect(names.indexOf('redmine/getCurrentUser')).toBeLessThan(
      names.indexOf('redmine/aaaPlainTool')
    );

    delete mutableRegistry['redmine']['aaaPlainTool'];
  });

  it('a self-reference-only query with no service filter returns userScoped tools across all enabled services', async () => {
    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
    mutableRegistry['redmine']['getCurrentUser'] = {
      ...mutableRegistry['redmine']['getCurrentUser'],
      userScoped: true,
    };
    mutableRegistry['sharepoint']['getCurrentUser'] = {
      ...mutableRegistry['sharepoint']['getCurrentUser'],
      userScoped: true,
    };

    const result = await searchTools({
      query: 'me',
      detailLevel: 'names_only',
    });

    expect(result.matches.some((m) => m.tool === 'redmine/getCurrentUser')).toBe(true);
    expect(result.matches.some((m) => m.tool === 'sharepoint/getCurrentUser')).toBe(true);
    expect(result.matches.every((m) => m.tool.endsWith('/getCurrentUser'))).toBe(true);
  });

  it('matches a token appearing mid-name even when absent from keywords and description', async () => {
    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
    mutableRegistry['slack']['fooChannelBar'] = buildMockToolMetadata('slack', 'fooChannelBar', {
      description: 'Wholly unrelated prose',
      deferLoading: true,
    });

    const result = await searchTools({
      query: 'channel',
      detailLevel: 'names_only',
      service: 'slack',
    });

    expect(result.matches.some((m) => m.tool === 'slack/fooChannelBar')).toBe(true);

    delete mutableRegistry['slack']['fooChannelBar'];
  });

  it('ranks a name-prefix match ahead of a mid-name substring match', async () => {
    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
    mutableRegistry['slack']['channelPrefix'] = buildMockToolMetadata('slack', 'channelPrefix', {
      description: 'Unrelated prose',
      deferLoading: true,
    });
    mutableRegistry['slack']['zzzChannelSuffix'] = buildMockToolMetadata(
      'slack',
      'zzzChannelSuffix',
      { description: 'Unrelated prose', deferLoading: true }
    );

    const result = await searchTools({
      query: 'channel',
      detailLevel: 'names_only',
      service: 'slack',
    });

    const names = result.matches.map((m) => m.tool);
    expect(names.indexOf('slack/channelPrefix')).toBeLessThan(
      names.indexOf('slack/zzzChannelSuffix')
    );

    delete mutableRegistry['slack']['channelPrefix'];
    delete mutableRegistry['slack']['zzzChannelSuffix'];
  });

  it('caps an oversized whitespace-heavy query without stalling', async () => {
    const query = `sendChannel ${'zz '.repeat(20000)}`;
    const start = Date.now();
    const result = await searchTools({ query, detailLevel: 'names_only', service: 'slack' });
    expect(Date.now() - start).toBeLessThan(500);
    expect(Array.isArray(result.matches)).toBe(true);
    expect(typeof result.total).toBe('number');
  });
});

describe('search-tools repeated-search consistency', () => {
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

  it('returns consistent results across repeated searches for the same tool', async () => {
    const first = await searchTools({
      query: 'sendChannel',
      detailLevel: 'names_only',
      service: 'slack',
    });
    const second = await searchTools({
      query: 'sendChannel',
      detailLevel: 'names_only',
      service: 'slack',
    });
    const third = await searchTools({
      query: 'SENDCHANNEL',
      detailLevel: 'names_only',
      service: 'slack',
    });

    expect(second.matches.map((m) => m.tool)).toEqual(first.matches.map((m) => m.tool));
    expect(third.matches.map((m) => m.tool)).toEqual(first.matches.map((m) => m.tool));
  });
});

describe('searchTools zero-match hint', () => {
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

  it('keeps the {matches: [], total: 0} shape for compatibility', async () => {
    const result = await searchTools({ query: 'xyznonexistent123', detailLevel: 'names_only' });
    expect(result.matches).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('adds a hint suggesting a single keyword or wildcard on a non-matching query', async () => {
    const result = await searchTools({ query: 'xyznonexistent123', detailLevel: 'names_only' });
    expect(result.hint).toBeDefined();
    expect(result.hint).toContain('single keyword');
    expect(result.hint).toContain('*');
  });

  it('names the invalid service and lists valid services when service filter is unrecognized', async () => {
    const result = await searchTools({
      query: '*',
      detailLevel: 'names_only',
      service: 'unknownservice',
    });

    expect(result.hint).toBeDefined();
    expect(result.hint).toContain('unknownservice');
    expect(result.hint).toContain('slack');
    expect(result.hint).toContain('redmine');
  });

  it('shows "(none enabled)" in the hint when no services are enabled', async () => {
    delete process.env.ENABLED_SERVICES;
    resetServiceCaches();

    const result = await searchTools({
      query: '*',
      detailLevel: 'names_only',
      service: 'unknownservice',
    });

    expect(result.hint).toContain('(none enabled)');
  });

  it('gives a service-scoped hint when the service is valid but the query matches nothing in it', async () => {
    const result = await searchTools({
      query: 'xyznonexistent123',
      detailLevel: 'names_only',
      service: 'slack',
    });

    expect(result.hint).toBeDefined();
    expect(result.hint).toContain('slack');
  });

  it('distinguishes a valid but disabled service from a no-match query', async () => {
    process.env.ENABLED_SERVICES = 'slack,sharepoint,redmine,os';
    resetServiceCaches();

    const result = await searchTools({
      query: 'listMrIds',
      detailLevel: 'names_only',
      service: 'gitlab',
    });

    expect(result.hint).toBeDefined();
    expect(result.hint).toContain('gitlab');
    expect(result.hint).toContain('not enabled');
    expect(result.hint).not.toContain('matched this query');
  });

  it('omits hint when there are matches', async () => {
    const result = await searchTools({ query: '*', detailLevel: 'names_only' });
    expect(result.hint).toBeUndefined();
  });
});

describe('renderDescriptionWithIdentity (via searchTools with_descriptions/full_schema)', () => {
  const savedEnabledServices = process.env.ENABLED_SERVICES;

  beforeEach(() => {
    _resetRegistryForTesting();
    populateRegistryWithMockTools();
    resetServiceCaches();
    process.env.ENABLED_SERVICES = 'slack,sharepoint,redmine,gitlab,os';

    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
    mutableRegistry['redmine']['getCurrentUser'] = {
      ...mutableRegistry['redmine']['getCurrentUser'],
      userScoped: true,
      currentUserTool: 'getCurrentUser',
      selfParam: 'user_id',
    };
  });

  afterEach(() => {
    if (savedEnabledServices === undefined) {
      delete process.env.ENABLED_SERVICES;
    } else {
      process.env.ENABLED_SERVICES = savedEnabledServices;
    }
    resetServiceCaches();
  });

  it('omits the full description at names_only but still carries the identity hint', async () => {
    const result = await searchTools({
      query: 'getCurrentUser',
      detailLevel: 'names_only',
      service: 'redmine',
    });

    const hint = result.matches[0].identityHint ?? '';
    expect(result.matches[0].description).toBeUndefined();
    expect(hint).toContain('Results depend on the authenticated user.');
    expect(hint).toContain('Use getCurrentUser to resolve the current user.');
    expect(hint).toContain('Pass "user_id" to reference yourself.');
  });

  it('appends the identity sentence at with_descriptions', async () => {
    const result = await searchTools({
      query: 'getCurrentUser',
      detailLevel: 'with_descriptions',
      service: 'redmine',
    });

    const desc = result.matches[0].description ?? '';
    expect(desc).toContain('Results depend on the authenticated user.');
    expect(desc).toContain('Use getCurrentUser to resolve the current user.');
    expect(desc).toContain('Pass "user_id" to reference yourself.');
  });

  it('appends the identity sentence at full_schema', async () => {
    const result = await searchTools({
      query: 'getCurrentUser',
      detailLevel: 'full_schema',
      service: 'redmine',
    });

    expect(result.matches[0].description).toContain('Results depend on the authenticated user.');
    expect(result.matches[0].inputSchema).toBeDefined();
  });

  it('does not append the sentence for a non-userScoped tool', async () => {
    const result = await searchTools({
      query: 'createIssue',
      detailLevel: 'with_descriptions',
      service: 'redmine',
    });

    expect(result.matches[0].description).not.toContain('authenticated user');
  });

  it('does not set identityHint for a non-userScoped tool at any detail level', async () => {
    const namesOnly = await searchTools({
      query: 'createIssue',
      detailLevel: 'names_only',
      service: 'redmine',
    });
    const withDescriptions = await searchTools({
      query: 'createIssue',
      detailLevel: 'with_descriptions',
      service: 'redmine',
    });

    expect(namesOnly.matches[0].identityHint).toBeUndefined();
    expect(withDescriptions.matches[0].identityHint).toBeUndefined();
  });

  it('sets identityHint for a userScoped tool at with_descriptions and full_schema too', async () => {
    const withDescriptions = await searchTools({
      query: 'getCurrentUser',
      detailLevel: 'with_descriptions',
      service: 'redmine',
    });
    const fullSchema = await searchTools({
      query: 'getCurrentUser',
      detailLevel: 'full_schema',
      service: 'redmine',
    });

    expect(withDescriptions.matches[0].identityHint).toContain(
      'Use getCurrentUser to resolve the current user.'
    );
    expect(fullSchema.matches[0].identityHint).toContain(
      'Use getCurrentUser to resolve the current user.'
    );
  });

  it('never mutates the stored ToolMetadata description', () => {
    const stored = TOOL_REGISTRY['redmine']['getCurrentUser'];
    expect(stored.description).not.toContain('authenticated user');
  });

  it('omits the currentUserTool/selfParam clauses when unset on an otherwise userScoped tool', async () => {
    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
    mutableRegistry['redmine']['getConfig'] = {
      ...mutableRegistry['redmine']['getConfig'],
      userScoped: true,
      currentUserTool: undefined,
      selfParam: undefined,
    };

    const result = await searchTools({
      query: 'getConfig',
      detailLevel: 'with_descriptions',
      service: 'redmine',
    });

    const desc = result.matches[0].description ?? '';
    expect(desc).toContain('Results depend on the authenticated user.');
    expect(desc).not.toContain('resolve the current user');
    expect(desc).not.toContain('reference yourself');
  });

  it('folds a misconfiguration hint into the sentence when neither companion is set', async () => {
    const mutableRegistry = TOOL_REGISTRY as Record<string, Record<string, ToolMetadata>>;
    mutableRegistry['redmine']['getConfig'] = {
      ...mutableRegistry['redmine']['getConfig'],
      userScoped: true,
      currentUserTool: undefined,
      selfParam: undefined,
    };

    const result = await searchTools({
      query: 'getConfig',
      detailLevel: 'with_descriptions',
      service: 'redmine',
    });

    const desc = result.matches[0].description ?? '';
    expect(desc).toContain('Results depend on the authenticated user.');
    expect(desc).toContain('No self-reference helper is configured');
  });

  it('renders no misconfiguration hint when a companion is declared', async () => {
    const result = await searchTools({
      query: 'getCurrentUser',
      detailLevel: 'with_descriptions',
      service: 'redmine',
    });

    const desc = result.matches[0].description ?? '';
    expect(desc).not.toContain('No self-reference helper is configured');
  });
});
