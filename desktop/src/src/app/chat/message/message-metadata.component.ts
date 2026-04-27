import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ChatMessage } from '../../models/chat';

const TOKEN_FORMATTER = new Intl.NumberFormat('en-US');

/**
 * Mono metadata line rendered below each assistant message:
 * `opus-4.7 · edited · 1,243 tok · cache: 4,012 · $0.018`.
 *
 * Missing data hides the corresponding segment, never the whole row, and
 * never renders NaN or `undefined`. Cost is always shown to 3 decimals.
 */
@Component({
  selector: 'app-message-metadata',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @let tokens = totalTokens();
    @let cache = cacheReadTokens();
    @let label = modelLabel();
    <div
      data-testid="message-metadata"
      class="mono mt-1 flex flex-wrap items-center gap-x-2 text-[11px] leading-none text-[var(--ink-mute)]"
    >
      @if (label) {
        <span data-testid="meta-model">{{ label }}</span>
      }
      @if (precedingEdited()) {
        <span data-testid="meta-edited" aria-label="retried">· edited</span>
      }
      @if (tokens !== null) {
        <span data-testid="meta-tokens" [attr.aria-label]="tokens + ' tokens'"
          >· {{ formatTokens(tokens) }} tok</span
        >
      }
      @if (cache !== null) {
        <span data-testid="meta-cache">· cache: {{ formatTokens(cache) }}</span>
      }
      @if (hasCost()) {
        <span data-testid="meta-cost">· \${{ costFormatted() }}</span>
      }
    </div>
  `,
})
export class MessageMetadataComponent {
  readonly entry = input.required<ChatMessage>();
  readonly precedingEdited = input(false);

  readonly modelLabel = computed<string>(() => {
    const raw = this.entry().meta?.model;
    if (!raw) return '';
    const stripped = raw.replace(/^claude-/, '');
    return stripped.replace(/-(\d+)-(\d+)$/, '-$1.$2');
  });

  /**
   * Per-turn total tokens (input + output). Returns `null` when usage is
   * absent so the template can hide the segment.
   */
  totalTokens(): number | null {
    const usage = this.entry().meta?.usage;
    if (!usage) return null;
    const input_tokens = usage.input_tokens ?? 0;
    const output_tokens = usage.output_tokens ?? 0;
    return input_tokens + output_tokens;
  }

  /**
   * Per-turn cache-read token count. Returns `null` when usage is absent
   * or cache-read is 0 so the segment hides rather than displaying "cache: 0".
   */
  cacheReadTokens(): number | null {
    const usage = this.entry().meta?.usage;
    if (!usage) return null;
    const cache = usage.cache_read_tokens;
    if (typeof cache !== 'number' || cache <= 0) return null;
    return cache;
  }

  /** Whether meta carries a cost value to render. */
  hasCost(): boolean {
    return this.entry().meta?.cost !== undefined;
  }

  /** Per-turn cost formatted to exactly 3 decimal places. */
  costFormatted(): string {
    return (this.entry().meta?.cost ?? 0).toFixed(3);
  }

  /**
   * Formats a token count with thousands separators (locale en-US).
   * @param n Raw token count to format.
   */
  formatTokens(n: number): string {
    return TOKEN_FORMATTER.format(n);
  }
}
