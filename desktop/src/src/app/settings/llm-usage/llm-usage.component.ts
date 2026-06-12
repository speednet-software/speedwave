import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
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

/**
 * LLM usage dashboard (ADR-073). Renders the aggregate returned by the
 * `get_llm_usage` Tauri command — the litellm callback JSONL is the single
 * source of truth here; per-session chat statistics (the stream-derived
 * numbers in `session-stats`) are intentionally NOT mixed in, the same
 * request would be counted twice.
 */
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
          <!-- Totals strip -->
          <div
            class="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 py-2"
            data-testid="llm-usage-totals"
          >
            <span
              >requests: <span class="text-[var(--ink)]">{{ num(s.totals.requests) }}</span></span
            >
            @if (s.totals.failures > 0) {
              <span
                >failures: <span class="text-[var(--red)]">{{ num(s.totals.failures) }}</span></span
              >
            }
            <span
              >in: <span class="text-[var(--teal)]">{{ num(s.totals.prompt_tokens) }}</span></span
            >
            <span
              >out:
              <span class="text-[var(--accent)]">{{ num(s.totals.completion_tokens) }}</span></span
            >
            @if (s.totals.cost_usd > 0) {
              <span
                >cost: <span class="text-[var(--ink)]">{{ usd(s.totals.cost_usd) }}</span></span
              >
            }
            @if (s.skipped_lines > 0) {
              <span data-testid="llm-usage-skipped"
                >({{ num(s.skipped_lines) }} records skipped)</span
              >
            }
          </div>

          <!-- Per-day, per-model table (newest day first) -->
          <table class="w-full border-collapse px-1" data-testid="llm-usage-table">
            <thead>
              <tr class="text-left text-[var(--ink-mute)]">
                <th class="py-1 pr-3 font-normal">day</th>
                <th class="py-1 pr-3 font-normal">model</th>
                <th class="py-1 pr-3 text-right font-normal">req</th>
                <th class="py-1 pr-3 text-right font-normal">in</th>
                <th class="py-1 pr-3 text-right font-normal">out</th>
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
                  <td class="py-1 text-right">
                    {{ row.bucket.cost_usd > 0 ? usd(row.bucket.cost_usd) : '—' }}
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
export class LlmUsageComponent implements OnInit {
  /** Project whose usage to display. */
  readonly project = input.required<string>();

  private tauri = inject(TauriService);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly summary = signal<UsageSummary | null>(null);
  readonly rows = signal<UsageRow[]>([]);

  /**
   * Fetches the aggregate on first render.
   */
  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  /** Fetches the aggregate; safe to call again (e.g. a future refresh button). */
  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const summary = await this.tauri.invoke<UsageSummary>('get_llm_usage', {
        project: this.project(),
      });
      this.summary.set(summary);
      this.rows.set(flattenRows(summary));
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
   * USD with 2 decimals (4 below 10 cents, where precision matters).
   * @param n - Cost in dollars.
   */
  usd(n: number): string {
    return `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
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
