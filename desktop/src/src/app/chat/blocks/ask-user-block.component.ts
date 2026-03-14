import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import type { AskUserQuestionBlock } from '../../models/chat';

/** Renders an interactive question prompt from Claude, with option buttons or freeform input. */
@Component({
  selector: 'app-ask-user-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ask-user-block">
      @if (question.header) {
        <div class="ask-header">{{ question.header }}</div>
      }
      <div class="ask-question">{{ question.question }}</div>
      @if (question.answered) {
        <div class="ask-answered">
          @for (val of question.selected_values; track val) {
            <span class="selected-option">{{ val }}</span>
          }
        </div>
      } @else {
        @if (question.options.length > 0) {
          <div class="ask-options">
            @for (option of question.options; track option.value) {
              <button
                class="ask-option-btn"
                [class.selected]="isSelected(option.value)"
                (click)="toggleOption(option.value)"
              >
                {{ option.label }}
              </button>
            }
          </div>
          <div class="ask-actions">
            <button
              class="ask-submit-btn"
              [disabled]="pendingSelection.length === 0"
              (click)="submit()"
            >
              Confirm
            </button>
            <span class="ask-or">or</span>
            <div class="ask-freeform">
              <input
                class="ask-input"
                placeholder="Type your own answer..."
                (keydown.enter)="submitFreeform($event)"
                #freeformInput
              />
              <button class="ask-submit-btn" (click)="submitFreeformFromInput(freeformInput)">
                Send
              </button>
            </div>
          </div>
        } @else {
          <div class="ask-freeform">
            <input
              class="ask-input"
              placeholder="Type your answer..."
              (keydown.enter)="submitFreeform($event)"
              #freeformInput
            />
            <button class="ask-submit-btn" (click)="submitFreeformFromInput(freeformInput)">
              Send
            </button>
          </div>
        }
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      margin: 8px 0;
    }
    .ask-user-block {
      background: #1a1a3e;
      border: 1px solid #7c3aed;
      border-radius: 6px;
      padding: 12px;
    }
    .ask-header {
      font-weight: bold;
      color: #a78bfa;
      font-size: 13px;
      margin-bottom: 4px;
    }
    .ask-question {
      color: #e0e0e0;
      font-size: 14px;
      margin-bottom: 8px;
    }
    .ask-options {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
    }
    .ask-option-btn {
      background: #0f3460;
      color: #e0e0e0;
      border: 1px solid #1e3a6e;
      border-radius: 4px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 13px;
      transition:
        background 0.15s,
        border-color 0.15s;
    }
    .ask-option-btn:hover {
      background: #163d70;
      border-color: #7c3aed;
    }
    .ask-option-btn.selected {
      background: #7c3aed;
      border-color: #a78bfa;
      color: #fff;
    }
    .ask-submit-btn {
      background: #7c3aed;
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 6px 16px;
      cursor: pointer;
      font-size: 13px;
    }
    .ask-submit-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .ask-submit-btn:hover:not(:disabled) {
      background: #6d28d9;
    }
    .ask-answered {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .selected-option {
      background: #7c3aed;
      color: #fff;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 13px;
    }
    .ask-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .ask-or {
      color: #6b7280;
      font-size: 12px;
    }
    .ask-freeform {
      display: flex;
      gap: 8px;
      flex: 1;
      min-width: 150px;
    }
    .ask-input {
      flex: 1;
      background: #0d1b2a;
      color: #e0e0e0;
      border: 1px solid #1e3a6e;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 13px;
      outline: none;
    }
    .ask-input:focus {
      border-color: #7c3aed;
    }
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
