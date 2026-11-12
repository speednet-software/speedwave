import {
  resolveWorkspaceFile,
  teachingErrorResult,
  WorkspaceFileError,
  type WorkspaceFile,
  type WorkspaceFileErrorKind,
} from '@speedwave/mcp-shared';

const MAX_ATTACHMENT_FILES = 10;

const FAILURE_TEXT: Record<WorkspaceFileErrorKind, string> = {
  not_found: 'was not found under /workspace. Check the path with a directory listing.',
  outside_workspace:
    'resolves outside the workspace. Only files under /workspace can be attached; copy the file there first.',
  not_a_file: 'is not a regular file. Pass a file, not a directory.',
  too_large: 'is too large to read.',
};

type Rejection = { error: ReturnType<typeof teachingErrorResult> };

/**
 * Resolve every path under the workspace before any Redmine call; the first bad entry rejects the whole list.
 * @param filePaths - The `file_paths` argument exactly as the caller sent it.
 */
export async function resolveAttachmentFiles(
  filePaths: unknown
): Promise<{ files: WorkspaceFile[] } | Rejection> {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return reject(
      'Pass a non-empty array of path strings under /workspace, e.g. ["/workspace/report.pdf"].'
    );
  }
  if (filePaths.length > MAX_ATTACHMENT_FILES) {
    return reject(
      `file_paths has ${filePaths.length} entries; at most ${MAX_ATTACHMENT_FILES} per call. Split them over several calls.`
    );
  }
  const files: WorkspaceFile[] = [];
  for (const [index, filePath] of filePaths.entries()) {
    if (typeof filePath !== 'string' || filePath === '') {
      return reject(
        `file_paths[${index}] is not a non-empty path string. Pass every entry as a path under /workspace.`
      );
    }
    const resolved = await resolveEntry(filePath, index);
    if ('error' in resolved) return resolved;
    if (files.some((f) => f.path === resolved.file.path)) {
      return reject(`file_paths[${index}] is a duplicate of an earlier entry. Remove it.`);
    }
    files.push(resolved.file);
  }
  return { files };
}

async function resolveEntry(
  filePath: string,
  index: number
): Promise<{ file: WorkspaceFile } | Rejection> {
  try {
    return { file: await resolveWorkspaceFile(filePath, Number.MAX_SAFE_INTEGER) };
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return reject(`file_paths[${index}] ${FAILURE_TEXT[error.kind]}`);
    }
    throw error;
  }
}

function reject(nextStep: string): Rejection {
  return { error: teachingErrorResult({ paramName: 'file_paths', nextStep }) };
}
