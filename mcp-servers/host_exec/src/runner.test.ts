import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnRecipe, runRecipeCall, killTree } from './runner.js';
import type { ConfirmReply, ConfirmRequest, ConfirmTransport } from './confirm.js';
import type { HostExecConfigSnapshot, HostExecRecipe } from './types.js';

const NODE = process.execPath;
const onWindows = process.platform === 'win32';

function recipe(
  p: Partial<HostExecRecipe> & Pick<HostExecRecipe, 'name' | 'exec'>
): HostExecRecipe {
  return { args: [], confirm: 'ask', ...p };
}

/** A confirm transport that auto-replies with a fixed decision. */
function autoTransport(decision: ConfirmReply['decision'] | 'never'): ConfirmTransport & {
  sent: ConfirmRequest[];
} {
  const cbs = new Set<(r: ConfirmReply) => void>();
  const sent: ConfirmRequest[] = [];
  return {
    sent,
    send(req) {
      sent.push(req);
      if (decision !== 'never') {
        // reply on next tick so the awaiter has subscribed
        setImmediate(() => {
          for (const cb of cbs) cb({ type: 'confirm-reply', id: req.id, decision });
        });
      }
    },
    onReply(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
  };
}

describe('spawnRecipe', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'host-exec-run-')));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('captures stdout, stderr, exit code on a clean exit', async () => {
    const r = await spawnRecipe(
      NODE,
      [
        '-e',
        'process.stdout.write("out-line\\n"); process.stderr.write("err-line\\n"); process.exit(0)',
      ],
      dir,
      'test',
      '.',
      { PATH: process.env.PATH }
    );
    expect(r.status).toBe('exited');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('out-line\n');
    expect(r.stderr).toBe('err-line\n');
    expect(r.truncated).toBe(false);
    expect(r.command).toBe('test');
    expect(r.cwd).toBe('.');
    expect(typeof r.durationMs).toBe('number');
  });

  it('reports a non-zero exit code as a normal result, not an error', async () => {
    const r = await spawnRecipe(
      NODE,
      ['-e', 'process.stderr.write("boom\\n"); process.exit(3)'],
      dir,
      'fail',
      '.',
      {
        PATH: process.env.PATH,
      }
    );
    expect(r.status).toBe('exited');
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toBe('boom\n');
  });

  it('reports spawn_error when the executable does not exist', async () => {
    const r = await spawnRecipe('definitely-not-a-real-binary-xyz', [], dir, 'x', '.', {
      PATH: process.env.PATH,
    });
    expect(r.status).toBe('spawn_error');
    expect(r.exitCode).toBeNull();
    expect(r.stderr).toMatch(/spawn error/i);
  });

  it('runs in the given cwd', async () => {
    const sub = path.join(dir, 'sub');
    await fs.mkdir(sub);
    const r = await spawnRecipe(
      NODE,
      ['-e', 'process.stdout.write(process.cwd())'],
      sub,
      'pwd',
      'sub',
      {
        PATH: process.env.PATH,
      }
    );
    expect(await fs.realpath(r.stdout.trim())).toBe(await fs.realpath(sub));
    expect(r.cwd).toBe('sub');
  });

  it('does not give the child stdin (a recipe cannot read it)', async () => {
    // The child reads stdin; with stdio[0]='ignore' it should see EOF immediately
    // (read returns null) rather than blocking, so it exits 0 quickly.
    const r = await spawnRecipe(
      NODE,
      [
        '-e',
        'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{ process.stdout.write("eof:"+d.length); process.exit(0); }); process.stdin.resume();',
      ],
      dir,
      'stdin',
      '.',
      { PATH: process.env.PATH },
      2000
    );
    expect(r.status).toBe('exited');
    expect(r.stdout).toBe('eof:0');
  });

  it('kills on timeout and reports killed_timeout', async () => {
    const start = Date.now();
    const r = await spawnRecipe(
      NODE,
      ['-e', 'setTimeout(()=>{}, 60_000)'], // sleep 60s
      dir,
      'sleep',
      '.',
      { PATH: process.env.PATH },
      200 // 200ms timeout
    );
    expect(r.status).toBe('killed_timeout');
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBeTruthy();
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('caps huge output to the tail and sets truncated', async () => {
    // ~5 MB of output (500k bytes * 10) — well over the 64 KiB per-stream cap,
    // but written in one go so the subprocess finishes quickly.
    const r = await spawnRecipe(
      NODE,
      [
        '-e',
        'const line="x".repeat(99)+"\\n"; let s=""; for(let i=0;i<5000;i++) s+=line; for(let j=0;j<10;j++) process.stdout.write(s);',
      ],
      dir,
      'flood',
      '.',
      { PATH: process.env.PATH },
      8000
    );
    expect(r.status).toBe('exited');
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout, 'utf-8')).toBeLessThanOrEqual(64 * 1024);
  });

  it('strips ANSI from output', async () => {
    const r = await spawnRecipe(
      NODE,
      ['-e', 'process.stdout.write("\\x1b[32mBUILD SUCCESSFUL\\x1b[0m\\n")'],
      dir,
      'ansi',
      '.',
      { PATH: process.env.PATH }
    );
    expect(r.stdout).toBe('BUILD SUCCESSFUL\n');
  });

  // Process-tree kill: a recipe (like `npm test` / `gradle`) that forks a
  // long-lived grandchild which ignores SIGTERM but stays in the recipe's
  // process group (NOT detached). When the recipe times out, the worker
  // SIGKILLs the *whole process group*, so the grandchild must die too — a
  // bare `child.kill()` would leave it running. (Skipped on Windows, where the
  // kill path is `taskkill /T /F` and process groups don't apply the same way;
  // the Unix case is the one we can verify deterministically here.)
  it.skipIf(onWindows)(
    'SIGKILLs the whole process group on timeout (grandchild dies)',
    async () => {
      // Grandchild: ignores SIGTERM, writes its pid to a file, then sleeps long.
      const pidFile = path.join(dir, 'grandchild.pid');
      const grandchildSrc = `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(()=>{}, 120_000);`;
      // Recipe: spawn the grandchild in the SAME process group (no `detached`),
      // wait for it to write its pid file, then sleep long itself.
      const recipeSrc = `
      const cp=require('child_process'), fs=require('fs');
      cp.spawn(process.execPath,['-e',${JSON.stringify(grandchildSrc)}],{stdio:'ignore'});
      const wait=()=>{ if(fs.existsSync(${JSON.stringify(pidFile)})) { setTimeout(()=>{}, 120_000); } else { setTimeout(wait, 50); } };
      wait();
    `;
      const r = await spawnRecipe(
        NODE,
        ['-e', recipeSrc],
        dir,
        'tree',
        '.',
        { PATH: process.env.PATH },
        2000
      );
      expect(r.status).toBe('killed_timeout');
      // Give the OS a moment, then read the grandchild pid and assert it's dead.
      await new Promise((res) => setTimeout(res, 500));
      const gcPid = Number.parseInt(await fs.readFile(pidFile, 'utf-8'), 10);
      expect(Number.isInteger(gcPid)).toBe(true);
      let alive = true;
      try {
        process.kill(gcPid, 0); // throws ESRCH if not alive
      } catch {
        alive = false;
      }
      if (alive) {
        // best-effort cleanup if the assertion is about to fail
        try {
          process.kill(gcPid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
      expect(alive).toBe(false);
    }
  );
});

describe('killTree', () => {
  it('is a no-op for an undefined pid', () => {
    expect(() => killTree(undefined, false)).not.toThrow();
    expect(() => killTree(undefined, true)).not.toThrow();
  });

  it('on Windows, spawns taskkill /T /F /PID (does not throw even if taskkill is absent)', () => {
    // We can't actually run taskkill off-Windows, but spawn() with a missing
    // binary does not throw synchronously — the child emits 'error' async,
    // which killTree ignores. Just assert no synchronous throw.
    expect(() => killTree(99999, /* onWindows */ true)).not.toThrow();
  });

  it('on Unix, falls back to killing just the child if the group kill fails', () => {
    const calls: Array<[number, string | number]> = [];
    const spy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      sig: string | number
    ) => {
      calls.push([pid, sig]);
      if (pid < 0) throw new Error('ESRCH: no such process group');
      return true;
    }) as typeof process.kill);
    try {
      killTree(4321, /* onWindows */ false);
    } finally {
      spy.mockRestore();
    }
    // First the group (-pid), then the fallback (pid).
    expect(calls[0]).toEqual([-4321, 'SIGKILL']);
    expect(calls[1]).toEqual([4321, 'SIGKILL']);
  });

  it('on Unix, swallows the error if even the child kill fails (already dead)', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw new Error('ESRCH');
    }) as typeof process.kill);
    try {
      expect(() => killTree(4321, false)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('runRecipeCall', () => {
  let proj: string;
  let configPath: string;

  async function writeSnapshot(commands: HostExecRecipe[]): Promise<void> {
    const snap: HostExecConfigSnapshot = { projectDir: proj, commands };
    await fs.writeFile(configPath, JSON.stringify(snap), 'utf-8');
  }

  beforeEach(async () => {
    proj = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'host-exec-rc-')));
    configPath = path.join(proj, 'config.json');
    delete process.env.HOST_EXEC_LOG_FILE; // audit goes to stderr in tests
  });
  afterEach(async () => {
    await fs.rm(proj, { recursive: true, force: true });
  });

  it('happy path: allowed recipe runs and returns a successful result', async () => {
    await writeSnapshot([
      recipe({ name: 'hello', exec: NODE, args: ['-e', 'process.stdout.write("hi")'] }),
    ]);
    const t = autoTransport('allow');
    const out = await runRecipeCall(configPath, 'hello', {}, t, 1000, 5000);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.status).toBe('exited');
      expect(out.result.exitCode).toBe(0);
      expect(out.result.stdout).toBe('hi');
      expect(out.result.command).toBe('hello');
    }
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].recipe).toBe('hello');
    expect(t.sent[0].argv).toEqual([NODE, '-e', 'process.stdout.write("hi")']);
  });

  it('exit code != 0 is still a successful result with stderr', async () => {
    await writeSnapshot([
      recipe({
        name: 'fail',
        exec: NODE,
        args: ['-e', 'process.stderr.write("nope"); process.exit(2)'],
      }),
    ]);
    const out = await runRecipeCall(configPath, 'fail', {}, autoTransport('allow'), 1000, 5000);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.status).toBe('exited');
      expect(out.result.exitCode).toBe(2);
      expect(out.result.stderr).toBe('nope');
    }
  });

  it('unknown / removed recipe → tool error (fail closed)', async () => {
    await writeSnapshot([recipe({ name: 'present', exec: NODE, args: ['-e', '0'] })]);
    const out = await runRecipeCall(configPath, 'absent', {}, autoTransport('allow'), 1000, 5000);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/no host_exec recipe named 'absent'/);
  });

  it('parameter failing its regex → tool error', async () => {
    await writeSnapshot([
      recipe({
        name: 'echo',
        exec: NODE,
        args: ['-e', 'process.stdout.write(process.argv[1])', '{val}'],
        params: [{ name: 'val', pattern: '[a-z]+' }],
      }),
    ]);
    const out = await runRecipeCall(
      configPath,
      'echo',
      { val: 'has spaces and 123' },
      autoTransport('allow'),
      1000,
      5000
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/does not match the required pattern/);
  });

  it('cwdSub escape → tool error', async () => {
    // realpath escape via symlink
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'host-exec-out-')));
    await fs.symlink(outside, path.join(proj, 'link'), 'dir');
    await writeSnapshot([recipe({ name: 'x', exec: NODE, args: ['-e', '0'], cwdSub: 'link' })]);
    const out = await runRecipeCall(configPath, 'x', {}, autoTransport('allow'), 1000, 5000);
    expect(out.ok).toBe(false);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('user denies → tool error "denied by the user"', async () => {
    await writeSnapshot([recipe({ name: 'hello', exec: NODE, args: ['-e', '0'] })]);
    const out = await runRecipeCall(configPath, 'hello', {}, autoTransport('deny'), 1000, 5000);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/denied by the user/);
  });

  it('confirmation never answered → tool error "confirmation unavailable" (fail closed)', async () => {
    await writeSnapshot([recipe({ name: 'hello', exec: NODE, args: ['-e', '0'] })]);
    const out = await runRecipeCall(
      configPath,
      'hello',
      {},
      autoTransport('never'),
      150 /* short confirm timeout */,
      5000
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/confirmation unavailable/);
  });

  it('spawn_error from a missing binary is a successful result with status spawn_error', async () => {
    await writeSnapshot([recipe({ name: 'missing', exec: 'no-such-binary-abc-xyz', args: [] })]);
    const out = await runRecipeCall(configPath, 'missing', {}, autoTransport('allow'), 1000, 5000);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.status).toBe('spawn_error');
      expect(out.result.stderr).toMatch(/spawn error/i);
    }
  });

  it('malformed config snapshot → tool error (internal error)', async () => {
    await fs.writeFile(configPath, '{ broken', 'utf-8');
    const out = await runRecipeCall(configPath, 'anything', {}, autoTransport('allow'), 1000, 5000);
    expect(out.ok).toBe(false);
  });

  it('uses a fallback id when crypto.randomUUID is unavailable', async () => {
    // Force the catch branch in newId().
    const orig = (globalThis.crypto as Crypto).randomUUID;
    (globalThis.crypto as { randomUUID: () => string }).randomUUID = () => {
      throw new Error('no crypto');
    };
    try {
      await writeSnapshot([
        recipe({ name: 'hi', exec: NODE, args: ['-e', 'process.stdout.write("ok")'] }),
      ]);
      const out = await runRecipeCall(configPath, 'hi', {}, autoTransport('allow'), 1000, 5000);
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result.stdout).toBe('ok');
    } finally {
      (globalThis.crypto as { randomUUID: typeof orig }).randomUUID = orig;
    }
  });

  it('writes an audit-log line with the full argv and redacted env keys', async () => {
    const logFile = path.join(proj, 'audit.log');
    process.env.HOST_EXEC_LOG_FILE = logFile;
    try {
      await writeSnapshot([
        recipe({
          name: 'hello',
          exec: NODE,
          args: ['-e', 'process.stdout.write("hi")'],
          env: { SPRING_PROFILES_ACTIVE: 'test', SOME_SECRET: 'sk-xxxx' },
        }),
      ]);
      const out = await runRecipeCall(configPath, 'hello', {}, autoTransport('allow'), 1000, 5000);
      expect(out.ok).toBe(true);
      const log = await fs.readFile(logFile, 'utf-8');
      const entry = JSON.parse(log.trim());
      expect(entry.recipe).toBe('hello');
      expect(entry.argv).toEqual([NODE, '-e', 'process.stdout.write("hi")']);
      expect(entry.confirm).toBe('allow');
      expect(entry.status).toBe('exited');
      // env VALUES must NOT appear; only the sorted KEYS.
      expect(log).not.toContain('sk-xxxx');
      expect(entry.envKeys).toEqual(['SOME_SECRET', 'SPRING_PROFILES_ACTIVE']);
    } finally {
      delete process.env.HOST_EXEC_LOG_FILE;
    }
  });
});
