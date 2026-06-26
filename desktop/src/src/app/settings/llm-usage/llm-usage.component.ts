import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { TauriService } from '../../services/tauri.service';
import type { UsageBucket, UsageSummary } from '../../models/llm';

/** Shared number formatter for thousands separators. */
const NUMBER_FMT = new Intl.NumberFormat('en-US');

/** Row of the per-day table: one (day, model) pair. */
interface UsageRow {
  day: string;
  model: string;
  bucket: UsageBucket;
}

/** One bar of the daily-tokens chart. */
export interface DayBar {
  day: string;
  /** Short label rendered under the bar (`MM-DD`). */
  label: string;
  promptTokens: number;
  completionTokens: number;
  /** Stacked segment heights as % of the chart's tallest bar. */
  promptPct: number;
  completionPct: number;
}

/** One segment of the provider-share bar. */
export interface ProviderShare {
  provider: string;
  tokens: number;
  /** Width of the segment, % of all tokens (≥ 2 so slivers stay visible). */
  pct: number;
  color: string;
}

/** One cell of the weekday × hour heatmap. */
export interface HeatCell {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  hour: number;
  requests: number;
  /** Fill opacity 0–1 relative to the busiest cell. */
  intensity: number;
}

/** Palette cycled over provider-share segments (theme CSS variables). */
const SHARE_COLORS = [
  'var(--accent)',
  'var(--teal)',
  'var(--amber)',
  'var(--green)',
  'var(--red)',
  'var(--ink-mute)',
] as const;

/** Bars shown in the daily chart — the most recent month of activity. */
export const DAILY_CHART_DAYS = 30;

