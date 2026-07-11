/**
 * Verifies mcp-context7 reads MCP_CONTEXT7_AUTH_TOKEN before starting, loads the optional
 * /tokens/api_key when present, and falls back to anonymous mode when the key is absent.
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

const WORKER_CWD = new URL('..', import.meta.url).pathname;

/** Spawn the worker once and capture its stdout/stderr/exit. */
async function runWorker(env: NodeJS.ProcessEnv): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const result = await exec('node', ['dist/index.js'], {
      cwd: WORKER_CWD,
      env: { ...process.env, ...env },
      timeout: 4000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('context7 auth enforcement', () => {
  it('exits with code 1 when MCP_CONTEXT7_AUTH_TOKEN is not set', async () => {
    const result = await runWorker({ MCP_CONTEXT7_AUTH_TOKEN: '' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('MCP_CONTEXT7_AUTH_TOKEN is required');
  }, 10_000);
});

describe('context7 optional API key', () => {
  let dir: string;

  it('starts in anonymous mode when /tokens/api_key is absent', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-context7-test-'));
    try {
      const result = await runWorker({
        MCP_CONTEXT7_AUTH_TOKEN: 'test-token',
        TOKENS_DIR: dir,
        // Binds ephemerally and exits fast; the 4s timeout in runWorker kills it before it serves traffic.
        PORT: '0',
      });
      // The worker keeps running until SIGTERM (timeout in runWorker). Look at
      // its stdout/stderr for the anonymous-mode log.
      expect(result.stdout + result.stderr).toMatch(/anonymous mode/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('loads key when /tokens/api_key has content', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-context7-test-'));
    try {
      await writeFile(join(dir, 'api_key'), 'ctx7sk_dummy\n');
      const result = await runWorker({
        MCP_CONTEXT7_AUTH_TOKEN: 'test-token',
        TOKENS_DIR: dir,
        PORT: '0',
      });
      expect(result.stdout + result.stderr).toMatch(/API key loaded/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('trims trailing whitespace from api_key — end-to-end via loadToken', async () => {
    // Whitespace stripped by mcp-shared's `loadToken`: a pasted "ctx7sk_xxx\n" must not become
    // "Bearer ctx7sk_xxx\n" (Context7 rejects that with 401).
    const { loadToken } = await import('@speedwave/mcp-shared');
    dir = await mkdtemp(join(tmpdir(), 'mcp-context7-test-'));
    try {
      await writeFile(join(dir, 'api_key'), '  ctx7sk_padded  \n\n');
      const value = await loadToken(join(dir, 'api_key'));
      expect(value).toBe('ctx7sk_padded');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rethrows on EACCES — never silently falls back to anonymous on a real misconfig', async () => {
    // POSIX-only: chmod 000 doesn't deny root, and the CI image runs as root.
    // Skip on Windows (different ACL model) and when running as root.
    if (platform() === 'win32') return;
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    dir = await mkdtemp(join(tmpdir(), 'mcp-context7-test-'));
    try {
      const path = join(dir, 'api_key');
      await writeFile(path, 'ctx7sk_secret');
      await chmod(path, 0o000);

      const { loadToken } = await import('@speedwave/mcp-shared');
      await expect(loadToken(path)).rejects.toThrow(/Permission denied/);
    } finally {
      // Restore perms so rm can clean up.
      await chmod(join(dir, 'api_key'), 0o600).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
