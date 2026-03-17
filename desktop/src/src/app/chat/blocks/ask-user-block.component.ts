import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import type { AskUserQuestionBlock } from '../../models/chat';

/** Renders an interactive question prompt from Claude, with option buttons or freeform input. */
@Component({
  selector: 'app-ask-user-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block my-2' },
  template: `
    <div
      data-testid="ask-user-block"
      class="bg-sw-purple-bg border border-sw-purple rounded-md p-3"
    >
      @if (question.header) {
        <div data-testid="ask-header" class="font-bold text-sw-purple-light text-[13px] mb-1">
          {{ question.header }}
        </div>
      }
      <div data-testid="ask-question" class="text-sw-text text-sm mb-2">
        {{ question.question }}
      </div>
      @if (question.answered) {
        <div data-testid="ask-answered" class="flex flex-wrap gap-1.5">
          @for (val of question.selected_values; track val) {
            <span
              data-testid="selected-option"
              class="bg-sw-purple text-white px-2.5 py-1 rounded text-[13px]"
              >{{ val }}</span
            >
          }
        </div>
      } @else {
        @if (question.options.length > 0) {
          <div class="flex flex-wrap gap-2 mb-2">
            @for (option of question.options; track option.value) {
              <button
                data-testid="ask-option-btn"
                class="bg-sw-bg-navy text-sw-text border border-sw-btn-ask-border rounded px-3 py-1.5 cursor-pointer text-[13px] transition-[background,border-color] duration-150 hover:bg-sw-btn-ask hover:border-sw-purple"
                [class.!bg-sw-purple]="isSelected(option.value)"
                [class.!border-sw-purple-light]="isSelected(option.value)"
                [class.!text-white]="isSelected(option.value)"
                (click)="toggleOption(option.value)"
              >
                {{ option.label }}
              </button>
            }
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <button
              data-testid="ask-submit-btn"
              class="bg-sw-purple text-white border-none rounded px-4 py-1.5 cursor-pointer text-[13px] hover:bg-sw-purple-dark disabled:opacity-50 disabled:cursor-not-allowed"
              [disabled]="pendingSelection.length === 0"
              (click)="submit()"
            >
              Confirm
            </button>
            <span data-testid="ask-or" class="text-sw-code-gray text-xs">or</span>
            <div class="flex gap-2 flex-1 min-w-[150px]">
              <input
                data-testid="ask-input"
                class="flex-1 bg-sw-bg-abyss text-sw-text border border-sw-btn-ask-border rounded px-2.5 py-1.5 text-[13px] outline-none focus:border-sw-purple"
                placeholder="Type your own answer..."
                (keydown.enter)="submitFreeform($event)"
                #freeformInput
              />
              <button
                data-testid="ask-submit-btn"
                class="bg-sw-purple text-white border-none rounded px-4 py-1.5 cursor-pointer text-[13px] hover:bg-sw-purple-dark"
                (click)="submitFreeformFromInput(freeformInput)"
              >
                Send
              </button>
            </div>
          </div>
        } @else {
          <div class="flex gap-2 flex-1 min-w-[150px]">
            <input
              data-testid="ask-input"
              class="flex-1 bg-sw-bg-abyss text-sw-text border border-sw-btn-ask-border rounded px-2.5 py-1.5 text-[13px] outline-none focus:border-sw-purple"
              placeholder="Type your answer..."
              (keydown.enter)="submitFreeform($event)"
              #freeformInput
            />
            <button
              data-testid="ask-submit-btn"
              class="bg-sw-purple text-white border-none rounded px-4 py-1.5 cursor-pointer text-[13px] hover:bg-sw-purple-dark"
              (click)="submitFreeformFromInput(freeformInput)"
            >
              Send
            </button>
          </div>
        }
      }
    </div>
  `,
})
export class AskUserBlockComponent {
  @Input({ required: true }) question!: AskUserQuestionBlock;
  @Output() answered = new EventEmitter<string[]>();

  pendingSelection: string[] = [];

  /**
   * Checks whether a given option value is currently selected.
   * @param value - The option value to check.
   */
  isSelected(value: string): boolean {
    return this.pendingSelection.includes(value);
  }

  /**
   * Toggles selection of an option value (single or multi-select).
   * @param value - The option value to toggle.
   */
  toggleOption(value: string): void {
    if (this.question.answered) return;
    if (this.question.multi_select) {
      if (this.pendingSelection.includes(value)) {
        this.pendingSelection = this.pendingSelection.filter((v) => v !== value);
      } else {
        this.pendingSelection = [...this.pendingSelection, value];
      }
    } else {
      this.pendingSelection = [value];
    }
  }

  /** Submits the currently selected options. */
  submit(): void {
    if (this.pendingSelection.length === 0 || this.question.answered) return;
    this.answered.emit(this.pendingSelection);
  }

  /**
   * Submits a freeform answer from a keyboard event target.
   * @param event - The keyboard event whose target holds the input value.
   */
  submitFreeform(event: Event): void {
    this.submitValue((event.target as HTMLInputElement).value);
  }

  /**
   * Submits a freeform answer from a direct input element reference.
   * @param input - The HTML input element containing the freeform value.
   */
  submitFreeformFromInput(input: HTMLInputElement): void {
    this.submitValue(input.value);
  }

  /**
   * Validates and emits a trimmed freeform value.
   * @param value - The raw freeform input string.
   */
  private submitValue(value: string): void {
    const trimmed = value.trim();
    if (!trimmed || this.question.answered) return;
    this.answered.emit([trimmed]);
  }
}
