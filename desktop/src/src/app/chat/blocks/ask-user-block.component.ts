import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { AskUserQuestionBlock } from '../../models/chat';

/**
 * Interactive question prompt — terminal-minimal callout box (mockup lines
 * 824–858). Renders three variants:
 * - Multi-select (chips, confirm with count).
 * - Single-select + freeform (chips + inline input).
 * - Answered (locked) — dimmed wrapper, opaque badge per chosen value.
 *
 * Pure Tailwind — no inline `<style>` blocks. Emits `answered` once the user
 * confirms a selection.
 */
@Component({
  selector: 'app-ask-user-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block my-2' },
  template: `
    <fieldset
      data-testid="ask-user-block"
      [attr.data-variant]="variant()"
      [disabled]="question().answered"
      class="m-0 border-0 p-0"
      [class]="
        question().answered
          ? 'rounded border border-[var(--violet)]/20 bg-[var(--bg-1)] p-4 opacity-80'
          : 'rounded border border-[var(--violet)]/40 bg-[var(--violet)]/[0.06] p-4'
      "
    >
      <legend
        data-testid="ask-legend"
        class="mono mb-2 px-0 text-[11px]"
        [class]="question().answered ? 'text-[var(--violet)]/70' : 'text-[var(--violet)]'"
        [class.sr-only]="legendHidden()"
      >
        {{ legendText() }}
      </legend>

      <div
        data-testid="ask-question"
        class="mb-3"
        [class]="
          question().answered
            ? 'text-[13px] text-[var(--ink-dim)]'
            : 'text-[14px] text-[var(--ink)]'
        "
      >
        {{ question().question }}
      </div>

      @if (question().answered) {
        <div data-testid="ask-answered" class="flex flex-wrap gap-1.5">
          @for (val of question().selected_values; track val) {
            <span
              data-testid="selected-option"
              class="mono inline-block rounded border border-[var(--violet)]/50 bg-[var(--violet)]/15 px-2 py-0.5 text-[11px] text-[var(--ink)]"
            >
              {{ val }}
            </span>
          }
        </div>
      } @else {
        @if (question().options.length > 0) {
          <div
            class="flex flex-wrap gap-2"
            role="group"
            [attr.aria-label]="question().multi_select ? 'Select any options' : 'Select one option'"
          >
            @for (option of question().options; track option.value) {
              <button
                type="button"
                data-testid="ask-option-btn"
                class="mono rounded border px-3 py-1 text-[12px] transition-colors"
                [class]="
                  isSelected(option.value)
                    ? 'border-[var(--violet)] bg-[var(--violet)]/20 text-[var(--ink)]'
                    : 'border-[var(--line-strong)] bg-[var(--bg-2)] text-[var(--ink-dim)] hover:border-[var(--violet)]'
                "
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
            <input
              data-testid="ask-input"
              type="text"
              [id]="freeformId"
              class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-1 text-[12px] text-[var(--ink)] placeholder-[var(--ink-mute)] focus:outline-none"
              [class]="freeformSilenced() ? 'border-[var(--line-strong)] opacity-50' : ''"
              placeholder="or type your own answer..."
              [value]="freeformText()"
              (input)="onFreeformInput($event)"
              (keydown.enter)="onFreeformEnter($event)"
            />
            @if (freeformSilenced()) {
              <span
                data-testid="ask-freeform-hint"
                class="mono mt-1 block text-[11px] text-[var(--ink-mute)]"
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
            class="mono rounded bg-[var(--accent)] px-3 py-1 text-[12px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
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
  /** The AskUserQuestion payload rendered by this prompt. */
  readonly question = input.required<AskUserQuestionBlock>();

  readonly answered = output<{ toolId: string; values: string[] }>();

  /** Selected option values, tracked reactively for efficient template updates. */
  readonly selected = signal<ReadonlySet<string>>(new Set());

  /** Freeform textarea content. */
  readonly freeformText = signal<string>('');

  /** DOM id for label-input association on the freeform textarea. */
  readonly freeformId = `ask-freeform-${Math.random().toString(36).slice(2, 9)}`;

  /** Variant key used as a data attribute and drives some visual decisions. */
  readonly variant = computed<'multi' | 'single-freeform' | 'freeform' | 'answered'>(() => {
    const q = this.question();
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
    const q = this.question();
    if (q?.answered) return false;
    if (this.selected().size > 0) return true;
    if (this.allowFreeform() && this.freeformText().trim().length > 0) return true;
    return false;
  });

  /** Send button label — shows a count for multi-select with any selection. */
  readonly sendLabel = computed(() => {
    const q = this.question();
    if (q?.multi_select) {
      const count = this.selected().size;
      return count > 0 ? `confirm (${count})` : 'confirm';
    }
    return 'send';
  });

  /** Legend text: either the provided header, a fallback, or an answered indicator. */
  readonly legendText = computed(() => {
    const q = this.question();
    if (!q) return '';
    if (q.answered) return '✓ answered';
    if (q.header) return q.header;
    return q.multi_select ? '? question · select any' : '? question · pick one or type';
  });

  /** Hide the legend visually when there's nothing meaningful to render (screen readers still get it). */
  readonly legendHidden = computed(() => {
    const q = this.question();
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
    if (this.question().answered) return;
    this.selected.update((prev) => {
      const next = new Set(prev);
      if (this.question().multi_select) {
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
    if (this.question().answered) return;
    const values = [...this.selected()];
    if (values.length > 0) {
      this.answered.emit({ toolId: this.question().tool_id, values });
      return;
    }
    const trimmed = this.freeformText().trim();
    if (trimmed.length > 0) {
      this.answered.emit({ toolId: this.question().tool_id, values: [trimmed] });
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
