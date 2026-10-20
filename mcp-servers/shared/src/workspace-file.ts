/**
 * Workspace file reader: confines a caller-supplied path to the project mount before any bytes are read.
 * @module mcp-shared/workspace-file
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * Read `filePath` from the workspace mount, rejecting any path escaping it (traversal or symlink) or exceeding `maxBytes`.
 * @param filePath - Path relative to (or inside) the workspace root.
 * @param maxBytes - Largest file size accepted.
 * @returns The file bytes and the basename of the resolved file.
 */
export async function readWorkspaceFile(
  filePath: string,
  maxBytes: number
): Promise<{ buffer: Buffer; name: string }> {
  const root = await fsp.realpath(workspaceRoot());
  const candidate = path.resolve(root, filePath);
  let real: string;
  try {
    real = await fsp.realpath(candidate);
  } catch {
    throw new Error(`File not found under workspace: ${filePath}`);
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error('filePath must resolve to a location inside the workspace');
  }
  const stat = await fsp.stat(real);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${filePath}`);
  if (stat.size > maxBytes) {
    throw new Error(
      `File is too large (${stat.size} bytes > ${maxBytes} byte limit): ${filePath}. ` +
        'Split the file or reduce it.'
    );
  }
  return { buffer: await fsp.readFile(real), name: path.basename(real) };
}

/** Root of the project mount inside the worker (overridable for tests). */
export function workspaceRoot(): string {
  return process.env.WORKSPACE_DIR || '/workspace';
}
