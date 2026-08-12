import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { CdkTextareaAutosize } from '@angular/cdk/text-field';
import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { ProjectStateService } from '../../services/project-state.service';
import { SlashMenuComponent } from '../slash/slash-menu.component';
import { SlashService, isBareSlash, type SlashCommand } from '../slash/slash.service';
import { TooltipDirective } from '../../shared/tooltip.directive';
import { AttachmentStripComponent, type AttachmentViewModel } from './attachment-strip.component';
import { FileDropDirective } from './file-drop.directive';
import { ResizeHandleDirective } from './resize-handle.directive';
import {
  ImagePreprocessorService,
  ERROR_UNSUPPORTED_TYPE,
  type ModelClass,
  type PreprocessedImage,
} from '../../services/image-preprocessor.service';
import type { ChatAttachment } from '../../models/chat';

/** Regex matching `/query` at the very start of input (optionally preceded by whitespace), capturing the query. */
const SLASH_TRIGGER = /^(\s*)\/([^\s/]*)$/;

/** Attachment between paste/drop and submit; `preprocessed === null` while pica runs. */
interface AttachmentRecord {
  id: string;
  filename: string;
  previewUrl: string;
  preprocessed: PreprocessedImage | null;
}

/** Floor for a manually-resized composer (≈2 text rows), matching the autosize minimum. */
const MIN_COMPOSER_HEIGHT_PX = 56;

/** Manual-resize ceiling as a fraction of the viewport, so a tall field never hides the transcript. */
const MAX_COMPOSER_HEIGHT_FRACTION = 0.6;

/** Inline directive prepended to a user message when plan mode is active. */
const PLAN_MODE_PREFIX =
  '[Plan mode] Produce a plan only — do NOT modify files, do NOT run tools that mutate state. Then ask me to confirm before acting.\n\n';

/**
 * Stateless composer: textarea, slash button, slash-menu popover, send button. Enter submits, Shift+Enter
 * newlines, `/` opens the slash menu; ADR-045: while `streaming`, submit emits `queueRequested`, not `submitted`.
 */
