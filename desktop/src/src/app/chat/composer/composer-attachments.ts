import { signal } from '@angular/core';
import type { StagedAttachment } from '../../services/file-attachment.service';
import type { ChatAttachment } from '../../models/chat';

export const ERROR_ATTACH_FAILED = 'Could not attach the file.';

/** Which staging pipeline a record took and which pill it renders as. */
export type AttachmentKind = ChatAttachment['kind'];

/** One attachment staged in a composer, upload in progress or complete. */
export interface AttachmentRecord {
  id: string;
  filename: string;
  kind: AttachmentKind;
  /** Blob URL of the thumbnail; empty for a file pill. */
  previewUrl: string;
  sizeBytes: number;
  staged: StagedAttachment | null;
}

/** Async step that puts one file on disk; `signal` aborts once the record is removed. */
export type StageAttachment = (file: File, signal: AbortSignal) => Promise<StagedAttachment>;

/**
 * Per-tab composer attachment state (SPEED-785). One instance lives on each `ChatSessionStore`,
 * so a paste/drop started on one tab resolves into that tab's state even if the composer view has
 * since rebound to another tab, and preview URLs are revoked exactly where ownership ends.
 */
export class ComposerAttachments {
  private seq = 0;
  private disposed = false;
  private readonly inFlight = new Map<string, AbortController>();

  readonly records = signal<ReadonlyArray<AttachmentRecord>>([]);
  readonly error = signal<string>('');
  readonly announcement = signal<string>('');

  /**
   * Stages a pending record for `file`, runs `stage`, and resolves it in place. Safe to call
   * from any tab's composer view — resolution always targets this instance, never whichever
   * instance is bound to the composer when `stage` settles. Removing the record aborts `stage`.
   * @param file - Source file (paste or drop).
   * @param kind - Pipeline the caller chose for it: resampled image or streamed file.
   * @param stage - Async resampling or upload step that persists the bytes.
   */
  async add(file: File, kind: AttachmentKind, stage: StageAttachment): Promise<void> {
    const id = `att-${++this.seq}`;
    const previewUrl = kind === 'image' ? URL.createObjectURL(file) : '';
    const controller = new AbortController();
    this.inFlight.set(id, controller);
    this.records.update((list) => [
      ...list,
      { id, filename: file.name || kind, kind, previewUrl, sizeBytes: file.size, staged: null },
    ]);
    try {
      const out = await stage(file, controller.signal);
      if (this.disposed || !this.records().some((r) => r.id === id)) {
        revoke(out.previewUrl);
        return;
      }
      revoke(previewUrl);
      this.records.update((list) =>
        list.map((r) =>
          r.id === id
            ? { ...r, previewUrl: out.previewUrl, sizeBytes: out.sizeBytes, staged: out }
            : r
        )
      );
      this.error.set('');
      this.announcement.set(`${kindLabel(kind)} attached: ${out.attachment.filename}`);
    } catch (err) {
      if (this.disposed) return;
      this.records.update((list) => list.filter((r) => r.id !== id));
      revoke(previewUrl);
      if (!controller.signal.aborted) {
        this.error.set(err instanceof Error ? err.message : ERROR_ATTACH_FAILED);
      }
    } finally {
      this.inFlight.delete(id);
    }
  }

  /**
   * Removes one record, revokes its preview URL and aborts its upload if still running.
   * @param id - Record id to remove.
   * @returns The removed record, or `undefined` if no record had that id.
   */
  remove(id: string): AttachmentRecord | undefined {
    const removed = this.records().find((r) => r.id === id);
    if (!removed) return undefined;
    this.records.update((list) => list.filter((r) => r.id !== id));
    revoke(removed.previewUrl);
    this.inFlight.get(id)?.abort();
    return removed;
  }

  /** Clears every record, revoking previews and aborting uploads (post-submit). */
  clear(): void {
    for (const r of this.records()) revoke(r.previewUrl);
    this.abortAll();
    this.records.set([]);
    this.error.set('');
  }

  /** Staged attachments ready to ship with a submit (pending records are excluded). */
  ready(): ChatAttachment[] {
    return this.records().flatMap((r) => (r.staged ? [r.staged.attachment] : []));
  }

  /** Whether any record is still staging (blocks submit). */
  anyPreprocessing(): boolean {
    return this.records().some((r) => r.staged === null);
  }

  /** Revokes every preview URL, aborts every upload and discards the result of any `add()` still in flight (tab close / project switch). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const r of this.records()) revoke(r.previewUrl);
    this.abortAll();
    this.records.set([]);
  }

  private abortAll(): void {
    for (const controller of this.inFlight.values()) controller.abort();
  }
}

function revoke(url: string): void {
  if (url) URL.revokeObjectURL(url);
}

function kindLabel(kind: AttachmentKind): string {
  return kind === 'image' ? 'Image' : 'File';
}
