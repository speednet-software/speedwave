import { describe, it, expect, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LlmUsageComponent, flattenRows } from './llm-usage.component';
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
    ...overrides,
  };
}

function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return { days: {}, totals: bucket(), skipped_lines: 0, ...overrides };
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

  it('renders totals and per-day rows', async () => {
    const { fixture } = await setup(
      summary({
        totals: bucket({
          requests: 3,
          prompt_tokens: 50019,
          completion_tokens: 12,
          cost_usd: 0.005,
        }),
        days: {
          '2026-06-12': {
            'claude-haiku-4-5': bucket({ requests: 1, prompt_tokens: 50000, cost_usd: 0.005 }),
            'local/qwen3': bucket({ requests: 1, prompt_tokens: 14, completion_tokens: 2 }),
          },
          '2026-06-13': {
            'local/qwen3': bucket({ requests: 1, prompt_tokens: 5, completion_tokens: 10 }),
          },
        },
      })
    );
    const el: HTMLElement = fixture.nativeElement;
    const totals = el.querySelector('[data-testid="llm-usage-totals"]')!.textContent!;
    expect(totals).toContain('50,019');
    expect(totals).toContain('$0.0050');
    const rows = el.querySelectorAll('[data-testid="llm-usage-table"] tbody tr');
    expect(rows.length).toBe(3);
    // Newest day first.
    expect(rows[0].textContent).toContain('2026-06-13');
    // Local models with no pricing render a dash, not $0.
    expect(rows[0].textContent).toContain('—');
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
