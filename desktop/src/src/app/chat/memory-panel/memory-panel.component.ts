import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { TextBlockComponent } from '../blocks/text-block.component';

/**
 * Right-drawer memory panel showing the active project's CLAUDE.md contents.
 *
 * Matches the terminal-minimal mockup: a 320px absolute drawer anchored to the
 * right edge, with a mono `memory` header, close button, and a markdown body
 * rendered via `TextBlockComponent` (reused to keep the marked pipeline DRY).
 *
 * Per the implementation prompt spec: the panel does NOT over-parse CLAUDE.md
 * into category buckets — the markdown source already has a clean section
 * structure (headings for User Preferences / Feedback / Project / Reference),
 * so the prose renderer shines through.
 *
 * Uses `@Input`/`@Output` decorators rather than signal input()/output() to stay
 * compatible with the project's Vitest runner, which does not apply Angular's
 * AOT compiler pass and therefore cannot register signal-based inputs. The
 * rest of the codebase follows the same convention.
 */
@Component({
  selector: 'app-memory-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TextBlockComponent],
  template: `
    @if (open) {
      <aside
        class="absolute right-0 top-0 h-full w-[320px] bg-bg-1 ring-1 ring-line flex flex-col z-10"
        role="complementary"
        aria-label="Project memory"
        data-testid="memory-panel"
      >
        <div class="flex h-11 items-center gap-2 border-b border-line px-3">
          <span class="font-mono text-[11px] text-ink-mute">memory</span>
          <button
            type="button"
            class="ml-auto text-ink-mute hover:text-ink text-sm px-1"
            data-testid="memory-panel-close"
            aria-label="Close memory panel"
            (click)="closed.emit()"
          >
            ×
          </button>
        </div>
        <div
          class="flex-1 overflow-y-auto p-3 text-[13px] leading-relaxed text-ink"
          data-testid="memory-panel-body"
        >
          @if (error) {
            <p
              class="font-mono text-[11.5px] text-sw-accent border border-sw-accent rounded px-2 py-1.5"
              data-testid="memory-panel-error"
            >
              {{ error }}
            </p>
          } @else if (markdown) {
            <app-text-block [content]="markdown" />
          } @else {
            <p class="font-mono text-[11.5px] text-ink-mute" data-testid="memory-panel-empty">
              no memory yet
            </p>
          }
        </div>
      </aside>
    }
  `,
})
export class MemoryPanelComponent {
  @Input() open = false;
  @Input() markdown = '';
  @Input() error = '';
  @Output() readonly closed = new EventEmitter<void>();
}
