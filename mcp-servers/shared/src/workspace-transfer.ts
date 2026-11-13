import { constants, promises as fsp, type Stats } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  resolveWorkspaceFile,
  workspaceRoot,
  WorkspaceFileError,
  type WorkspaceFile,
  type WorkspaceFileErrorKind,
} from './workspace-file.js';

export const MAX_WORKSPACE_FILES = 10;

/** Rejection of a file list; the message says what to change. */
export class WorkspaceFileListError extends Error {}

const FAILURE_TEXT: Record<WorkspaceFileErrorKind, string> = {
  not_found: 'was not found under /workspace. Check the path with a directory listing.',
  outside_workspace:
    'resolves outside the workspace. Only files under /workspace can be used; copy the file there first.',
  not_a_file: 'is not a regular file. Pass a file, not a directory.',
  too_large: 'is too large to read.',
};

/**
 * Validate a list of workspace paths and resolve each one; nothing is read.
 * @param filePaths - The list exactly as the caller sent it.
 * @param paramName - Parameter name used in the messages.
 */
export async function resolveWorkspaceFileList(
  filePaths: unknown,
  paramName: string
): Promise<WorkspaceFile[]> {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new WorkspaceFileListError(
      `Pass ${paramName} as a non-empty array of path strings under /workspace, e.g. ["/workspace/report.pdf"].`
    );
  }
  if (filePaths.length > MAX_WORKSPACE_FILES) {
    throw new WorkspaceFileListError(
      `${paramName} has ${filePaths.length} entries; at most ${MAX_WORKSPACE_FILES} per call. Split them over several calls.`
    );
  }
  const files: WorkspaceFile[] = [];
  for (const [index, filePath] of filePaths.entries()) {
    const label = `${paramName}[${index}]`;
    if (typeof filePath !== 'string' || filePath === '') {
      throw new WorkspaceFileListError(
        `${label} is not a non-empty path string. Pass every entry as a path under /workspace.`
      );
    }
    const file = await resolveEntry(filePath, label);
    if (files.some((f) => f.path === file.path)) {
      throw new WorkspaceFileListError(`${label} is a duplicate of an earlier entry. Remove it.`);
    }
    files.push(file);
  }
  return files;
}

async function resolveEntry(filePath: string, label: string): Promise<WorkspaceFile> {
  try {
    return await resolveWorkspaceFile(filePath, Number.MAX_SAFE_INTEGER);
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      throw new WorkspaceFileListError(`${label} ${FAILURE_TEXT[error.kind]}`);
    }
    throw error;
  }
}

/**
 * Reduce a filename to a safe basename: no separators, no leading dots.
 * @param name - Raw filename from a remote service.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'file';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned || 'file';
}

/**
 * Stream a download to `/workspace/.speedwave/<service>/<id>-<name>` without following links an agent planted.
 * @param params - Target naming, the byte source and the size the service reports.
 * @param params.service - Service directory name under `.speedwave`.
 * @param params.id - Remote file ID prefixed to the name.
 * @param params.name - Remote filename, reduced to a safe basename.
 * @param params.source - Stream of the file bytes.
 * @param params.expectedSize - Size the service reports; a different byte count fails the download.
 */
export async function writeWorkspaceDownload(params: {
  service: string;
  id: string | number;
  name: string;
  source: Readable;
  expectedSize?: number;
}): Promise<{ path: string; size: number }> {
  const { service, id, name, source, expectedSize } = params;
  try {
    const root = await fsp.realpath(workspaceRoot());
    const base = await ensureInsideDir(root, path.join(root, '.speedwave'));
    const realDir = await ensureInsideDir(root, path.join(base, service));
    const target = path.join(realDir, `${sanitizeFilename(String(id))}-${sanitizeFilename(name)}`);
    const partial = `${target}.part`;
    await fsp.rm(partial, { force: true });
    const handle = await fsp.open(
      partial,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o644
    );
    try {
      await pipeline(source, handle.createWriteStream());
      const { size } = await fsp.stat(partial);
      if (expectedSize !== undefined && size !== expectedSize) {
        throw new Error(
          `Downloaded ${size} bytes but the service reports ${expectedSize}; the file is incomplete or is not the file, so nothing was saved.`
        );
      }
      await fsp.rename(partial, target);
      return { path: target, size };
    } catch (error) {
      await fsp.rm(partial, { force: true });
      throw error;
    }
  } finally {
    source.destroy();
  }
}

async function ensureInsideDir(root: string, dir: string): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  const real = await fsp.realpath(dir);
  if (!real.startsWith(root + path.sep)) {
    throw new WorkspaceFileError(
      'outside_workspace',
      `Download directory resolves outside the workspace: ${dir}`
    );
  }
  return real;
}

/**
 * Open a resolved workspace file for reading without following a link swapped in for its last path element.
 * @param file - The file `resolveWorkspaceFile` returned.
 */
export async function openWorkspaceFile(
  file: WorkspaceFile
): Promise<{ handle: fsp.FileHandle; size: number }> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new WorkspaceFileError(
        'outside_workspace',
        `File changed into a link after it was checked: ${file.path}`
      );
    }
    throw error;
  }
  const stats: Stats = await handle.stat();
  if (!stats.isFile()) {
    await handle.close();
    throw new WorkspaceFileError('not_a_file', `Not a regular file: ${file.path}`);
  }
  return { handle, size: stats.size };
}
