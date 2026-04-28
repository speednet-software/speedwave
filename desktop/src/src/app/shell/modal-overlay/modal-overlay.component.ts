import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  TemplateRef,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  output,
} from '@angular/core';
import { Dialog, DialogRef } from '@angular/cdk/dialog';

/** Color family applied to the kicker line above the title. */
export type ModalKickerColor = 'amber' | 'green' | 'red' | 'accent';

/** Border color around the modal box — `red` is reserved for failure dialogs. */
export type ModalBorderColor = 'default' | 'red';

/**
 * Generic modal-overlay shell — backdrop + centered card + title/body/actions.
 *
 * Used by the shell to surface the restart-required, update-available, and
 * system-check-failed dialogs from the mockup (lines 1904-1952). All copy and
 * action handlers come from the parent via inputs/outputs; this component
 * delegates positioning, backdrop, focus trap, and Esc handling to the CDK
 * `Dialog` service so we never re-implement those primitives ourselves.
 */
@Component({
  selector: 'app-modal-overlay',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #content>
      <div
        class="rounded p-5 bg-[var(--bg-1)]"
        role="document"
        [class]="boxClasses()"
        [attr.data-testid]="testId()"
      >
        <div class="mono text-[11px] uppercase tracking-widest" [class]="kickerClasses()">
          {{ kicker() }}
        </div>
        <h3 class="view-title view-title-section mt-1 text-[var(--ink)]" data-testid="modal-title">
          {{ modalTitle() }}
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
            class="mono mt-3 break-all rounded border border-[var(--line)] bg-[var(--bg)] p-2 text-[11px] text-[var(--ink-mute)]"
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
    </ng-template>
  `,
})
export class ModalOverlayComponent {
  /** Whether the modal is visible. */
  readonly open = input.required<boolean>();
  /** Small uppercase line above the title — e.g. "⚠ restart required". */
  readonly kicker = input.required<string>();
  /** Color family applied to the kicker — picks one of the semantic palette tokens. */
  readonly kickerColor = input<ModalKickerColor>('accent');
  /**
   * Title rendered with the view-title font/spacing. Renamed from `title` to
   * avoid the HTML `title` attribute collision (which would surface as a
   * native browser tooltip on the host element).
   */
  readonly modalTitle = input.required<string>();
  /** Body paragraph; pass an empty string to hide the paragraph entirely. */
  readonly body = input<string>('');
  /** Optional pre-formatted block (e.g. stderr trace) inside a red callout. */
  readonly code = input<string>('');
  /** Optional mono inset bar for a short auxiliary note (estimates, hints). */
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
  /** Emitted when the dialog closes via backdrop, Esc, or programmatic close. */
  readonly closed = output<void>();

  @ViewChild('content', { static: true })
  private readonly content!: TemplateRef<unknown>;

  private readonly dialog = inject(Dialog);
  private dialogRef: DialogRef<unknown, unknown> | null = null;

  /**
   * True while the host is closing the dialog because `open()` flipped
   * to false. Used to suppress the `closed` output that the dialog's own
   * `closed` subscription would otherwise fire (which would echo right back
   * to the parent that already knows).
   */
  private closingProgrammatically = false;

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
   * Wires the dialog lifecycle to the `open()` input — opens/closes the
   * CDK dialog as the input toggles, and tears down on host destroy.
   */
  constructor() {
    // Sync dialog open/closed state with the `open()` input. CDK Dialog handles
    // the backdrop click, Esc key, and focus trap entirely on its own.
    effect(() => {
      const isOpen = this.open();
      if (isOpen) this.openDialog();
      else this.closeDialog();
    });

    // Ensure the dialog is torn down if the host component is destroyed
    // mid-flight (e.g. parent collapses the surrounding `@if`).
    inject(DestroyRef).onDestroy(() => this.closeDialog());
  }

  private openDialog(): void {
    if (this.dialogRef) return;
    const ref = this.dialog.open(this.content, {
      hasBackdrop: true,
      ariaLabel: this.modalTitle(),
      panelClass: 'modal-overlay-panel',
      disableClose: false,
    });
    this.dialogRef = ref;
    ref.closed.subscribe(() => {
      this.dialogRef = null;
      if (!this.closingProgrammatically) {
        this.closed.emit();
      }
      this.closingProgrammatically = false;
    });
  }

  private closeDialog(): void {
    if (!this.dialogRef) return;
    this.closingProgrammatically = true;
    this.dialogRef.close();
    this.dialogRef = null;
  }
}
