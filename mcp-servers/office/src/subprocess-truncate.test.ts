/**
 * Tests the subprocess output cap with a tiny `MAX_SUBPROCESS_OUTPUT_BYTES` so a single data chunk
 * crosses the limit, deterministically exercising the partial-chunk truncation path.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./config.js', () => ({
  PYTHON_BIN: process.execPath,
  SCRIPTS_DIR: '/tmp',
  TIMEOUT_STANDARD_MS: 60_000,
  MAX_SUBPROCESS_OUTPUT_BYTES: 5, // tiny: the very first chunk of any non-trivial output overflows it
}));

import { run } from './subprocess.js';

describe('run with a tiny output cap', () => {
  it('truncates stdout at the first overflowing chunk', async () => {
    const r = await run(process.execPath, ['-e', 'process.stdout.write("abcdefghij")']);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stdout).toBe('abcde');
  });

  it('truncates stderr at the first overflowing chunk', async () => {
    const r = await run(process.execPath, ['-e', 'process.stderr.write("0123456789")']);
    expect(r.stderrTruncated).toBe(true);
    expect(r.stderr).toBe('01234');
  });

  it('drops a further chunk once already full', async () => {
    const r = await run(process.execPath, [
      '-e',
      'process.stdout.write("abcdefgh"); setTimeout(() => { process.stdout.write("ijkl"); }, 20)',
    ]);
    expect(r.stdoutTruncated).toBe(true);
    // First chunk overflows immediately → "abcde" (5 bytes, full). Second chunk hits `len >= MAX` → dropped.
    expect(r.stdout).toBe('abcde');
  });
});
