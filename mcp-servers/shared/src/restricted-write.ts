/**
 * Atomic owner-only file write for OAuth state and other secrets.
 * Mirrors Rust SSOT `crate::fs_perms::write_restricted_file`.
 *
 * Used by the host-side `oauth` worker to write `oauth.json` and refreshed
 * `access_token` files. The Rust supervisor must create the parent directory
 * with mode 0o700 before this is called — POSIX permissions on the directory
 * are the systemic gate; this helper is the file-level gate.
 *
 * Atomicity: writes to `${path}.tmp.<pid>.<rand>`, chmod 0o600, fsync, rename.
 * On rename failure the tmp file is unlinked.
 *
 * Windows: relies on parent directory ACL being owner-only (set by Rust
 * supervisor via `set_owner_only` on the directory). Node-side asserts this
 * before write — refuses to write into a world-readable parent on POSIX.
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

  // Defense in depth: refuse to write into a world-readable parent dir.
  // The Rust supervisor creates `~/.speedwave/oauth/<project>/` with mode 0o700;
  // if that invariant is violated we don't want to silently leak secrets.
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
    // chmod again post-open: O_CREAT honors umask, so explicit chmod is needed
    // on systems where umask masks group/other bits in unexpected ways.
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
