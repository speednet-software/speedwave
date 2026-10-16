import { signal } from '@angular/core';
import {
  ERROR_UNSUPPORTED_TYPE,
  type PreprocessedImage,
} from '../../services/image-preprocessor.service';
import type { ChatAttachment } from '../../models/chat';

/** One image attachment staged in a composer, preprocessing in progress or complete. */
export interface AttachmentRecord {
  id: string;
  filename: string;
  previewUrl: string;
  preprocessed: PreprocessedImage | null;
}

/**
 * Per-tab composer attachment state (SPEED-785). One instance lives on each `ChatSessionStore`,
 * so a paste/drop started on one tab resolves into that tab's state even if the composer view has
 * since rebound to another tab, and preview URLs are revoked exactly where ownership ends.
 */
export class ComposerAttachments {
  private seq = 0;
  private disposed = false;

  readonly records = signal<ReadonlyArray<AttachmentRecord>>([]);
  readonly error = signal<string>('');
  readonly announcement = signal<string>('');

  /**
   * Stages a pending record for `file`, runs `preprocess`, and resolves it in place. Safe to call
   * from any tab's composer view — resolution always targets this instance, never whichever
   * instance is bound to the composer when `preprocess` settles.
   * @param file - Source image file (paste or drop).
   * @param preprocess - Async resampling + persistence step.
   */
  async add(file: File, preprocess: (file: File) => Promise<PreprocessedImage>): Promise<void> {
    const id = `att-${++this.seq}`;
    const previewUrl = URL.createObjectURL(file);
    this.records.update((list) => [
      ...list,
      { id, filename: file.name || 'image', previewUrl, preprocessed: null },
    ]);
    try {
      const out = await preprocess(file);
      if (this.disposed || !this.records().some((r) => r.id === id)) {
        URL.revokeObjectURL(out.previewUrl);
        return;
      }
      URL.revokeObjectURL(previewUrl);
      this.records.update((list) =>
        list.map((r) => (r.id === id ? { ...r, previewUrl: out.previewUrl, preprocessed: out } : r))
      );
      this.error.set('');
      this.announcement.set(`Image attached: ${out.attachment.filename}`);
    } catch (err) {
      if (this.disposed) return;
      this.records.update((list) => list.filter((r) => r.id !== id));
      URL.revokeObjectURL(previewUrl);
      this.error.set(err instanceof Error ? err.message : ERROR_UNSUPPORTED_TYPE);
    }
  }

  /**
   * Removes one record and revokes its preview URL.
   * @param id - Record id to remove.
   * @returns The removed record, or `undefined` if no record had that id.
   */
  remove(id: string): AttachmentRecord | undefined {
    const removed = this.records().find((r) => r.id === id);
    if (!removed) return undefined;
    this.records.update((list) => list.filter((r) => r.id !== id));
    URL.revokeObjectURL(removed.previewUrl);
    return removed;
  }

  /** Clears every record, revoking previews (post-submit). */
  clear(): void {
    for (const r of this.records()) URL.revokeObjectURL(r.previewUrl);
    this.records.set([]);
    this.error.set('');
  }

  /** Resolved attachments ready to ship with a submit (pending records are excluded). */
  ready(): ChatAttachment[] {
    return this.records()
      .map((r) => r.preprocessed)
      .filter((p): p is PreprocessedImage => p !== null)
      .map((p) => p.attachment);
  }

  /** Whether any record is still preprocessing (blocks submit). */
  anyPreprocessing(): boolean {
    return this.records().some((r) => r.preprocessed === null);
  }

  /** Revokes every preview URL and discards the result of any `add()` still in flight (tab close / project switch). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const r of this.records()) URL.revokeObjectURL(r.previewUrl);
    this.records.set([]);
  }
}