@Component({
  selector: 'app-composer',
  imports: [
    ReactiveFormsModule,
    SlashMenuComponent,
    CdkTextareaAutosize,
    CdkConnectedOverlay,
    CdkOverlayOrigin,
    TooltipDirective,
    AttachmentStripComponent,
    FileDropDirective,
    ResizeHandleDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'relative block min-w-0' },
  template: `
    @if (queuedText()) {
      <div
        data-testid="composer-queued"
        class="mono mb-2 flex items-center gap-2 rounded ring-1 ring-[var(--accent)]/40 bg-[var(--accent)]/[0.06] px-3 py-1.5 text-[11px] text-[var(--ink-dim)]"
      >
        <span class="text-[var(--accent)]">queued:</span>
        <span class="truncate" data-testid="composer-queued-text">{{ queuedPreview() }}</span>
        <button
          type="button"
          data-testid="composer-queued-cancel"
          class="ml-auto rounded px-1 text-[var(--ink-mute)] hover:text-[var(--ink)]"
          aria-label="Cancel queued message"
          (click)="queueCancelled.emit()"
        >
          ×
        </button>
      </div>
    }
    <app-attachment-strip
      [attachments]="attachmentViewModels()"
      (remove)="removeAttachment($event)"
    />
    @if (attachmentError()) {
      <div
        data-testid="composer-attachment-error"
        role="alert"
        class="mb-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300"
      >
        {{ attachmentError() }}
      </div>
    }
    <div class="sr-only" aria-live="polite" data-testid="composer-attachment-announce">
      {{ attachmentAnnouncement() }}
    </div>
    <div
      appFileDrop
      #fileDrop="appFileDrop"
      [disabled]="disabled()"
      (filesDropped)="onFilesDropped($event)"
      class="relative rounded border border-[var(--line)] bg-[var(--bg-1)] focus-within:border-[var(--accent)]"
      [class.ring-2]="fileDrop.isDragging()"
      [class.ring-[var(--accent)]]="fileDrop.isDragging()"
    >
      @if (fileDrop.isDragging()) {
        <div
          class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded bg-[var(--accent)]/10 text-[12px] font-medium text-[var(--accent)]"
        >
          Drop image to attach
        </div>
      }
      <div
        appResizeHandle
        [disabled]="disabled()"
        (resizeStart)="onResizeStart()"
        (resizeBy)="onResizeBy($event)"
        (resizeEnd)="onResizeEnd()"
        (resizeReset)="onResizeReset()"
        data-testid="composer-resize-handle"
        aria-label="Resize message input (drag or arrow keys; double-click to auto-size)"
        [attr.aria-valuenow]="resizeValueNow()"
        [attr.aria-valuemin]="resizeValueNow() !== null ? minResizePx : null"
        [attr.aria-valuemax]="resizeValueNow() !== null ? resizeValueMax() : null"
        class="group absolute inset-x-0 top-0 z-20 flex h-1.5 cursor-ns-resize items-center justify-center rounded-t focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
      >
        <span
          class="h-0.5 w-8 rounded-full bg-[var(--line-strong)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        ></span>
      </div>
      <div class="px-3 py-2.5">
        <textarea
          #textarea
          data-testid="chat-input"
          cdkTextareaAutosize
          cdkAutosizeMinRows="2"
          cdkAutosizeMaxRows="8"
          cdkOverlayOrigin
          #overlayOrigin="cdkOverlayOrigin"
          aria-label="Compose message"
          class="block w-full resize-none border-0 bg-transparent p-0 text-[14px] leading-relaxed text-[var(--ink)] placeholder-[var(--ink-mute)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          [placeholder]="effectivePlaceholder()"
          [formControl]="text"
          (keydown.enter)="onEnter($event)"
          (input)="onInput($event)"
          (paste)="onPaste($event)"
        ></textarea>
      </div>
      <div
        class="mono flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--line)] px-3 py-1.5 text-[11px] text-[var(--ink-mute)]"
      >
        <!-- Plan / Act mode toggle. -->
        <button
          type="button"
          data-testid="composer-plan-toggle"
          class="rounded border px-2 py-0.5 text-[10px] uppercase tracking-widest transition-colors"
          [class]="
            planMode()
              ? 'border-[var(--amber)] text-[var(--amber)] bg-[var(--amber)]/10'
              : 'border-[var(--line)] text-[var(--ink-mute)] hover:text-[var(--ink)]'
          "
          [attr.aria-pressed]="planMode()"
          [appTooltip]="
            planMode()
              ? 'Plan mode on — Claude will plan, not act'
              : 'Plan mode off — Claude will execute changes'
          "
          placement="top"
          (click)="togglePlanMode()"
        >
          {{ planMode() ? 'plan' : 'act' }}
        </button>
        <button
          type="button"
          data-testid="composer-slash"
          class="hover:text-[var(--ink)]"
          aria-label="Open skill menu"
          appTooltip="Open skill menu"
          placement="top"
          (click)="onSlashButtonClick()"
        >
          /<span class="hidden sm:inline"> skill</span>
        </button>
        @if (model()) {
          <span class="mx-1 hidden text-[var(--line-strong)] md:inline">·</span>
          <span
            class="hidden text-[var(--teal)] md:inline"
            data-testid="composer-model"
            appTooltip="Active LLM model"
            placement="top"
            >{{ model() }}</span
          >
        }
        @if (contextLabel()) {
          <span
            class="hidden text-[var(--ink-mute)] lg:inline"
            data-testid="composer-context"
            appTooltip="Maximum context window for this model"
            placement="top"
            >{{ contextLabel() }}</span
          >
        }
        <div class="ml-auto flex flex-shrink-0 items-center gap-2">
          @if (streaming()) {
            <button
              type="button"
              data-testid="chat-stop"
              aria-label="Stop"
              appTooltip="Stop"
              tooltipKbd="Esc"
              placement="top"
              class="rounded border border-red-500/50 bg-red-500/10 px-2.5 py-0.5 font-medium text-red-300 hover:bg-red-500/20"
              (click)="stopRequested.emit()"
            >
              stop
            </button>
          } @else {
            <button
              type="button"
              data-testid="chat-send"
              aria-label="Send"
              appTooltip="Send message"
              placement="top"
              class="rounded bg-[var(--accent)] px-2.5 py-0.5 font-medium text-[var(--on-accent)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              [disabled]="!canSubmit()"
              (click)="submit()"
            >
              send &rarr;
            </button>
          }
        </div>
      </div>
    </div>
    <ng-template
      [cdkConnectedOverlayOrigin]="overlayOrigin"
      [cdkConnectedOverlayOpen]="slashOpen()"
      [cdkConnectedOverlayPositions]="slashOverlayPositions"
      [cdkConnectedOverlayHasBackdrop]="true"
      cdkConnectedOverlayBackdropClass="cdk-overlay-transparent-backdrop"
      [cdkConnectedOverlayWidth]="overlayWidth()"
      (backdropClick)="closeSlash()"
      (detach)="closeSlash()"
      (overlayKeydown)="onOverlayKeydown($event)"
      cdkConnectedOverlay
    >
      <app-slash-menu
        [open]="true"
        [query]="slashQuery()"
        (selected)="applySelection($event)"
        (closed)="closeSlash()"
      />
    </ng-template>
  `,
})
export class ComposerComponent implements AfterViewInit {
  /** Textarea DOM node used to read the caret position and insert text at the cursor. */
  @ViewChild('textarea', { static: true })
  private textareaRef!: ElementRef<HTMLTextAreaElement>;

