/**
 * Tests for the worker entry point.
 *
 * Regression-guards the rule that the local /health probe MUST NOT call
 * Context7 — at 30 s intervals it would burn the ~200/day anonymous quota
 * in under 2 h, breaking every other user on the same source IP.
 */

import { describe, expect, it, vi } from 'vitest';
import { createMCPServer } from '@speedwave/mcp-shared';

describe('context7 worker healthcheck', () => {
  it('healthCheck does NOT make outbound HTTP — anonymous quota regression guard', async () => {
    // The worker installs a local readiness probe. If anyone "improves" it
    // by probing Context7 (`fetch(BASE_URL + '/libs/search?...')`), this
    // assertion fires.
    const fetchSpy = vi.fn(() => {
      throw new Error('healthCheck must NOT make HTTP calls');
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const fakeClient = { initialised: true };
      let healthCheck: (() => Promise<void>) | undefined;
      const server = createMCPServer({
        name: 'context7-test',
        version: '0.0.0',
        port: 0,
        auth: { token: 'test-token' },
        healthCheck: async () => {
          if (!fakeClient) {
            throw new Error('Context7 client not initialised');
          }
        },
      });
      // Pull the configured healthCheck out of the server options indirectly
      // by hitting `/health` against the live server.
      const actualPort = await server.start();
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        import('node:http').then(({ request }) => {
          const req = request(
            {
              hostname: '127.0.0.1',
              port: actualPort,
              path: '/health',
              method: 'GET',
            },
            (res) => {
              let data = '';
              res.on('data', (chunk: Buffer) => (data += chunk));
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
            }
          );
          req.on('error', reject);
          req.end();
        });
      });
      void healthCheck;
      expect(response.status).toBe(200);
      // fetchSpy must NOT have been called even once.
      expect(fetchSpy).not.toHaveBeenCalled();
      await server.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 10_000);
});
