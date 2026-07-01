import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  DAILY_CHART_DAYS,
  LlmUsageComponent,
  dailySeries,
  flattenRows,
  hasDeferrableUnpricedRows,
  heatmapRows,
  providerOf,
  providerShares,
} from './llm-usage.component';
import { TauriService } from '../../services/tauri.service';
import type { UsageBucket, UsageSummary } from '../../models/llm';

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    requests: 0,
    failures: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    cost_usd: 0,
    throughput_completion_tokens: 0,
    decode_latency_ms_sum: 0,
    ...overrides,
  };
}

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return { days: {}, hours: {}, totals: bucket(), skipped_lines: 0, ...overrides };
}

/**
 * Drains pending microtasks (refresh() chains awaits outside Zone).
 * @param cycles - Number of microtask ticks to drain before settling.
 */
async function flushMicrotasks(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    await Promise.resolve();
  }
}

describe('LlmUsageComponent', () => {
  async function setup(
    result: UsageSummary | Error
  ): Promise<{ fixture: ComponentFixture<LlmUsageComponent>; invoke: ReturnType<typeof vi.fn> }> {
    const invoke =
      result instanceof Error
        ? vi.fn().mockRejectedValue(result)
        : vi.fn().mockResolvedValue(result);
    await TestBed.configureTestingModule({
      imports: [LlmUsageComponent],
      providers: [{ provide: TauriService, useValue: { invoke } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(LlmUsageComponent);
    fixture.componentRef.setInput('project', 'proj');
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();
    return { fixture, invoke };
  }

  it('renders the empty state when no requests were recorded', async () => {
    const { fixture, invoke } = await setup(summary());
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="llm-usage-empty"]')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('get_llm_usage', { project: 'proj' });
  });

  it('refetches when the bound project changes (in-place switch)', async () => {
    const { fixture, invoke } = await setup(summary());
    invoke.mockClear();
    fixture.componentRef.setInput('project', 'other-proj');
    fixture.detectChanges();
    await flushMicrotasks();
    expect(invoke).toHaveBeenCalledWith('get_llm_usage', { project: 'other-proj' });
  });

  it('renders stat cards and per-day rows', async () => {
    const { fixture } = await setup(
      summary({
        totals: bucket({
          requests: 3,
          prompt_tokens: 50019,
          completion_tokens: 12,
          cost_usd: 0.005,
          cache_read: 25_010,
          throughput_completion_tokens: 12,
          decode_latency_ms_sum: 1200,
        }),
        days: {
          '2026-06-12': {
            'claude-haiku-4-5': bucket({ requests: 1, prompt_tokens: 50000, cost_usd: 0.005 }),
            'local/qwen3': bucket({ requests: 1, prompt_tokens: 14, completion_tokens: 2 }),
          },
          '2026-06-13': {
            'claude-opus-4-8': bucket({
              requests: 1,
              prompt_tokens: 5,
              completion_tokens: 10,
              cost_usd: null,
            }),
          },
        },
      })
    );
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="llm-usage-card-requests"]')?.textContent).toContain('3');
    // cache hit = 25010/50019 ≈ 50%
    expect(el.querySelector('[data-testid="llm-usage-card-cache"]')?.textContent).toContain('50%');
    // 12 completion tokens over 1.2s of latency = 10 tok/s
    expect(el.querySelector('[data-testid="llm-usage-card-speed"]')?.textContent).toContain(
      '10.0 tok/s'
    );
    expect(el.querySelector('[data-testid="llm-usage-card-cost"]')?.textContent).toContain(
      '$0.0050'
    );
    const rows = el.querySelectorAll('[data-testid="llm-usage-table"] tbody tr');
    expect(rows.length).toBe(3);
    // Newest day first.
    expect(rows[0].textContent).toContain('2026-06-13');
    // Unpriced (null cost, e.g. subscription) renders a dash, not $0.
    expect(rows[0].textContent).toContain('—');
  });

  it('renders $0 for a priced-zero (local) bucket, dash only for null', async () => {
    const { fixture } = await setup(
      summary({
        totals: bucket({ requests: 1, cost_usd: 0 }),
        days: {
          '2026-06-12': {
            'local/qwen3': bucket({ requests: 1, cost_usd: 0 }),
          },
        },
      })
    );
    const el: HTMLElement = fixture.nativeElement;
    // A genuine zero (free local) is priced — shows $0, never a dash.
    expect(el.querySelector('[data-testid="llm-usage-card-cost"]')?.textContent).toContain('$0');
    // The cost column (last cell) shows $0, not a dash.
    const rows = el.querySelectorAll('[data-testid="llm-usage-table"] tbody tr');
    const costCell = rows[0].querySelector('td:last-child');
    expect(costCell?.textContent).toContain('$0');
    expect(costCell?.textContent).not.toContain('—');
  });

  it('tags each table row with its provider-prefixed model and exposes the per-row cost cell', async () => {
    // Usage JSONL stores the model as `<provider_kind>/<model>` — assert both the
    // full data-model and a suffix match (how the E2E helper targets a row).
    const { fixture } = await setup(
      summary({
        totals: bucket({ requests: 2, cost_usd: 0.01 }),
        days: {
          '2026-06-12': {
            'local/unsloth/Qwen3.6-35B-A3B': bucket({ requests: 1, cost_usd: null }),
            'openrouter/openai/gpt-4o': bucket({ requests: 1, cost_usd: 0.01 }),
          },
        },
      })
    );
    const el: HTMLElement = fixture.nativeElement;
    const localRow = el.querySelector(
      '[data-testid="llm-usage-row"][data-model$="unsloth/Qwen3.6-35B-A3B"]'
    );
    expect(localRow).not.toBeNull();
    expect(localRow?.getAttribute('data-model')).toBe('local/unsloth/Qwen3.6-35B-A3B');
    // The unpriced local model shows "—" in its own per-row cost cell.
    expect(localRow?.querySelector('[data-testid="llm-usage-row-cost"]')?.textContent).toContain(
      '—'
    );
    // The priced OpenRouter row shows a $ figure, not a dash.
    const orRow = el.querySelector(
      '[data-testid="llm-usage-row"][data-model="openrouter/openai/gpt-4o"]'
    );
    expect(orRow?.querySelector('[data-testid="llm-usage-row-cost"]')?.textContent).toContain('$');
  });

  it('renders the daily chart, provider bar and heatmap when data exists', async () => {
    const { fixture } = await setup(
      summary({
        totals: bucket({ requests: 2, prompt_tokens: 110, completion_tokens: 20 }),
        days: {
          '2026-06-12': {
            'claude-haiku-4-5': bucket({ requests: 1, prompt_tokens: 100, completion_tokens: 10 }),
            'local/qwen3': bucket({ requests: 1, prompt_tokens: 10, completion_tokens: 10 }),
          },
        },
        hours: { '2026-06-12': [...Array(10).fill(0), 2, ...Array(13).fill(0)] },
      })
    );
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('[data-testid="llm-usage-daily-bar"]').length).toBe(1);
    const legend = el.querySelector('[data-testid="llm-usage-provider-legend"]')!.textContent!;
    expect(legend).toContain('anthropic');
    expect(legend).toContain('local');
    expect(el.querySelector('[data-testid="llm-usage-heatmap"]')).toBeTruthy();
  });

  it('omits the heatmap when no hourly data was recorded', async () => {
    const { fixture } = await setup(
      summary({
        totals: bucket({ requests: 1, prompt_tokens: 1 }),
        days: { '2026-06-12': { m: bucket({ requests: 1, prompt_tokens: 1 }) } },
      })
    );
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="llm-usage-heatmap"]')).toBeNull();
  });

  it('shows zero-failure errors card in default ink and failures in red', async () => {
    const { fixture } = await setup(
      summary({
        totals: bucket({ requests: 4, failures: 1, prompt_tokens: 1 }),
        days: { '2026-06-12': { m: bucket({ requests: 4, failures: 1, prompt_tokens: 1 }) } },
      })
    );
    const el: HTMLElement = fixture.nativeElement;
    const errors = el.querySelector<HTMLElement>('[data-testid="llm-usage-card-errors"]')!;
    expect(errors.textContent).toContain('1');
    expect(errors.textContent).toContain('(25%)');
    expect(errors.style.color).toBe('var(--red)');
  });

  it('surfaces skipped-line counts instead of hiding them', async () => {
    const { fixture } = await setup(
      summary({
        totals: bucket({ requests: 1 }),
        days: { '2026-06-12': { m: bucket({ requests: 1 }) } },
        skipped_lines: 2,
      })
    );
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="llm-usage-skipped"]')?.textContent).toContain('2');
  });

  it('shows the error state when the command fails', async () => {
    const { fixture } = await setup(new Error('boom'));
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="llm-usage-error"]')?.textContent).toContain('boom');
  });
});

