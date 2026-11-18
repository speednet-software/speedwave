import { Injectable, inject } from '@angular/core';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import type { SavedPaste, StagedAttachment } from '../models/chat';

export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export const UPLOAD_ID_HEADER = 'x-upload-id';

export const ERROR_ATTACH_CANCELLED = 'Attachment cancelled.';

const LOGGED_EXTENSIONS: ReadonlySet<string> = new Set([
  '7z',
  'avi',
  'bin',
  'bmp',
  'c',
  'cpp',
  'css',
  'csv',
  'doc',
  'docx',
  'eml',
  'env',
  'gif',
  'go',
  'gz',
  'h',
  'heic',
  'htm',
  'html',
  'ics',
  'ipynb',
  'java',
  'jpeg',
  'jpg',
  'js',
  'json',
  'jsx',
  'key',
  'kt',
  'log',
  'm4a',
  'md',
  'mov',
  'mp3',
  'mp4',
  'msg',
  'odp',
  'ods',
  'odt',
  'ogg',
  'pdf',
  'png',
  'ppt',
  'pptx',
  'py',
  'rs',
  'rtf',
  'sh',
  'sql',
  'svg',
  'swift',
  'tar',
  'tif',
  'tiff',
  'toml',
  'ts',
  'tsx',
  'txt',
  'wav',
  'webp',
  'xlsx',
  'zip',
]);

/** Streams a non-image file into `<project>/.speedwave/pastes/` one chunk at a time (ADR-094). */
@Injectable({ providedIn: 'root' })
export class FileAttachmentService {
  private readonly tauri = inject(TauriService);
  private readonly logger = inject(LoggerService);

  /**
   * Copies `file` to the project paste directory while holding at most one chunk in memory.
   * @param file - Pasted or dropped file of any type and size.
   * @param project - Active project name (paths resolved Tauri-side).
   * @param signal - Aborting it stops the upload and removes the partial file.
   */
  async stage(file: File, project: string, signal: AbortSignal): Promise<StagedAttachment<'file'>> {
    throwIfAborted(signal);
    const uploadId = await this.tauri.invoke<number>('begin_paste_upload', {
      project,
      filename: file.name,
      sizeBytes: file.size,
    });
    const headers = { [UPLOAD_ID_HEADER]: String(uploadId) };
    try {
      for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
        throwIfAborted(signal);
        const chunk = await readChunk(
          file,
          offset,
          Math.min(file.size, offset + UPLOAD_CHUNK_BYTES)
        );
        throwIfAborted(signal);
        await this.tauri.invoke('append_paste_upload', chunk, { headers });
      }
      throwIfAborted(signal);
      const saved = await this.tauri.invoke<SavedPaste>('finish_paste_upload', { uploadId });
      return {
        attachment: {
          kind: 'file',
          filename: file.name,
          sizeBytes: file.size,
          containerPath: saved.container_path,
        },
        sizeBytes: file.size,
        discard: () => this.discard(saved.paste_id),
      };
    } catch (err) {
      this.discard(uploadId);
      if (!signal.aborted) {
        this.logger.warn(
          `could not attach a pasted file (extension: ${extensionOf(file.name)}, ${file.size} bytes)`
        );
      }
      throw err;
    }
  }

  /**
   * Deletes a paste that will not be sent: an open upload with its part file, or a written file.
   * A failure is logged, never thrown.
   * @param pasteId - Id from `begin_paste_upload`, `finish_paste_upload` or `save_pasted_image`.
   */
  discard(pasteId: number): void {
    this.tauri.invoke('discard_paste', { pasteId }).catch(() => {
      this.logger.warn(`could not discard pasted file ${pasteId}`);
    });
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(ERROR_ATTACH_CANCELLED);
}

async function readChunk(file: File, start: number, end: number): Promise<Uint8Array> {
  try {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  } catch (err) {
    throw new Error(`Could not read ${file.name}: ${rejectionText(err)}`, { cause: err });
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  const extension = name.slice(dot + 1).toLowerCase();
  if (dot < 0 || extension === '') return 'none';
  return LOGGED_EXTENSIONS.has(extension) ? extension : 'other';
}

function rejectionText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
