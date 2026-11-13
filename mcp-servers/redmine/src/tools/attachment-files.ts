import {
  resolveWorkspaceFileList,
  teachingErrorResult,
  WorkspaceFileListError,
  type WorkspaceFile,
} from '@speedwave/mcp-shared';

/**
 * Resolve every `file_paths` entry under the workspace before any Redmine call.
 * @param filePaths - The argument exactly as the caller sent it.
 */
export async function resolveAttachmentFiles(
  filePaths: unknown
): Promise<{ files: WorkspaceFile[] } | { error: ReturnType<typeof teachingErrorResult> }> {
  try {
    return { files: await resolveWorkspaceFileList(filePaths, 'file_paths') };
  } catch (error) {
    if (error instanceof WorkspaceFileListError) {
      return { error: teachingErrorResult({ paramName: 'file_paths', nextStep: error.message }) };
    }
    throw error;
  }
}
