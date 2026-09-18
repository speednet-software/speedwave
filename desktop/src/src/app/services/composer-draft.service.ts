import {
  Injectable,
  type OnDestroy,
  type Signal,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ProjectStateService } from './project-state.service';
import {
  ERROR_UNSUPPORTED_TYPE,
  ImagePreprocessorService,
  type ModelClass,
  type PreprocessedImage,
} from './image-preprocessor.service';
import type { ChatAttachment } from '../models/chat';

/** One staged image; `previewUrl` is a blob URL owned by the service, `preprocessed` is null while resampling. */
export interface AttachmentRecord {
  id: string;
  filename: string;
  previewUrl: string;
  preprocessed: PreprocessedImage | null;
}

export const ERROR_NO_PROJECT = 'Select a project before attaching an image.';

function modelClassFor(modelId: string): ModelClass {
  if (modelId.includes('opus')) return 'opus';
  if (modelId.includes('haiku')) return 'haiku';
  return 'sonnet';
}

/**
 * SSOT for the unsent chat prompt (text, plan mode, staged images) so it survives the composer's
 * destruction on route change; sole owner of every attachment `previewUrl` blob and its revocation.
 */
@Injectable({ providedIn: 'root' })
export class ComposerDraftService implements OnDestroy {
  private readonly projectState = inject(ProjectStateService);
  private readonly preprocessor = inject(ImagePreprocessorService);

  private readonly textSignal = signal<string>('');
  private readonly planModeSignal = signal<boolean>(false);
  private readonly attachmentsSignal = signal<ReadonlyArray<AttachmentRecord>>([]);
  private readonly attachmentErrorSignal = signal<string>('');
  private readonly attachmentAnnouncementSignal = signal<string>('');

  private seq = 0;
  private generation = 0;

  /** Read-only signal carrying the unsent prompt text; the composer's FormControl mirrors into it. */
  readonly text: Signal<string> = this.textSignal.asReadonly();

  /** Read-only signal reflecting plan mode; neither submit nor clear resets it. */
  readonly planMode: Signal<boolean> = this.planModeSignal.asReadonly();

  /** Read-only signal carrying the staged images in insertion order. */
  readonly attachments: Signal<ReadonlyArray<AttachmentRecord>> =
    this.attachmentsSignal.asReadonly();

  /** Read-only signal carrying the last ingest failure; cleared by the next success or by a clear. */
  readonly attachmentError: Signal<string> = this.attachmentErrorSignal.asReadonly();

  /** Read-only signal feeding the composer's polite live region after an attach or a remove. */
  readonly attachmentAnnouncement: Signal<string> = this.attachmentAnnouncementSignal.asReadonly();

  /** True while any staged image is still resampling; blocks submit. */
  readonly anyPreprocessing = computed<boolean>(() =>
    this.attachmentsSignal().some((a) => a.preprocessed === null)
  );

  /** Drops staged images when the active project changes: their `containerPath` is project-scoped. */
  constructor() {
    let previous = this.projectState.activeProject();
    effect(() => {
      const next = this.projectState.activeProject();
      if (next === previous) return;
      const hadProject = previous !== null;
      previous = next;
      if (!hadProject) {
        this.attachmentErrorSignal.set('');
        return;
      }
      this.generation += 1;
      this.clearAttachments();
    });
  }

  /**
   * Mirrors the composer's live field value; stored verbatim, never trimmed.
   * @param value - Raw textarea content.
   */
  setText(value: string): void {
    this.textSignal.set(value);
  }

  /** Flips plan mode; persists across messages, clears, and project switches until toggled again. */
  togglePlanMode(): void {
    this.planModeSignal.update((v) => !v);
  }

  /**
   * Resamples and persists each image, appending one record per file.
   * @param files - Candidate files; non-image MIME types are ignored.
   * @param modelId - Active model id; selects the resample long edge.
   */
  async ingest(files: File[], modelId: string): Promise<void> {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    const project = this.projectState.activeProject();
    if (!project) {
      this.attachmentErrorSignal.set(ERROR_NO_PROJECT);
      return;
    }
    const modelClass = modelClassFor(modelId);
    const generation = this.generation;
    for (const file of images) {
      const id = `att-${++this.seq}`;
      const previewUrl = URL.createObjectURL(file);
      this.attachmentsSignal.update((list) => [
        ...list,
        { id, filename: file.name || 'image', previewUrl, preprocessed: null },
      ]);
      try {
        const out = await this.preprocessor.preprocess(file, modelClass, project);
        URL.revokeObjectURL(previewUrl);
        if (generation !== this.generation) {
          URL.revokeObjectURL(out.previewUrl);
          return;
        }
        if (!this.attachmentsSignal().some((a) => a.id === id)) {
          URL.revokeObjectURL(out.previewUrl);
          continue;
        }
        this.attachmentsSignal.update((list) =>
          list.map((a) =>
            a.id === id ? { ...a, previewUrl: out.previewUrl, preprocessed: out } : a
          )
        );
        this.attachmentErrorSignal.set('');
        this.attachmentAnnouncementSignal.set(`Image attached: ${out.attachment.filename}`);
      } catch (err) {
        const wasPresent = this.attachmentsSignal().some((a) => a.id === id);
        this.attachmentsSignal.update((list) => list.filter((a) => a.id !== id));
        URL.revokeObjectURL(previewUrl);
        if (generation !== this.generation) return;
        if (!wasPresent) continue;
        this.attachmentErrorSignal.set(err instanceof Error ? err.message : ERROR_UNSUPPORTED_TYPE);
      }
    }
  }

  /**
   * Removes one staged image and revokes its preview blob.
   * @param id - Record id from the strip view-model.
   */
  removeAttachment(id: string): void {
    const removed = this.attachmentsSignal().find((a) => a.id === id);
    if (!removed) return;
    this.attachmentsSignal.update((list) => list.filter((a) => a.id !== id));
    URL.revokeObjectURL(removed.previewUrl);
    this.attachmentAnnouncementSignal.set(`Image removed: ${removed.filename}`);
  }

  /** Drops every staged image, revoking each preview blob, and clears the ingest error. */
  clearAttachments(): void {
    for (const a of this.attachmentsSignal()) URL.revokeObjectURL(a.previewUrl);
    this.attachmentsSignal.set([]);
    this.attachmentErrorSignal.set('');
  }

  /** Wire-ready attachments for the current draft; records still resampling are skipped. */
  readyChatAttachments(): ChatAttachment[] {
    return this.attachmentsSignal()
      .map((a) => a.preprocessed)
      .filter((p): p is PreprocessedImage => p !== null)
      .map((p) => p.attachment);
  }

  /** Revokes every live preview blob when the root injector is torn down. */
  ngOnDestroy(): void {
    for (const a of this.attachmentsSignal()) URL.revokeObjectURL(a.previewUrl);
    this.attachmentsSignal.set([]);
  }
}
