/**
 * Tests the path policy: workspace confinement, symlink rejection, atomic writes,
 * overwrite refusal, and the default output directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

let workspaceDir: string;

// Make the Nth-from-now `lstat`/`lstatSync` call throw `err` (1 = the very next call).
const lstatThrow = vi.hoisted(() => ({
  countdown: 0,
  err: null as NodeJS.ErrnoException | null,
  arm(skipBefore: number, err: NodeJS.ErrnoException) {
    this.countdown = skipBefore;
    this.err = err;
  },
  maybeThrow() {
    if (this.err === null) return;
    if (this.countdown > 0) {
      this.countdown -= 1;
      return;
    }
    const e = this.err;
    this.err = null;
    throw e;
  },
}));

// Point WORKSPACE_ROOT / OUTPUT_DIR at a fresh temp dir for each test file run.
vi.mock('./config.js', async () => {
  const realOs = await import('node:os');
  const realPath = await import('node:path');
  const realFs = await import('node:fs');
  const dir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'office-ws-'));
  return {
    WORKSPACE_ROOT: dir,
    OUTPUT_DIR: realPath.join(dir, '.speedwave', 'office'),
    MAX_INPUT_BYTES: 1024 * 1024,
  };
});

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    lstatSync: (...args: Parameters<typeof real.lstatSync>) => {
      lstatThrow.maybeThrow();
      return real.lstatSync(...args);
    },
  };
});
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: async (...args: Parameters<typeof real.lstat>) => {
      lstatThrow.maybeThrow();
      return real.lstat(...args);
    },
  };
});

import {
  resolveWithinWorkspace,
  resolveInputFile,
  resolveOutputPath,
  atomicWrite,
  atomicMoveOnto,
  PathPolicyError,
} from './path-policy.js';
import { WORKSPACE_ROOT, OUTPUT_DIR } from './config.js';

beforeEach(async () => {
  workspaceDir = WORKSPACE_ROOT as unknown as string;
  await fsp.mkdir(workspaceDir, { recursive: true });
  // Clean out anything from a previous test.
  for (const e of await fsp.readdir(workspaceDir)) {
    await fsp.rm(path.join(workspaceDir, e), { recursive: true, force: true });
  }
});

afterEach(async () => {
  await fsp.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('resolveWithinWorkspace', () => {
  it('accepts a plain relative path and a path already under the workspace', () => {
    expect(resolveWithinWorkspace('a/b.txt')).toBe(path.join(workspaceDir, 'a/b.txt'));
    expect(resolveWithinWorkspace(path.join(workspaceDir, 'c.txt'))).toBe(
      path.join(workspaceDir, 'c.txt')
    );
  });

  it('accepts the workspace root itself', () => {
    expect(resolveWithinWorkspace(workspaceDir)).toBe(workspaceDir);
  });

  it('rejects a non-string or empty path', () => {
    expect(() => resolveWithinWorkspace('')).toThrow(PathPolicyError);
    // @ts-expect-error — exercising the runtime guard
    expect(() => resolveWithinWorkspace(undefined)).toThrow(PathPolicyError);
  });

  it('rejects a NUL byte in the path', () => {
    expect(() => resolveWithinWorkspace('a\0b')).toThrow(/NUL/);
  });

  it('rejects traversal that escapes the workspace', () => {
    expect(() => resolveWithinWorkspace('../escape')).toThrow(/escapes the workspace/);
    expect(() => resolveWithinWorkspace('/etc/passwd')).toThrow(/escapes the workspace/);
  });

  it('rejects a symlinked component', async () => {
    await fsp.mkdir(path.join(workspaceDir, 'real'), { recursive: true });
    await fsp.symlink(path.join(workspaceDir, 'real'), path.join(workspaceDir, 'link'));
    expect(() => resolveWithinWorkspace('link/file.txt')).toThrow(/symlink/);
  });

  it('allows a path whose deeper component does not exist yet (output paths)', () => {
    expect(resolveWithinWorkspace('does/not/exist/yet.txt')).toBe(
      path.join(workspaceDir, 'does/not/exist/yet.txt')
    );
  });
});

describe('resolveInputFile', () => {
  it('returns the absolute path for an existing regular file within size limits', async () => {
    const p = path.join(workspaceDir, 'in.txt');
    await fsp.writeFile(p, 'hello');
    expect(await resolveInputFile('in.txt')).toBe(p);
  });

  it('throws for a missing file', async () => {
    await expect(resolveInputFile('nope.txt')).rejects.toThrow(/not found/);
  });

  it('throws for a directory', async () => {
    await fsp.mkdir(path.join(workspaceDir, 'd'));
    await expect(resolveInputFile('d')).rejects.toThrow(/not a regular file/);
  });

  it('throws for a symlinked input file (rejected as a symlinked leaf component)', async () => {
    const target = path.join(workspaceDir, 'target.txt');
    await fsp.writeFile(target, 'x');
    await fsp.symlink(target, path.join(workspaceDir, 'slink.txt'));
    await expect(resolveInputFile('slink.txt')).rejects.toThrow(/symlink/);
  });

  it('throws when a path component (not the leaf) is not a regular file', async () => {
    await fsp.mkdir(path.join(workspaceDir, 'sub'));
    await fsp.writeFile(path.join(workspaceDir, 'sub', 'f'), 'x');
    // `sub/f` is a regular file; lstat of `sub/f/inner` fails → "not found".
    await expect(resolveInputFile('sub/f/inner')).rejects.toThrow(/not found/);
  });

  it('throws for an oversize file', async () => {
    const big = path.join(workspaceDir, 'big.bin');
    await fsp.writeFile(big, Buffer.alloc(1024 * 1024 + 1));
    await expect(resolveInputFile('big.bin')).rejects.toThrow(/too large/);
  });

  it('rethrows a permission error from the symlink-component walk (not silently skipped)', async () => {
    await fsp.writeFile(path.join(workspaceDir, 'guarded.txt'), 'x');
    // The symlink walk's first lstatSync (on `guarded.txt`) throws EACCES → rethrown, not skipped.
    lstatThrow.arm(0, Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(resolveInputFile('guarded.txt')).rejects.toThrow(/EACCES/);
  });

  it('reports the errno when the leaf lstat fails with a permission error', async () => {
    await fsp.writeFile(path.join(workspaceDir, 'guarded.txt'), 'x');
    // Skip the walk's lstatSync (call 1); fail the leaf lstat (call 2) → "Cannot access … (EACCES)".
    lstatThrow.arm(1, Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(resolveInputFile('guarded.txt')).rejects.toThrow(
      /Cannot access input file \(EACCES\)/
    );
  });
});

describe('resolveOutputPath', () => {
  it('defaults to OUTPUT_DIR/<generatedBase> when outName is omitted', async () => {
    const dest = await resolveOutputPath(undefined, 'doc.pdf');
    expect(dest).toBe(path.join(OUTPUT_DIR as unknown as string, 'doc.pdf'));
    expect(fs.existsSync(path.dirname(dest))).toBe(true);
  });

  it('places a bare filename under OUTPUT_DIR', async () => {
    const dest = await resolveOutputPath('out.docx', 'unused.docx');
    expect(dest).toBe(path.join(OUTPUT_DIR as unknown as string, 'out.docx'));
  });

  it('treats a name with a separator as a workspace path', async () => {
    const dest = await resolveOutputPath('sub/out.pdf', 'unused.pdf');
    expect(dest).toBe(path.join(workspaceDir, 'sub/out.pdf'));
  });

  it('rejects a NUL byte in a bare output name', async () => {
    await expect(resolveOutputPath('bad\0name.pdf', 'x.pdf')).rejects.toThrow(/NUL/);
  });

  it('rejects an output name that escapes the workspace', async () => {
    await expect(resolveOutputPath('../escape.pdf', 'x.pdf')).rejects.toThrow(
      /escapes the workspace/
    );
  });

  it('refuses to overwrite an existing file unless overwrite is true', async () => {
    const existing = path.join(OUTPUT_DIR as unknown as string, 'exists.pdf');
    await fsp.mkdir(path.dirname(existing), { recursive: true });
    await fsp.writeFile(existing, 'x');
    await expect(resolveOutputPath('exists.pdf', 'x.pdf')).rejects.toThrow(/already exists/);
    await expect(resolveOutputPath('exists.pdf', 'x.pdf', true)).resolves.toBe(existing);
  });

  it('propagates a permission error from the overwrite check (not treated as "free")', async () => {
    // The overwrite check is the first lstat call in resolveOutputPath for a bare name.
    lstatThrow.arm(1, Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(resolveOutputPath('guarded.pdf', 'x.pdf')).rejects.toThrow(/EACCES/);
  });
});

describe('atomicWrite / atomicMoveOnto', () => {
  it('writes file content atomically', async () => {
    const dest = path.join(workspaceDir, 'atomic.txt');
    await atomicWrite(dest, 'payload');
    expect(await fsp.readFile(dest, 'utf8')).toBe('payload');
    // No stray temp files left behind.
    const leftover = (await fsp.readdir(workspaceDir)).filter((f) => f.includes('.tmp-'));
    expect(leftover).toHaveLength(0);
  });

  it('cleans up the temp file if the write fails', async () => {
    // Destination directory does not exist → writeFile to the temp path fails.
    const dest = path.join(workspaceDir, 'no-such-dir', 'x.txt');
    await expect(atomicWrite(dest, 'payload')).rejects.toThrow();
  });

  it('moves a source file onto the destination and removes the source', async () => {
    const src = path.join(workspaceDir, 'src.bin');
    const dest = path.join(workspaceDir, 'dest.bin');
    await fsp.writeFile(src, 'data');
    await atomicMoveOnto(src, dest);
    expect(await fsp.readFile(dest, 'utf8')).toBe('data');
    expect(fs.existsSync(src)).toBe(false);
  });

  it('propagates and cleans up when the move fails', async () => {
    const src = path.join(workspaceDir, 'src2.bin');
    await fsp.writeFile(src, 'data');
    const dest = path.join(workspaceDir, 'missing-dir', 'd.bin');
    await expect(atomicMoveOnto(src, dest)).rejects.toThrow();
    // Source is removed in the finally block even on failure.
    expect(fs.existsSync(src)).toBe(false);
  });
});
