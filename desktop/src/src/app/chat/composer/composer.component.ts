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
import { SlashService, type SlashCommand } from '../slash/slash.service';
import { TooltipDirective } from '../../shared/tooltip.directive';

/** Regex matching `/query` at the very start of input (optionally preceded by whitespace), capturing the query. */
const SLASH_TRIGGER = /^(\s*)\/([^\s/]*)$/;

/**
 * Inline directive prepended to a user message when plan mode is active.
 * Stream-json has no first-class plan toggle, so we encode the intent in the
 * prompt itself. The wording mirrors Claude Code's CLI plan mode banner.
 */
const PLAN_MODE_PREFIX =
  '[Plan mode] Produce a plan only — do NOT modify files, do NOT run tools that mutate state. Then ask me to confirm before acting.\n\n';

/**
 * Stateless composer that wraps a textarea, slash button, slash-menu popover, and a
 * send button. Input is managed by a reactive `FormControl<string>`; Enter
 * submits while Shift+Enter inserts a newline. Typing `/` at the start of the
 * textarea (or clicking the `/` toolbar button) opens the slash-menu popover.
 *
 * ADR-045: when `streaming` is true and a user submits, the composer emits
 * `queueRequested` instead of `submitted`; the parent wires the queue
 * Tauri command. The "queued: …" preview line surfaces the active slot
 * with an X button that emits `queueCancelled`.
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
    <div
      class="rounded border border-[var(--line)] bg-[var(--bg-1)] focus-within:border-[var(--accent)]"
    >
      <textarea
        #textarea
        data-testid="chat-input"
        cdkTextareaAutosize
        cdkAutosizeMinRows="2"
        cdkAutosizeMaxRows="8"
        cdkOverlayOrigin
        #overlayOrigin="cdkOverlayOrigin"
        aria-label="Compose message"
        class="w-full resize-none border-0 bg-transparent px-3 py-2.5 text-[14px] leading-relaxed text-[var(--ink)] placeholder-[var(--ink-mute)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        [placeholder]="effectivePlaceholder()"
        [formControl]="text"
        (keydown.enter)="onEnter($event)"
        (input)="onInput($event)"
      ></textarea>
      <div
        class="mono flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--line)] px-3 py-1.5 text-[11px] text-[var(--ink-mute)]"
      >
        <!-- Plan / Act mode toggle — first control in the toolbar so the
             active mode is the most visible piece of the row. Plan mode
             prepends a planning directive to the backend payload (Claude
             produces a plan and asks before acting); the local bubble
             keeps the user's raw text. -->
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

  /** True to disable input and prevent submits, false to enable. */
  readonly disabled = input(false);

  /**
   * True when a turn is currently streaming (ADR-045). The composer stays
   * enabled — the user can keep typing — but submits route to
   * `queueRequested` instead of `submitted`.
   */
  readonly streaming = input(false);

  /** Current queued message preview, when one is set (ADR-045). */
  readonly queuedText = input('');

  /** Placeholder shown in the textarea when it is empty. */
  readonly placeholder = input('message speedwave...');

  /** Active model id (e.g. "opus-4.7") — shown in teal in the toolbar when set. */
  readonly model = input('');

  /** Context window hint (e.g. "128k") — shown next to the model on lg+. */
  readonly contextLabel = input('');

  /** Emits the trimmed message text when the user submits via Enter or the send button. */
  readonly submitted = output<{ payload: string; displayText: string }>();

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

  /** Reactive control holding the current textarea value. */
  readonly text = new FormControl<string>('', { nonNullable: true });

  /** Whether the slash popover is open. */
  readonly slashOpen = signal<boolean>(false);
  /** Active query used to filter the slash menu (text after `/`). */
  readonly slashQuery = signal<string>('');

  /**
   * Plan mode state. When true, the next submitted message is prefixed with
   * the planning directive (`PLAN_MODE_PREFIX`). Persists across messages
   * until the user toggles it off — mirrors the CLI's plan mode behaviour.
   */
  readonly planMode = signal<boolean>(false);

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

  /**
   * True when the user explicitly closed the slash menu (Esc / backdrop click)
   * while the textarea still matches the slash trigger. Prevents the menu from
   * immediately re-opening on the next keystroke until the user clears the
   * trigger or explicitly clicks the slash button again.
   */
  private slashSuppressedByUser = false;

  /**
   * Wires the slash service to the active project and syncs the textarea
   * disabled state with the `disabled` input.
   */
  constructor() {
    this.projectState.onProjectReady(() => {
      const id = this.projectState.activeProject;
      if (id) void this.slashService.refresh(id);
    });
    // Mirror the legacy setter side-effect: enable/disable the FormControl
    // whenever the `disabled` input changes.
    effect(() => {
      const value = this.disabled();
      if (value) this.text.disable({ emitEvent: false });
      else this.text.enable({ emitEvent: false });
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
    queueMicrotask(() => this.textareaRef?.nativeElement?.focus());
  }

  /**
   * True when there is text to send. The composer accepts submits while
   * `streaming` is true — those are routed to `queueRequested` (ADR-045).
   * `disabled` still blocks all input (auth/setup states).
   */
  canSubmit(): boolean {
    return !this.disabled() && this.textValue().trim().length > 0;
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

  /**
   * Submits the current textarea value and resets the form. Routes to
   * `queueRequested` while streaming (ADR-045); `submitted` otherwise.
   *
   * When plan mode is active, the prefix is added to the backend payload
   * so Claude produces a plan instead of acting — but the local bubble
   * still shows the user's raw text, not the directive boilerplate.
   */
  submit(): void {
    if (!this.canSubmit()) return;
    const text = this.textValue().trim();
    const payload = this.planMode() ? `${PLAN_MODE_PREFIX}${text}` : text;
    if (this.streaming()) {
      this.queueRequested.emit(payload);
    } else {
      this.submitted.emit({ payload, displayText: text });
    }
    this.text.reset('');
    this.closeSlash();
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

  /**
   * Closes the popover and returns focus to the textarea. If the textarea
   * still matches the slash trigger, suppress automatic re-opening until the
   * user clears the trigger or explicitly clicks the slash button again.
   */
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
   * Handle keystrokes inside the overlay. Esc closes the menu without
   * propagating up to the textarea (which would otherwise re-trigger
   * the menu via `updateSlashState`).
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
        const project = this.projectState.activeProject;
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
