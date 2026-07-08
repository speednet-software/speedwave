/**
 * Tests for `runPythonScript` JSON-contract parsing.
 * @module mcp-office/subprocess-pyscript.test
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { SCRIPTS_DIR } = vi.hoisted(() => {
  // `process.execPath` and the temp dir are available without any import inside the factory.
  const dir =
    `${process.env.TMPDIR || process.env.TEMP || '/tmp'}/office-pyscripts-${process.pid}`.replace(
      /\/+/g,
      '/'
    );
  return { SCRIPTS_DIR: dir };
});
// Point the helper at `node` as the "python" interpreter and at our temp scripts dir.
vi.mock('./config.js', () => ({
  PYTHON_BIN: process.execPath,
  SCRIPTS_DIR,
  TIMEOUT_STANDARD_MS: 60_000,
  MAX_SUBPROCESS_OUTPUT_BYTES: 10 * 1024 * 1024,
}));

import { runPythonScript, SubprocessError } from './subprocess.js';

beforeAll(() => {
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SCRIPTS_DIR, 'ok.py'),
    'process.stdout.write(JSON.stringify({ ok: true, value: 1 }))'
  );
  fs.writeFileSync(path.join(SCRIPTS_DIR, 'notjson.py'), 'process.stdout.write("plain text")');
  fs.writeFileSync(
    path.join(SCRIPTS_DIR, 'failed.py'),
    'process.stdout.write(JSON.stringify({ ok: false, error: "nope" }))'
  );
  fs.writeFileSync(path.join(SCRIPTS_DIR, 'crash.py'), 'process.exit(2)');
  // Mirrors the real `script_runner.fail()` contract: JSON error on stdout, a much longer
  // traceback on stderr, AND a non-zero exit — the case `runOk`'s generic path cannot see through.
  fs.writeFileSync(
    path.join(SCRIPTS_DIR, 'teaching-fail.py'),
    [
      "process.stdout.write(JSON.stringify({ ok: false, error: \"sheet 'X' not found; workbook sheets are: ['Y']\" }));",
      'process.stderr.write("Traceback (most recent call last):\\n".repeat(50));',
      'process.exit(1);',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(SCRIPTS_DIR, 'crash-with-junk-stdout.py'),
    'process.stdout.write("not json"); process.stderr.write("stack trace"); process.exit(1);'
  );
  // Prints a valid `{ok:true}` payload but still exits non-zero — the exit code must win.
  fs.writeFileSync(
    path.join(SCRIPTS_DIR, 'ok-json-but-nonzero-exit.py'),
    'process.stdout.write(JSON.stringify({ ok: true, value: 1 })); process.exit(3);'
  );
  fs.writeFileSync(path.join(SCRIPTS_DIR, 'sleeper.py'), 'setTimeout(() => {}, 5000);');
});

afterAll(() => {
  fs.rmSync(SCRIPTS_DIR, { recursive: true, force: true });
});

describe('runPythonScript', () => {
  it('parses a JSON object with ok:true and returns it', async () => {
    expect(await runPythonScript('ok.py', [])).toEqual({ ok: true, value: 1 });
  });

  it('throws when stdout is not JSON', async () => {
    await expect(runPythonScript('notjson.py', [])).rejects.toThrow(/did not return JSON/);
  });

  it('throws when the JSON lacks ok:true', async () => {
    await expect(runPythonScript('failed.py', [])).rejects.toThrow(/reported failure/);
  });

  it('throws when the script exits non-zero', async () => {
    await expect(runPythonScript('crash.py', [])).rejects.toBeInstanceOf(SubprocessError);
  });

  it('surfaces the JSON error field verbatim even though the process exits non-zero with a long stderr traceback', async () => {
    await expect(runPythonScript('teaching-fail.py', [])).rejects.toThrow(
      /sheet 'X' not found; workbook sheets are: \['Y'\]/
    );
    // The traceback must not leak into the thrown message (it stayed on stderr only).
    await expect(runPythonScript('teaching-fail.py', [])).rejects.not.toThrow(
      /Traceback \(most recent call last\)/
    );
  });

  it('falls back to the raw exit/stderr detail when a non-zero exit produced no parseable JSON', async () => {
    await expect(runPythonScript('crash-with-junk-stdout.py', [])).rejects.toThrow(
      /exited with code 1: stack trace/
    );
  });

  it('throws when the process exits non-zero even though stdout claims ok:true', async () => {
    await expect(runPythonScript('ok-json-but-nonzero-exit.py', [])).rejects.toBeInstanceOf(
      SubprocessError
    );
    await expect(runPythonScript('ok-json-but-nonzero-exit.py', [])).rejects.toThrow(
      /exited with code 3 even though stdout claimed success/
    );
  });

  it('throws a timeout SubprocessError when the script exceeds timeoutMs', async () => {
    await expect(runPythonScript('sleeper.py', [], { timeoutMs: 100 })).rejects.toThrow(
      /timed out after 100ms/
    );
  });
});
