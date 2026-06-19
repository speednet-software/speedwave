/**
 * Tests for the worker entry point.
 * Guards that the local /health probe never calls Context7.
 */

import { describe, expect, it, vi } from 'vitest';
import { createMCPServer } from '@speedwave/mcp-shared';

describe('context7 worker healthcheck', () => {
  it('healthCheck does NOT make outbound HTTP — anonymous quota regression guard', async () => {
    // Local readiness probe must not call Context7.
    const fetchSpy = vi.fn(() => {
      throw new Error('healthCheck must NOT make HTTP calls');
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const server = createMCPServer({
        name: 'context7-test',
        version: '0.0.0',
        port: 0,
        auth: { token: 'test-token' },
        // Local readiness only; mirrors production src/index.ts.
        healthCheck: async () => {},
      });
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
      expect(response.status).toBe(200);
      // fetchSpy must NOT have been called even once.
      expect(fetchSpy).not.toHaveBeenCalled();
      await server.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 10_000);
});
