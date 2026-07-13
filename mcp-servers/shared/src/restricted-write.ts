/**
 * Atomic owner-only write for OAuth secrets (mirrors Rust `crate::fs_perms::write_restricted_file`); parent dir must
 * already be owner-only (0o700 POSIX / ACL Windows) — refuses a world-readable POSIX parent. Writes via tmp+chmod+fsync+rename.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Write `contents` to `filePath` atomically with mode 0o600.
 * Parent directory must exist and (on POSIX) must be owner-only (0o700).
 * @param filePath - absolute path to write
 * @param contents - file body (string or Buffer)
 */
export async function writeRestrictedSecret(
  filePath: string,
  contents: string | Buffer
): Promise<void> {
  const parent = path.dirname(filePath);

  // Refuse to write into a world-readable parent dir.
  if (process.platform !== 'win32') {
    const stat = await fs.stat(parent);
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `writeRestrictedSecret: parent dir ${parent} is not owner-only (mode 0o${mode.toString(
          8
        )}); refusing to write`
      );
    }
  }

  const tmpName = `${path.basename(filePath)}.tmp.${process.pid}.${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const tmpPath = path.join(parent, tmpName);

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, 'wx', 0o600);
    await handle.writeFile(contents);
    // O_CREAT honors umask; explicit chmod ensures mode 0o600.
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await fs.rename(tmpPath, filePath);
  } catch (err) {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}
