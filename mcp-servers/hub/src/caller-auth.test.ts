import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCallerAuth } from './caller-auth.js';

const HEADER = 'x-speedwave-proxy-auth';

describe('createCallerAuth', () => {
  let dir: string;
  let tokenPath: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'caller-auth-'));
    tokenPath = join(dir, 'caller-token');
    const app = express();
    app.use(createCallerAuth(tokenPath));
    app.post('/', (_req, res) => {
      res.json({ ok: true });
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  async function post(token?: string): Promise<number> {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: token === undefined ? {} : { [HEADER]: token },
    });
    return res.status;
  }

  it('lets a request with the right token through', async () => {
    writeFileSync(tokenPath, 'secret-1\n');
    expect(await post('secret-1')).toBe(200);
  });

  it('answers 401 without the header or with a wrong token', async () => {
    writeFileSync(tokenPath, 'secret-1');
    expect(await post()).toBe(401);
    expect(await post('secret-2')).toBe(401);
    expect(await post('')).toBe(401);
  });

  it('rejects every request while the token file is missing or empty', async () => {
    expect(await post('secret-1')).toBe(401);
    writeFileSync(tokenPath, '  \n');
    expect(await post('')).toBe(401);
    expect(await post('secret-1')).toBe(401);
  });

  it('follows a rotated token without a restart', async () => {
    writeFileSync(tokenPath, 'first');
    expect(await post('first')).toBe(200);
    writeFileSync(tokenPath, 'second');
    expect(await post('first')).toBe(401);
    expect(await post('second')).toBe(200);
  });

  it('does not echo the token in the log or the response body', async () => {
    writeFileSync(tokenPath, 'expected-secret');
    const res = await fetch(baseUrl, { method: 'POST', headers: { [HEADER]: 'presented-secret' } });
    expect(await res.text()).not.toContain('secret');
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).not.toContain('expected-secret');
    expect(logged).not.toContain('presented-secret');
  });
});
