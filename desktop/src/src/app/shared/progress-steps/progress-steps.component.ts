import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SpinIconComponent } from '../spin-icon.component';

/** Lifecycle status of a single progress step. */
export type StepState = 'pending' | 'active' | 'done' | 'error';

/** A single step in a multi-step progress display. */
export interface SetupStep {
  id: string;
  title: string;
  description: string;
  status: StepState;
  detail?: string;
  /** 0-100 progress for an `active` step that exposes one. */
  progress?: number;
}

/**
 * Presentational component that renders a list of progress steps with status
 * circles, pills, an optional progress bar, an error banner with retry/back
 * controls, and an optional footer.
 *
 * Used by both the first-run setup wizard and the plugin install overlay.
 * The caller owns the step list and drives status transitions.
 */
@Component({
  selector: 'app-progress-steps',
  imports: [CommonModule, SpinIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="rounded border border-[var(--line)] bg-[var(--bg-1)]"
      data-testid="setup-steps"
    >
      @for (step of steps(); track step.id; let i = $index) {
        <div
          class="flex items-start gap-4 px-5 py-4"
          [style.borderBottom]="i < steps().length - 1 ? '1px solid var(--line)' : 'none'"
          [class.opacity-50]="step.status === 'pending'"
          data-testid="setup-step"
          [attr.data-status]="step.status"
        >
          <div
            class="mono flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-[11px]"
            [style.borderColor]="circleBorder(step)"
            [style.background]="circleBg(step)"
            [style.color]="circleColor(step)"
          >
            @switch (step.status) {
              @case ('done') {
                <span aria-hidden="true">✓</span>
              }
              @case ('active') {
                <app-spin-icon />
              }
              @case ('error') {
                <span aria-hidden="true">!</span>
              }
              @default {
                <span>{{ i + 1 }}</span>
              }
            }
          </div>
          <div class="flex-1">
            <div
              class="mono flex items-center gap-2 text-[13px]"
              [style.color]="step.status === 'pending' ? 'var(--ink-dim)' : 'var(--ink)'"
            >
              <span data-testid="step-title">{{ step.title }}</span>
              @if (step.status === 'done') {
                <span class="pill green" data-testid="step-pill">done</span>
              }
              @if (step.status === 'active') {
                <span class="pill amber" data-testid="step-pill">running</span>
              }
              @if (step.status === 'error') {
                <span
                  class="pill"
                  style="color: #f87171; border-color: rgba(239, 68, 68, 0.4);"
                  data-testid="step-pill"
                  >error</span
                >
              }
            </div>
            <div
              class="mono mt-0.5 text-[11px] text-[var(--ink-mute)]"
              data-testid="step-detail"
            >
              {{ step.detail || step.description }}
            </div>
            @if (step.status === 'active' && step.progress !== undefined) {
              <div class="mono mt-2 h-1 w-full overflow-hidden rounded bg-[var(--bg-2)]">
                <div
                  class="h-full bg-[var(--accent)]"
                  [style.width.%]="step.progress"
                ></div>
              </div>
            }
          </div>
        </div>
      }
    </div>

    @if (error()) {
      <div
        class="mt-4 rounded ring-1 ring-red-500/40 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-300 mono"
        data-testid="setup-error"
        role="alert"
      >
        {{ error() }}
      </div>
      <div class="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          class="mono rounded border border-[var(--accent-dim)] bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90"
          data-testid="setup-retry-btn"
          (click)="retry.emit()"
        >
          $ retry
        </button>
        @if (showBackButton()) {
          <button
            type="button"
            class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
            data-testid="setup-back-btn"
            (click)="back.emit()"
          >
            ← back
          </button>
        }
      </div>
    }

    @if (showFooter()) {
      <div class="mono mt-4 text-[11px] text-[var(--ink-mute)]" data-testid="setup-footer">
        <span data-testid="setup-progress-summary">
          step {{ currentStepNumber() }} of {{ totalSteps() }}@if (etaSeconds() !== null) {
            <span> · ~{{ etaSeconds() }}s remaining</span>
          }
        </span>
      </div>
    }
  `,
})
export class ProgressStepsComponent {
  /** Steps to render (caller-owned). */
  readonly steps = input.required<readonly SetupStep[]>();
  /** Error message rendered under the step list; `null` hides the banner. */
  readonly error = input<string | null>(null);
  /** Total ETA in seconds. When `null`, the footer omits "~Ns remaining". */
  readonly etaSeconds = input<number | null>(null);
  /** Whether to render the footer ("step X of Y · ~Ns remaining"). */
  readonly showFooter = input<boolean>(true);
  /** Whether to render the "back" button inside the error banner. */
  readonly showBackButton = input<boolean>(true);

  /** Emitted when the user clicks the "$ retry" button. */
  readonly retry = output<void>();
  /** Emitted when the user clicks the "← back" button. */
  readonly back = output<void>();

  /** Total number of steps. */
  readonly totalSteps = computed<number>(() => this.steps().length);

  /** Step number (1-based) currently in progress, or the first error/pending. */
  readonly currentStepNumber = computed<number>(() => {
    const list = this.steps();
    const idx = list.findIndex((s) => s.status === 'active');
    if (idx >= 0) return idx + 1;
    const errIdx = list.findIndex((s) => s.status === 'error');
    if (errIdx >= 0) return errIdx + 1;
    const pendingIdx = list.findIndex((s) => s.status === 'pending');
    if (pendingIdx >= 0) return pendingIdx + 1;
    return list.length;
  });

  /**
   * Status circle — border colour.
   * @param step Step whose status drives the colour.
   */
  protected circleBorder(step: SetupStep): string {
    if (step.status === 'done') return 'rgba(52, 211, 153, 0.3)';
    if (step.status === 'active') return 'var(--accent-dim)';
    if (step.status === 'error') return 'rgba(239, 68, 68, 0.5)';
    return 'var(--line)';
  }

  /**
   * Status circle — background fill.
   * @param step Step whose status drives the fill colour.
   */
  protected circleBg(step: SetupStep): string {
    if (step.status === 'done') return 'rgba(52, 211, 153, 0.1)';
    if (step.status === 'active') return 'var(--accent-soft)';
    if (step.status === 'error') return 'rgba(239, 68, 68, 0.1)';
    return 'transparent';
  }

  /**
   * Status circle — text/icon colour.
   * @param step Step whose status drives the foreground colour.
   */
  protected circleColor(step: SetupStep): string {
    if (step.status === 'done') return 'var(--green)';
    if (step.status === 'active') return 'var(--accent)';
    if (step.status === 'error') return '#f87171';
    return 'var(--ink-mute)';
  }
}
