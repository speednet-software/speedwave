import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SessionStatsComponent } from './session-stats.component';

describe('SessionStatsComponent', () => {
  let component: SessionStatsComponent;
  let fixture: ComponentFixture<SessionStatsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionStatsComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(SessionStatsComponent);
    component = fixture.componentInstance;
  });

  it('renders nothing when stats is null', () => {
    component.stats = null;
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="session-stats"]')).toBeNull();
  });

  it('renders model name', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0.01,
      total_cost: 0.05,
      model: 'Opus 4.6',
      cumulative_input_tokens: 1000,
      cumulative_output_tokens: 200,
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Opus 4.6');
    const statsDiv = el.querySelector('[data-testid="session-stats"]') as HTMLElement;
    const firstSpan = statsDiv.querySelector('span') as HTMLElement;
    expect(firstSpan.textContent?.trim()).toBe('Opus 4.6');
  });

  it('renders Claude fallback when model is undefined', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0.01,
      total_cost: 0.05,
      cumulative_input_tokens: 0,
      cumulative_output_tokens: 0,
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Claude');
  });

  it('renders Claude fallback when model is empty string', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0.01,
      total_cost: 0.05,
      model: '',
      cumulative_input_tokens: 0,
      cumulative_output_tokens: 0,
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Claude');
  });

  it('renders CTX bar and cumulative token counts', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0.01,
      total_cost: 0.05,
      usage: { input_tokens: 50000, output_tokens: 1000 },
      cumulative_input_tokens: 50000,
      cumulative_output_tokens: 1000,
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('CTX');
    expect(el.textContent).toContain('%');
    expect(el.textContent).toContain('50,000');
    expect(el.textContent).toContain('1,000');
  });

  it('does not render CTX section when cumulative tokens are 0', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0.01,
      total_cost: 0.05,
      cumulative_input_tokens: 0,
      cumulative_output_tokens: 0,
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('CTX');
  });

  it('renders rate limit with utilization and reset time', () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    component.stats = {
      session_id: 'abc',
      cost_usd: 0.01,
      total_cost: 0.05,
      rate_limit: { utilization: 65, resets_at: resetEpoch },
      cumulative_input_tokens: 1000,
      cumulative_output_tokens: 200,
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Limit');
    expect(el.textContent).toContain('65%');
    expect(el.textContent).toContain('reset');
  });

  it('does not render rate limit section when absent', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0.01,
      total_cost: 0.05,
      cumulative_input_tokens: 0,
      cumulative_output_tokens: 0,
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('Limit');
  });

  it('renders cost when total_cost > 0', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0.003,
      total_cost: 0.015,
      cumulative_input_tokens: 0,
      cumulative_output_tokens: 0,
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('$0.0150');
  });

  it('does not render cost when total_cost is 0', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0,
      total_cost: 0,
      cumulative_input_tokens: 0,
      cumulative_output_tokens: 0,
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Claude');
    expect(el.textContent).not.toContain('$0.0000');
  });

  it('renders divider separators between sections', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0.01,
      total_cost: 0.05,
      usage: { input_tokens: 100, output_tokens: 50 },
      cumulative_input_tokens: 100,
      cumulative_output_tokens: 50,
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const spans = Array.from(el.querySelectorAll('span'));
    const dividers = spans.filter((s) => s.textContent?.trim() === '│');
    expect(dividers.length).toBeGreaterThanOrEqual(2);
  });

  it('computes ctxPct correctly for 200k window', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0,
      total_cost: 0,
      cumulative_input_tokens: 100000,
      cumulative_output_tokens: 0,
    };
    expect(component.ctxPct).toBe(50);
    expect(component.ctxFilled).toBe(3);
  });

  it('computes ctxPct 0 when no cumulative tokens', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0,
      total_cost: 0,
      cumulative_input_tokens: 0,
      cumulative_output_tokens: 0,
    };
    expect(component.ctxPct).toBe(0);
  });

  it('uses 1M window when cumulative input exceeds 180k', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0,
      total_cost: 0,
      cumulative_input_tokens: 200000,
      cumulative_output_tokens: 0,
    };
    // 200k / 1M = 20%
    expect(component.ctxPct).toBe(20);
  });

  it('applies green bar color for low pct', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0,
      total_cost: 0,
      cumulative_input_tokens: 10000,
      cumulative_output_tokens: 0,
    };
    expect(component.ctxBarColor).toBe('bg-green-500');
    expect(component.ctxTextColor).toBe('text-green-500');
  });

  it('renders rate limit without reset time', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0.01,
      total_cost: 0.05,
      rate_limit: { utilization: 30, resets_at: null },
      cumulative_input_tokens: 1000,
      cumulative_output_tokens: 200,
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Limit');
    expect(el.textContent).toContain('30%');
    expect(el.textContent).not.toContain('reset');
  });

  it('applies yellow bar color for medium pct', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0,
      total_cost: 0,
      rate_limit: { utilization: 60, resets_at: null },
      cumulative_input_tokens: 0,
      cumulative_output_tokens: 0,
    };
    expect(component.rlBarColor).toBe('bg-yellow-400');
    expect(component.rlTextColor).toBe('text-yellow-400');
  });

  it('applies red bar color for high pct', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0,
      total_cost: 0,
      rate_limit: { utilization: 80, resets_at: null },
      cumulative_input_tokens: 0,
      cumulative_output_tokens: 0,
    };
    expect(component.rlBarColor).toBe('bg-red-400');
  });

  it('applies bold red for critical pct', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0,
      total_cost: 0,
      rate_limit: { utilization: 95, resets_at: null },
      cumulative_input_tokens: 0,
      cumulative_output_tokens: 0,
    };
    expect(component.rlBarColor).toBe('bg-red-500');
    expect(component.rlTextColor).toContain('font-bold');
  });

  it('accumulates tokens across multiple turns', () => {
    component.stats = {
      session_id: 'abc',
      cost_usd: 0.01,
      total_cost: 0.03,
      usage: { input_tokens: 5000, output_tokens: 500 },
      cumulative_input_tokens: 15000,
      cumulative_output_tokens: 1500,
    };
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    // Shows cumulative, not per-turn
    expect(el.textContent).toContain('15,000');
    expect(el.textContent).toContain('1,500');
  });
});
