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
      total_cost: 0.05,
      model: 'Opus 4.6',
      context_window_size: 200000,
      total_output_tokens: 0,
    };
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const firstSpan = el.querySelector('[data-testid="session-stats"] span') as HTMLElement;
    expect(firstSpan.textContent?.trim()).toBe('Opus 4.6');
  });

  it('renders Claude fallback when model is undefined', () => {
    component.stats = {
      session_id: 'abc',
      total_cost: 0,
      context_window_size: 200000,
      total_output_tokens: 0,
    };
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Claude');
  });

  it('renders CTX bar from per-step usage', () => {
    component.stats = {
      session_id: 'abc',
      total_cost: 0.05,
      usage: {
        input_tokens: 3,
        output_tokens: 65,
        cache_read_tokens: 11204,
        cache_write_tokens: 11358,
      },
      context_window_size: 1000000,
      total_output_tokens: 65,
    };
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('CTX');
    // (3 + 11204 + 11358) / 1000000 = ~2%
    expect(el.textContent).toContain('2%');
  });

  it('does not render CTX when no usage', () => {
    component.stats = {
      session_id: 'abc',
      total_cost: 0,
      context_window_size: 200000,
      total_output_tokens: 0,
    };
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('CTX');
  });

  it('renders cache read and cache write tokens separately', () => {
    component.stats = {
      session_id: 'abc',
      total_cost: 0.05,
      usage: {
        input_tokens: 3,
        output_tokens: 65,
        cache_read_tokens: 22562,
        cache_write_tokens: 75,
      },
      context_window_size: 1000000,
      total_output_tokens: 65,
    };
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('In: 3');
    expect(el.textContent).toContain('CR: 22,562');
    expect(el.textContent).toContain('CW: 75');
    expect(el.textContent).toContain('Out: 65');
  });

  it('hides CR/CW when cache tokens are absent', () => {
    component.stats = {
      session_id: 'abc',
      total_cost: 0.05,
      usage: { input_tokens: 500, output_tokens: 100 },
      context_window_size: 200000,
      total_output_tokens: 100,
    };
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('In: 500');
    expect(el.textContent).not.toContain('CR:');
    expect(el.textContent).not.toContain('CW:');
    expect(el.textContent).toContain('Out: 100');
  });

  it('renders rate limit with utilization and reset time', () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    component.stats = {
      session_id: 'abc',
      total_cost: 0.05,
      rate_limit: { status: 'allowed_warning', utilization: 65, resets_at: resetEpoch },
      context_window_size: 200000,
      total_output_tokens: 0,
    };
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Limit');
    expect(el.textContent).toContain('65%');
    expect(el.textContent).toContain('reset');
  });

  it('does not render rate limit when absent', () => {
    component.stats = {
      session_id: 'abc',
      total_cost: 0,
      context_window_size: 200000,
      total_output_tokens: 0,
    };
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Limit');
  });

  it('renders cost when total_cost > 0', () => {
    component.stats = {
      session_id: 'abc',
      total_cost: 0.015,
      context_window_size: 200000,
      total_output_tokens: 0,
    };
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('$0.0150');
  });

  it('hides cost when total_cost is 0', () => {
    component.stats = {
      session_id: 'abc',
      total_cost: 0,
      context_window_size: 200000,
      total_output_tokens: 0,
    };
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('$');
  });

  it('computes ctxPct correctly', () => {
    component.stats = {
      session_id: 'abc',
      total_cost: 0,
      usage: { input_tokens: 100, output_tokens: 0, cache_read_tokens: 49900 },
      context_window_size: 200000,
      total_output_tokens: 0,
    };
    // (100 + 49900) / 200000 = 25%
    expect(component.ctxPct).toBe(25);
    expect(component.ctxFilled).toBe(1);
  });

  it('uses actual context_window_size', () => {
    component.stats = {
      session_id: 'abc',
      total_cost: 0,
      usage: { input_tokens: 3, output_tokens: 0, cache_read_tokens: 20000 },
      context_window_size: 1000000,
      total_output_tokens: 0,
    };
    // ~20k / 1M = 2%
    expect(component.ctxPct).toBe(2);
  });

  it('applies green bar color for low pct', () => {
    component.stats = {
      session_id: 'abc',
      total_cost: 0,
      usage: { input_tokens: 1000, output_tokens: 0 },
      context_window_size: 200000,
      total_output_tokens: 0,
    };
    expect(component.ctxBarColor).toBe('bg-green-500');
  });

  it('applies yellow bar color for medium pct', () => {
    component.stats = {
      session_id: 'abc',
      total_cost: 0,
      rate_limit: { status: 'allowed', utilization: 60, resets_at: null },
      context_window_size: 200000,
      total_output_tokens: 0,
    };
    expect(component.rlBarColor).toBe('bg-yellow-400');
  });

  it('applies bold red for critical pct', () => {
    component.stats = {
      session_id: 'abc',
      total_cost: 0,
      rate_limit: { status: 'rejected', utilization: 95, resets_at: null },
      context_window_size: 200000,
      total_output_tokens: 0,
    };
    expect(component.rlBarColor).toBe('bg-red-500');
    expect(component.rlTextColor).toContain('font-bold');
  });

  it('shows cumulative output tokens', () => {
    component.stats = {
      session_id: 'abc',
      total_cost: 0.05,
      usage: { input_tokens: 3, output_tokens: 100 },
      context_window_size: 200000,
      total_output_tokens: 500,
    };
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    // Out shows cumulative total, not per-step
    expect(el.textContent).toContain('Out: 500');
  });
});
