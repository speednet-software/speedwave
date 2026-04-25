import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  signal,
} from '@angular/core';
import type { ErrorBlockKind } from '../../models/chat';

/** Visual shape for an error block — drives which CSS classes get applied. */
type ErrorShape = 'red-timeline' | 'gray-timeline' | 'amber-callout';

/** Metadata table keyed by error kind: single source of truth for label and shape. */
const ERROR_META: Record<ErrorBlockKind, { shape: ErrorShape; label: string; action?: string }> = {
  rate_limit: { shape: 'red-timeline', label: '⚠ rate_limit' },
  network: { shape: 'red-timeline', label: '⚠ network_error' },
  session_exited: { shape: 'red-timeline', label: '⚠ session_exited' },
  broken_pipe: { shape: 'red-timeline', label: '⚠ broken_pipe' },
  generic: { shape: 'red-timeline', label: '⚠ error' },
  stopped_by_user: { shape: 'gray-timeline', label: '■ stopped by user' },
  no_active_project: {
    shape: 'amber-callout',
    label: 'no active project',
    action: 'switch project',
  },
  session_starting: {
    shape: 'amber-callout',
    label: 'session starting',
    action: 'retry',
  },
  auth_required: {
    shape: 'amber-callout',
    label: 'auth required',
    action: 'open settings',
  },
};

/** Renders a chat error in one of three shapes: red timeline (passive), amber callout (actionable), gray timeline (muted). */
@Component({
  selector: 'app-error-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block my-2' },
  styles: [
    `
      :host {
        display: block;
      }
      .err-timeline {
        border-left-width: 2px;
        border-left-style: solid;
        padding-left: 1rem;
      }
      .err-timeline-red {
        border-left-color: color-mix(in oklab, #ef4444 50%, transparent);
        color: #fca5a5;
      }
      .err-timeline-red .err-label {
        color: #f87171;
      }
      .err-timeline-gray {
        border-left-color: color-mix(in oklab, var(--ink-mute, #707a96) 50%, transparent);
        color: var(--ink-mute, #707a96);
      }
      .err-timeline-gray .err-label {
        color: var(--ink-dim, #9aa3ba);
      }
      .err-callout {
        border-radius: 0.25rem;
        box-shadow: 0 0 0 1px color-mix(in oklab, var(--amber, #f5b942) 40%, transparent);
        background-color: color-mix(in oklab, var(--amber, #f5b942) 6%, transparent);
        padding: 0.75rem;
        color: var(--amber, #f5b942);
      }
      .err-action-link {
        color: var(--accent, #ff4d6d);
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
      }
      .err-action-link:hover {
        text-decoration: underline;
      }
    `,
  ],
  template: `
    <div
      data-testid="error-block"
      role="alert"
      [attr.aria-live]="isCallout() ? 'assertive' : 'polite'"
      [attr.data-kind]="kind"
      [class.err-timeline]="isTimeline()"
      [class.err-timeline-red]="isRedTimeline()"
      [class.err-timeline-gray]="isStopped()"
      [class.err-callout]="isCallout()"
    >
      <div class="mono flex items-center gap-2 text-[12.5px]">
        <span data-testid="error-label" class="err-label font-medium">
          {{ label() }}
        </span>
        <span data-testid="error-content" class="min-w-0 break-words">{{ content }}</span>
        @if (isCallout()) {
          <button
            type="button"
            data-testid="error-action"
            class="err-action-link ml-2 mono text-[12.5px]"
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
  @Input({ required: true }) content!: string;

  /**
   * Public accessor for the current kind — used by tests and template bindings.
   * Angular's change-detection invalidates `computed()` signals when upstream
   * `signal()` sources change; the `_kind` signal below is the real source of truth.
   */
  get kind(): ErrorBlockKind {
    return this._kind();
  }
  /**
   * Sets the error kind; normalises missing/invalid values to `'generic'`
   * so callers may pass `undefined` without a crash.
   * @param value - Discriminator driving both shape and label.
   */
  @Input()
  set kind(value: ErrorBlockKind) {
    this._kind.set(value ?? 'generic');
  }

  /** Parent can listen for user clicks on the inline action button. */
  @Output() actioned = new EventEmitter<void>();

  /** Internal source-of-truth signal backing the `kind` setter for reactive computeds. */
  private readonly _kind = signal<ErrorBlockKind>('generic');

  /** Metadata lookup for the current kind — single source of truth for label/shape/action. */
  private readonly meta = computed(() => ERROR_META[this._kind()]);

  /** Passive failures render as red timeline events. */
  readonly isRedTimeline = computed(() => this.meta().shape === 'red-timeline');

  /** "stopped by user" renders as a muted gray timeline event. */
  readonly isStopped = computed(() => this.meta().shape === 'gray-timeline');

  /** Actionable amber callouts for operator-recoverable states. */
  readonly isCallout = computed(() => this.meta().shape === 'amber-callout');

  /** True when either timeline variant applies. */
  readonly isTimeline = computed(() => this.isRedTimeline() || this.isStopped());

  /** Short mono label shown before the content string (e.g. "⚠ rate_limit"). */
  readonly label = computed<string>(() => this.meta().label);

  /** Action button label — matches mockup wording for each actionable kind. */
  readonly actionLabel = computed<string>(() => this.meta().action ?? 'action');

  /** Forwards the user's click on the inline action button to the parent. */
  onAction(): void {
    this.actioned.emit();
  }
}