describe('LlmUsageComponent metrics', () => {
  async function makeComponent(): Promise<LlmUsageComponent> {
    await TestBed.configureTestingModule({
      imports: [LlmUsageComponent],
      providers: [
        { provide: TauriService, useValue: { invoke: vi.fn().mockResolvedValue(summary()) } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LlmUsageComponent);
    fixture.componentRef.setInput('project', 'proj');
    return fixture.componentInstance;
  }

  it('clamps cache hit rate to 100% when cache_read exceeds reported prompt tokens', async () => {
    const c = await makeComponent();
    // Anthropic streamed records: prompt_tokens excludes cached.
    expect(c.cacheHitRate(bucket({ prompt_tokens: 100, cache_read: 20_000 }))).toBeLessThanOrEqual(
      1
    );
    // Normal OpenAI-style inclusive counts: 50% stays 50%.
    expect(c.cacheHitRate(bucket({ prompt_tokens: 100, cache_read: 50 }))).toBeCloseTo(0.5);
    expect(c.cacheHitRate(bucket({ prompt_tokens: 0, cache_read: 0 }))).toBe(0);
  });

  it('computes tok/s from decode time (latency minus ttft)', async () => {
    const c = await makeComponent();
    // 12 tokens over 1.2 s of decode time = 10 tok/s.
    expect(
      c.tokensPerSec(bucket({ throughput_completion_tokens: 12, decode_latency_ms_sum: 1200 }))
    ).toBeCloseTo(10);
    // No decode time → null (not a divide-by-zero or inflated rate).
    expect(
      c.tokensPerSec(bucket({ completion_tokens: 9999, decode_latency_ms_sum: 0 }))
    ).toBeNull();
  });
});

describe('flattenRows', () => {
  it('orders newest day first, models alphabetically within a day', () => {
    const rows = flattenRows(
      summary({
        days: {
          '2026-06-11': { b: bucket(), a: bucket() },
          '2026-06-12': { z: bucket() },
        },
      })
    );
    expect(rows.map((r) => `${r.day}:${r.model}`)).toEqual([
      '2026-06-12:z',
      '2026-06-11:a',
      '2026-06-11:b',
    ]);
  });

  it('returns no rows for an empty summary', () => {
    expect(flattenRows(summary())).toEqual([]);
  });
});

describe('providerOf', () => {
  it('takes the prefix before the first slash', () => {
    expect(providerOf('local/unsloth/Qwen3.6-35B-A3B')).toBe('local');
    expect(providerOf('openrouter/meta/llama-4')).toBe('openrouter');
  });

  it('maps bare model ids to anthropic', () => {
    expect(providerOf('claude-haiku-4-5')).toBe('anthropic');
  });

  it('does not treat a leading slash as an empty provider', () => {
    expect(providerOf('/weird')).toBe('anthropic');
  });
});

describe('dailySeries', () => {
  it('sums models per day, oldest first, scaled to the tallest bar', () => {
    const bars = dailySeries(
      summary({
        days: {
          '2026-06-12': {
            a: bucket({ prompt_tokens: 60, completion_tokens: 20 }),
            b: bucket({ prompt_tokens: 20 }),
          },
          '2026-06-11': { a: bucket({ prompt_tokens: 50 }) },
        },
      })
    );
    expect(bars.map((b) => b.day)).toEqual(['2026-06-11', '2026-06-12']);
    expect(bars[1].promptTokens).toBe(80);
    expect(bars[1].completionTokens).toBe(20);
    // Tallest bar (100 tokens) fills 100%: 80% prompt + 20% completion.
    expect(bars[1].promptPct).toBe(80);
    expect(bars[1].completionPct).toBe(20);
    expect(bars[0].promptPct).toBe(50);
    expect(bars[0].label).toBe('06-11');
  });

  it('caps the series at the chart window', () => {
    const days: UsageSummary['days'] = {};
    for (let i = 1; i <= DAILY_CHART_DAYS + 5; i++) {
      days[`2026-05-${String(i).padStart(2, '0')}`] = { m: bucket({ prompt_tokens: 1 }) };
    }
    expect(dailySeries(summary({ days })).length).toBe(DAILY_CHART_DAYS);
  });

  it('returns an empty series for an empty summary', () => {
    expect(dailySeries(summary())).toEqual([]);
  });
});

describe('providerShares', () => {
  it('orders providers by tokens and reports the grand total', () => {
    const { shares, total } = providerShares(
      summary({
        days: {
          '2026-06-12': {
            'claude-haiku-4-5': bucket({ prompt_tokens: 10 }),
            'local/qwen3': bucket({ prompt_tokens: 80, completion_tokens: 10 }),
          },
        },
      })
    );
    expect(total).toBe(100);
    expect(shares.map((s) => s.provider)).toEqual(['local', 'anthropic']);
    expect(shares[0].pct).toBe(90);
  });

  it('floors sliver segments at 2% width', () => {
    const { shares } = providerShares(
      summary({
        days: {
          '2026-06-12': {
            'local/qwen3': bucket({ prompt_tokens: 9990 }),
            'claude-haiku-4-5': bucket({ prompt_tokens: 10 }),
          },
        },
      })
    );
    expect(shares[1].pct).toBe(2);
  });

  it('returns no shares when there are no tokens', () => {
    expect(providerShares(summary())).toEqual({ shares: [], total: 0 });
  });
});

describe('heatmapRows', () => {
  it('folds days onto a Monday-first weekday grid and scales intensity', () => {
    // 2026-06-12 is a Friday (weekday index 4), 2026-06-08 a Monday (0).
    const hours = Array(24).fill(0) as number[];
    const { rows, max } = heatmapRows(
      summary({
        hours: {
          '2026-06-12': [...hours.slice(0, 10), 4, ...hours.slice(11)],
          '2026-06-08': [...hours.slice(0, 10), 2, ...hours.slice(11)],
        },
      })
    );
    expect(max).toBe(4);
    expect(rows.length).toBe(7);
    expect(rows[4][10].requests).toBe(4);
    expect(rows[4][10].intensity).toBe(1);
    expect(rows[0][10].requests).toBe(2);
    expect(rows[0][10].intensity).toBe(0.5);
    expect(rows[6][0].requests).toBe(0);
  });

  it('sums the same weekday across weeks', () => {
    const hours = Array(24).fill(0) as number[];
    const { rows } = heatmapRows(
      summary({
        hours: {
          '2026-06-05': [...hours.slice(0, 9), 1, ...hours.slice(10)],
          '2026-06-12': [...hours.slice(0, 9), 2, ...hours.slice(10)],
        },
      })
    );
    expect(rows[4][9].requests).toBe(3);
  });

  it('ignores malformed day keys and missing hours maps', () => {
    const { rows, max } = heatmapRows(summary({ hours: { 'not-a-date': [1, 2, 3] } }));
    expect(max).toBe(0);
    expect(rows.flat().every((c) => c.requests === 0)).toBe(true);
    // Older payloads without an `hours` field at all.
    const legacy = heatmapRows({ ...summary(), hours: undefined as never });
    expect(legacy.max).toBe(0);
  });
});

describe('hasDeferrableUnpricedRows', () => {
  it('is true for a null-cost OpenRouter row (deferred enrichment pending)', () => {
    const s = summary({
      days: {
        '2026-06-12': { 'openrouter/openai/gpt-4o': bucket({ requests: 1, cost_usd: null }) },
      },
    });
    expect(hasDeferrableUnpricedRows(s)).toBe(true);
  });

  it('is false when every null-cost row is permanently unpriced (local/anthropic)', () => {
    const s = summary({
      days: {
        '2026-06-12': {
          'local/unsloth/Qwen3.6-35B-A3B': bucket({ requests: 1, cost_usd: null }),
          'claude-opus-4-8': bucket({ requests: 1, cost_usd: null }),
        },
      },
    });
    expect(hasDeferrableUnpricedRows(s)).toBe(false);
  });

  it('is true when a deferrable null-cost row hides among permanently-unpriced ones', () => {
    const s = summary({
      days: {
        '2026-06-12': { 'local/qwen3': bucket({ requests: 1, cost_usd: null }) },
        '2026-06-13': { 'openrouter/x': bucket({ requests: 1, cost_usd: null }) },
      },
    });
    expect(hasDeferrableUnpricedRows(s)).toBe(true);
  });

  it('ignores priced rows and is false for an empty summary', () => {
    const priced = summary({
      days: { '2026-06-12': { 'openrouter/x': bucket({ requests: 1, cost_usd: 0.01 }) } },
    });
    expect(hasDeferrableUnpricedRows(priced)).toBe(false);
    expect(hasDeferrableUnpricedRows(summary())).toBe(false);
  });

  it('treats an unknown custom provider prefix as deferrable (conservative)', () => {
    const s = summary({
      days: { '2026-06-12': { 'my-router/m': bucket({ requests: 1, cost_usd: null }) } },
    });
    expect(hasDeferrableUnpricedRows(s)).toBe(true);
  });
});

describe('LlmUsageComponent deferred re-poll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Unpriced aggregate with a deferrable (OpenRouter) row — re-poll eligible. */
  function deferredSummary(): UsageSummary {
    return summary({
      totals: bucket({ requests: 1, cost_usd: null }),
      days: {
        '2026-06-12': { 'openrouter/openai/gpt-4o': bucket({ requests: 1, cost_usd: null }) },
      },
    });
  }

  /**
   * Priced aggregate (enrichment landed).
   * @param cost - Total cost the enrichment resolved to.
   */
  function pricedSummary(cost: number): UsageSummary {
    return summary({
      totals: bucket({ requests: 1, cost_usd: cost }),
      days: {
        '2026-06-12': { 'openrouter/openai/gpt-4o': bucket({ requests: 1, cost_usd: cost }) },
      },
    });
  }

  /**
   * Mounts the component bound to project `proj` and settles the initial fetch.
   * @param invoke - TauriService.invoke mock backing `get_llm_usage`.
   */
  async function mount(
    invoke: ReturnType<typeof vi.fn>
  ): Promise<ComponentFixture<LlmUsageComponent>> {
    await TestBed.configureTestingModule({
      imports: [LlmUsageComponent],
      providers: [{ provide: TauriService, useValue: { invoke } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(LlmUsageComponent);
    fixture.componentRef.setInput('project', 'proj');
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    return fixture;
  }

  it('re-polls an unpriced (deferred) aggregate until the cost is enriched', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(deferredSummary()) // initial mount fetch: unpriced
      .mockResolvedValue(pricedSummary(0.0003)); // re-poll fetch: priced
    const fixture = await mount(invoke);
    expect(fixture.componentInstance.summary()?.totals.cost_usd).toBeNull();

    // First backoff tick (2s) fires the re-poll, which returns the priced value.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.componentInstance.summary()?.totals.cost_usd).toBe(0.0003);
    expect(invoke).toHaveBeenCalledTimes(2);
    fixture.destroy();
  });

  it('does not re-poll once the aggregate is already priced', async () => {
    const invoke = vi.fn().mockResolvedValue(pricedSummary(0.0003));
    const fixture = await mount(invoke);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(invoke).toHaveBeenCalledTimes(1);
    fixture.destroy();
  });

  it('never re-polls a permanently-unpriced aggregate (local + subscription rows)', async () => {
    const unpriced = summary({
      totals: bucket({ requests: 2, cost_usd: null }),
      days: {
        '2026-06-12': {
          'local/qwen3': bucket({ requests: 1, cost_usd: null }),
          'claude-opus-4-8': bucket({ requests: 1, cost_usd: null }),
        },
      },
    });
    const invoke = vi.fn().mockResolvedValue(unpriced);
    const fixture = await mount(invoke);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(invoke).toHaveBeenCalledTimes(1);
    // Unpriced stays null → the dash, never coerced to $0 (invariant 6).
    expect(fixture.componentInstance.summary()?.totals.cost_usd).toBeNull();
    fixture.destroy();
  });

  it('stops re-polling after the last backoff step (bounded, never a poll loop)', async () => {
    const invoke = vi.fn().mockResolvedValue(deferredSummary());
    const fixture = await mount(invoke);
    // All five backoff steps: 2+4+8+15+30 s = 59 s → 1 mount fetch + 5 re-polls.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(invoke).toHaveBeenCalledTimes(6);
    // Exhausted: no sixth re-poll no matter how long we wait.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(invoke).toHaveBeenCalledTimes(6);
    fixture.destroy();
  });

  it('drops a stale re-poll response after the project changed mid-flight', async () => {
    let resolveStale: (s: UsageSummary) => void = () => undefined;
    const stale = new Promise<UsageSummary>((resolve) => {
      resolveStale = resolve;
    });
    let projCalls = 0;
    const invoke = vi.fn((_cmd: string, args: { project: string }): Promise<UsageSummary> => {
      if (args.project === 'other') return Promise.resolve(pricedSummary(0.42));
      projCalls++;
      return projCalls === 1 ? Promise.resolve(deferredSummary()) : stale;
    });
    const fixture = await mount(invoke);

    // Re-poll for 'proj' fires and is left in flight (unresolved promise).
    await vi.advanceTimersByTimeAsync(2_000);
    fixture.componentRef.setInput('project', 'other');
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.componentInstance.summary()?.totals.cost_usd).toBe(0.42);

    // The stale 'proj' response must neither apply nor re-schedule.
    resolveStale(pricedSummary(0.99));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.componentInstance.summary()?.totals.cost_usd).toBe(0.42);
    const projCallsAfterStale = projCalls;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(projCalls).toBe(projCallsAfterStale);
    fixture.destroy();
  });
});
