import { signal } from '@angular/core';
import type { AttachmentKind, ChatAttachment, StagedAttachment } from '../../models/chat';

export const ERROR_ATTACH_FAILED = 'Could not attach the file.';

const KIND_LABELS: Record<AttachmentKind, string> = { image: 'Image', file: 'File' };

/** One attachment staged in a composer, upload in progress or complete. */
export interface AttachmentRecord {
  id: string;
  filename: string;
  kind: AttachmentKind;
  previewUrl: string;
  sizeBytes: number;
  staged: StagedAttachment | null;
}

type StageAttachment<K extends AttachmentKind> = (
  file: File,
  signal: AbortSignal
) => Promise<StagedAttachment<NoInfer<K>>>;

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

  /** Whether `dispose()` ran. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Stages a pending record for `file`, runs `stage`, and resolves the record in place.
   * @param file - Source file (paste or drop).
   * @param kind - Pipeline the caller chose for it.
   * @param stage - Async step that writes the bytes; its signal aborts once the record is removed.
   */
  async add<K extends AttachmentKind>(
    file: File,
    kind: K,
    stage: StageAttachment<K>
  ): Promise<void> {
    if (this.disposed) return;
    const id = `att-${++this.seq}`;
    const filename = file.name || kind;
    const previewUrl = kind === 'image' ? URL.createObjectURL(file) : '';
    const controller = new AbortController();
    const cancelled = (): boolean => this.disposed || controller.signal.aborted;
    this.inFlight.set(id, controller);
    this.records.update((list) => [
      ...list,
      { id, filename, kind, previewUrl, sizeBytes: file.size, staged: null },
    ]);
    try {
      const out = await stage(file, controller.signal);
      if (cancelled()) {
        revoke(out.previewUrl);
        out.discard();
        return;
      }
      revoke(previewUrl);
      this.records.update((list) =>
        list.map((r) =>
          r.id === id
            ? { ...r, previewUrl: out.previewUrl ?? '', sizeBytes: out.sizeBytes, staged: out }
            : r
        )
      );
      this.announcement.set(`${KIND_LABELS[kind]} attached: ${out.attachment.filename}`);
    } catch (err) {
      if (cancelled()) return;
      this.records.update((list) => list.filter((r) => r.id !== id));
      revoke(previewUrl);
      this.reportError(`${filename}: ${failureText(err)}`);
    } finally {
      this.inFlight.delete(id);
    }
  }

  /**
   * Adds one line to `error`, after any reported since it was last cleared.
   * @param message - Self-contained message for the user.
   */
  reportError(message: string): void {
    this.error.update((current) => (current ? `${current}\n${message}` : message));
  }

  /**
   * Removes one record, announces it, revokes its preview URL, aborts its upload if still
   * running and discards the file it wrote.
   * @param id - Record id to remove.
   * @returns The removed record, or `undefined` if no record had that id.
   */
  remove(id: string): AttachmentRecord | undefined {
    const removed = this.records().find((r) => r.id === id);
    if (!removed) return undefined;
    this.records.update((list) => list.filter((r) => r.id !== id));
    revoke(removed.previewUrl);
    this.inFlight.get(id)?.abort();
    removed.staged?.discard();
    this.announcement.set(`${KIND_LABELS[removed.kind]} removed: ${removed.filename}`);
    return removed;
  }

  /** Clears every record after a submit sent them, revoking previews and aborting uploads. */
  clear(): void {
    this.releaseRecords();
    this.error.set('');
  }

  /** Staged attachments ready to ship with a submit (pending records are excluded). */
  ready(): ChatAttachment[] {
    return this.records().flatMap((r) => (r.staged ? [r.staged.attachment] : []));
  }

  /** Whether any record is still staging (blocks submit). */
  anyStaging(): boolean {
    return this.records().some((r) => r.staged === null);
  }

  /**
   * Revokes every preview URL, aborts every upload, discards every file staged but not sent, and
   * discards the result of any `add()` still in flight (tab close / project switch).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const r of this.records()) r.staged?.discard();
    this.releaseRecords();
  }

  private releaseRecords(): void {
    for (const r of this.records()) revoke(r.previewUrl);
    for (const controller of this.inFlight.values()) controller.abort();
    this.records.set([]);
  }
}

function revoke(url: string | undefined): void {
  if (url) URL.revokeObjectURL(url);
}

function failureText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return ERROR_ATTACH_FAILED;
}
