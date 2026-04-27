import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Loading indicator shown while a transcript is being fetched.
 * Mirrors the mockup (lines 935–939): mono "loading conversation history..."
 * label preceded by a refresh-style spin SVG inside a `border-[var(--line)]`
 * card.
 */
@Component({
  selector: 'app-chat-loading',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block my-2',
    role: 'status',
    'aria-live': 'polite',
  },
  template: `<div
    data-testid="chat-loading"
    class="mono flex items-center justify-center gap-2 rounded border border-[var(--line)] p-4 text-[12px] text-[var(--ink-mute)]"
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
    <span data-testid="chat-loading-label">{{ label() }}</span>
  </div>`,
})
export class ChatLoadingComponent {
  readonly label = input('loading conversation history...');
}