/** LLM usage dashboard (ADR-073). Renders the aggregate returned by the `get_llm_usage` Tauri command. */
@Component({
  selector: 'app-llm-usage',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="mono text-[11px] text-[var(--ink-mute)]" data-testid="llm-usage">
      @if (loading()) {
        <div class="px-1 py-2">loading usage…</div>
      } @else if (error(); as err) {
        <div class="px-1 py-2 text-[var(--red)]" data-testid="llm-usage-error">{{ err }}</div>
      } @else if (summary(); as s) {
        @if (s.totals.requests === 0) {
          <div class="px-1 py-2" data-testid="llm-usage-empty">
            No proxied LLM requests recorded yet for this project.
          </div>
        } @else {
          <!-- Stat cards -->
          <div
            class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
            data-testid="llm-usage-cards"
          >
            <div class="rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-2">
              <div class="text-[10px] uppercase tracking-widest">requests</div>
              <div class="mt-1 text-[15px] text-[var(--ink)]" data-testid="llm-usage-card-requests">
                {{ num(s.totals.requests) }}
              </div>
            </div>
            <div class="rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-2">
              <div class="text-[10px] uppercase tracking-widest">tokens in / out</div>
              <div class="mt-1 text-[15px]">
                <span class="text-[var(--teal)]">{{ short(s.totals.prompt_tokens) }}</span>
                <span class="text-[var(--ink-mute)]"> / </span>
                <span class="text-[var(--accent)]">{{ short(s.totals.completion_tokens) }}</span>
              </div>
            </div>
            <div class="rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-2">
              <div class="text-[10px] uppercase tracking-widest">cache hit</div>
              <div class="mt-1 text-[15px] text-[var(--ink)]" data-testid="llm-usage-card-cache">
                {{ pct(cacheHitRate(s.totals)) }}
              </div>
            </div>
            <div class="rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-2">
              <div class="text-[10px] uppercase tracking-widest">avg speed</div>
              <div class="mt-1 text-[15px] text-[var(--ink)]" data-testid="llm-usage-card-speed">
                @if (tokensPerSec(s.totals); as tps) {
                  {{ tps.toFixed(1) }} tok/s
                } @else {
                  —
                }
              </div>
            </div>
            <div class="rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-2">
              <div class="text-[10px] uppercase tracking-widest">errors</div>
              <div
                class="mt-1 text-[15px]"
                [style.color]="s.totals.failures > 0 ? 'var(--red)' : 'var(--ink)'"
                data-testid="llm-usage-card-errors"
              >
                {{ num(s.totals.failures) }}
                @if (s.totals.requests > 0) {
                  <span class="text-[11px] text-[var(--ink-mute)]"
                    >({{ pct(s.totals.failures / s.totals.requests) }})</span
                  >
                }
              </div>
            </div>
            <div class="rounded border border-[var(--line)] bg-[var(--bg-1)] px-3 py-2">
              <div class="text-[10px] uppercase tracking-widest">cost</div>
              <div class="mt-1 text-[15px] text-[var(--ink)]" data-testid="llm-usage-card-cost">
                {{ s.totals.cost_usd !== null ? usd(s.totals.cost_usd) : '—' }}
              </div>
            </div>
          </div>

          @if (s.skipped_lines > 0) {
            <div class="mt-2 px-1" data-testid="llm-usage-skipped">
              ({{ num(s.skipped_lines) }} records skipped)
            </div>
          }

          <!-- Daily tokens, stacked prompt/completion -->
          @if (dayBars().length > 0) {
            <div class="mt-5 px-1">
              <div class="mb-2 text-[10px] uppercase tracking-widest">
                daily tokens
                <span class="normal-case tracking-normal">
                  (<span class="text-[var(--teal)]">in</span> /
                  <span class="text-[var(--accent)]">out</span>)
                </span>
              </div>
              <div class="flex h-24 items-end gap-[3px]" data-testid="llm-usage-daily-chart">
                @for (bar of dayBars(); track bar.day) {
                  <div
                    class="group flex h-full flex-1 flex-col justify-end"
                    [title]="
                      bar.day +
                      ': in ' +
                      num(bar.promptTokens) +
                      ', out ' +
                      num(bar.completionTokens)
                    "
                    data-testid="llm-usage-daily-bar"
                  >
                    <div
                      class="w-full rounded-t-[2px] bg-[var(--accent)]"
                      [style.height.%]="bar.completionPct"
                    ></div>
                    <div class="w-full bg-[var(--teal)]" [style.height.%]="bar.promptPct"></div>
                  </div>
                }
              </div>
              <div class="mt-1 flex justify-between text-[9px] text-[var(--ink-mute)]">
                <span>{{ dayBars()[0].label }}</span>
                <span>{{ dayBars()[dayBars().length - 1].label }}</span>
              </div>
            </div>
          }

          <!-- Provider share -->
          @if (shares().length > 0) {
            <div class="mt-5 px-1">
              <div class="mb-2 text-[10px] uppercase tracking-widest">tokens by provider</div>
              <div
                class="flex h-3 w-full overflow-hidden rounded"
                data-testid="llm-usage-provider-bar"
              >
                @for (share of shares(); track share.provider) {
                  <div
                    [style.width.%]="share.pct"
                    [style.background]="share.color"
                    [title]="share.provider + ': ' + num(share.tokens) + ' tokens'"
                  ></div>
                }
              </div>
              <div
                class="mt-2 flex flex-wrap gap-x-4 gap-y-1"
                data-testid="llm-usage-provider-legend"
              >
                @for (share of shares(); track share.provider) {
                  <span class="inline-flex items-center gap-1.5">
                    <span
                      class="inline-block h-2 w-2 rounded-sm"
                      [style.background]="share.color"
                    ></span>
                    {{ share.provider }}
                    <span class="text-[var(--ink)]">{{ pct(share.tokens / shareTotal()) }}</span>
                  </span>
                }
              </div>
            </div>
          }

          <!-- Weekday × hour heatmap -->
          @if (heatMax() > 0) {
            <div class="mt-5 px-1">
              <div class="mb-2 text-[10px] uppercase tracking-widest">requests by hour</div>
              <div class="flex gap-[2px]" data-testid="llm-usage-heatmap">
                <div class="flex flex-col gap-[2px] pr-1 text-[9px] leading-[10px]">
                  @for (label of weekdayLabels; track label) {
                    <span class="h-[10px]">{{ label }}</span>
                  }
                </div>
                <div class="grid flex-1 grid-rows-7 gap-[2px]">
                  @for (row of heatRows(); track $index) {
                    <div class="grid grid-cols-24 gap-[2px]">
                      @for (cell of row; track cell.hour) {
                        <div
                          class="h-[10px] rounded-[1px]"
                          [style.opacity]="cell.requests > 0 ? 0.15 + cell.intensity * 0.85 : 1"
                          [style.background]="cell.requests > 0 ? 'var(--accent)' : 'var(--bg-2)'"
                          [title]="
                            weekdayLabels[cell.weekday] +
                            ' ' +
                            cell.hour +
                            ':00 — ' +
                            num(cell.requests) +
                            ' requests'
                          "
                        ></div>
                      }
                    </div>
                  }
                </div>
              </div>
              <div class="mt-1 flex justify-between pl-7 text-[9px] text-[var(--ink-mute)]">
                <span>0:00</span>
                <span>12:00</span>
                <span>23:00</span>
              </div>
            </div>
          }

          <!-- Per-day, per-model table (newest day first) -->
          <table class="mt-5 w-full border-collapse px-1" data-testid="llm-usage-table">
            <thead>
              <tr class="text-left text-[var(--ink-mute)]">
                <th class="py-1 pr-3 font-normal">day</th>
                <th class="py-1 pr-3 font-normal">model</th>
                <th class="py-1 pr-3 text-right font-normal">req</th>
                <th class="py-1 pr-3 text-right font-normal">in</th>
                <th class="py-1 pr-3 text-right font-normal">out</th>
                <th class="py-1 pr-3 text-right font-normal">cache</th>
                <th class="py-1 pr-3 text-right font-normal">tok/s</th>
                <th class="py-1 text-right font-normal">cost</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.day + '|' + row.model) {
                <tr class="border-t border-[var(--line)]">
                  <td class="py-1 pr-3 whitespace-nowrap">{{ row.day }}</td>
                  <td class="py-1 pr-3 break-all">{{ row.model }}</td>
                  <td class="py-1 pr-3 text-right">{{ num(row.bucket.requests) }}</td>
                  <td class="py-1 pr-3 text-right">{{ num(row.bucket.prompt_tokens) }}</td>
                  <td class="py-1 pr-3 text-right">{{ num(row.bucket.completion_tokens) }}</td>
                  <td class="py-1 pr-3 text-right">
                    {{ row.bucket.cache_read > 0 ? pct(cacheHitRate(row.bucket)) : '—' }}
                  </td>
                  <td class="py-1 pr-3 text-right">
                    @if (tokensPerSec(row.bucket); as tps) {
                      {{ tps.toFixed(1) }}
                    } @else {
                      —
                    }
                  </td>
                  <td class="py-1 text-right">
                    {{ row.bucket.cost_usd !== null ? usd(row.bucket.cost_usd) : '—' }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
      }
    </div>
  `,
})
export class LlmUsageComponent {
  /** Project whose usage to display. */
  readonly project = input.required<string>();

  private tauri = inject(TauriService);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly summary = signal<UsageSummary | null>(null);
  readonly rows = signal<UsageRow[]>([]);
  readonly dayBars = signal<DayBar[]>([]);
  readonly shares = signal<ProviderShare[]>([]);
  readonly shareTotal = signal(0);
  readonly heatRows = signal<HeatCell[][]>([]);
  readonly heatMax = signal(0);

  /** Row labels of the heatmap, Monday-first. */
  readonly weekdayLabels = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] as const;

  /** Refetches on project changes; covers initial render and in-place project switches. */
  constructor() {
    effect(() => {
      const project = this.project();
      void this.refresh(project);
    });
  }

  /**
   * Fetches the aggregate; safe to call again (e.g. a future refresh button).
   * @param project - Project to fetch usage for; defaults to the bound input.
   */
  async refresh(project: string = this.project()): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const summary = await this.tauri.invoke<UsageSummary>('get_llm_usage', {
        project,
      });
      this.summary.set(summary);
      this.rows.set(flattenRows(summary));
      this.dayBars.set(dailySeries(summary));
      const { shares, total } = providerShares(summary);
      this.shares.set(shares);
      this.shareTotal.set(total);
      const { rows, max } = heatmapRows(summary);
      this.heatRows.set(rows);
      this.heatMax.set(max);
    } catch (e: unknown) {
      this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Thousands-separated integer for template rendering.
   * @param n - Raw count.
   */
  num(n: number): string {
    return NUMBER_FMT.format(n);
  }

  /**
   * Short token count for stat cards (`297k`, `1.2M`).
   * @param n - Raw token count.
   */
  short(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return NUMBER_FMT.format(n);
  }

  /**
   * USD with 2 decimals (4 below 10 cents, where precision matters).
   * @param n - Cost in dollars.
   */
  usd(n: number): string {
    return `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
  }

  /**
   * Ratio as a percentage label (`42%`).
   * @param ratio - 0–1 fraction.
   */
  pct(ratio: number): string {
    return `${Math.round(ratio * 100)}%`;
  }

  /**
   * Share of input tokens from prompt cache, clamped to [0,1].
   * @param bucket - Aggregate bucket (totals or a table row).
   */
  cacheHitRate(bucket: UsageBucket): number {
    const denom =
      bucket.cache_read > bucket.prompt_tokens
        ? bucket.prompt_tokens + bucket.cache_read
        : bucket.prompt_tokens;
    if (denom <= 0) return 0;
    return Math.min(1, bucket.cache_read / denom);
  }

  /**
   * Mean output throughput (tok/s) over timed records, null when none.
   * @param bucket - Aggregate bucket (totals or a table row).
   */
  tokensPerSec(bucket: UsageBucket): number | null {
    // Falsy checks also cover payloads from a binary older than these fields.
    if (!bucket.throughput_latency_ms_sum) return null;
    return bucket.throughput_completion_tokens / (bucket.throughput_latency_ms_sum / 1000);
  }
}

/**
 * Flattens day → model maps into table rows, newest day first.
 * @param summary - Aggregate returned by the `get_llm_usage` command.
 */
export function flattenRows(summary: UsageSummary): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const day of Object.keys(summary.days).sort().reverse()) {
    const models = summary.days[day];
    for (const model of Object.keys(models).sort()) {
      rows.push({ day, model, bucket: models[model] });
    }
  }
  return rows;
}

