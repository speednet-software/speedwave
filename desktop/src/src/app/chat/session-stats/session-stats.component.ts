import { ChangeDetectionStrategy, Component, Input, computed, signal } from '@angular/core';
import type { SessionStats } from '../../models/chat';

/** Shared bar segment indices — module-level constant to avoid per-instance allocation. */
const BAR_INDICES: readonly number[] = [0, 1, 2, 3, 4];

/** Shared number formatter for thousands separators (Intl instances are not free). */
const NUMBER_FMT = new Intl.NumberFormat('en-US');

/**
 * Terminal-style session stats strip rendered as a single monospaced line:
 *   `model · ctx <bar> <pct> · <used>/<max> · limit <bar> <pct> · resets <HH:MM> ·
 *    tokens in <n> · cr <n> · cw <n> · out <n> · cost $<x.xxxx>`
 *
 * Bars use 5 inline segments of `h-2 w-2` whose fill color comes from the
 * percentage bucket (green/amber/red) defined in
 * design-proposals/06-terminal-minimal-implementation-prompt.md.
 */
@Component({
  selector: 'app-session-stats',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (statsSignal(); as stats) {
      <div
        data-testid="session-stats"
        class="mono flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-bg-1 px-4 py-1.5 text-[11px] text-ink-mute"
      >
        <!-- Model -->
        <span class="text-teal whitespace-nowrap" title="AI model used for this session">{{
          stats.model || 'Claude'
        }}</span>

        <!-- Context usage -->
        @if (ctxPct() > 0) {
          <span class="flex items-center gap-1.5 whitespace-nowrap">
            <span>ctx</span>
            <span class="flex gap-px" [attr.aria-label]="'Context: ' + ctxPct() + '% used'">
              @for (i of barIndices; track i) {
                <span
                  class="inline-block h-2 w-2"
                  [class]="i < ctxFilled() ? ctxBarColor() : 'bg-line-strong'"
                ></span>
              }
            </span>
            <span class="text-ink-dim">{{ ctxPct() }}%</span>
            @if (ctxUsedMax(); as um) {
              <span>&middot; {{ um }}</span>
            }
          </span>
        }

        <!-- Rate limit -->
        @if (stats.rate_limit) {
          <span class="flex items-center gap-1.5 whitespace-nowrap">
            <span>limit</span>
            <span class="flex gap-px" [attr.aria-label]="'Rate limit: ' + rlPct() + '% used'">
              @for (i of barIndices; track i) {
                <span
                  class="inline-block h-2 w-2"
                  [class]="i < rlFilled() ? rlBarColor() : 'bg-line-strong'"
                ></span>
              }
            </span>
            <span class="text-ink-dim">{{ rlPct() }}%</span>
            @if (rlResetTime()) {
              <span>&middot; resets {{ rlResetTime() }}</span>
            }
          </span>
        }

        <!-- Token breakdown -->
        @if (stats.usage; as usage) {
          <span class="whitespace-nowrap">
            tokens in <span class="text-ink-dim">{{ formatNum(usage.input_tokens) }}</span>
          </span>
          @if (usage.cache_read_tokens) {
            <span class="whitespace-nowrap">
              &middot; cr
              <span class="text-ink-dim">{{ formatNum(usage.cache_read_tokens) }}</span>
            </span>
          }
          @if (usage.cache_write_tokens) {
            <span class="whitespace-nowrap">
              &middot; cw
              <span class="text-ink-dim">{{ formatNum(usage.cache_write_tokens) }}</span>
            </span>
          }
          <span class="whitespace-nowrap">
            &middot; out
            <span class="text-ink-dim">{{ formatNum(stats.total_output_tokens) }}</span>
          </span>
        }

        <!-- Cost (right-aligned) -->
        @if (stats.total_cost > 0) {
          <span class="ml-auto whitespace-nowrap">
            cost <span class="text-ink-dim">\${{ stats.total_cost.toFixed(4) }}</span>
          </span>
        }
      </div>
    }
  `,
})
export class SessionStatsComponent {
  /** Shared segment indices exposed to the template. */
  readonly barIndices = BAR_INDICES;

  /** Signal mirroring the legacy `@Input` setter so template bindings re-evaluate. */
  readonly statsSignal = signal<SessionStats | null>(null);

  /** Legacy setter — keeps `[stats]="..."` binding contract stable across the rewrite. */
  @Input() set stats(value: SessionStats | null) {
    this.statsSignal.set(value);
  }

  /** Current stats value, or null if no session is active. */
  get stats(): SessionStats | null {
    return this.statsSignal();
  }

  /**
   * Total input tokens consumed from the context window (sum of `input`,
   * `cache_read`, `cache_write`). Matches the statusline.sh calculation —
   * `output_tokens` are excluded because they don't occupy the prompt context.
   */
  private readonly totalInput = computed<number>(() => {
    const usage = this.statsSignal()?.usage;
    if (!usage) return 0;
    return usage.input_tokens + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
  });

  /** Context window usage as an integer percentage (0–100). */
  readonly ctxPct = computed<number>(() => {
    const total = this.totalInput();
    if (total <= 0) return 0;
    const windowSize = this.statsSignal()?.context_window_size || 200_000;
    return Math.min(100, Math.round((total / windowSize) * 100));
  });

  /** Filled segments (0–5) for the context bar, rounded to nearest. */
  readonly ctxFilled = computed<number>(() => bucketFilled(this.ctxPct()));

  /** Tailwind class for filled context-bar segments. */
  readonly ctxBarColor = computed<string>(() => barColor(this.ctxPct()));

  /** `used/max` label in short-form (e.g. `116k/200k`); empty string if not derivable. */
  readonly ctxUsedMax = computed<string>(() => {
    const total = this.totalInput();
    if (total <= 0) return '';
    const windowSize = this.statsSignal()?.context_window_size || 200_000;
    return `${shortK(total)}/${shortK(windowSize)}`;
  });

  /** Rate-limit utilisation as an integer percentage (0–100). */
  readonly rlPct = computed<number>(() => {
    const stats = this.statsSignal();
    return Math.round(stats?.rate_limit?.utilization ?? 0);
  });

  /** Filled segments (0–5) for the rate-limit bar. */
  readonly rlFilled = computed<number>(() => bucketFilled(this.rlPct()));

  /** Tailwind class for filled rate-limit-bar segments. */
  readonly rlBarColor = computed<string>(() => barColor(this.rlPct()));

  /** Reset time for rate limit formatted as HH:MM (local), or empty string. */
  readonly rlResetTime = computed<string>(() => {
    const epoch = this.statsSignal()?.rate_limit?.resets_at;
    if (!epoch) return '';
    const d = new Date(epoch * 1000);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  });

  /**
   * Formats an integer with `Intl.NumberFormat('en-US')` (thousands separators).
   * @param n - Integer token count to format.
   */
  formatNum(n: number): string {
    return NUMBER_FMT.format(n);
  }
}

/**
 * Bucket the percentage into one of three Tailwind bar-segment colors.
 * @param pct - Percentage in the range 0–100.
 */
function barColor(pct: number): string {
  if (pct >= 77) return 'bg-red-500';
  if (pct >= 50) return 'bg-amber';
  return 'bg-green';
}

/**
 * Converts a percentage (0–100) to the number of filled segments (0–5), rounded.
 * 30% → 1.5 → 2; 80% → 4.
 * @param pct - Percentage in the range 0–100.
 */
function bucketFilled(pct: number): number {
  return Math.min(5, Math.round((pct / 100) * 5));
}

/**
 * Short-form thousands suffix — `116400 → 116k`, `1234 → 1k`, `800 → 800`.
 * Used for the compact `used/max` label under the context bar.
 * @param n - Integer count to convert to a short-form label.
 */
function shortK(n: number): string {
  if (n >= 1000) {
    return `${Math.round(n / 1000)}k`;
  }
  return String(n);
}