  /** Autosize directive on the textarea; toggled off while a manual height is in effect. */
  @ViewChild(CdkTextareaAutosize, { static: true })
  private autosize?: CdkTextareaAutosize;

  /** Slash-menu overlay; repositioned on resize so it stays anchored to the textarea. */
  @ViewChild(CdkConnectedOverlay)
  private slashOverlay?: CdkConnectedOverlay;

  /** Textarea height (px) captured when a resize gesture starts. */
  private resizeBaseHeight = 0;

  /** Upper bound for the current resize gesture, computed from the viewport at gesture start. */
  private resizeMaxHeight = 0;

  /** True while a manual height overrides autosize (from first gesture until reset). */
  private manualResizeActive = false;

  /** CDK's inline max-height captured at manual-resize start, restored on return to autosize. */
  private savedMaxHeight = '';

  /** Manual-resize floor exposed to the handle for `aria-valuemin`. */
  protected readonly minResizePx = MIN_COMPOSER_HEIGHT_PX;

  /** Current manual height for `aria-valuenow`; null while autosize is in control. */
  readonly resizeValueNow = signal<number | null>(null);

  /** Manual-resize ceiling for `aria-valuemax`, set when a gesture starts. */
  readonly resizeValueMax = signal<number>(0);

  /** True to disable input and prevent submits, false to enable. */
  readonly disabled = input(false);

  /** True when a turn is streaming (ADR-045); submits route to `queueRequested`. */
  readonly streaming = input(false);

  /** Current queued message preview, when one is set (ADR-045). */
  readonly queuedText = input('');

  /** Placeholder shown in the textarea when it is empty. */
  readonly placeholder = input('message speedwave...');

  /** Active model id (e.g. "opus-4.7") — shown in teal in the toolbar when set. */
  readonly model = input('');

  /** Context window hint (e.g. "128k") — shown next to the model on lg+. */
  readonly contextLabel = input('');

  /** `attachments` are pre-saved to `<project>/.speedwave/pastes/`. */
  readonly submitted = output<{
    payload: string;
    displayText: string;
    attachments: ChatAttachment[];
  }>();

  /**
   * ADR-045 — emits when the user submits while a turn is streaming.
   * Parent should call `chat.queueMessage(text)`.
   */
  readonly queueRequested = output<string>();

  /** ADR-045 — emits when the user clicks the X on the queued preview. */
  readonly queueCancelled = output<void>();

  /** Emits when the user clicks the inline Stop button while streaming. */
  readonly stopRequested = output<void>();

  /** Emits when the slash popover transitions open/closed (for parent UI coordination). */
  readonly slashOpenChange = output<boolean>();

