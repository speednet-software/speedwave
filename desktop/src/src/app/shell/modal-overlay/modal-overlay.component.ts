import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

/** Color family applied to the kicker line above the title. */
export type ModalKickerColor = 'amber' | 'green' | 'red' | 'accent';

/** Border color around the modal box — `red` is reserved for failure dialogs. */
export type ModalBorderColor = 'default' | 'red';

/**
 * Generic modal-overlay shell — backdrop + centered card + title/body/actions.
 *
 * Used by the shell to surface the restart-required, update-available, and
 * system-check-failed dialogs from the mockup (lines 1904-1952). All copy and
 * action handlers come from the parent via inputs/outputs; this component owns
 * only the visual chrome plus the backdrop dismissal contract.
 */
@Component({
  selector: 'app-modal-overlay',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div
        class="fixed inset-0 z-[900] flex items-center justify-center bg-black/75 backdrop-blur-sm"
        role="alertdialog"
        aria-modal="true"
        tabindex="-1"
        [attr.aria-label]="title()"
        [attr.data-testid]="testId()"
        (click)="onBackdropClick($event)"
        (keydown.escape)="closed.emit()"
      >
        <div
          class="rounded p-5 bg-[var(--bg-1)]"
          role="document"
          [class]="boxClasses()"
          (click)="onCardClick($event)"
          (keydown)="onCardKeydown($event)"
        >
          <div class="mono text-[11px] uppercase tracking-widest" [class]="kickerClasses()">
            {{ kicker() }}
          </div>
          <h3 class="view-title mt-1 text-[16px] text-[var(--ink)]" data-testid="modal-title">
            {{ title() }}
          </h3>
          @if (body()) {
            <p
              class="mt-2 text-[13px] leading-relaxed text-[var(--ink-dim)]"
              data-testid="modal-body"
            >
              {{ body() }}
            </p>
          }
          @if (code()) {
            <pre
              class="mono mt-3 overflow-x-auto rounded border border-red-500/20 bg-red-500/5 p-3 text-[11px] text-red-200"
              data-testid="modal-code"
              >{{ code() }}</pre
            >
          }
          @if (note()) {
            <div
              class="mono mt-3 rounded border border-[var(--line)] bg-[var(--bg)] p-2 text-[11px] text-[var(--ink-mute)]"
              data-testid="modal-note"
            >
              {{ note() }}
            </div>
          }
          @if (inlineError()) {
            <div
              class="mono mt-3 rounded border border-red-500/30 bg-red-500/5 p-2 text-[11.5px] text-red-300"
              [attr.data-testid]="inlineErrorTestId()"
            >
              {{ inlineError() }}
            </div>
          }
          <div class="mt-4 flex justify-end gap-2">
            <button
              type="button"
              class="mono rounded border border-[var(--line)] px-3 py-1 text-[12px] text-[var(--ink-dim)] hover:text-[var(--ink)]"
              [attr.data-testid]="secondaryTestId()"
              (click)="secondary.emit()"
            >
              {{ secondaryLabel() }}
            </button>
            <button
              type="button"
              class="mono rounded px-3 py-1 text-[12px] font-medium hover:opacity-90"
              [class]="primaryClasses()"
              [attr.data-testid]="primaryTestId()"
              (click)="primary.emit()"
            >
              {{ primaryLabel() }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ModalOverlayComponent {
  /** Whether the modal is visible. */
  readonly open = input.required<boolean>();
  /** Small uppercase line above the title — e.g. "⚠ restart required". */
  readonly kicker = input.required<string>();
  /** Color family applied to the kicker — picks one of the semantic palette tokens. */
  readonly kickerColor = input<ModalKickerColor>('accent');
  /** Title rendered with the view-title font/spacing. */
  readonly title = input.required<string>();
  /** Body paragraph; pass an empty string to hide the paragraph entirely. */
  readonly body = input<string>('');
  /** Optional pre-formatted block (e.g. stderr trace) inside a red callout. */
  readonly code = input<string>('');
  /** Optional mono inset bar (e.g. "estimated: ~8s · lima keeps running"). */
  readonly note = input<string>('');
  /** Optional inline error message rendered above the action buttons in red. */
  readonly inlineError = input<string>('');
  /** `data-testid` for the inline error message — defaults to `modal-error`. */
  readonly inlineErrorTestId = input<string>('modal-error');
  /** Border color around the modal box — `red` is reserved for failure dialogs. */
  readonly borderColor = input<ModalBorderColor>('default');
  /** Label for the primary (right-side) button. */
  readonly primaryLabel = input.required<string>();
  /** Label for the secondary (left-side) button — mockup default is "later". */
  readonly secondaryLabel = input<string>('later');
  /** Optional `data-testid` for E2E tests targeting a specific overlay. */
  readonly testId = input<string>('modal-overlay');
  /** `data-testid` for the primary button — defaults to `modal-primary`. */
  readonly primaryTestId = input<string>('modal-primary');
  /** `data-testid` for the secondary button — defaults to `modal-secondary`. */
  readonly secondaryTestId = input<string>('modal-secondary');

  /** Emitted when the primary button is clicked. */
  readonly primary = output<void>();
  /** Emitted when the secondary button is clicked. */
  readonly secondary = output<void>();
  /** Emitted when the backdrop (not the inner card) is clicked. */
  readonly closed = output<void>();

  /** CSS classes for the kicker text — picks a semantic color from the palette. */
  readonly kickerClasses = computed(() => {
    switch (this.kickerColor()) {
      case 'amber':
        return 'text-[var(--amber)]';
      case 'green':
        return 'text-[var(--green)]';
      case 'red':
        return 'text-red-400';
      default:
        return 'text-[var(--accent)]';
    }
  });

  /** Modal box classes — width + accent vs. red border. */
  readonly boxClasses = computed(() => {
    const widthClass =
      this.borderColor() === 'red'
        ? 'w-[min(480px,calc(100vw-2rem))]'
        : 'w-[min(24rem,calc(100vw-2rem))]';
    const borderClass =
      this.borderColor() === 'red'
        ? 'border border-red-500/30'
        : 'border border-[var(--line-strong)]';
    return `${widthClass} ${borderClass}`;
  });

  /** Primary button classes — red for failures, accent otherwise. */
  readonly primaryClasses = computed(() => {
    if (this.borderColor() === 'red') {
      return 'border border-red-500/50 bg-red-500/10 text-red-300 hover:bg-red-500/20';
    }
    return 'bg-[var(--accent)] text-[var(--on-accent)]';
  });

  /**
   * Closes the overlay when the backdrop (not the inner card) is clicked.
   * @param event - Mouse click event from the backdrop element.
   */
  onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.closed.emit();
    }
  }

  /**
   * Stops a click on the inner card from bubbling to the backdrop and
   * closing the overlay. Always silent — the buttons own their own actions.
   * @param event - Mouse click event from inside the modal card.
   */
  onCardClick(event: MouseEvent): void {
    event.stopPropagation();
  }

  /**
   * No-op keyboard handler attached to the modal card so the
   * `click-events-have-key-events` accessibility lint rule is satisfied —
   * actual focusable controls (buttons) live inside the card.
   * @param event - Keyboard event from inside the modal card; intentionally
   *   ignored.
   */
  onCardKeydown(event: KeyboardEvent): void {
    // Intentionally ignored — the inner buttons own their own keyboard
    // handling. Reading the parameter prevents the no-unused-vars rule.
    void event;
  }
}
