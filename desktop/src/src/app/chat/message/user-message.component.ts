import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { MessageBlock } from '../../models/chat';

/** User messages contain only text blocks; non-text blocks are filtered out at render time. */
@Component({
  selector: 'app-user-message',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div data-testid="user-message">
      <div class="mono mb-1 flex items-center gap-2 text-[11px] text-[var(--ink-mute,#888888)]">
        <span>user</span>
        @if (formattedTime()) {
          <span>·</span>
          <span data-testid="user-message-time">{{ formattedTime() }}</span>
        }
        @if (editedAt() !== undefined) {
          <span>·</span>
          <span data-testid="user-message-edited" class="text-[11px] text-[var(--ink-mute,#888888)]"
            >edited</span
          >
        }
      </div>
      <div
        data-testid="user-message-body"
        class="text-[14px] leading-[1.7] text-[var(--ink,#e0e0e0)]"
      >
        @for (block of textBlocks(); track $index) {
          <div>{{ block.content }}</div>
        }
      </div>
    </div>
  `,
})
export class UserMessageComponent {
  readonly blocks = input.required<readonly MessageBlock[]>();
  readonly editedAt = input<number | undefined>(undefined);
  readonly timestamp = input(0);

  /** Text-only view of blocks — user messages may only contain text. */
  readonly textBlocks = computed<readonly Extract<MessageBlock, { type: 'text' }>[]>(() =>
    this.blocks().filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
  );

  /** Formats `timestamp` as `HH:MM` local time; empty when zero (unknown sentinel). */
  readonly formattedTime = computed<string>(() => {
    const ts = this.timestamp();
    if (!ts) return '';
    const date = new Date(ts);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  });
}