  readonly slashService = inject(SlashService);
  private readonly projectState = inject(ProjectStateService);
  private readonly preprocessor = inject(ImagePreprocessorService);

  /** Reactive control holding the current textarea value. */
  readonly text = new FormControl<string>('', { nonNullable: true });

  /** Whether the slash popover is open. */
  readonly slashOpen = signal<boolean>(false);
  /** Active query used to filter the slash menu (text after `/`). */
  readonly slashQuery = signal<string>('');

  /** Plan mode state; when true the next submit is prefixed with `PLAN_MODE_PREFIX`. */
  readonly planMode = signal<boolean>(false);

  /** Pending image attachments; cleanup effect below revokes blob URLs on remove. */
  readonly attachments = signal<ReadonlyArray<AttachmentRecord>>([]);

  /** Counter for generating stable attachment ids without crypto. */
  private attachmentSeq = 0;

  /** Most recent user-facing error (e.g. preprocessing failure, capability reject). */
  readonly attachmentError = signal<string>('');

  /** Latest aria-live announcement (e.g. "Image attached: screenshot.png"). */
  readonly attachmentAnnouncement = signal<string>('');

  /** Bridges `FormControl.valueChanges` (RxJS) into the signal graph for OnPush. */
  readonly textValue = toSignal(this.text.valueChanges, { initialValue: '' });

  /** CDK overlay positions for the slash menu (anchored to the textarea). */
  readonly slashOverlayPositions: ConnectedPosition[] = [
    {
      originX: 'start',
      originY: 'top',
      overlayX: 'start',
      overlayY: 'bottom',
      offsetY: -8,
    },
    {
      originX: 'start',
      originY: 'bottom',
      overlayX: 'start',
      overlayY: 'top',
      offsetY: 8,
    },
  ];

  /** Width binding used so the overlay matches the textarea width. */
  readonly overlayWidth = computed<string>(() =>
    this.textareaRef?.nativeElement ? `${this.textareaRef.nativeElement.offsetWidth}px` : 'auto'
  );

  /** True when the user closed the slash menu while the trigger still matches, suppressing auto-reopen. */
  private slashSuppressedByUser = false;

  /**
   * Wires the slash service to the active project and syncs the textarea
   * disabled state with the `disabled` input.
   */
  constructor() {
    this.projectState.onProjectReady(() => {
      const id = this.projectState.activeProject();
      if (id) void this.slashService.refresh(id);
    });
    // Enable/disable the FormControl when the `disabled` input changes.
    effect(() => {
      const value = this.disabled();
      if (value) this.text.disable({ emitEvent: false });
      else this.text.enable({ emitEvent: false });
    });
    let previous: ReadonlyArray<AttachmentRecord> = [];
    effect((onCleanup) => {
      const current = this.attachments();
      for (const r of previous.filter((p) => !current.some((c) => c.id === p.id))) {
        URL.revokeObjectURL(r.previewUrl);
      }
      previous = current;
      onCleanup(() => {
        for (const r of current) URL.revokeObjectURL(r.previewUrl);
      });
    });
  }

  /** Auto-focus the textarea on mount so the user can start typing immediately. */
  ngAfterViewInit(): void {
    this.focusInput();
  }

  /**
   * Focus the textarea. Public so the parent can re-focus after high-level
   * actions like "new conversation" that reset state and may steal focus.
   */
  focusInput(): void {
    // New-conversation path: drop any manual height so the fresh composer starts auto-sized.
    this.restoreAutoSize();
    queueMicrotask(() => this.textareaRef?.nativeElement?.focus());
  }

