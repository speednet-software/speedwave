import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { MessageBlock } from '../../models/chat';
import { formatBytes } from '../../shared/format-bytes';
import { IconComponent } from '../../shared/icon.component';
import { ControlChipComponent } from '../blocks/control-chip.component';

/** Renders text + image + file + chip blocks; image and file are placeholder pills (ADR-065, ADR-094). */
@Component({
  selector: 'app-user-message',
  imports: [ControlChipComponent, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex justify-end' },
  template: `
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
            @case ('file') {
              <div
                data-testid="user-message-file"
                class="mono mt-1 inline-flex max-w-full items-center gap-1 rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-0.5 text-[11px] text-[var(--ink-mute,#888888)]"
                [title]="block.filename + ' (' + formatBytes(block.size_bytes) + ')'"
                aria-label="File attachment"
              >
                <app-icon name="document" class="h-3.5 w-3.5" />
                <span class="min-w-0 truncate">{{ block.filename }}</span>
                <span class="shrink-0">{{ formatBytes(block.size_bytes) }}</span>
              </div>
            }
            @case ('chip') {
              <app-control-chip [command]="block.command" [argument]="block.argument" />
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
    this.blocks().filter(
      (b): b is RenderableUserBlock =>
        b.type === 'text' || b.type === 'image' || b.type === 'file' || b.type === 'chip'
    )
  );

  readonly textBlocks = computed<readonly Extract<MessageBlock, { type: 'text' }>[]>(() =>
    this.blocks().filter((b): b is Extract<MessageBlock, { type: 'text' }> => b.type === 'text')
  );

  /** Pretty-prints the size of a file pill (shared helper). */
  readonly formatBytes = formatBytes;

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

type RenderableUserBlock = Extract<MessageBlock, { type: 'text' | 'image' | 'file' | 'chip' }>;
