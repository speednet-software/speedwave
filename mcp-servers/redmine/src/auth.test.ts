/**
 * Redmine worker auth wiring tests (SEC-035)
 *
 * Verifies that mcp-redmine reads MCP_REDMINE_AUTH_TOKEN and passes it to createMCPServer.
 * Middleware correctness is covered by shared/src/server.test.ts — here we test wiring only.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createMCPServer } from '@speedwave/mcp-shared';

describe('redmine auth enforcement', () => {
  it('exits with code 1 when MCP_REDMINE_AUTH_TOKEN is not set', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    const cwd = new URL('..', import.meta.url).pathname;

    try {
      await exec('node', ['dist/index.js'], {
        cwd,
        env: { ...process.env, MCP_REDMINE_AUTH_TOKEN: '' },
        timeout: 5000,
      });
      expect.unreachable('Should have exited with code 1');
    } catch (error: unknown) {
      const execError = error as { code: number; stderr: string };
      expect(execError.code).toBe(1);
      expect(execError.stderr).toContain('MCP_REDMINE_AUTH_TOKEN is required');
    }
  });

  describe('middleware wiring', () => {
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

    it('returns 401 for requests without Bearer token', async () => {
      const server = createMCPServer({
        name: 'mcp-redmine-test',
        version: '1.0.0',
        port: 0,
        auth: { token: 'test-redmine-token' },
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

      const res = await request({
        path: '/',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      expect(res.status).toBe(401);
    });

    it('/health returns 500 when healthCheck fails with auth', async () => {
      const server = createMCPServer({
        name: 'mcp-redmine-test',
        version: '1.0.0',
        port: 0,
        auth: { token: 'test-redmine-token' },
        healthCheck: async () => {
          throw new Error('Redmine client not configured');
        },
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

      const res = await request({ path: '/health' });
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ status: 'error' });
    });
  });
});