/**
 * Provider segment of a model string: `local/x/y` → `local`, bare Anthropic
 * model ids (`claude-…`) → `anthropic`.
 * @param model - Model string as logged by the callback.
 */
export function providerOf(model: string): string {
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : 'anthropic';
}

/**
 * Builds the stacked daily-tokens series over the most recent
 * {@link DAILY_CHART_DAYS} days of recorded activity (oldest first).
 * Segment heights are % of the tallest bar's total.
 * @param summary - Aggregate returned by the `get_llm_usage` command.
 */
export function dailySeries(summary: UsageSummary): DayBar[] {
  const days = Object.keys(summary.days).sort().slice(-DAILY_CHART_DAYS);
  const bars = days.map((day) => {
    let promptTokens = 0;
    let completionTokens = 0;
    for (const bucket of Object.values(summary.days[day])) {
      promptTokens += bucket.prompt_tokens;
      completionTokens += bucket.completion_tokens;
    }
    return { day, label: day.slice(5), promptTokens, completionTokens };
  });
  const max = Math.max(...bars.map((b) => b.promptTokens + b.completionTokens), 1);
  return bars.map((b) => ({
    ...b,
    promptPct: (b.promptTokens / max) * 100,
    completionPct: (b.completionTokens / max) * 100,
  }));
}

