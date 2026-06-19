import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { MessageBlock } from '../../models/chat';

/** Renders text + image blocks; image is a placeholder pill (ADR-065). */
@Component({
  selector: 'app-user-message',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex justify-end' },
  template: `
    <!-- Right-aligned bubble, max 80% column width. -->
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
        @for (block of renderBlocks(); track $index) {
          @switch (block.type) {
            @case ('text') {
              <div>{{ block.content }}</div>
            }
            @case ('image') {
              <div
                data-testid="user-message-image"
                class="mono mt-1 inline-flex items-center gap-1 rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-0.5 text-[11px] text-[var(--ink-mute,#888888)]"
                [title]="block.alt ?? block.media_type"
                aria-label="Image attachment"
              >
                🖼 <span>{{ imageLabel(block) }}</span>
              </div>
            }
          }
        }
      </div>
    </div>
  `,
})
export class UserMessageComponent {
  readonly blocks = input.required<readonly MessageBlock[]>();
  readonly editedAt = input<number | undefined>(undefined);
  readonly timestamp = input(0);

  readonly renderBlocks = computed<readonly RenderableUserBlock[]>(() =>
    this.blocks().filter((b): b is RenderableUserBlock => b.type === 'text' || b.type === 'image')
  );

  readonly textBlocks = computed<readonly Extract<MessageBlock, { type: 'text' }>[]>(() =>
    this.blocks().filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
  );

  /**
   * Filename if known, else humanised MIME (e.g. `PNG`).
   * @param block - Image placeholder block from the state-tree.
   */
  imageLabel(block: Extract<MessageBlock, { type: 'image' }>): string {
    if (block.alt && block.alt.length > 0) return block.alt;
    const sub = block.media_type.split('/')[1] ?? block.media_type;
    return sub.toUpperCase();
  }
}

type RenderableUserBlock = Extract<MessageBlock, { type: 'text' | 'image' }>;
