import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { marked } from 'marked';
import { parseMarkdownSync } from '../../shared/markdown';

/**
 * Renders markdown text as HTML with an optional streaming caret.
 * `marked` does not sanitize; XSS protection relies on Angular's `[innerHTML]` DomSanitizer.
 */
@Component({
  selector: 'app-text-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block text-[14px] leading-[1.7]',
    '[style.color]': "'var(--ink, #e8edf7)'",
    '[attr.role]': "streaming() ? 'status' : null",
    '[attr.aria-live]': "streaming() ? 'polite' : null",
  },
  template: `
    <div class="prose-sw" [innerHTML]="rendered()"></div>
    @if (streaming()) {
      <span
        data-testid="streaming-caret"
        aria-hidden="true"
        class="ml-0.5 inline-block animate-blink"
        style="color: var(--accent, #ff4d6d)"
        >&#x258E;</span
      >
    }
  `,
})
export class TextBlockComponent {
  /** Raw markdown content to render. */
  readonly content = input.required<string>();
  /** When true, renders a blinking caret and exposes aria-live status semantics. */
  readonly streaming = input(false);

  /** Returns unsanitized HTML from `marked`. Safe only when bound via `[innerHTML]` — see class doc. */
  readonly rendered = computed(() => parseMarkdownSync(marked, this.content()));
}
