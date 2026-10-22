/** Custom MCP servers in the hub: gated tool states, the raw catalog channel and per-service PII mode. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LATEST_PROTOCOL_VERSION, META_KEYS, type Tool } from '@speedwave/mcp-shared';
import { executeCode, _setBridgesForTesting } from './executor.js';
import { getEngine } from './policy.js';
import { _setServicePiiModesForTesting } from './pii-mode.js';
import { searchTools, TOKENS_MODE_SENTENCE } from './search-tools.js';
import {
  buildExecutorWrappers,
  buildServiceBridge,
  getToolMetadata,
  refreshServiceTools,
  resetServiceCaches,
  _setServiceNamesForTesting,
} from './tool-registry.js';
import { _resetRegistryForTesting, createMockBridges } from './test-helpers.js';
import { mergeToolWithMeta } from './tool-discovery.js';

vi.mock('./auth-tokens.js', () => ({ getAuthToken: vi.fn(() => 'hub-bearer') }));

function gated(name: string, state: string, upstreamName = name): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    _meta: {
      [META_KEYS.TOOL_STATE]: state,
      [META_KEYS.UPSTREAM_NAME]: upstreamName,
      [META_KEYS.DEFER_LOADING]: true,
    },
  };
}

const GUARD_TOOLS: Tool[] = [
  gated('get_file', 'allowed', 'files.get'),
  gated('post_comment', 'pending'),
  gated('delete_file', 'blocked'),
  gated('rename_file', 'changed'),
];

interface WorkerCall {
  url: string;
  name: string;
  args: Record<string, unknown>;
}

let calls: WorkerCall[];
let toolResult: (args: Record<string, unknown>) => unknown;
let auditDir: string;
const savedEnv = { ...process.env };
const originalFetch = globalThis.fetch;

function installWorkerFetch(tools: Tool[]): void {
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const message = JSON.parse(String(init?.body ?? '{}'));
    const respond = (result: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json', ...headers },
      });
    if (message.method === 'initialize') {
      return respond(
        {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mcp-custom-figma', version: '1.0.0' },
        },
        { 'mcp-session-id': 'sess-1' }
      );
    }
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (message.method === 'tools/list') return respond({ tools });
    calls.push({ url: String(url), name: message.params.name, args: message.params.arguments });
    return respond({
      content: [{ type: 'text', text: JSON.stringify(toolResult(message.params.arguments)) }],
    });
  }) as unknown as typeof fetch;
}

function tokenFor(email: string): string {
  const { value } = getEngine().tokenize({ email });
  return (value as { email: string }).email;
}

function auditRows(): Array<Record<string, unknown>> {
  const file = join(auditDir, 'audit-hub.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

beforeEach(async () => {
  calls = [];
  toolResult = () => ({ ok: true });
  auditDir = mkdtempSync(join(tmpdir(), 'hub-custom-'));
  process.env.AUDIT_DIR = auditDir;
  process.env.ENABLED_SERVICES = 'slack,custom-figma';
  process.env.WORKER_CUSTOM_FIGMA_URL = 'http://mcp-custom-figma:3000/';
  process.env.WORKER_SLACK_URL = 'http://mcp-slack:3001/';
  resetServiceCaches();
  _resetRegistryForTesting();
  _setServiceNamesForTesting(['slack', 'custom-figma']);
  _setBridgesForTesting(createMockBridges());
  _setServicePiiModesForTesting(new Map());
  installWorkerFetch(GUARD_TOOLS);
  await refreshServiceTools('custom-figma');
  installWorkerFetch([
    {
      name: 'send_channel',
      description: 'Send a Slack channel message',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      _meta: { [META_KEYS.DEFER_LOADING]: false },
    },
  ]);
  await refreshServiceTools('slack');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...savedEnv };
  resetServiceCaches();
  _setBridgesForTesting(null);
  _setServicePiiModesForTesting(new Map());
  _resetRegistryForTesting();
  vi.restoreAllMocks();
  rmSync(auditDir, { recursive: true, force: true });
});

describe('gated tool states', () => {
  it('parses the gate state and upstream name; an ungated worker is allowed', () => {
    const merged = mergeToolWithMeta(GUARD_TOOLS[0], 'custom-figma', 'getFile');
    expect(merged.toolState).toBe('allowed');
    expect(merged.upstreamName).toBe('files.get');
    const plain = mergeToolWithMeta(
      { name: 'x', description: 'x', inputSchema: { type: 'object', properties: {} } },
      'slack',
      'x'
    );
    expect(plain.toolState).toBe('allowed');
    expect(plain.upstreamName).toBeUndefined();
  });

  it('treats an absent state on a custom service as pending, without a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bare: Tool = {
      name: 'x',
      description: 'x',
      inputSchema: { type: 'object', properties: {} },
    };
    expect(mergeToolWithMeta(bare, 'custom-figma', 'x').toolState).toBe('pending');
    expect(mergeToolWithMeta({ ...bare, _meta: {} }, 'custom-figma', 'x').toolState).toBe(
      'pending'
    );
    expect(warn.mock.calls.some((c) => String(c[0]).includes('unknown tool-state'))).toBe(false);
  });

  it('treats an unknown or non-string state as pending on a custom service and allowed elsewhere, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const state of ['approved', 7, null]) {
      const tool = { ...GUARD_TOOLS[0], _meta: { [META_KEYS.TOOL_STATE]: state } } as Tool;
      expect(mergeToolWithMeta(tool, 'custom-figma', 'getFile').toolState).toBe('pending');
      expect(mergeToolWithMeta(tool, 'my-plugin', 'getFile').toolState).toBe('allowed');
    }
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(
      lines.filter((l) => l.includes('unknown tool-state — treating as pending'))
    ).toHaveLength(3);
    expect(
      lines.filter((l) => l.includes('unknown tool-state — treating as allowed'))
    ).toHaveLength(3);
  });

  it('hides a custom tool listed without a gate state', async () => {
    installWorkerFetch([
      { name: 'ungated', description: 'No gate', inputSchema: { type: 'object', properties: {} } },
      GUARD_TOOLS[0],
    ]);
    await refreshServiceTools('custom-figma');
    expect(getToolMetadata('custom-figma', 'ungated')).toBeUndefined();
    expect(getToolMetadata('custom-figma', 'getFile')).toBeDefined();
  });

  it('keeps only allowed tools in the registry', () => {
    expect(getToolMetadata('custom-figma', 'getFile')?.upstreamName).toBe('files.get');
    for (const hidden of ['postComment', 'deleteFile', 'renameFile']) {
      expect(getToolMetadata('custom-figma', hidden)).toBeUndefined();
    }
  });

  it('hides pending, blocked and changed tools from search_tools', async () => {
    const result = await searchTools({ query: '*', detailLevel: 'names_only' });
    const custom = result.matches.filter((match) => match.service === 'custom-figma');
    expect(custom.map((match) => match.tool)).toEqual(['custom-figma/getFile']);
  });

  it('hides pending, blocked and changed tools from the execute_code sandbox', async () => {
    const bridge = buildServiceBridge('custom-figma', vi.fn());
    const wrappers = buildExecutorWrappers(
      'custom-figma',
      bridge,
      (_s, _t, fn) => fn,
      (params) => params,
      (call) => call()
    );
    expect(Object.keys(wrappers)).toEqual(['getFile']);

    installWorkerFetch(GUARD_TOOLS);
    const result = await executeCode({
      code: `return typeof customFigma.postComment + ',' + typeof customFigma.getFile;`,
      timeoutMs: 5000,
    });
    expect(result.data).toBe('undefined,function');
  });
});

describe('raw tool catalog', () => {
  it('writes every listed tool with its state before the drop', () => {
    const catalog = JSON.parse(
      readFileSync(join(auditDir, 'tool-catalog-custom-figma.json'), 'utf-8')
    );
    expect(catalog.service).toBe('custom-figma');
    expect(
      catalog.tools.map((tool: { name: string; state: string; upstream_name: string }) => [
        tool.name,
        tool.state,
        tool.upstream_name,
      ])
    ).toEqual([
      ['get_file', 'allowed', 'files.get'],
      ['post_comment', 'pending', 'post_comment'],
      ['delete_file', 'blocked', 'delete_file'],
      ['rename_file', 'changed', 'rename_file'],
    ]);
  });

  it('writes no catalog for built-in services', () => {
    expect(existsSync(join(auditDir, 'tool-catalog-slack.json'))).toBe(false);
  });
});

describe('per-service PII mode', () => {
  it('forwards tokens to a custom server unchanged and never detokenizes them', async () => {
    const token = tokenFor('alice@example.com');
    const detokenize = vi.spyOn(getEngine(), 'detokenize');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    installWorkerFetch(GUARD_TOOLS);

    const result = await executeCode({
      code: `return await customFigma.getFile({ text: ${JSON.stringify(`mail ${token} and ${token}`)} });`,
      timeoutMs: 5000,
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('get_file');
    expect(calls[0].args).toEqual({ text: `mail ${token} and ${token}` });
    expect(JSON.stringify(calls)).not.toContain('alice@example.com');
    expect(detokenize).not.toHaveBeenCalled();
    const auditLine = log.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('custom-figma.getFile('));
    expect(auditLine).toContain('pii_mode=tokens');

    const argRows = auditRows().filter((row) => row.layer === 'tool-args');
    expect(argRows).toEqual([
      expect.objectContaining({
        layer: 'tool-args',
        category: 'EMAIL',
        action: 'tokenized',
        count: 2,
        tool: 'custom-figma.getFile',
      }),
    ]);
    expect(readFileSync(join(auditDir, 'audit-hub.jsonl'), 'utf-8')).not.toContain(token);
  });

  it('writes no tool-args rows when the arguments carry no tokens', async () => {
    installWorkerFetch(GUARD_TOOLS);
    await executeCode({
      code: `return await customFigma.getFile({ text: 'hi' });`,
      timeoutMs: 5000,
    });
    expect(auditRows().filter((row) => row.layer === 'tool-args')).toEqual([]);
  });

  it('keeps a token the server echoes back identical through result tokenization', async () => {
    const token = tokenFor('bob@example.com');
    toolResult = (args) => ({ echoed: args.text });
    installWorkerFetch(GUARD_TOOLS);

    const result = await executeCode({
      code: `return await customFigma.getFile({ text: ${JSON.stringify(token)} });`,
      timeoutMs: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ echoed: token });
  });

  it('detokenizes for a custom server the policy explicitly sets to plaintext', async () => {
    _setServicePiiModesForTesting(new Map([['custom-figma', 'plaintext']]));
    const token = tokenFor('carol@example.com');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    installWorkerFetch(GUARD_TOOLS);

    await executeCode({
      code: `return await customFigma.getFile({ text: ${JSON.stringify(token)} });`,
      timeoutMs: 5000,
    });

    expect(calls[0].args).toEqual({ text: 'carol@example.com' });
    expect(auditRows().filter((row) => row.layer === 'tool-args')).toEqual([]);
    const auditLine = log.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('custom-figma.getFile('));
    expect(auditLine).toContain('pii_mode=plaintext');
  });

  it('leaves built-in services on plaintext', async () => {
    const token = tokenFor('dave@example.com');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    installWorkerFetch([]);

    await executeCode({
      code: `return await slack.sendChannel({ text: ${JSON.stringify(token)} });`,
      timeoutMs: 5000,
    });

    expect(calls[0].args).toEqual({ text: 'dave@example.com' });
    const auditLine = log.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('slack.sendChannel('));
    expect(auditLine).toContain('pii_mode=plaintext');
  });

  it('tells the model that arguments stay tokenized for tokens-mode services only', async () => {
    for (const detailLevel of ['with_descriptions', 'full_schema'] as const) {
      const result = await searchTools({ query: '*', detailLevel });
      const custom = result.matches.find((match) => match.service === 'custom-figma');
      const slack = result.matches.find((match) => match.service === 'slack');
      expect(custom?.description).toBe(`get_file tool ${TOKENS_MODE_SENTENCE}`);
      expect(slack?.description).toBe('Send a Slack channel message');
    }
    const names = await searchTools({ query: '*', detailLevel: 'names_only' });
    expect(names.matches.every((match) => match.description === undefined)).toBe(true);

    _setServicePiiModesForTesting(new Map([['custom-figma', 'plaintext']]));
    const plaintext = await searchTools({ query: '*', detailLevel: 'with_descriptions' });
    expect(plaintext.matches.find((m) => m.service === 'custom-figma')?.description).toBe(
      'get_file tool'
    );
  });
});