  /**
   * Freezes the current height, disables autosize, and lifts CDK's row cap so the
   * drag can exceed `cdkAutosizeMaxRows`. `enabled = false` runs `reset()` synchronously.
   */
  onResizeStart(): void {
    const ta = this.textareaRef.nativeElement;
    const computed = parseFloat(window.getComputedStyle(ta).height);
    this.resizeBaseHeight = Number.isFinite(computed) ? computed : ta.offsetHeight;
    this.resizeMaxHeight = Math.max(
      MIN_COMPOSER_HEIGHT_PX,
      Math.round(window.innerHeight * MAX_COMPOSER_HEIGHT_FRACTION)
    );
    if (!this.manualResizeActive) {
      this.manualResizeActive = true;
      // Save CDK's row cap once, then hand height control to the manual gesture.
      this.savedMaxHeight = ta.style.maxHeight;
      if (this.autosize) this.autosize.enabled = false;
    }
    // Drop the inline max-height (cdkAutosizeMaxRows) or the field can't grow past 8 rows.
    ta.style.maxHeight = 'none';
    ta.style.height = `${this.resizeBaseHeight}px`;
    this.resizeValueMax.set(this.resizeMaxHeight);
    this.resizeValueNow.set(this.resizeBaseHeight);
  }

  /**
   * Applies a clamped height for the current gesture and keeps the slash menu anchored.
   * @param deltaY - Signed px offset from the gesture start (positive grows the field).
   */
  onResizeBy(deltaY: number): void {
    const target = Math.min(
      this.resizeMaxHeight,
      Math.max(MIN_COMPOSER_HEIGHT_PX, this.resizeBaseHeight + deltaY)
    );
    this.textareaRef.nativeElement.style.height = `${target}px`;
    this.resizeValueNow.set(target);
    if (this.slashOpen()) this.slashOverlay?.overlayRef?.updatePosition();
  }

  /** Reposition once more at gesture end (drag may have finished outside a move event). */
  onResizeEnd(): void {
    if (this.slashOpen()) this.slashOverlay?.overlayRef?.updatePosition();
  }

  /** Double-click the handle to drop the manual height and return to automatic sizing. */
  onResizeReset(): void {
    this.restoreAutoSize();
    if (this.slashOpen()) this.slashOverlay?.overlayRef?.updatePosition();
  }

  /**
   * Clears any manual height and hands sizing back to CDK autosize, re-applying the row
   * cap that `onResizeStart` dropped. Shared by the reset handle, submit, and new-conversation.
   */
  private restoreAutoSize(): void {
    if (!this.manualResizeActive) return;
    this.manualResizeActive = false;
    const ta = this.textareaRef?.nativeElement;
    if (!ta) return;
    ta.style.height = '';
    // Restore the exact row cap captured at resize start (no CDK internals poked).
    ta.style.maxHeight = this.savedMaxHeight;
    this.resizeValueNow.set(null);
    this.resizeValueMax.set(0);
    // enabled false→true makes the CDK setter reflow to fit content; no extra call needed.
    if (this.autosize) this.autosize.enabled = true;
  }

  /** Text submits queue while streaming (ADR-045); submits with attachments don't (ADR-065). */
  canSubmit(): boolean {
    if (this.disabled()) return false;
    if (this.anyAttachmentPreprocessing()) return false;
    const text = this.textValue();
    // A lone `/` is the skill-menu trigger, not a message.
    const hasText = text.trim().length > 0 && !isBareSlash(text);
    const hasAttachments = this.attachments().length > 0;
    if (!hasText && !hasAttachments) return false;
    return !(hasAttachments && this.streaming());
  }

  /** Truncated preview of the queued slot (single-line, max 80 chars). */
  queuedPreview(): string {
    const t = this.queuedText().replace(/\s+/g, ' ').trim();
    return t.length <= 80 ? t : `${t.slice(0, 77)}…`;
  }

  /**
   * Placeholder swaps to a queueing hint while streaming so the user knows
   * their next submit will queue rather than send immediately.
   */
  effectivePlaceholder(): string {
    if (this.streaming()) return 'queue next message...';
    return this.placeholder();
  }

  /**
   * Handles Enter — Shift+Enter inserts newline, Enter alone submits.
   * @param event Native keydown event from the textarea.
   */
  onEnter(event: Event): void {
    if ((event as KeyboardEvent).shiftKey) return;
    if (this.slashOpen() && this.slashService.commands().length > 0) return;
    event.preventDefault();
    this.submit();
  }