/**
 * Aggregates total tokens per provider into ordered share-bar segments
 * (largest first). Slivers are floored at 2% width so they stay visible;
 * legend percentages use the returned `total`, not the floored width.
 * @param summary - Aggregate returned by the `get_llm_usage` command.
 */
export function providerShares(summary: UsageSummary): {
  shares: ProviderShare[];
  total: number;
} {
  const byProvider = new Map<string, number>();
  for (const models of Object.values(summary.days)) {
    for (const [model, bucket] of Object.entries(models)) {
      const provider = providerOf(model);
      const tokens = bucket.prompt_tokens + bucket.completion_tokens;
      byProvider.set(provider, (byProvider.get(provider) ?? 0) + tokens);
    }
  }
  const total = [...byProvider.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return { shares: [], total: 0 };
  const shares = [...byProvider.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([provider, tokens], i) => ({
      provider,
      tokens,
      pct: Math.max((tokens / total) * 100, 2),
      color: SHARE_COLORS[i % SHARE_COLORS.length],
    }));
  return { shares, total };
}

/**
 * Folds the per-day hourly histogram into a Monday-first weekday × hour
 * grid. Intensity is linear against the busiest cell.
 * @param summary - Aggregate returned by the `get_llm_usage` command.
 */
export function heatmapRows(summary: UsageSummary): { rows: HeatCell[][]; max: number } {
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  for (const [day, hours] of Object.entries(summary.hours ?? {})) {
    const date = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) continue;
    const weekday = (date.getUTCDay() + 6) % 7;
    hours.slice(0, 24).forEach((count, hour) => {
      grid[weekday][hour] += count;
    });
  }
  const max = Math.max(...grid.flat());
  const rows = grid.map((row, weekday) =>
    row.map((requests, hour) => ({
      weekday,
      hour,
      requests,
      intensity: max > 0 ? requests / max : 0,
    }))
  );
  return { rows, max };
}
