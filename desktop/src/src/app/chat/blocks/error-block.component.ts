import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { ErrorBlockKind } from '../../models/chat';

/** Visual shape for an error block — drives which Tailwind classes get applied. */
type ErrorShape = 'red-timeline' | 'gray-timeline' | 'amber-timeline';

/** Metadata table keyed by error kind: single source of truth for label and shape. */
const ERROR_META: Record<ErrorBlockKind, { shape: ErrorShape; label: string; action?: string }> = {
  rate_limit: { shape: 'red-timeline', label: '⚠ rate_limit' },
  network: { shape: 'red-timeline', label: '⚠ network_error' },
  session_exited: {
    shape: 'red-timeline',
    label: '⚠ session_exited',
    action: 'restart container',
  },
  broken_pipe: {
    shape: 'red-timeline',
    label: '⚠ broken_pipe',
    action: 'retry',
  },
  generic: { shape: 'red-timeline', label: '⚠ error' },
  stopped_by_user: { shape: 'gray-timeline', label: '■ stopped by user' },
  no_active_project: {
    shape: 'amber-timeline',
    label: 'no active project',
    action: 'switch project',
  },
  session_starting: {
    shape: 'amber-timeline',
    label: 'session starting',
    action: 'retry',
  },
  auth_required: {
    shape: 'amber-timeline',
    label: 'auth required',
    action: 'open settings',
  },
};

/**
 * Renders a chat error in one of three timeline shapes — red (failure), amber
 * (operator-recoverable), or muted gray (stopped by user). Mirrors the mockup
 * lines 861–910: every variant is `mono border-l-2 border-<color>/50 pl-4
 * text-[12.5px]` — NEVER a callout box. Pure Tailwind, no inline `<style>`.
 */
@Component({
  selector: 'app-error-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block my-2' },
  template: `
    <div
      data-testid="error-block"
      role="alert"
      [attr.aria-live]="isStopped() ? 'polite' : 'assertive'"
      [attr.data-kind]="kind()"
      class="mono pl-4 text-[12.5px] border-l-2"
      [class]="wrapperClass()"
    >
      <div class="flex items-center gap-2">
        <span data-testid="error-label" class="font-medium" [class]="labelClass()">
          {{ label() }}
        </span>
        <span data-testid="error-content" class="min-w-0 break-words">{{ content() }}</span>
        @if (actionLabel()) {
          <button
            type="button"
            data-testid="error-action"
            class="mono ml-2 text-[12.5px] text-[var(--accent)] hover:underline"
            (click)="onAction()"
          >
            {{ actionLabel() }} &rarr;
          </button>
        }
      </div>
    </div>
  `,
})
export class ErrorBlockComponent {
  /** Error message content displayed next to the kind label. */
  readonly content = input.required<string>();

  /**
   * Discriminator driving both shape and label. Missing/invalid values are
   * normalised to `'generic'` via `kindOrDefault()` so callers may pass
   * `undefined` without a crash.
   */
  readonly kind = input<ErrorBlockKind>('generic');

  /** Parent can listen for user clicks on the inline action button. */
  readonly actioned = output<void>();

  /** Resolved kind, never `undefined` — used by every downstream computed. */
  private readonly resolvedKind = computed<ErrorBlockKind>(() => this.kind() ?? 'generic');

  /** Metadata lookup for the current kind — single source of truth for label/shape/action. */
  private readonly meta = computed(() => ERROR_META[this.resolvedKind()]);

  /** Passive failures render as red timeline events. */
  readonly isRedTimeline = computed(() => this.meta().shape === 'red-timeline');

  /** "stopped by user" renders as a muted gray timeline event. */
  readonly isStopped = computed(() => this.meta().shape === 'gray-timeline');

  /** Operator-recoverable hints render as amber timeline events. */
  readonly isAmberTimeline = computed(() => this.meta().shape === 'amber-timeline');

  /**
   * Boolean accessor preserved for downstream callers that switched on
   * "is this a callout-shape error" — every actionable error is now an amber
   * timeline, so the flag aliases to `isAmberTimeline`.
   */
  readonly isCallout = computed(() => this.isAmberTimeline());

  /** True when any of the three timeline variants applies (always, post-rewrite). */
  readonly isTimeline = computed(
    () => this.isRedTimeline() || this.isStopped() || this.isAmberTimeline()
  );

  /** Short mono label shown before the content string (e.g. "⚠ rate_limit"). */
  readonly label = computed<string>(() => this.meta().label);

  /** Action button label — empty string hides the button when no action applies. */
  readonly actionLabel = computed<string>(() => this.meta().action ?? '');

  /** Tailwind classes for the wrapper border + foreground colour. */
  readonly wrapperClass = computed<string>(() => {
    if (this.isStopped()) {
      return 'border-[var(--ink-mute)]/50 text-[var(--ink-mute)]';
    }
    if (this.isAmberTimeline()) {
      return 'border-[var(--amber)]/50 text-[var(--amber)]';
    }
    return 'border-red-500/50 text-red-300';
  });

  /** Tailwind class for the leading label span. */
  readonly labelClass = computed<string>(() => {
    if (this.isStopped()) return 'text-[var(--ink-dim)]';
    if (this.isAmberTimeline()) return 'text-[var(--amber)]';
    return 'text-red-400';
  });

  /** Forwards the user's click on the inline action button to the parent. */
  onAction(): void {
    this.actioned.emit();
  }
}
