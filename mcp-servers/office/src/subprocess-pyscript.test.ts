/**
 * Tests for `runPythonScript` driving a real interpreter (node standing in for python via a
 * mocked `PYTHON_BIN`/`SCRIPTS_DIR`), so the JSON-contract parsing branches are exercised end to end.
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
});
