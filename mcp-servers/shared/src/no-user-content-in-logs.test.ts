import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import type { Request, Response } from 'express';
import { JSONRPCHandler } from './jsonrpc.js';
import { handleMCPPost } from './transport.js';
import { retryAsync } from './retry.js';

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

let written: string[];

beforeEach(() => {
  written = [];
  for (const method of METHODS) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      written.push(inspect(args, { depth: 8 }));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shared logging carries no user content', () => {
  it('internal error of a tool handler', async () => {
    const sentinel = 'SENTINEL-997-jsonrpc';
    const handler = new JSONRPCHandler({ name: 'worker', version: '1.0.0' });
    handler.registerTool(
      {
        name: 'boom',
        description: 'boom',
        inputSchema: { type: 'object', properties: {} },
      },
      async () => {
        throw new Error(`failed for ${sentinel}`);
      }
    );

    const response = await handler.processRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'boom', arguments: { text: sentinel } },
      },
      null
    );

    expect(response.response?.error?.message).toBe('Internal error');
    expect(written.length).toBeGreaterThan(0);
    expect(written.join('\n')).not.toContain(sentinel);
  });

  it('unhandled error in the POST handler', async () => {
    const sentinel = 'SENTINEL-997-transport';
    const throwing = {
      processRequest: vi.fn().mockRejectedValue(new Error(`crash ${sentinel}`)),
    } as unknown as JSONRPCHandler;
    const res = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    };

    await handleMCPPost(
      throwing,
      {
        body: { jsonrpc: '2.0', id: 1, method: 'ping' },
        headers: {},
        get: () => undefined,
      } as unknown as Request,
      res as unknown as Response
    );

    expect(written.length).toBeGreaterThan(0);
    expect(written.join('\n')).not.toContain(sentinel);
  });

  it('failed attempt in retryAsync', async () => {
    const sentinel = 'SENTINEL-997-retry';

    await retryAsync(() => Promise.reject(new Error(`fetch failed for ${sentinel}`)), {
      maxRetries: 0,
      label: 'init',
    });

    expect(written.length).toBeGreaterThan(0);
    expect(written.join('\n')).not.toContain(sentinel);
  });
});
