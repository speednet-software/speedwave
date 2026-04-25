import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  signal,
} from '@angular/core';
import type { AskUserQuestionBlock } from '../../models/chat';

/** Interactive question prompt — renders multi-select, single+freeform, or answered (locked) variants and emits `answered`. */
@Component({
  selector: 'app-ask-user-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block my-2' },
  styles: [
    `
      :host {
        display: block;
      }
      .ask-active {
        border-radius: 0.25rem;
        box-shadow: 0 0 0 1px color-mix(in oklab, var(--violet, #a78bfa) 40%, transparent);
        background-color: color-mix(in oklab, var(--violet, #a78bfa) 6%, transparent);
        padding: 1rem;
      }
      .ask-locked {
        border-radius: 0.25rem;
        box-shadow: 0 0 0 1px color-mix(in oklab, var(--violet, #a78bfa) 20%, transparent);
        background-color: var(--bg-1, #0b0e18);
        padding: 1rem;
        opacity: 0.8;
      }
      .ask-legend {
        color: var(--violet, #a78bfa);
      }
      .ask-legend-answered {
        color: color-mix(in oklab, var(--violet, #a78bfa) 70%, transparent);
      }
      .ask-question {
        color: var(--ink, #e8edf7);
      }
      .ask-question-answered {
        color: var(--ink-dim, #9aa3ba);
      }
      .opt-btn {
        transition:
          background-color 120ms ease,
          border-color 120ms ease;
      }
      .opt-btn.opt-selected {
        border-color: var(--violet, #a78bfa);
        background-color: color-mix(in oklab, var(--violet, #a78bfa) 20%, transparent);
        color: var(--ink, #e8edf7);
      }
      .opt-btn:not(.opt-selected) {
        border-color: var(--line-strong, #252c42);
        background-color: var(--bg-2, #10141f);
        color: var(--ink-dim, #9aa3ba);
      }
      .opt-btn:not(.opt-selected):hover {
        border-color: var(--violet, #a78bfa);
      }
      .answered-badge {
        border: 1px solid color-mix(in oklab, var(--violet, #a78bfa) 50%, transparent);
        background-color: color-mix(in oklab, var(--violet, #a78bfa) 15%, transparent);
        color: var(--ink, #e8edf7);
      }
      .freeform {
        border: 1px solid var(--line, #1a2030);
        background-color: var(--bg-2, #10141f);
        color: var(--ink, #e8edf7);
      }
      .freeform-muted {
        opacity: 0.5;
        border-color: var(--line-strong, #252c42);
      }
      .freeform-hint {
        color: var(--ink-mute, #707a96);
      }
      .send-btn {
        background-color: var(--accent, #ff4d6d);
        color: var(--on-accent, #07090f);
      }
      .send-btn:hover:not(:disabled) {
        opacity: 0.9;
      }
      .send-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ],
  template: `
    <fieldset
      data-testid="ask-user-block"
      [attr.data-variant]="variant()"
      [disabled]="question.answered"
      class="border-0 m-0"
      [class.ask-active]="!question.answered"
      [class.ask-locked]="question.answered"
    >
      <legend
        data-testid="ask-legend"
        class="mono mb-2 px-0 text-[11px]"
        [class.ask-legend]="!question.answered"
        [class.ask-legend-answered]="question.answered"
        [class.sr-only]="legendHidden()"
      >
        {{ legendText() }}
      </legend>

      <div
        data-testid="ask-question"
        class="mb-3"
        [class.text-[14px]]="!question.answered"
        [class.text-[13px]]="question.answered"
        [class.ask-question]="!question.answered"
        [class.ask-question-answered]="question.answered"
      >
        {{ question.question }}
      </div>

      @if (question.answered) {
        <div data-testid="ask-answered" class="flex flex-wrap gap-1.5">
          @for (val of question.selected_values; track val) {
            <span
              data-testid="selected-option"
              class="answered-badge mono inline-block rounded px-2 py-0.5 text-[11px]"
            >
              {{ val }}
            </span>
          }
        </div>
      } @else {
        @if (question.options.length > 0) {
          <div
            class="flex flex-wrap gap-2"
            role="group"
            [attr.aria-label]="question.multi_select ? 'Select any options' : 'Select one option'"
          >
            @for (option of question.options; track option.value) {
              <button
                type="button"
                data-testid="ask-option-btn"
                class="opt-btn mono rounded border px-3 py-1 text-[12px]"
                [class.opt-selected]="isSelected(option.value)"
                [attr.aria-pressed]="isSelected(option.value)"
                (click)="toggleOption(option.value)"
              >
                {{ option.label }}{{ isSelected(option.value) ? ' ✓' : '' }}
              </button>
            }
          </div>
        }

        @if (allowFreeform()) {
          <div class="mt-3">
            <label class="sr-only" [attr.for]="freeformId">Freeform answer</label>
            <textarea
              data-testid="ask-input"
              [id]="freeformId"
              class="freeform mono w-full rounded px-3 py-1 text-[12px] resize-y min-h-[2.25rem]"
              [class.freeform-muted]="freeformSilenced()"
              rows="1"
              placeholder="or type your own answer..."
              [value]="freeformText()"
              (input)="onFreeformInput($event)"
              (keydown.enter)="onFreeformEnter($event)"
            ></textarea>
            @if (freeformSilenced()) {
              <span
                data-testid="ask-freeform-hint"
                class="freeform-hint mono mt-1 block text-[11px]"
              >
                freeform input ignored when option selected
              </span>
            }
          </div>
        }

        <div class="mt-3 flex gap-2">
          <button
            type="button"
            data-testid="ask-send-btn"
            class="send-btn mono rounded px-3 py-1 text-[12px] font-medium"
            [disabled]="!canSend()"
            (click)="submit()"
          >
            {{ sendLabel() }}
          </button>
        </div>
      }
    </fieldset>
  `,
})
export class AskUserBlockComponent {
  /** Backing signal for the `question` input so `computed()` derivations update reactively. */
  private readonly _question = signal<AskUserQuestionBlock | undefined>(undefined);

  /** The AskUserQuestion payload rendered by this prompt. */
  get question(): AskUserQuestionBlock {
    const q = this._question();
    if (!q) {
      throw new Error('AskUserBlockComponent.question accessed before initialisation');
    }
    return q;
  }
  /**
   * Replaces the current question payload; pushes it into `_question` so all
   * reactive computeds re-evaluate against the new value.
   * @param value - The new AskUserQuestion payload.
   */
  @Input({ required: true })
  set question(value: AskUserQuestionBlock) {
    this._question.set(value);
  }

  @Output() answered = new EventEmitter<{ toolId: string; values: string[] }>();

  /** Selected option values, tracked reactively for efficient template updates. */
  readonly selected = signal<ReadonlySet<string>>(new Set());

  /** Freeform textarea content. */
  readonly freeformText = signal<string>('');

  /** DOM id for label-input association on the freeform textarea. */
  readonly freeformId = `ask-freeform-${Math.random().toString(36).slice(2, 9)}`;

  /** Variant key used as a data attribute and drives some visual decisions. */
  readonly variant = computed<'multi' | 'single-freeform' | 'freeform' | 'answered'>(() => {
    const q = this._question();
    if (!q) return 'freeform';
    if (q.answered) return 'answered';
    if (q.multi_select) return 'multi';
    if (q.options.length === 0) return 'freeform';
    return 'single-freeform';
  });

  /** Freeform input is shown for single-select + freeform and freeform-only variants. */
  readonly allowFreeform = computed(() => {
    const v = this.variant();
    return v === 'single-freeform' || v === 'freeform';
  });

  /** Freeform value will be silently dropped on submit because an option is also selected. */
  readonly freeformSilenced = computed(
    () => this.selected().size > 0 && this.freeformText().trim().length > 0
  );

  /** Whether the Send button may fire. */
  readonly canSend = computed(() => {
    const q = this._question();
    if (q?.answered) return false;
    if (this.selected().size > 0) return true;
    if (this.allowFreeform() && this.freeformText().trim().length > 0) return true;
    return false;
  });

  /** Send button label — shows a count for multi-select with any selection. */
  readonly sendLabel = computed(() => {
    const q = this._question();
    if (q?.multi_select) {
      const count = this.selected().size;
      return count > 0 ? `Send (${count})` : 'Send';
    }
    return 'Send';
  });

  /** Legend text: either the provided header, a fallback, or an answered indicator. */
  readonly legendText = computed(() => {
    const q = this._question();
    if (!q) return '';
    if (q.answered) return '✓ answered';
    if (q.header) return q.header;
    return q.multi_select ? '? question · select any' : '? question · pick one or type';
  });

  /** Hide the legend visually when there's nothing meaningful to render (screen readers still get it). */
  readonly legendHidden = computed(() => {
    const q = this._question();
    if (!q) return true;
    return !q.answered && !q.header && q.options.length === 0 && !q.multi_select;
  });

  /**
   * Checks whether a given option value is currently selected.
   * @param value - Option value to check against the selected set.
   */
  isSelected(value: string): boolean {
    return this.selected().has(value);
  }

  /**
   * Toggles selection of an option value (single or multi-select).
   * @param value - Option value to toggle into/out of the selected set.
   */
  toggleOption(value: string): void {
    if (this.question.answered) return;
    this.selected.update((prev) => {
      const next = new Set(prev);
      if (this.question.multi_select) {
        if (next.has(value)) {
          next.delete(value);
        } else {
          next.add(value);
        }
      } else {
        next.clear();
        next.add(value);
      }
      return next;
    });
  }

  /** Emits the pending selection or freeform text. Selection wins over freeform when both present. */
  submit(): void {
    if (this.question.answered) return;
    const values = [...this.selected()];
    if (values.length > 0) {
      this.answered.emit({ toolId: this.question.tool_id, values });
      return;
    }
    const trimmed = this.freeformText().trim();
    if (trimmed.length > 0) {
      this.answered.emit({ toolId: this.question.tool_id, values: [trimmed] });
    }
  }

  /**
   * Stores the textarea value on each input event.
   * @param event - The DOM input event whose target holds the current text.
   */
  onFreeformInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement | null;
    this.freeformText.set(target?.value ?? '');
  }

  /**
   * Submits on Enter (without Shift) for a keyboard-friendly workflow.
   * @param event - The keydown event fired by the freeform textarea.
   */
  onFreeformEnter(event: Event): void {
    const ke = event as KeyboardEvent;
    if (ke.shiftKey) return;
    event.preventDefault();
    this.submit();
  }
}
