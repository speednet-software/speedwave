import { Injectable, inject } from '@angular/core';
import { TauriService } from './tauri.service';
import type { ChatAttachment, FileAttachment } from '../models/chat';

export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export const UPLOAD_ID_HEADER = 'x-upload-id';

export const ERROR_ATTACH_CANCELLED = 'Attachment cancelled.';

/** One attachment written to the project paste directory, ready to ship with a submit. */
export interface StagedAttachment {
  attachment: ChatAttachment;
  /** Blob URL for a thumbnail, empty when the attachment has none; the owning `ComposerAttachments` revokes it. */
  previewUrl: string;
  sizeBytes: number;
}

interface UploadTicket {
  upload_id: number;
  filename: string;
}

interface SavedPaste {
  container_path: string;
  host_path: string;
  filename: string;
}

/** Streams a non-image file into `<project>/.speedwave/pastes/` one chunk at a time (ADR-094). */
@Injectable({ providedIn: 'root' })
export class FileAttachmentService {
  private readonly tauri = inject(TauriService);

  /**
   * Copies `file` to the project paste directory while holding at most one chunk in memory.
   * @param file - Pasted or dropped file of any type and size.
   * @param project - Active project name (paths resolved Tauri-side).
   * @param signal - Aborting it stops the upload and removes the partial file.
   */
  async stage(file: File, project: string, signal: AbortSignal): Promise<StagedAttachment> {
    throwIfAborted(signal);
    const ticket = await this.tauri.invoke<UploadTicket>('begin_paste_upload', {
      project,
      filename: file.name,
      sizeBytes: file.size,
    });
    const headers = { [UPLOAD_ID_HEADER]: String(ticket.upload_id) };
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
      const saved = await this.tauri.invoke<SavedPaste>('finish_paste_upload', {
        uploadId: ticket.upload_id,
      });
      const attachment: FileAttachment = {
        kind: 'file',
        filename: file.name,
        mediaType: file.type,
        sizeBytes: file.size,
        containerPath: saved.container_path,
        hostPath: saved.host_path,
      };
      return { attachment, previewUrl: '', sizeBytes: file.size };
    } catch (err) {
      await this.tauri
        .invoke('abort_paste_upload', { uploadId: ticket.upload_id })
        .catch(() => undefined);
      throw err;
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(ERROR_ATTACH_CANCELLED);
}

async function readChunk(file: File, start: number, end: number): Promise<Uint8Array> {
  try {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read ${file.name}: ${reason}`, { cause: err });
  }
}
