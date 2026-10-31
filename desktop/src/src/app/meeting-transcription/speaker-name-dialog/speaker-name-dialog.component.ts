import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  viewChild,
} from '@angular/core';

import { SPEAKER_NAME_MAX_CHARS } from '../../models/transcript';

let nextDialogId = 0;

/**
 * Inline dialog that names a speaker or the user: Enter or Save saves, Cancel cancels, Esc or a
 * click outside dismisses.
 */
@Component({
  selector: 'app-speaker-name-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', '(document:mousedown)': 'onDocumentMousedown($event)' },
  template: `
    <div
      role="dialog"
      class="w-full max-w-[360px] rounded-md border border-[var(--line-strong)] bg-[var(--bg-2)] p-3 text-[12.5px] shadow-lg"
      data-testid="speaker-name-dialog"
      [attr.aria-label]="heading()"
      (keydown.escape)="dismissed.emit()"
    >
      <label [for]="inputId" class="mb-1.5 block text-[11px] text-[var(--ink-mute)]">
        {{ heading() }}
      </label>
      <input
        #field
        type="text"
        class="h-8 w-full rounded border border-[var(--accent)] bg-[var(--bg-1)] px-2 text-[13.5px] font-medium text-[var(--ink)] outline-none placeholder:font-normal placeholder:text-[var(--ink-mute)]"
        data-testid="speaker-name-input"
        [id]="inputId"
        [attr.maxlength]="maxChars"
        [attr.aria-describedby]="noteId"
        [value]="initial()"
        [placeholder]="placeholder()"
        (input)="typed.set(field.value)"
        (keydown.enter)="saved.emit(field.value)"
      />
      @if (suggestions().length > 0) {
        <div
          class="mt-2 flex flex-wrap items-center gap-1.5"
          data-testid="speaker-name-suggestions"
        >
          <span class="w-full text-[11px] text-[var(--ink-mute)]"
            >Names from the previous transcript</span
          >
          @for (name of suggestions(); track name) {
            <button
              type="button"
              class="rounded-full border border-[var(--line-strong)] bg-[var(--bg-1)] px-2 py-0.5 text-[11.5px] text-[var(--ink)] hover:bg-[var(--bg-3)]"
              data-testid="speaker-name-suggestion"
              (click)="pick(name)"
            >
              {{ name }}
            </button>
          }
        </div>
      }
      <p
        class="mt-2 text-[11.5px] leading-relaxed text-[var(--ink-dim)]"
        aria-live="polite"
        data-testid="speaker-name-note"
        [id]="noteId"
      >
        {{ note() }}
      </p>
      <div class="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="mono rounded bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--on-accent)] hover:opacity-90"
          data-testid="speaker-name-save"
          (click)="saved.emit(field.value)"
        >
          {{ saveLabel() }}
        </button>
        <button
          type="button"
          class="mono rounded border border-[var(--line)] px-2.5 py-1 text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
          data-testid="speaker-name-cancel"
          (click)="cancelled.emit()"
        >
          {{ cancelLabel() }}
        </button>
        <span class="ml-auto text-[10.5px] text-[var(--ink-mute)]">{{ hint() }}</span>
      </div>
    </div>
  `,
})
export class SpeakerNameDialogComponent {
  /** The field's label, also the dialog's accessible name. */
  readonly heading = input.required<string>();
  /** The text the field opens with. */
  readonly initial = input('');
  /** The field's placeholder. */
  readonly placeholder = input('');
  /** What saving the typed text changes, worked out on every keystroke. */
  readonly describe = input.required<(typed: string) => string>();
  /** Names offered for one click; a click puts the name in the field. */
  readonly suggestions = input<string[]>([]);
  /** The keyboard hint beside the buttons. */
  readonly hint = input('');
  /** The save button's text. */
  readonly saveLabel = input('Save');
  /** The cancel button's text. */
  readonly cancelLabel = input('Cancel');
  /** The text in the field when the user saved. */
  readonly saved = output<string>();
  /** The user pressed Cancel. */
  readonly cancelled = output<void>();
  /** The user pressed Esc or clicked outside the dialog. */
  readonly dismissed = output<void>();

  protected readonly maxChars = SPEAKER_NAME_MAX_CHARS;
  protected readonly inputId = `speaker-name-${++nextDialogId}`;
  protected readonly noteId = `${this.inputId}-note`;
  protected readonly typed = linkedSignal(() => this.initial());
  protected readonly note = computed(() => this.describe()(this.typed()));

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  /** Focuses the field with its text selected once the dialog is drawn. */
  constructor() {
    afterNextRender({
      write: () => {
        const el = this.field().nativeElement;
        el.focus();
        el.select();
      },
    });
  }

  /**
   * Dismisses the dialog on a press outside it.
   * @param event - any mouse press in the document.
   */
  onDocumentMousedown(event: MouseEvent): void {
    const target = event.target as Node | null;
    if (target && !this.host.nativeElement.contains(target)) this.dismissed.emit();
  }

  /**
   * Puts an offered name in the field and keeps the focus there.
   * @param name - the offered name.
   */
  protected pick(name: string): void {
    const el = this.field().nativeElement;
    el.value = name;
    this.typed.set(name);
    el.focus();
  }
}
