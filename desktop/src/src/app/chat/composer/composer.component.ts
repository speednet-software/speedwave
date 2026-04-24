import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

/** Regex matching `/` at the very start of input (optionally preceded by whitespace). */
const SLASH_AT_START = /^\s*\/[^\s/]*$/;

/**
 * Stateless composer that wraps a textarea, toolbar slash/mention buttons, and a
 * send button. Input is managed by a reactive `FormControl<string>`; Enter
 * submits while Shift+Enter inserts a newline. Typing `/` at the start of the
 * textarea (or clicking the `/` toolbar button) emits `slashOpened` so a parent
 * component can mount a slash-menu popover (Feature 1).
 *
 * The `queuedMessage` input renders a `queued: <preview>` badge above the
 * textarea with a cancel button; when non-empty the caller is expected to have
 * stored the message in the ADR-045 one-slot queue.
 */
@Component({
  selector: 'app-composer',
  standalone: true,
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="mx-auto max-w-3xl relative">
      @if (queuedMessage) {
        <div
          data-testid="composer-queued"
          class="mb-2 flex items-center gap-2 rounded border border-line bg-bg-1 px-3 py-1.5 mono text-[11px] text-ink-dim"
        >
          <span class="text-accent">queued:</span>
          <span class="flex-1 truncate text-ink">{{ queuedMessage }}</span>
          <button
            type="button"
            data-testid="composer-queued-cancel"
            class="text-ink-mute hover:text-ink"
            aria-label="Cancel queued message"
            (click)="cancelQueued.emit()"
          >
            &times;
          </button>
        </div>
      }

      <div class="rounded border border-line bg-bg-1 focus-within:border-accent">
        <textarea
          #textarea
          data-testid="chat-input"
          rows="2"
          aria-label="Compose message"
          class="w-full resize-none border-0 bg-transparent px-3 py-2.5 text-[14px] leading-relaxed text-ink placeholder-ink-mute focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
          [placeholder]="placeholder"
          [formControl]="text"
          [attr.disabled]="disabled ? '' : null"
          (keydown.enter)="onEnter($event)"
          (input)="onInput($event)"
        ></textarea>
        <div
          class="mono flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-1.5 text-[11px] text-ink-mute"
        >
          <button type="button" class="hover:text-ink">
            &#64;<span class="hidden sm:inline"> mention</span>
          </button>
          <button type="button" class="hover:text-ink">
            +<span class="hidden sm:inline"> attach</span>
          </button>
          <button
            type="button"
            data-testid="composer-slash"
            class="hover:text-ink"
            (click)="onSlashButtonClick()"
          >
            /<span class="hidden sm:inline"> skill</span>
          </button>
          <div class="ml-auto flex flex-shrink-0 items-center gap-2">
            <span class="hidden sm:inline">&#8984;+&#8629;</span>
            <button
              type="button"
              data-testid="chat-send"
              aria-label="Send"
              class="rounded bg-accent px-2.5 py-0.5 font-medium text-on-accent hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              [attr.disabled]="canSubmit() ? null : ''"
              (click)="submit()"
            >
              send &rarr;
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
})
export class ComposerComponent {
  /** Textarea DOM node used to read the caret position and insert text at the cursor. */
  @ViewChild('textarea', { static: true })
  private textareaRef!: ElementRef<HTMLTextAreaElement>;

  /** Disables input and suppresses submits while the turn is streaming. */
  @Input() disabled = false;

  /** Placeholder shown in the textarea when it is empty. */
  @Input() placeholder = 'Message Claude...';

  /**
   * Preview of the message currently sitting in the ADR-045 one-slot queue.
   * When non-empty, the composer shows a `queued: <preview>` badge with a cancel button.
   */
  @Input() queuedMessage = '';

  /** Emits the trimmed message text when the user submits via Enter or the send button. */
  @Output() readonly submitted = new EventEmitter<string>();

  /**
   * Emits when the slash menu should open — either because the user typed `/`
   * at the start of the textarea, or because they clicked the `/` toolbar button.
   * The `caretPos` tells the parent where to anchor the popover / apply the insertion.
   */
  @Output() readonly slashOpened = new EventEmitter<{ caretPos: number }>();

  /** Emits when the user clicks the cancel button on the queued-message badge. */
  @Output() readonly cancelQueued = new EventEmitter<void>();

  /** Reactive control holding the current textarea value. */
  readonly text = new FormControl<string>('', { nonNullable: true });

  /**
   * Text value as a signal — bridges `FormControl.valueChanges` (RxJS) into
   * the signal graph so OnPush templates re-render when the textarea changes.
   * `toSignal` handles teardown automatically when the component is destroyed.
   */
  readonly textValue = toSignal(this.text.valueChanges, { initialValue: '' });

  /** True when there is text to send and the composer is not disabled. */
  canSubmit(): boolean {
    return !this.disabled && this.textValue().trim().length > 0;
  }

  /**
   * Handles the Enter key. Shift+Enter inserts a newline (default behavior),
   * Enter alone submits. The template routes this via `(keydown.enter)` which
   * forwards `$event` typed as `Event`; we narrow to `KeyboardEvent` here.
   * @param event - Keyboard event from the textarea.
   */
  onEnter(event: Event): void {
    if ((event as KeyboardEvent).shiftKey) return;
    event.preventDefault();
    this.submit();
  }

  /** Submits the current textarea value and resets the form. */
  submit(): void {
    if (!this.canSubmit()) return;
    this.submitted.emit(this.textValue().trim());
    this.text.reset('');
  }

  /**
   * Fires `slashOpened` when the textarea text matches `^\s*\/...$`.
   * @param event - Input event from the textarea.
   */
  onInput(event: Event): void {
    const ta = event.target as HTMLTextAreaElement;
    const caretPos = ta.selectionStart ?? 0;
    if (SLASH_AT_START.test(ta.value.slice(0, caretPos))) {
      this.slashOpened.emit({ caretPos });
    }
  }

  /**
   * Inserts a `/` at the current caret position and emits `slashOpened` so the
   * parent can mount the slash-menu popover.
   */
  onSlashButtonClick(): void {
    if (this.disabled) return;
    const ta = this.textareaRef.nativeElement;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    this.text.setValue(`${ta.value.slice(0, start)}/${ta.value.slice(end)}`);
    const newPos = start + 1;
    queueMicrotask(() => {
      ta.focus();
      ta.setSelectionRange(newPos, newPos);
    });
    this.slashOpened.emit({ caretPos: newPos });
  }
}
