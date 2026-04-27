import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { MessageBlock } from '../../models/chat';

/** User messages contain only text blocks; non-text blocks are filtered out at render time. */
@Component({
  selector: 'app-user-message',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex justify-end' },
  template: `
    <!-- Right-aligned bubble (max 80% column width) so user turns sit on the
         opposite side of assistant turns — standard chat orientation. The
         "user · HH:MM" header was removed: identity is conveyed by alignment
         and the bubble background, and the timestamp duplicated info that
         already lived in the assistant's per-turn metadata row. The "edited"
         badge survives because it carries non-redundant signal. -->
    <div data-testid="user-message" class="max-w-[80%]">
      @if (editedAt() !== undefined) {
        <div
          class="mono mb-1 flex items-center justify-end gap-2 text-[11px] text-[var(--ink-mute,#888888)]"
        >
          <span data-testid="user-message-edited">edited</span>
        </div>
      }
      <div
        data-testid="user-message-body"
        class="rounded border border-[var(--line)] bg-[var(--bg-2)] px-3 py-2 text-[14px] leading-[1.7] text-[var(--ink,#e0e0e0)]"
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
}
