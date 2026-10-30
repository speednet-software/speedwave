import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { ChatTabRow } from './chat-tab-row';

/**
 * A chat tab's dot, title and `ended` badge. The dot pulses while the tab streams and stays solid
 * (red for an error) while the tab holds an unseen session event, whose title is also bold.
 */
@Component({
  selector: 'app-chat-tab-label',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-1 items-center gap-1.5' },
  template: `
    @if (row().streaming) {
      <span
        class="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-[var(--accent)]"
        data-testid="chat-tab-streaming"
        aria-hidden="true"
      ></span>
    } @else if (row().unseen; as unseen) {
      <span
        class="h-1.5 w-1.5 flex-shrink-0 rounded-full"
        [class]="unseen === 'session_error' ? 'bg-[var(--red)]' : 'bg-[var(--accent)]'"
        data-testid="chat-tab-unseen"
        [attr.data-kind]="unseen"
        aria-hidden="true"
      ></span>
    }
    <span class="truncate text-[12px]" data-testid="chat-tab-title" [class]="titleClass()">
      {{ row().title }}
    </span>
    @if (row().ended) {
      <span class="pill flex-shrink-0" data-testid="chat-tab-ended">ended</span>
    }
  `,
})
export class ChatTabLabelComponent {
  /** The tab to show. */
  readonly row = input.required<ChatTabRow>();
  /** Full-contrast title without an unseen event (the active tab in the strip, every switcher row). */
  readonly emphasized = input(false);

  protected readonly titleClass = computed(() => {
    if (this.row().unseen) return 'font-bold text-[var(--ink)]';
    return this.emphasized() ? 'text-[var(--ink)]' : 'text-[var(--ink-mute)]';
  });
}
