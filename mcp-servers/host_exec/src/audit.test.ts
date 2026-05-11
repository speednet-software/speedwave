import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { auditRecipeCall } from './audit.js';
import type { HostExecRecipe, HostExecResult } from './types.js';

function recipe(
  p: Partial<HostExecRecipe> & Pick<HostExecRecipe, 'name' | 'exec'>
): HostExecRecipe {
  return { args: [], confirm: 'ask', ...p };
}

const RESULT: HostExecResult = {
  status: 'exited',
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  truncated: false,
  durationMs: 12,
  command: 'test',
  cwd: '.',
};

describe('auditRecipeCall', () => {
  let dir: string;
  const saved = process.env.HOST_EXEC_LOG_FILE;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-exec-audit-'));
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.HOST_EXEC_LOG_FILE;
    else process.env.HOST_EXEC_LOG_FILE = saved;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('appends a JSON line with recipe name, full argv, decision, and result fields', async () => {
    const logFile = path.join(dir, 'log');
    process.env.HOST_EXEC_LOG_FILE = logFile;
    await auditRecipeCall(
      recipe({ name: 'test', exec: './gradlew', args: ['test'] }),
      ['./gradlew', 'test'],
      'allow',
      RESULT
    );
    const content = await fs.readFile(logFile, 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.recipe).toBe('test');
    expect(entry.argv).toEqual(['./gradlew', 'test']);
    expect(entry.confirm).toBe('allow');
    expect(entry.status).toBe('exited');
    expect(entry.exitCode).toBe(0);
    expect(entry.envKeys).toEqual([]);
  });

  it('redacts env VALUES — only sorted keys appear', async () => {
    const logFile = path.join(dir, 'log');
    process.env.HOST_EXEC_LOG_FILE = logFile;
    await auditRecipeCall(
      recipe({
        name: 't',
        exec: './t',
        env: { ZED: 'zzz', ALPHA: 'sk-secret-do-not-log', CI: 'true' },
      }),
      ['./t'],
      'allow-session',
      RESULT
    );
    const content = await fs.readFile(logFile, 'utf-8');
    expect(content).not.toContain('sk-secret-do-not-log');
    expect(content).not.toContain('zzz');
    const entry = JSON.parse(content.trim());
    expect(entry.envKeys).toEqual(['ALPHA', 'CI', 'ZED']);
  });

  it('records "not_executed" when there is no result', async () => {
    const logFile = path.join(dir, 'log');
    process.env.HOST_EXEC_LOG_FILE = logFile;
    await auditRecipeCall(recipe({ name: 't', exec: './t' }), ['./t'], 'deny', undefined);
    const entry = JSON.parse((await fs.readFile(logFile, 'utf-8')).trim());
    expect(entry.status).toBe('not_executed');
    expect(entry.exitCode).toBeNull();
    expect(entry.confirm).toBe('deny');
  });

  it('does not throw when HOST_EXEC_LOG_FILE is unset (logs to stderr)', async () => {
    delete process.env.HOST_EXEC_LOG_FILE;
    await expect(
      auditRecipeCall(recipe({ name: 't', exec: './t' }), ['./t'], 'allow', RESULT)
    ).resolves.toBeUndefined();
  });

  it('does not throw when the log path cannot be written (append fails)', async () => {
    // Point at a path whose parent directory does not exist → ENOENT on append.
    process.env.HOST_EXEC_LOG_FILE = path.join(dir, 'no-such-dir', 'log');
    await expect(
      auditRecipeCall(recipe({ name: 't', exec: './t' }), ['./t'], 'allow', RESULT)
    ).resolves.toBeUndefined();
  });
});
