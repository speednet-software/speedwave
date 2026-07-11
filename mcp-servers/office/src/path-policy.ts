/**
 * Path policy — enforces every input/output path stays inside `/workspace`, rejects symlinked components, writes atomically, refuses to overwrite unless asked (the worker holds `/workspace:rw`, so a parser exploit must not reach `.git`/`.speedwave.json`/build scripts).
 * @module mcp-office/path-policy
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WORKSPACE_ROOT, OUTPUT_DIR, MAX_INPUT_BYTES } from './config.js';
import { ignoreError } from './util.js';
import { PathPolicyError } from './errors.js';

export { PathPolicyError } from './errors.js';

/**
 * True if `err` means the path simply does not / cannot exist (`ENOENT`, or `ENOTDIR` for a non-directory prefix component).
 * Permission errors (`EACCES`/`EPERM`) are NOT included — those must propagate, or silently treating them as absent defeats the symlink guard.
 * @param err - The error thrown by an `lstat`/`lstatSync` call.
 * @returns Whether `err` indicates the path does not / cannot exist.
 */
function isPathAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * True if `candidate` is `base` or a descendant of it (path-segment comparison, not string prefix).
 * @param base - The directory that must contain `candidate`.
 * @param candidate - The path to test.
 * @returns Whether `candidate` is within `base`.
 */
function isWithin(base: string, candidate: string): boolean {
  const rel = path.relative(base, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Reject any path component (from `/workspace` down to the leaf) that is a symlink — closes the "plant a symlink to `.git` then write through it" hole.
 * @param absPath - An absolute path already confirmed to be under `/workspace`.
 * @throws {PathPolicyError} If any intermediate component exists and is a symlink.
 */
function assertNoSymlinkComponents(absPath: string): void {
  const rel = path.relative(WORKSPACE_ROOT, absPath);
  if (rel === '') {
    return;
  }
  const parts = rel.split(path.sep);
  let cur = WORKSPACE_ROOT;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      // ENOENT: component doesn't exist yet, fine for an unwritten output path. Other errno (EACCES/EPERM/EIO) must propagate — skipping it would defeat the guard.
      if (isPathAbsent(err)) {
        return;
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new PathPolicyError(`Path component is a symlink, refused: ${part}`);
    }
  }
}

/**
 * Resolve `userPath` to a canonical absolute path under `/workspace`, verifying no component is a symlink. Does NOT require existence.
 * @param userPath - The path provided by the caller.
 * @returns The canonical absolute path under `/workspace`.
 * @throws {PathPolicyError} If the path escapes `/workspace` or has a symlinked component.
 */
export function resolveWithinWorkspace(userPath: string): string {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    throw new PathPolicyError('Path must be a non-empty string');
  }
  if (userPath.includes('\0')) {
    throw new PathPolicyError('Path must not contain NUL bytes');
  }
  const abs = path.resolve(WORKSPACE_ROOT, userPath);
  if (!isWithin(WORKSPACE_ROOT, abs)) {
    throw new PathPolicyError(`Path escapes the workspace, refused: ${userPath}`);
  }
  assertNoSymlinkComponents(abs);
  return abs;
}

/**
 * Resolve and validate an existing input file: inside `/workspace`, a regular file, within the size cap (symlinked leaf already rejected upstream).
 * @param userPath - Caller-supplied path to an input file.
 * @returns The canonical absolute path of the input file.
 * @throws {PathPolicyError} If the path is invalid, the file is missing/not-regular, or exceeds `MAX_INPUT_BYTES`.
 */