  /** Routes to queueRequested while streaming (ADR-045); submitted otherwise. */
  submit(): void {
    if (!this.canSubmit()) return;
    const text = this.textValue().trim();
    const payload = this.planMode() ? `${PLAN_MODE_PREFIX}${text}` : text;
    const attachments = this.readyChatAttachments();
    if (this.streaming()) {
      if (attachments.length > 0) return;
      this.queueRequested.emit(payload);
    } else {
      this.submitted.emit({ payload, displayText: text, attachments });
    }
    this.text.reset('');
    this.restoreAutoSize();
    this.clearAttachments();
    this.closeSlash();
  }

  /**
   * preventDefault only when an image was captured, so text paste keeps working.
   * @param event - Native paste event.
   */
  onPaste(event: ClipboardEvent): void {
    if (this.disabled()) return;
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return;
    event.preventDefault();
    void this.ingest(files);
  }

  /**
   * Drop handler — emits from `FileDropDirective`, validates MIME.
   * @param files - Dropped files (any MIME).
   */
  onFilesDropped(files: File[]): void {
    void this.ingest(files);
  }

  /**
   * Removes one attachment by id.
   * @param id - Attachment id from the view-model.
   */
  removeAttachment(id: string): void {
    const removed = this.attachments().find((a) => a.id === id);
    this.attachments.update((list) => list.filter((a) => a.id !== id));
    if (removed) {
      this.attachmentAnnouncement.set(`Image removed: ${removed.filename}`);
    }
  }

  /** Clears every attachment (post-submit and on session reset). */
  clearAttachments(): void {
    this.attachments.set([]);
    this.attachmentError.set('');
  }

  /** View-model used by the strip — strips composer-only state out. */
  readonly attachmentViewModels = computed<ReadonlyArray<AttachmentViewModel>>(() =>
    this.attachments().map((a) => ({
      id: a.id,
      filename: a.filename,
      previewUrl: a.previewUrl,
      encodedSizeBytes: a.preprocessed?.sizeBytes ?? 0,
      preprocessing: a.preprocessed === null,
    }))
  );

  /** True when at least one attachment is still being processed. */
  readonly anyAttachmentPreprocessing = computed<boolean>(() =>
    this.attachments().some((a) => a.preprocessed === null)
  );

  /** Submit gating reason (used in tooltip / aria-disabled state). */
  readonly submitBlockedReason = computed<string>(() => {
    if (this.disabled()) return '';
    if (this.anyAttachmentPreprocessing()) return 'Preparing image…';
    if (this.attachments().length > 0 && this.streaming()) {
      return 'Wait for the response to finish before sending an image.';
    }
    return '';
  });

  private async ingest(files: File[]): Promise<void> {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) {
      // Non-image drop/paste is silently ignored.
      return;
    }
    const project = this.projectState.activeProject();
    if (!project) {
      this.attachmentError.set('Wybierz projekt przed wklejeniem obrazka.');
      return;
    }

