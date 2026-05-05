import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import type { AskUserQuestionBlock, AskUserQuestionItem } from '../../models/chat';

/**
 * Interactive AskUserQuestion prompt — supports 1–4 questions per block
 * Walks the user through each question sequentially: only the
 * `current_index` slot is interactive; previously-answered slots are locked
 * and show their chosen-label badge.
 *
 * Pure Tailwind — no inline `<style>` blocks. Emits `answered` once per
 * confirmation with the per-slot value (multi-select labels joined with
 * `, ` per the SDK contract).
 */
@Component({
  selector: 'app-ask-user-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block my-2' },
  template: `
    @for (q of question().questions; let i = $index; track i) {
      @let locked = i < question().current_index;
      @let active = i === question().current_index;
      @if (locked || active) {
        <fieldset
          [attr.data-testid]="locked ? 'ask-user-block-locked' : 'ask-user-block'"
          [attr.data-variant]="locked ? null : variant()"
          [attr.data-slot-index]="i"
          [disabled]="locked"
          [class]="
            locked
              ? 'm-0 mb-2 rounded border border-[var(--violet)]/20 bg-[var(--bg-1)] p-4 opacity-80'
              : 'm-0 rounded border border-[var(--violet)]/40 bg-[var(--violet)]/[0.06] p-4'
          "
        >
          <legend
            data-testid="ask-legend"
            [class]="
              locked
                ? 'mono mb-2 px-0 text-[11px] text-[var(--violet)]/70'
                : 'mono mb-2 px-0 text-[11px] text-[var(--violet)]'
            "
            [class.sr-only]="!locked && legendHidden()"
          >
            {{ locked ? legendForLocked(q, i) : legendText() }}
          </legend>

          <div
            data-testid="ask-question"
            [class]="
              locked
                ? 'mb-3 text-[13px] text-[var(--ink-dim)]'
                : 'mb-3 text-[14px] text-[var(--ink)]'
            "
          >
            {{ q.question }}
          </div>

          @if (locked) {
            <div data-testid="ask-answered" class="flex flex-wrap gap-1.5">
              <span
                data-testid="selected-option"
                [attr.aria-pressed]="true"
                class="mono inline-block rounded border border-[var(--violet)]/50 bg-[var(--violet)]/15 px-2 py-0.5 text-[11px] text-[var(--ink)]"
              >
                {{ question().answers[i] ?? '' }}
              </span>
            </div>
          } @else {
            @if (q.options.length > 0) {
              <div
                class="flex flex-wrap gap-2"
                role="group"
                [attr.aria-label]="q.multi_select ? 'Select any options' : 'Select one option'"
              >
                @for (option of q.options; track option.value) {
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
      }
    }
  `,
})
export class AskUserBlockComponent {
  /** The composite AskUserQuestion payload rendered by this prompt. */
  readonly question = input.required<AskUserQuestionBlock>();

  readonly answered = output<{ toolId: string; questionIdx: number; value: string }>();

  /** Selected option values for the active question, tracked reactively. */
  readonly selected = signal<ReadonlySet<string>>(new Set());

  /** Freeform input content for the active question. */
  readonly freeformText = signal<string>('');

  /** DOM id for label-input association on the freeform textarea. */
  readonly freeformId = `ask-freeform-${Math.random().toString(36).slice(2, 9)}`;

  /** The active question, or `null` once every slot has been answered. */
  readonly activeQuestion = computed<AskUserQuestionItem | null>(() => {
    const q = this.question();
    const idx = q.current_index;
    if (idx < 0 || idx >= q.questions.length) return null;
    return q.questions[idx];
  });

  /**
   * Wires the per-input reset effect that clears `selected` and `freeformText`
   * whenever the parent reducer hands us a new `question()` block.
   */
  constructor() {
    // Reset transient input state whenever the parent reducer hands us a
    // new question() input. Lives in an effect (not a computed) because
    // Angular forbids signal writes inside computed(). Note: the
    // dependency is the entire `question()` input — any reducer-driven
    // replacement (which always happens via spread, not in-place mutation)
    // triggers the reset, not just `current_index` changes. That's
    // intentional: `selected` and `freeformText` are scoped to the active
    // slot, so a fresh block reference means a fresh slot to clear.
    effect(() => {
      void this.question();
      this.selected.set(new Set());
      this.freeformText.set('');
    });
  }