export async function resolveInputFile(userPath: string): Promise<string> {
  const abs = resolveWithinWorkspace(userPath);
  let st: fs.Stats;
  try {
    st = await fsp.lstat(abs);
  } catch (err) {
    if (isPathAbsent(err)) {
      throw new PathPolicyError(`Input file not found: ${userPath}`);
    }
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new PathPolicyError(`Cannot access input file (${code}): ${userPath}`);
  }
  if (!st.isFile()) {
    throw new PathPolicyError(`Input path is not a regular file: ${userPath}`);
  }
  if (st.size > MAX_INPUT_BYTES) {
    throw new PathPolicyError(
      `Input file is too large (${st.size} bytes > ${MAX_INPUT_BYTES} byte limit): ${userPath}`
    );
  }
  return abs;
}

/**
 * Compute the absolute output path: `outName` omitted → `{OUTPUT_DIR}/{generatedBase}`; bare filename → `{OUTPUT_DIR}/{outName}`; else a validated path under `/workspace`. Refuses to overwrite unless `overwrite` is true, creates the parent directory.
 * @param outName - Caller-supplied output name or path (optional).
 * @param generatedBase - The default base filename to use when `outName` is omitted.
 * @param overwrite - Whether overwriting an existing target is permitted (default false).
 * @returns The canonical absolute output path, with its parent directory created.
 * @throws {PathPolicyError} If the path escapes `/workspace`, has a symlinked component, or already exists and `overwrite` is false.
 */
export async function resolveOutputPath(
  outName: string | undefined,
  generatedBase: string,
  overwrite = false
): Promise<string> {
  let abs: string;
  if (!outName) {
    abs = path.join(OUTPUT_DIR, generatedBase);
  } else if (outName.includes('/')) {
    // Container is Linux, so '/' is the only separator that can appear here.
    abs = resolveWithinWorkspace(outName);
  } else {
    if (outName.includes('\0')) {
      throw new PathPolicyError('Output name must not contain NUL bytes');
    }
    abs = path.join(OUTPUT_DIR, outName);
  }
  // A bare `outName` joined onto OUTPUT_DIR can still be unsafe (e.g. `..`); re-check.
  abs = resolveWithinWorkspace(abs);
  if (!overwrite) {
    try {
      await fsp.lstat(abs);
      throw new PathPolicyError(
        `Output file already exists (pass overwrite:true to replace): ${abs}`
      );
    } catch (err) {
      if (err instanceof PathPolicyError) {
        throw err;
      }
      // ENOENT: the target is free. Any other errno (EACCES, EPERM) must propagate, not be mistaken for "free" — else the later write fails opaquely.
      if (!isPathAbsent(err)) {
        throw err;
      }
    }
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  assertNoSymlinkComponents(abs);
  return abs;
}

/**
 * Write `data` to `absPath` atomically: write to a sibling `*.tmp-<uuid>` then `rename` over the target.
 * A reader never observes a half-written file, and a crash leaves either the old file or the temp file (cleaned up).
 * @param absPath - The canonical absolute destination path (already validated by `resolveOutputPath`).
 * @param data - The bytes to write.
 */
export async function atomicWrite(absPath: string, data: Buffer | string): Promise<void> {
  const tmp = `${absPath}.tmp-${randomUUID()}`;
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, absPath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(ignoreError);
    throw err;
  }
}

/**
 * Move an already-written source file (e.g. a tool's `/tmp` output) onto the validated destination: copy to a sibling `*.tmp-<uuid>`, rename over the target, then delete the source.
 * Uses copy+rename (not a direct rename) because the source (`/tmp` tmpfs) and destination (`/workspace` host mount) are always different devices.
 * @param srcAbs - Absolute path of the source file (typically under `/tmp`).
 * @param destAbs - Canonical absolute destination under `/workspace` (already validated).
 */
export async function atomicMoveOnto(srcAbs: string, destAbs: string): Promise<void> {
  const tmp = `${destAbs}.tmp-${randomUUID()}`;
  try {
    await fsp.copyFile(srcAbs, tmp);
    await fsp.rename(tmp, destAbs);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(ignoreError);
    throw err;
  } finally {
    await fsp.rm(srcAbs, { force: true }).catch(ignoreError);
  }
}
