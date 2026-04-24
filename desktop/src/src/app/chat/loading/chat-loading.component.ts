import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

/**
 * Renders a loading indicator for conversation history.
 *
 * Mockup: a thin card with the `.spin` animated SVG plus a mono label —
 * displayed while history is being fetched from disk or the container.
 * Uses the shared `.spin` keyframe defined in `styles.css` (never a second
 * spinner style, per the terminal-minimal design-system rules).
 *
 * Note on inputs: `@Input()` is used rather than signal-based `input()` to
 * stay compatible with the repo's vitest harness, which does not run the
 * Angular compiler plugin and therefore cannot resolve signal-input metadata.
 */
@Component({
  standalone: true,
  selector: 'app-chat-loading',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block my-2',
    role: 'status',
    'aria-live': 'polite',
  },
  template: `<div
    data-testid="chat-loading"
    class="mono flex items-center justify-center gap-2 rounded border border-line p-4 text-[12px] text-ink-dim"
  >
    <svg
      data-testid="chat-loading-spinner"
      class="spin h-3 w-3"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      stroke-width="2"
      aria-hidden="true"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 0 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 0 1-15.357-2m15.357 2H15"
      />
    </svg>
    <span data-testid="chat-loading-label">{{ label }}</span>
  </div>`,
})
export class ChatLoadingComponent {
  /** Accessible label shown next to the spinner. */
  @Input() label = 'Loading conversation history...';
}
