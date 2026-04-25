import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { marked } from 'marked';

/**
 * Renders markdown-formatted text content as HTML, with an optional streaming caret.
 *
 * Markdown is parsed by the `marked` library, which does NOT sanitize its HTML output.
 * XSS protection comes from Angular's built-in `DomSanitizer`, which runs automatically
 * when the string is assigned via the `[innerHTML]` property binding — stripping `<script>`
 * tags, event-handler attributes (`onerror`, `onclick`, etc.), and rewriting `javascript:`
 * URLs to the inert `unsafe:javascript:` prefix so they cannot execute.
 *
 * SCOPE LIMIT: Angular's HTML sanitizer only rewrites the `javascript:` scheme; `data:`
 * and `vbscript:` URLs pass through unchanged. Speedwave relies on assistant-controlled
 * (not user-controlled) chat content here, so those schemes are not an active threat —
 * but any future render path that accepts attacker-controlled markdown must add its own
 * scheme filtering or rely on CSP, not on this component alone.
 *
 * WARNING: Do not switch this binding to a `SafeHtml` produced by
 * `DomSanitizer.bypassSecurityTrustHtml(...)` — doing so disables all sanitization and
 * would make `<script>` tags, event-handler attributes, and `javascript:` URLs executable.
 */
@Component({
  selector: 'app-text-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block text-[14px] leading-[1.7]',
    '[style.color]': "'var(--ink, #e8edf7)'",
    '[attr.role]': "streaming ? 'status' : null",
    '[attr.aria-live]': "streaming ? 'polite' : null",
  },
  template: `
    <div class="prose-sw" [innerHTML]="rendered"></div>
    @if (streaming) {
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
  @Input({ required: true }) content!: string;
  /** When true, renders a blinking caret and exposes aria-live status semantics. */
  @Input() streaming = false;

  /** Returns unsanitized HTML from `marked`. Safe only when bound via `[innerHTML]` — see class doc. */
  get rendered(): string {
    const result = marked.parse(this.content, { async: false });
    if (typeof result !== 'string') {
      throw new Error('marked.parse returned a Promise; async option must remain false');
    }
    return result;
  }
}
