import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { SessionStats } from '../../models/chat';

/** Shared bar segment indices — module-level constant to avoid per-instance allocation. */
const BAR_INDICES: readonly number[] = [0, 1, 2, 3, 4];

/** Shared number formatter for thousands separators (Intl instances are not free). */
const NUMBER_FMT = new Intl.NumberFormat('en-US');

/**
 * Terminal-minimal session stats strip — a single mono line shown below the
 * composer. Matches the mockup (lines 1143–1177):
 *
 *   `in: <n> · out: <n> · ctx [▮▮▮▯▯] N% · 116k/200k · limit [▮▮▮▯▯] N% · resets HH:MM · session: $0.018`
 *
 * Bars are 5 inline 6×6px segments coloured per-bucket (green ≤49% / amber
 * ≤76% / red). Optional segments (ctx + bar / limit + bar / cost) hide on
 * smaller breakpoints to preserve the single-line shape.
 */
@Component({
  selector: 'app-session-stats',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  host: { class: 'block' },
  template: `
    @if (stats(); as s) {
      <div
        data-testid="session-stats"
        class="mono flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-3 text-[10px] text-[var(--ink-mute)]"
      >
        <!-- Tokens in/out -->
        @if (s.usage; as usage) {
          <span class="whitespace-nowrap">
            in: <span class="text-[var(--teal)]">{{ formatNum(totalInput()) }}</span>
          </span>
          <span class="whitespace-nowrap">
            out:
            <span class="text-[var(--accent)]">{{ formatNum(s.total_output_tokens) }}</span>
          </span>
        }

        <!-- Context bar (sm+) -->
        @if (ctxPct() > 0) {
          <span class="hidden items-center gap-1.5 whitespace-nowrap sm:inline-flex">
            ctx
            <span class="flex gap-px" [attr.aria-label]="'Context: ' + ctxPct() + '% used'">
              @for (i of barIndices; track i) {
                <span
                  class="inline-block h-1.5 w-1.5"
                  [class]="i < ctxFilled() ? ctxBarColor() : 'bg-[var(--line-strong)]'"
                ></span>
              }
            </span>
            <span class="text-[var(--ink-dim)]">{{ ctxPct() }}%</span>
            @if (ctxUsedMax(); as um) {
              <span>· {{ um }}</span>
            }
          </span>
        }

        <!-- Rate-limit bar (md+) -->
        @if (s.rate_limit) {
          <span class="hidden items-center gap-1.5 whitespace-nowrap md:inline-flex">
            limit
            <span class="flex gap-px" [attr.aria-label]="'Rate limit: ' + rlPct() + '% used'">
              @for (i of barIndices; track i) {
                <span
                  class="inline-block h-1.5 w-1.5"
                  [class]="i < rlFilled() ? rlBarColor() : 'bg-[var(--line-strong)]'"
                ></span>
              }
            </span>
            <span class="text-[var(--ink-dim)]">{{ rlPct() }}%</span>
            @if (rlResetTime()) {
              <span>· resets {{ rlResetTime() }}</span>
            }
          </span>
        }

        <ng-container *ngTemplateOutlet="branchChip" />

        @if (s.total_cost > 0) {
          <span class="hidden whitespace-nowrap sm:inline" [class.ml-auto]="!branch()">
            session:
            <span class="text-[var(--ink-dim)]">\${{ s.total_cost.toFixed(4) }}</span>
          </span>
        }
      </div>
    } @else {
      <!-- Zero-state: same row, just with all counters at 0. Always visible
           so the user sees the metric set even before the first turn — it
           also preserves vertical rhythm so the composer never reflows. -->
      <div
        data-testid="session-stats-placeholder"
        class="mono flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-3 text-[10px] text-[var(--ink-mute)]"
      >
        <span class="whitespace-nowrap"> in: <span class="text-[var(--teal)]">0</span> </span>
        <span class="whitespace-nowrap"> out: <span class="text-[var(--accent)]">0</span> </span>
        <span class="hidden items-center gap-1.5 whitespace-nowrap sm:inline-flex">
          ctx
          <span class="flex gap-px" aria-label="Context: 0% used">
            @for (i of barIndices; track i) {
              <span class="inline-block h-1.5 w-1.5 bg-[var(--line-strong)]"></span>
            }
          </span>
          <span class="text-[var(--ink-dim)]">0%</span>
        </span>
        <span class="hidden items-center gap-1.5 whitespace-nowrap md:inline-flex">
          limit
          <span class="flex gap-px" aria-label="Rate limit: 0% used">
            @for (i of barIndices; track i) {
              <span class="inline-block h-1.5 w-1.5 bg-[var(--line-strong)]"></span>
            }
          </span>
          <span class="text-[var(--ink-dim)]">0%</span>
        </span>
        <ng-container *ngTemplateOutlet="branchChip" />
        <span class="hidden whitespace-nowrap sm:inline" [class.ml-auto]="!branch()">
          session: <span class="text-[var(--ink-dim)]">$0.0000</span>
        </span>
      </div>
    }

    <ng-template #branchChip>
      @if (branch(); as br) {
        <span
          class="ml-auto hidden items-center gap-1.5 whitespace-nowrap sm:inline-flex"
          data-testid="session-stats-branch"
        >
          <svg
            class="h-3 w-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            stroke-width="1.75"
            aria-hidden="true"
          >
            <circle cx="6" cy="6" r="2" />
            <circle cx="6" cy="18" r="2" />
            <circle cx="18" cy="8" r="2" />
            <path stroke-linecap="round" d="M6 8v8m0-8a6 6 0 0 0 6 6h4" />
          </svg>
          <span class="text-[var(--ink-dim)]">{{ br }}</span>
        </span>
      }
    </ng-template>
  `,
})
export class SessionStatsComponent {
  /** Shared segment indices exposed to the template. */
  readonly barIndices = BAR_INDICES;

