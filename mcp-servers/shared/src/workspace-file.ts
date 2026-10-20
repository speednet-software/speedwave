/**
 * Workspace file guard and reader: confines a caller-supplied path to the project mount before any bytes are read.
 * @module mcp-shared/workspace-file
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** A resolved workspace file: real path, basename and size in bytes. */
export type WorkspaceFile = { path: string; name: string; size: number };

/** Kind of rejection a workspace path can get from {@link resolveWorkspaceFile}. */
export type WorkspaceFileErrorKind = 'not_found' | 'outside_workspace' | 'not_a_file' | 'too_large';

/** Rejection of a caller-supplied path by the workspace guard; `kind` tells the failure apart without parsing the message. */
export class WorkspaceFileError extends Error {
  readonly kind: WorkspaceFileErrorKind;

  /**
   * Build the rejection.
   * @param kind - Which guard check failed.
   * @param message - Human-readable description (contains the rejected path).
   */
  constructor(kind: WorkspaceFileErrorKind, message: string) {
    super(message);
    this.name = 'WorkspaceFileError';
    this.kind = kind;
  }
}

/**
 * Read `filePath` from the workspace mount under the same guard as `resolveWorkspaceFile`.
 * @param filePath - Path relative to (or inside) the workspace root.
 * @param maxBytes - Largest file size accepted.
 * @returns The file bytes and the basename of the resolved file.
 */
export async function readWorkspaceFile(
  filePath: string,
  maxBytes: number
): Promise<{ buffer: Buffer; name: string }> {
  const { path: real, name } = await resolveWorkspaceFile(filePath, maxBytes);
  return { buffer: await fsp.readFile(real), name };
}

/**
 * Resolve `filePath` inside the workspace mount without reading it, rejecting any path escaping it (traversal or symlink), non-files, or files over `maxBytes`.
 * @param filePath - Path relative to (or inside) the workspace root.
 * @param maxBytes - Largest file size accepted.
 * @returns The real path, basename and size of the resolved file.
 */
export async function resolveWorkspaceFile(
  filePath: string,
  maxBytes: number
): Promise<WorkspaceFile> {
  const root = await fsp.realpath(workspaceRoot());
  const candidate = path.resolve(root, filePath);
  let real: string;
  try {
    real = await fsp.realpath(candidate);
  } catch {
    throw new WorkspaceFileError('not_found', `File not found under workspace: ${filePath}`);
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new WorkspaceFileError(
      'outside_workspace',
      `Path resolves outside the workspace: ${filePath}. Only files under ${root} can be read; copy the file there first.`
    );
  }
  const stat = await fsp.stat(real);
  if (!stat.isFile()) throw new WorkspaceFileError('not_a_file', `Not a regular file: ${filePath}`);
  if (stat.size > maxBytes) {
    throw new WorkspaceFileError(
      'too_large',
      `File is too large (${stat.size} bytes > ${maxBytes} byte limit): ${filePath}. ` +
        'Split the file or reduce it.'
    );
  }
  return { path: real, name: path.basename(real), size: stat.size };
}

/** Root of the project mount inside the worker (overridable for tests). */
export function workspaceRoot(): string {
  return process.env.WORKSPACE_DIR || '/workspace';
}
