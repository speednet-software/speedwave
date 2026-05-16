import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeRestrictedSecret } from './restricted-write.js';

describe('writeRestrictedSecret', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-test-'));
    // Tighten parent dir to owner-only so writeRestrictedSecret accepts it
    if (process.platform !== 'win32') {
      await fs.chmod(tmpDir, 0o700);
    }
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes content to a new file', async () => {
    const target = path.join(tmpDir, 'secret.json');
    await writeRestrictedSecret(target, '{"k":"v"}');

    const content = await fs.readFile(target, 'utf8');
    expect(content).toBe('{"k":"v"}');
  });

  it.runIf(process.platform !== 'win32')('sets mode 0o600 on the target file', async () => {
    const target = path.join(tmpDir, 'token');
    await writeRestrictedSecret(target, 'abc');

    const stat = await fs.stat(target);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('overwrites an existing file atomically', async () => {
    const target = path.join(tmpDir, 'secret');
    await fs.writeFile(target, 'old');
    if (process.platform !== 'win32') {
      await fs.chmod(target, 0o600);
    }

    await writeRestrictedSecret(target, 'new');

    const content = await fs.readFile(target, 'utf8');
    expect(content).toBe('new');
  });

  it.runIf(process.platform !== 'win32')(
    'refuses to write into a world-readable parent dir',
    async () => {
      const looseDir = path.join(tmpDir, 'loose');
      await fs.mkdir(looseDir, { mode: 0o755 });

      await expect(writeRestrictedSecret(path.join(looseDir, 'secret'), 'x')).rejects.toThrow(
        /not owner-only/
      );
    }
  );

  it('cleans up the tmp file when rename fails', async () => {
    // Force rename failure by passing a target inside a non-existent dir.
    // Tmp file is created in the (existing) parent of `filePath` and rename
    // would target a sibling — but here we point parent to a missing path
    // to provoke `fs.open` failure (before tmp is ever created).
    // To force a rename-time failure instead, point the *target name* to an
    // existing directory: rename of a file onto a non-empty dir fails on POSIX.
    const sub = path.join(tmpDir, 'sub');
    await fs.mkdir(sub, { mode: 0o700 });
    await fs.writeFile(path.join(sub, 'sentinel'), 'x');

    // Target path points to the directory `sub` — rename of a file to an
    // existing non-empty directory will fail.
    await expect(writeRestrictedSecret(sub, 'data')).rejects.toThrow();

    // No leftover tmp files in parent
    const entries = await fs.readdir(tmpDir);
    const leftoverTmp = entries.filter((e) => e.startsWith(`${path.basename(sub)}.tmp.`));
    expect(leftoverTmp).toEqual([]);
  });

  it('writes empty content', async () => {
    const target = path.join(tmpDir, 'empty');
    await writeRestrictedSecret(target, '');

    const content = await fs.readFile(target, 'utf8');
    expect(content).toBe('');
  });

  it('writes Buffer content', async () => {
    const target = path.join(tmpDir, 'buf');
    const data = Buffer.from([0x01, 0x02, 0x03]);
    await writeRestrictedSecret(target, data);

    const content = await fs.readFile(target);
    expect(content.equals(data)).toBe(true);
  });
});