  /** Stats input (signal). */
  readonly stats = input<SessionStats | null>(null);

  /**
   * Current git branch of the active project's working tree, or `null` when
   * the project isn't a git repo. Renders as the branch-icon chip on the
   * right side of the strip.
   */
  readonly branch = input<string | null>(null);

  /**
   * Total input tokens consumed from the context window (sum of `input`,
   * `cache_read`, `cache_write`). Matches the statusline.sh calculation —
   * `output_tokens` are excluded because they don't occupy the prompt context.
   */
  readonly totalInput = computed<number>(() => {
    const usage = this.stats()?.usage;
    if (!usage) return 0;
    return usage.input_tokens + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
  });

  /** Context window usage as an integer percentage (0–100). */
  readonly ctxPct = computed<number>(() => {
    const total = this.totalInput();
    if (total <= 0) return 0;
    const windowSize = this.stats()?.context_window_size ?? 200_000;
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
    const windowSize = this.stats()?.context_window_size ?? 200_000;
    return `${shortK(total)}/${shortK(windowSize)}`;
  });

  /** Rate-limit utilisation as an integer percentage (0–100). */
  readonly rlPct = computed<number>(() => {
    const stats = this.stats();
    return Math.round(stats?.rate_limit?.utilization ?? 0);
  });

  /** Filled segments (0–5) for the rate-limit bar. */
  readonly rlFilled = computed<number>(() => bucketFilled(this.rlPct()));

  /** Tailwind class for filled rate-limit-bar segments. */
  readonly rlBarColor = computed<string>(() => barColor(this.rlPct()));

  /** Reset time for rate limit formatted as HH:MM (local), or empty string. */
  readonly rlResetTime = computed<string>(() => {
    const epoch = this.stats()?.rate_limit?.resets_at;
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
  if (pct >= 50) return 'bg-[var(--amber)]';
  return 'bg-[var(--green)]';
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