  /**
   * Shared "question N of M · " prefix for legends; empty for 1-question blocks.
   * @param idx Zero-based index of the question whose legend is being rendered.
   */
  private progressPrefix(idx: number): string {
    const total = this.question().questions.length;
    return total > 1 ? `question ${idx + 1} of ${total} · ` : '';
  }

  /** Variant key used as a data attribute and drives some visual decisions. */
  readonly variant = computed<'multi' | 'single-freeform' | 'freeform'>(() => {
    const q = this.activeQuestion();
    if (!q) return 'freeform';
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
    if (!this.activeQuestion()) return false;
    if (this.selected().size > 0) return true;
    if (this.allowFreeform() && this.freeformText().trim().length > 0) return true;
    return false;
  });

  /** Send button label — shows a count for multi-select with any selection. */
  readonly sendLabel = computed(() => {
    const q = this.activeQuestion();
    if (q?.multi_select) {
      const count = this.selected().size;
      return count > 0 ? `confirm (${count})` : 'confirm';
    }
    return 'send';
  });

  /** Legend text: provided header, fallback, or progress hint for multi-question blocks. */
  readonly legendText = computed(() => {
    const q = this.activeQuestion();
    if (!q) return '';
    const progress = this.progressPrefix(this.question().current_index);
    if (q.header) return `${progress}${q.header}`;
    return q.multi_select
      ? `${progress}? question · select any`
      : `${progress}? question · pick one or type`;
  });

  /** Hide the legend visually when there's nothing meaningful to render (screen readers still get it). */
  readonly legendHidden = computed(() => {
    const q = this.activeQuestion();
    if (!q) return true;
    const block = this.question();
    if (block.questions.length > 1) return false;
    return !q.header && q.options.length === 0 && !q.multi_select;
  });

  /**
   * Legend rendered for previously-answered (locked) slots.
   * @param q The already-answered question item.
   * @param i Zero-based index of the locked slot in the questions array.
   */
  legendForLocked(q: AskUserQuestionItem, i: number): string {
    return `${this.progressPrefix(i)}✓ answered${q.header ? ` · ${q.header}` : ''}`;
  }

  /**
   * Checks whether a given option value is currently selected for the
   * active question.
   * @param value Option value to test against the active selection set.
   */
  isSelected(value: string): boolean {
    return this.selected().has(value);
  }

  /**
   * Toggles selection of an option value (single or multi-select) for the
   * active question.
   * @param value Option value to add or remove from the active selection set.
   */
  toggleOption(value: string): void {
    const q = this.activeQuestion();
    if (!q) return;
    this.selected.update((prev) => {
      const next = new Set(prev);
      if (q.multi_select) {
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

  /**
   * Emits the user's answer for the active question. For multi-select the
   * chosen labels are joined with `", "` per the Agent SDK contract.
   * Selection wins over freeform when both are populated.
   */
  submit(): void {
    const q = this.activeQuestion();
    if (!q) return;
    const block = this.question();
    const idx = block.current_index;

    const selected = [...this.selected()];
    if (selected.length > 0) {
      const labels = q.options.filter((o) => selected.includes(o.value)).map((o) => o.label);
      const value = q.multi_select ? labels.join(', ') : (labels[0] ?? selected[0]!);
      this.answered.emit({ toolId: block.tool_id, questionIdx: idx, value });
      return;
    }
    const trimmed = this.freeformText().trim();
    if (trimmed.length > 0) {
      this.answered.emit({ toolId: block.tool_id, questionIdx: idx, value: trimmed });
    }
  }

  /**
   * Stores the input value on each input event for the active question.
   * @param event DOM input event whose target carries the latest text value.
   */
  onFreeformInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.freeformText.set(target?.value ?? '');
  }

  /**
   * Submits on Enter (without Shift) for a keyboard-friendly workflow.
   * @param event Keyboard event triggered by the Enter keypress on the freeform input.
   */
  onFreeformEnter(event: Event): void {
    const ke = event as KeyboardEvent;
    if (ke.shiftKey) return;
    event.preventDefault();
    this.submit();
  }
}
