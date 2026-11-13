import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { executeCode, _setBridgesForTesting } from './executor.js';
import { resetServiceCaches, stopBackgroundRefresh } from './tool-registry.js';
import {
  populateRegistryWithMockTools,
  _resetRegistryForTesting,
  createMockBridges,
} from './test-helpers.js';

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

let written: string[];
let originalFetch: typeof globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

/** All console output so far, one string per call, errors with stack and own properties. */
function output(): string {
  return written.join('\n');
}

function workerResponse(body: unknown, init: { status?: number; isError?: boolean } = {}) {
  const status = init.status ?? 200;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({
      jsonrpc: '2.0',
      id: 'test',
      result: { content: [{ type: 'text', text }], ...(init.isError && { isError: true }) },
    }),
    text: async () => text,
  };
}

beforeAll(() => {
  _resetRegistryForTesting();
  populateRegistryWithMockTools();
});

afterAll(() => {
  stopBackgroundRefresh();
});

beforeEach(() => {
  written = [];
  for (const method of METHODS) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      written.push(
        args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' ')
      );
    });
  }
  for (const key of ['ENABLED_SERVICES', 'WORKER_SLACK_URL', 'NODE_ENV', 'DEBUG']) {
    savedEnv[key] = process.env[key];
  }
  process.env.WORKER_SLACK_URL = 'http://mcp-slack:3001';
  process.env.ENABLED_SERVICES = 'slack';
  resetServiceCaches();
  _setBridgesForTesting(createMockBridges());
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _setBridgesForTesting(null);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServiceCaches();
  vi.restoreAllMocks();
});

describe('hub logging carries no user content', () => {
  describe('tool-call line', () => {
    it('logs parameter names with value lengths and no values', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(workerResponse({ ok: true })) as never;

      await executeCode({
        code: `return await slack.sendChannel({ channel: 'SENTINEL-997-channel', text: 'SENTINEL-997-text', tags: ['SENTINEL-997-tag'], n: 7, u: undefined });`,
        timeoutMs: 5000,
      });

      expect(output()).not.toContain('SENTINEL-997');
      expect(output()).toContain(
        '[WRITE] slack.sendChannel(keys channel:22,text:19,tags:20,n:1,u:0)'
      );
    });

    it('logs a call without parameters with empty parentheses', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(workerResponse([])) as never;

      await executeCode({ code: `return await slack.listChannelIds();`, timeoutMs: 5000 });

      expect(output()).toMatch(/\[(READ|WRITE)\] slack\.listChannelIds\(\)/);
    });
  });

  describe('hub error log', () => {
    it('keeps the worker error message out of the log and in the tool result', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          workerResponse(
            { code: 'READ_FAILED', message: 'PR not found SENTINEL-997-error' },
            { isError: true }
          )
        ) as never;

      const result = await executeCode({
        code: `return await slack.listChannelIds();`,
        timeoutMs: 5000,
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('SENTINEL-997-error');
      expect(output()).not.toContain('SENTINEL-997');
      expect(output()).toContain('callWorker(slack, listChannelIds) failed: code=READ_FAILED');
    });

    it('names a worker error without a code TOOL_ERROR', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          workerResponse('Error: not found SENTINEL-997-plain', { isError: true })
        ) as never;

      await executeCode({ code: `return await slack.listChannelIds();`, timeoutMs: 5000 });

      expect(output()).not.toContain('SENTINEL-997');
      expect(output()).toContain('callWorker(slack, listChannelIds) failed: code=TOOL_ERROR');
    });

    it('keeps a transport error message out of the log', async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(
          new Error('connect failed to https://x.example/?q=SENTINEL-997-net')
        ) as never;

      const result = await executeCode({
        code: `return await slack.listChannelIds();`,
        timeoutMs: 5000,
      });

      expect(result.error?.message).toContain('SENTINEL-997-net');
      expect(output()).not.toContain('SENTINEL-997');
    });

    it('keeps the body of an HTTP error out of the log', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          workerResponse('bad request SENTINEL-997-body', { status: 400 })
        ) as never;

      await executeCode({ code: `return await slack.listChannelIds();`, timeoutMs: 5000 });

      expect(output()).not.toContain('SENTINEL-997');
      expect(output()).toContain('code=HTTP_400');
    });

    it('keeps the body of a session-reset response out of the log', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          workerResponse('session not found SENTINEL-997-session', { status: 404 })
        ) as never;

      await executeCode({ code: `return await slack.listChannelIds();`, timeoutMs: 5000 });

      expect(output()).not.toContain('SENTINEL-997');
    });

    it('keeps the error message out of the log in development mode', async () => {
      process.env.NODE_ENV = 'development';
      process.env.DEBUG = '1';
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('SENTINEL-997-dev')) as never;

      await executeCode({ code: `return await slack.listChannelIds();`, timeoutMs: 5000 });

      expect(output()).not.toContain('SENTINEL-997');
    });

    it('keeps a thrown non-Error value out of the log', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue('SENTINEL-997-string') as never;

      await executeCode({ code: `return await slack.listChannelIds();`, timeoutMs: 5000 });

      expect(output()).not.toContain('SENTINEL-997');
    });
  });

  describe('sandbox console', () => {
    it.each(['log', 'warn', 'error'] as const)(
      'console.%s writes level and length, not the content',
      async (level) => {
        const result = await executeCode({
          code: `console.${level}('SENTINEL-997-console', { a: 'SENTINEL-997-object' }); return 1;`,
          timeoutMs: 5000,
        });

        expect(result.success).toBe(true);
        expect(output()).not.toContain('SENTINEL-997');
        expect(output()).toMatch(new RegExp(`\\[sandbox\\] ${level} length=\\d+`));
      }
    );

    it('reports the length of the formatted output', async () => {
      await executeCode({ code: `console.log('abc', 'de'); return 1;`, timeoutMs: 5000 });

      expect(output()).toContain('[sandbox] log length=6');
    });
  });

  describe('execution error', () => {
    it('keeps the thrown message and the code out of the log', async () => {
      const result = await executeCode({
        code: `const v = 'SENTINEL-997-code'; throw new Error('failed ' + v);`,
        timeoutMs: 5000,
      });

      expect(result.error?.code).toBe('EXECUTION_ERROR');
      expect(result.error?.message).toContain('SENTINEL-997-code');
      expect(output()).not.toContain('SENTINEL-997');
    });

    it('keeps a syntax error excerpt out of the log', async () => {
      await executeCode({ code: `const SENTINEL-997-syntax = {`, timeoutMs: 5000 });

      expect(output()).not.toContain('SENTINEL-997');
    });

    it('logs the denylist pattern and the hit position for rejected code', async () => {
      const code = `const v = 'SENTINEL-997-reject'; eval(v);`;

      const result = await executeCode({ code, timeoutMs: 5000 });

      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(output()).not.toContain('SENTINEL-997');
      expect(output()).toContain(
        `code rejected by pattern \\beval\\s*\\( at ${code.indexOf('eval')}`
      );
    });
  });
});
