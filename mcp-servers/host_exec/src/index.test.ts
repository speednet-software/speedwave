/**
 * Entrypoint tests for the `host_exec` worker — the fatal-exit branches
 * (missing auth token / missing or malformed config snapshot / invalid PORT).
 * Like `mcp-os`'s index test, these spawn the built `dist/index.js` as a
 * subprocess (the only way to exercise `process.exit(1)`); the entrypoint is
 * deliberately NOT imported here (importing it would run `main()` in the test
 * process). The successful-startup path is covered indirectly by the unit tests
 * (they exercise `createMCPServer`, the tools, the confirm channel, etc.).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
// .../mcp-servers/host_exec/  (this file is at .../host_exec/src/index.test.ts)
const workerDir = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const distIndex = path.join(workerDir, 'dist', 'index.js');

/** Run `node dist/index.js` with the given env overrides; expect it to exit 1. */
async function expectExit1(
  overrides: Record<string, string | undefined>,
  stderrMatch: RegExp
): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: '0' };
  // Don't let the worker inherit vitest's coverage instrumentation.
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_OPTIONS;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  try {
    await execFileP('node', [distIndex], { cwd: workerDir, env, timeout: 8000 });
    expect.unreachable('worker should have exited with code 1');
  } catch (e) {
    const err = e as { code?: number; stderr?: string };
    expect(err.code).toBe(1);
    expect(err.stderr ?? '').toMatch(stderrMatch);
  }
}

describe('host_exec entrypoint — fatal exits (subprocess)', () => {
  beforeAll(async () => {
    await fs.access(distIndex).catch(() => {
      throw new Error(`dist/index.js not found at ${distIndex} — run the worker build first`);
    });
  });

  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'host-exec-idx-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('exits 1 when HOST_EXEC_AUTH_TOKEN is missing', async () => {
    await expectExit1(
      { HOST_EXEC_AUTH_TOKEN: undefined, HOST_EXEC_CONFIG_PATH: path.join(tmp, 'c.json') },
      /HOST_EXEC_AUTH_TOKEN is required/
    );
  });

  it('exits 1 when HOST_EXEC_CONFIG_PATH is missing', async () => {
    await expectExit1(
      { HOST_EXEC_AUTH_TOKEN: 'tok', HOST_EXEC_CONFIG_PATH: undefined },
      /HOST_EXEC_CONFIG_PATH is required/
    );
  });

  it('exits 1 when the config snapshot is missing', async () => {
    await expectExit1(
      { HOST_EXEC_AUTH_TOKEN: 'tok', HOST_EXEC_CONFIG_PATH: path.join(tmp, 'absent.json') },
      /cannot read config snapshot/
    );
  });

  it('exits 1 when the config snapshot is malformed JSON', async () => {
    const bad = path.join(tmp, 'bad.json');
    await fs.writeFile(bad, '{ not json', 'utf-8');
    await expectExit1(
      { HOST_EXEC_AUTH_TOKEN: 'tok', HOST_EXEC_CONFIG_PATH: bad },
      /not valid JSON|wrong shape/
    );
  });

  it('exits 1 on an invalid PORT', async () => {
    const cfg = path.join(tmp, 'c.json');
    await fs.writeFile(cfg, JSON.stringify({ projectDir: tmp, commands: [] }), 'utf-8');
    await expectExit1(
      { HOST_EXEC_AUTH_TOKEN: 'tok', HOST_EXEC_CONFIG_PATH: cfg, PORT: '99999' },
      /invalid PORT value/
    );
  });
});
