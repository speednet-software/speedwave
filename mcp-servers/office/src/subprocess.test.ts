/**
 * Tests for the hardened subprocess wrapper: capture, timeout/SIGKILL, output cap,
 * non-zero-exit handling, stdin, cwd/env, and spawn-error. Uses real short-lived
 * `node -e` child processes so the actual spawn/timeout/stdio paths are exercised.
 * (The `runPythonScript` JSON-contract branches are covered in `subprocess-pyscript.test.ts`.)
 * @module mcp-office/subprocess.test
 */

import { describe, it, expect } from 'vitest';
import { run, runOk, SubprocessError } from './subprocess.js';

const nodeBin = process.execPath;

describe('run', () => {
  it('captures stdout/stderr and exit code 0', async () => {
    const r = await run(nodeBin, [
      '-e',
      'process.stdout.write("hi"); process.stderr.write("warn")',
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hi');
    expect(r.stderr).toBe('warn');
    expect(r.timedOut).toBe(false);
    expect(r.stdoutTruncated).toBe(false);
    expect(r.stderrTruncated).toBe(false);
  });

  it('reports a non-zero exit code without throwing', async () => {
    const r = await run(nodeBin, ['-e', 'process.exit(3)']);
    expect(r.code).toBe(3);
  });

  it('kills a process that exceeds the timeout and sets timedOut', async () => {
    const r = await run(nodeBin, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });

  it('truncates stdout at the cap', async () => {
    const r = await run(nodeBin, ['-e', 'process.stdout.write("x".repeat(11 * 1024 * 1024))']);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stdout.length).toBe(10 * 1024 * 1024);
  });

  it('truncates stderr at the cap', async () => {
    const r = await run(nodeBin, ['-e', 'process.stderr.write("y".repeat(11 * 1024 * 1024))']);
    expect(r.stderrTruncated).toBe(true);
    expect(r.stderr.length).toBe(10 * 1024 * 1024);
  });

  it('passes stdin input through', async () => {
    const r = await run(nodeBin, ['-e', 'process.stdin.on("data", d => process.stdout.write(d))'], {
      input: 'piped',
    });
    expect(r.stdout).toBe('piped');
  });

  it('rejects with SubprocessError when the binary does not exist', async () => {
    await expect(run('/nonexistent/binary-xyz', [])).rejects.toBeInstanceOf(SubprocessError);
  });

  it('honours cwd and env options', async () => {
    const r = await run(
      nodeBin,
      ['-e', 'process.stdout.write(process.cwd() + "|" + process.env.FOO)'],
      {
        cwd: '/tmp',
        env: { FOO: 'bar' },
      }
    );
    expect(r.stdout).toContain('|bar');
  });
});

describe('runOk', () => {
  it('returns the result on success', async () => {
    const r = await runOk(nodeBin, ['-e', 'process.stdout.write("ok")']);
    expect(r.stdout).toBe('ok');
  });

  it('throws on a non-zero exit, including stderr in the message', async () => {
    await expect(
      runOk(nodeBin, ['-e', 'process.stderr.write("nope"); process.exit(1)'])
    ).rejects.toThrow(/exited with code 1: nope/);
  });

  it('throws on a non-zero exit with no captured output', async () => {
    await expect(runOk(nodeBin, ['-e', 'process.exit(5)'])).rejects.toThrow(/exited with code 5$/);
  });

  it('throws on timeout', async () => {
    await expect(
      runOk(nodeBin, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 80 })
    ).rejects.toThrow(/timed out/);
  });
});

describe('SubprocessError', () => {
  it('carries the run result when provided', () => {
    const r = {
      code: 1,
      stdout: '',
      stderr: 'x',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
    };
    const err = new SubprocessError('boom', r);
    expect(err.name).toBe('SubprocessError');
    expect(err.result).toBe(r);
  });
});
