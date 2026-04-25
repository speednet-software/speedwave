import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import type { ChatMessage } from '../../models/chat';

/**
 * Formats an integer token count with thousands separators (e.g. `1,243`)
 * using locale `en-US` so the output is stable regardless of user locale.
 */
const TOKEN_FORMATTER = new Intl.NumberFormat('en-US');

/**
 * Mono metadata line rendered below each assistant message:
 * `opus-4.7 · edited · 1,243 tok · cache: 4,012 · $0.018`.
 *
 * Missing data hides the corresponding segment (not the whole row).
 * Cost is always rendered to 3 decimal places when present.
 */
@Component({
  selector: 'app-message-metadata',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @let label = modelLabel();
    <div
      data-testid="message-metadata"
      class="mt-1 text-[11px] text-sw-text-dim font-mono flex flex-wrap items-center gap-x-2 leading-none"
    >
      @if (label) {
        <span data-testid="meta-model">{{ label }}</span>
      }
      @if (precedingEdited) {
        <span data-testid="meta-edited" aria-label="retried">· edited</span>
      }
      @if (totalTokens() !== null) {
        <span data-testid="meta-tokens" [attr.aria-label]="totalTokens()! + ' tokens'"
          >· {{ formatTokens(totalTokens()!) }} tok</span
        >
      }
      @if (cacheReadTokens() !== null) {
        <span data-testid="meta-cache">· cache: {{ formatTokens(cacheReadTokens()!) }}</span>
      }
      @if (hasCost()) {
        <span data-testid="meta-cost">· \${{ costFormatted() }}</span>
      }
    </div>
  `,
})
export class MessageMetadataComponent {
  @Input({ required: true }) entry!: ChatMessage;
  /**
   * Set to `true` when the user entry that preceded this assistant was
   * retried. Surfaces as `· edited` in the rendered row. The retry
   * reducer (Feature 2) owns setting this.
   */
  @Input() precedingEdited = false;

  /**
   * Display-friendly model label per the design (`opus-4.7`, not the raw
   * Anthropic id `claude-opus-4-7`). Strips the `claude-` prefix and
   * rewrites the version dashes (e.g. `4-7`) back to dots so the label
   * matches the published model name.
   */
  modelLabel(): string {
    const raw = this.entry.meta?.model;
    if (!raw) return '';
    const stripped = raw.replace(/^claude-/, '');
    return stripped.replace(/-(\d+)-(\d+)$/, '-$1.$2');
  }

  /**
   * Per-turn total tokens (input + output). Returns `null` when usage is
   * absent so the template can hide the segment. Treats missing cache
   * fields as 0 — the backend already normalizes them, this is defensive.
   */
  totalTokens(): number | null {
    const usage = this.entry.meta?.usage;
    if (!usage) return null;
    return usage.input_tokens + usage.output_tokens;
  }

  /**
   * Per-turn cache-read token count. Returns `null` when usage is absent
   * OR when cache-read is 0, so the segment hides rather than displaying
   * "cache: 0".
   */
  cacheReadTokens(): number | null {
    const usage = this.entry.meta?.usage;
    if (!usage) return null;
    return usage.cache_read_tokens > 0 ? usage.cache_read_tokens : null;
  }

  /** Whether meta carries a cost value to render. */
  hasCost(): boolean {
    return this.entry.meta?.cost !== undefined;
  }

  /** Per-turn cost formatted to exactly 3 decimal places (e.g. `"0.018"`). */
  costFormatted(): string {
    return (this.entry.meta?.cost ?? 0).toFixed(3);
  }

  /**
   * Formats a token count with thousands separators (locale `en-US`).
   * @param n - The integer token count to format.
   */
  formatTokens(n: number): string {
    return TOKEN_FORMATTER.format(n);
  }
}
