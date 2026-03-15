/**
 * MCP OS Worker Integration Tests
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { createToolDefinitions } from './tools/index.js';
import { createMCPServer } from '@speedwave/mcp-shared';

// Mock the platform runner so tests don't need real binaries
vi.mock('./platform-runner.js', () => ({
  runCommand: vi.fn().mockResolvedValue({ stdout: '{}', parsed: {} }),
}));

describe('mcp-os integration', () => {
  describe('createToolDefinitions', () => {
    it('returns all 25 tools', () => {
      const tools = createToolDefinitions();
      expect(tools).toHaveLength(25);
    });

    it('all tool names are unique', () => {
      const tools = createToolDefinitions();
      const names = tools.map((t) => t.tool.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('all tools have valid structure', () => {
      const tools = createToolDefinitions();
      for (const { tool, handler } of tools) {
        expect(tool.name).toBeTypeOf('string');
        expect(tool.name.length).toBeGreaterThan(0);
        expect(tool.description).toBeTypeOf('string');
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.inputSchema.type).toBe('object');
        expect(handler).toBeTypeOf('function');
      }
    });

    it('contains all reminder tools', () => {
      const tools = createToolDefinitions();
      const names = tools.map((t) => t.tool.name);
      expect(names).toContain('listReminderLists');
      expect(names).toContain('listReminders');
      expect(names).toContain('getReminder');
      expect(names).toContain('createReminder');
      expect(names).toContain('completeReminder');
    });

    it('contains all calendar tools', () => {
      const tools = createToolDefinitions();
      const names = tools.map((t) => t.tool.name);
      expect(names).toContain('listCalendars');
      expect(names).toContain('listEvents');
      expect(names).toContain('getEvent');
      expect(names).toContain('createEvent');
      expect(names).toContain('updateEvent');
      expect(names).toContain('deleteEvent');
    });

    it('contains all mail tools', () => {
      const tools = createToolDefinitions();
      const names = tools.map((t) => t.tool.name);
      expect(names).toContain('detectMailClients');
      expect(names).toContain('listMailboxes');
      expect(names).toContain('listEmails');
      expect(names).toContain('getEmail');
      expect(names).toContain('searchEmails');
      expect(names).toContain('sendEmail');
      expect(names).toContain('replyToEmail');
    });

    it('contains all notes tools', () => {
      const tools = createToolDefinitions();
      const names = tools.map((t) => t.tool.name);
      expect(names).toContain('listNoteFolders');
      expect(names).toContain('listNotes');
      expect(names).toContain('getNote');
      expect(names).toContain('searchNotes');
      expect(names).toContain('createNote');
      expect(names).toContain('updateNote');
      expect(names).toContain('deleteNote');
    });

    it('tool names use camelCase', () => {
      const tools = createToolDefinitions();
      for (const { tool } of tools) {
        // camelCase: starts with lowercase letter, no underscores, no hyphens
        expect(tool.name).toMatch(/^[a-z][a-zA-Z]*$/);
      }
    });

    it('tools with required fields have them in schema', () => {
      const tools = createToolDefinitions();
      const toolsWithRequired = [
        'getReminder',
        'createReminder',
        'completeReminder',
        'getEvent',
        'createEvent',
        'updateEvent',
        'deleteEvent',
        'getEmail',
        'searchEmails',
        'sendEmail',
        'replyToEmail',
        'getNote',
        'searchNotes',
        'createNote',
        'updateNote',
        'deleteNote',
      ];

      for (const { tool } of tools) {
        if (toolsWithRequired.includes(tool.name)) {
          expect(
            tool.inputSchema.required,
            `${tool.name} should have required fields`
          ).toBeDefined();
          expect(tool.inputSchema.required!.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('tool handlers return MCP format', () => {
    it('handlers return ToolsCallResult format through withValidation', async () => {
      const tools = createToolDefinitions();
      // Pick a simple tool to test the format
      const listReminderLists = tools.find((t) => t.tool.name === 'listReminderLists')!;

      const result = await listReminderLists.handler({});

      // withValidation wraps everything in MCP ToolsCallResult format
      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]).toHaveProperty('type', 'text');
      expect(result.content[0]).toHaveProperty('text');
    });
  });
});

describe('auth enforcement', () => {
  const TEST_TOKEN = 'test-secret-token-abc123';

  it('exits with code 1 when MCP_OS_AUTH_TOKEN is not set', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    const cwd = new URL('..', import.meta.url).pathname;

    try {
      await exec('node', ['dist/index.js'], {
        cwd,
        env: { ...process.env, MCP_OS_AUTH_TOKEN: '' },
        timeout: 5000,
      });
      expect.unreachable('Should have exited with code 1');
    } catch (error: unknown) {
      const execError = error as { code: number; stderr: string };
      expect(execError.code).toBe(1);
      expect(execError.stderr).toContain('MCP_OS_AUTH_TOKEN is required');
    }
  });

  describe('middleware', () => {
    let httpServer: http.Server | undefined;
    let port: number;

    function request(options: {
      path: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Request timeout')), 5000);
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: options.path,
            method: options.method || 'GET',
            headers: options.headers || {},
          },
          (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => (data += chunk));
            res.on('end', () => {
              clearTimeout(timeout);
              resolve({ status: res.statusCode!, body: data });
            });
          }
        );
        req.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        if (options.body) req.write(options.body);
        req.end();
      });
    }

    afterEach(async () => {
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
        httpServer = undefined;
      }
    });

    async function startServerWithAuth(token: string): Promise<void> {
      const server = createMCPServer({
        name: 'mcp-os-test',
        version: '1.0.0',
        port: 0,
        auth: { token },
      });

      await new Promise<void>((resolve) => {
        httpServer = server.app.listen(0, () => {
          const addr = httpServer!.address();
          if (addr && typeof addr === 'object') {
            port = addr.port;
          }
          resolve();
        });
      });
    }

    it('returns 401 for requests without Bearer token', async () => {
      await startServerWithAuth(TEST_TOKEN);

      const res = await request({
        path: '/',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 for requests with wrong Bearer token', async () => {
      await startServerWithAuth(TEST_TOKEN);

      const res = await request({
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-token',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 for requests with Basic auth scheme', async () => {
      await startServerWithAuth(TEST_TOKEN);

      const res = await request({
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`user:${TEST_TOKEN}`).toString('base64')}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      expect(res.status).toBe(401);
    });

    it('passes requests with correct Bearer token', async () => {
      await startServerWithAuth(TEST_TOKEN);

      const res = await request({
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      expect(res.status).toBe(200);
    });

    it('/health endpoint works without auth', async () => {
      await startServerWithAuth(TEST_TOKEN);

      const res = await request({ path: '/health' });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('ok');
    });

    it('/health returns only minimal data when auth is configured', async () => {
      await startServerWithAuth(TEST_TOKEN);

      const res = await request({ path: '/health' });
      const body = JSON.parse(res.body);

      // Should NOT leak version, tools list, platform, session count
      expect(body).toEqual({ status: 'ok' });
    });

    it('returns 401 for Bearer with empty token value', async () => {
      await startServerWithAuth(TEST_TOKEN);

      const res = await request({
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 for lowercase bearer scheme', async () => {
      await startServerWithAuth(TEST_TOKEN);

      const res = await request({
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 for token with extra whitespace', async () => {
      await startServerWithAuth(TEST_TOKEN);

      const res = await request({
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer  ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 for path traversal attempt on health endpoint', async () => {
      await startServerWithAuth(TEST_TOKEN);

      const res = await request({
        path: '/health/../',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 for SSE requests without auth', async () => {
      await startServerWithAuth(TEST_TOKEN);

      const res = await request({
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      expect(res.status).toBe(401);
    });

    it('returns 401 for GET request to /', async () => {
      await startServerWithAuth(TEST_TOKEN);

      const res = await request({ path: '/', method: 'GET' });

      expect(res.status).toBe(401);
    });

    it('returns 401 for Authorization header without space (BearerTOKEN)', async () => {
      await startServerWithAuth(TEST_TOKEN);

      const res = await request({
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer${TEST_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      expect(res.status).toBe(401);
    });
  });
});