    const modelClass = this.modelClass();
    for (const file of images) {
      const id = `att-${++this.attachmentSeq}`;
      const previewUrl = URL.createObjectURL(file);
      this.attachments.update((list) => [
        ...list,
        { id, filename: file.name || 'image', previewUrl, preprocessed: null },
      ]);
      try {
        const out = await this.preprocessor.preprocess(file, modelClass, project);
        // Preprocessor returns its own post-resample blob URL; drop the optimistic one.
        URL.revokeObjectURL(previewUrl);
        this.attachments.update((list) =>
          list.map((a) =>
            a.id === id ? { ...a, previewUrl: out.previewUrl, preprocessed: out } : a
          )
        );
        this.attachmentError.set('');
        this.attachmentAnnouncement.set(`Image attached: ${out.attachment.filename}`);
      } catch (err) {
        this.attachments.update((list) => list.filter((a) => a.id !== id));
        URL.revokeObjectURL(previewUrl);
        this.attachmentError.set(err instanceof Error ? err.message : ERROR_UNSUPPORTED_TYPE);
      }
    }
  }

  private modelClass(): ModelClass {
    const id = this.model();
    if (!id) return 'sonnet';
    if (id.includes('opus')) return 'opus';
    if (id.includes('haiku')) return 'haiku';
    return 'sonnet';
  }

  /** Snapshot of attachments that finished preprocessing. */
  private readyAttachments(): PreprocessedImage[] {
    return this.attachments()
      .map((a) => a.preprocessed)
      .filter((p): p is PreprocessedImage => p !== null);
  }

  /** Same snapshot projected to `ChatAttachment` for the parent submit handler. */
  private readyChatAttachments(): ChatAttachment[] {
    return this.readyAttachments().map((p) => p.attachment);
  }

  /** Toggles plan mode on/off. Persists across messages until toggled again. */
  togglePlanMode(): void {
    this.planMode.update((v) => !v);
  }

  /**
   * Updates slash-menu visibility when the textarea content changes.
   * @param event Native input event whose target is the textarea.
   */
  onInput(event: Event): void {
    this.updateSlashState(event.target as HTMLTextAreaElement);
  }

  /**
   * Inserts a `/` at the current caret position and opens the slash menu.
   */
  onSlashButtonClick(): void {
    if (this.disabled()) return;
    // Explicit user request — clear any prior suppression.
    this.slashSuppressedByUser = false;
    const ta = this.textareaRef.nativeElement;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const insert = before.length === 0 || /\s$/.test(before) ? '/' : ' /';
    this.text.setValue(`${before}${insert}${after}`);
    const newPos = start + insert.length;
    queueMicrotask(() => {
      ta.focus();
      ta.setSelectionRange(newPos, newPos);
      this.updateSlashState(ta);
    });
  }

  /**
   * Replaces the `/query` token with the selected command name and closes the popover.
   * @param command Slash command chosen from the popover.
   */
  applySelection(command: SlashCommand): void {
    const ta = this.textareaRef.nativeElement;
    const caret = ta.selectionStart ?? ta.value.length;
    const prefix = ta.value.slice(0, caret);
    const suffix = ta.value.slice(caret);
    const match = SLASH_TRIGGER.exec(prefix);
    if (!match) {
      this.closeSlash();
      return;
    }
    const leading = match[1] ?? '';
    const replacement = `${leading}/${command.name} `;
    this.text.setValue(`${replacement}${suffix}`);
    queueMicrotask(() => {
      const newCaret = replacement.length;
      ta.focus();
      ta.setSelectionRange(newCaret, newCaret);
    });
    this.closeSlash();
  }

  /** Closes the popover, refocuses the textarea, and suppresses auto-reopen while the trigger matches. */
  closeSlash(): void {
    const ta = this.textareaRef?.nativeElement;
    if (ta) {
      const caret = ta.selectionStart ?? ta.value.length;
      const prefix = ta.value.slice(0, caret);
      if (SLASH_TRIGGER.test(prefix)) {
        this.slashSuppressedByUser = true;
      }
    }
    this.setSlashOpen(false);
    this.slashQuery.set('');
  }

  /**
   * Handle keystrokes inside the overlay; Esc closes the menu without propagating.
   * @param event Keyboard event raised by the CDK overlay.
   */
  onOverlayKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closeSlash();
    }
  }

  private setSlashOpen(open: boolean): void {
    if (this.slashOpen() === open) return;
    this.slashOpen.set(open);
    this.slashOpenChange.emit(open);
  }

  private updateSlashState(el: HTMLTextAreaElement): void {
    const caret = el.selectionStart ?? el.value.length;
    const prefix = el.value.slice(0, caret);
    const match = SLASH_TRIGGER.exec(prefix);
    if (match) {
      // Honour user suppression — do not auto-reopen until the trigger clears.
      if (this.slashSuppressedByUser) {
        this.slashQuery.set(match[2] ?? '');
        return;
      }
      this.slashQuery.set(match[2] ?? '');
      if (!this.slashOpen()) {
        this.setSlashOpen(true);
        const project = this.projectState.activeProject();
        if (project && this.slashService.commands().length === 0) {
          void this.slashService.refresh(project);
        }
      }
    } else {
      // Trigger no longer matches — clear suppression and close the menu.
      this.slashSuppressedByUser = false;
      if (this.slashOpen()) {
        this.setSlashOpen(false);
        this.slashQuery.set('');
      }
    }
  }
}
