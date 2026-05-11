/**
 * Tests for Atlassian credential loading and the auth-token wiring.
 *
 * `normalizeSiteUrl` and `readCredentials` are unit-tested with a mocked `fs`.
 * The `MCP_ATLASSIAN_AUTH_TOKEN` exit-1 contract and `createMCPServer` middleware
 * wiring follow the same shape as the other workers (see `redmine/src/auth.test.ts`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createMCPServer } from '@speedwave/mcp-shared';

// ── fs mock ────────────────────────────────────────────────────────────────
const readFileMock = vi.fn();
vi.mock('node:fs', () => ({
  promises: {
    readFile: (...args: unknown[]) => readFileMock(...args),
  },
}));

// Imported after the mock is registered.
import { normalizeSiteUrl, readCredentials } from './auth.js';

/** Build an fs.readFile mock that resolves files from a map and ENOENTs the rest. */
function fsFrom(files: Record<string, string>): void {
  readFileMock.mockImplementation(async (p: string) => {
    const name = p.split('/').pop()!;
    if (name in files) return files[name];
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

beforeEach(() => {
  readFileMock.mockReset();
});

describe('normalizeSiteUrl', () => {
  it('accepts a bare https://*.atlassian.net URL', () => {
    expect(normalizeSiteUrl('https://acme.atlassian.net')).toBe('https://acme.atlassian.net');
  });

  it('lower-cases the host and strips a trailing slash', () => {
    expect(normalizeSiteUrl('https://ACME.Atlassian.Net/')).toBe('https://acme.atlassian.net');
  });

  it('accepts explicit port 443', () => {
    expect(normalizeSiteUrl('https://acme.atlassian.net:443')).toBe('https://acme.atlassian.net');
  });

  it.each([
    ['http (not https)', 'http://acme.atlassian.net'],
    ['wrong domain', 'https://acme.example.com'],
    ['jira-server style host', 'https://jira.acme.com'],
    ['embedded credentials', 'https://user:pass@acme.atlassian.net'],
    ['non-default port', 'https://acme.atlassian.net:8443'],
    ['has a path', 'https://acme.atlassian.net/wiki'],
    ['not a URL at all', 'acme.atlassian.net'],
    ['empty string', ''],
  ])('rejects %s', (_label, input) => {
    expect(normalizeSiteUrl(input)).toBeNull();
  });
});

describe('readCredentials', () => {
  it('returns the full config when all required files are present', async () => {
    fsFrom({
      site_url: 'https://acme.atlassian.net\n',
      email: 'bot@acme.com\n',
      api_token: 'ATATT3xSecret\n',
    });
    expect(await readCredentials()).toEqual({
      siteUrl: 'https://acme.atlassian.net',
      email: 'bot@acme.com',
      apiToken: 'ATATT3xSecret',
      jiraProjectKeys: [],
      confluenceSpaceKeys: [],
    });
  });

  it('parses optional allowlists (comma + whitespace separated, deduped, upper-cased)', async () => {
    fsFrom({
      site_url: 'https://acme.atlassian.net',
      email: 'bot@acme.com',
      api_token: 'ATATT3xSecret',
      jira_project_keys: 'proj, ops\nproj',
      confluence_space_keys: 'dev docs',
    });
    const cfg = await readCredentials();
    expect(cfg?.jiraProjectKeys).toEqual(['PROJ', 'OPS']);
    expect(cfg?.confluenceSpaceKeys).toEqual(['DEV', 'DOCS']);
  });

  it('treats an empty allowlist file as unrestricted', async () => {
    fsFrom({
      site_url: 'https://acme.atlassian.net',
      email: 'bot@acme.com',
      api_token: 'ATATT3xSecret',
      jira_project_keys: '   \n',
    });
    expect((await readCredentials())?.jiraProjectKeys).toEqual([]);
  });

  it('returns null when site_url is missing', async () => {
    fsFrom({ email: 'bot@acme.com', api_token: 'ATATT3xSecret' });
    expect(await readCredentials()).toBeNull();
  });

  it('returns null when api_token is empty', async () => {
    fsFrom({ site_url: 'https://acme.atlassian.net', email: 'bot@acme.com', api_token: '   ' });
    expect(await readCredentials()).toBeNull();
  });

  it('returns null when site_url is invalid', async () => {
    fsFrom({
      site_url: 'https://jira.internal.example.com',
      email: 'bot@acme.com',
      api_token: 'ATATT3xSecret',
    });
    expect(await readCredentials()).toBeNull();
  });

  it('returns null and logs when a required file errors non-ENOENT', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      const name = p.split('/').pop()!;
      if (name === 'site_url') {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return 'x';
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await readCredentials()).toBeNull();
    warn.mockRestore();
  });

  it('logs but does not throw when an allowlist file errors non-ENOENT', async () => {
    readFileMock.mockImplementation(async (p: string) => {
      const name = p.split('/').pop()!;
      if (name === 'site_url') return 'https://acme.atlassian.net';
      if (name === 'email') return 'bot@acme.com';
      if (name === 'api_token') return 'ATATT3xSecret';
      const err = new Error('EIO') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = await readCredentials();
    expect(cfg?.jiraProjectKeys).toEqual([]);
    expect(cfg?.confluenceSpaceKeys).toEqual([]);
    warn.mockRestore();
  });
});

describe('atlassian auth enforcement (process exit)', () => {
  it('exits with code 1 when MCP_ATLASSIAN_AUTH_TOKEN is not set', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const cwd = new URL('..', import.meta.url).pathname;
    try {
      await exec('node', ['dist/index.js'], {
        cwd,
        env: { ...process.env, MCP_ATLASSIAN_AUTH_TOKEN: '' },
        timeout: 5000,
      });
      expect.unreachable('Should have exited with code 1');
    } catch (error: unknown) {
      const e = error as { code: number; stderr: string };
      expect(e.code).toBe(1);
      expect(e.stderr).toContain('MCP_ATLASSIAN_AUTH_TOKEN is required');
    }
  });
});

describe('atlassian middleware wiring', () => {
  let server: http.Server | undefined;
  let port: number;

  function request(opts: {
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
          path: opts.path,
          method: opts.method || 'GET',
          headers: opts.headers || {},
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => (data += c));
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
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  async function listen(mcp: ReturnType<typeof createMCPServer>): Promise<void> {
    await new Promise<void>((resolve) => {
      server = mcp.app.listen(0, () => {
        const addr = server!.address();
        if (addr && typeof addr === 'object') port = addr.port;
        resolve();
      });
    });
  }

  it('returns 401 for requests without a Bearer token', async () => {
    const mcp = createMCPServer({
      name: 'mcp-atlassian-test',
      version: '1.0.0',
      port: 0,
      auth: { token: 'test-atlassian-token' },
    });
    await listen(mcp);
    const res = await request({
      path: '/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it('/health returns 500 when the configured healthCheck throws', async () => {
    const mcp = createMCPServer({
      name: 'mcp-atlassian-test',
      version: '1.0.0',
      port: 0,
      auth: { token: 'test-atlassian-token' },
      healthCheck: async () => {
        throw new Error('Atlassian client not configured');
      },
    });
    await listen(mcp);
    const res = await request({ path: '/health' });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ status: 'error' });
  });
});
