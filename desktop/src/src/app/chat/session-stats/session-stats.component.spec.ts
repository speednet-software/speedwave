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

  function rootText(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  // ── null / empty stats ─────────────────────────────────────────────────
  describe('null stats', () => {
    it('renders nothing when stats is null', () => {
      fixture.componentRef.setInput('stats', null);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="session-stats"]')).toBeNull();
    });
  });

  // ── happy path ─────────────────────────────────────────────────────────
  describe('happy path', () => {
    it('renders `in:` total at the start of the row', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0.05,
        usage: { input_tokens: 3, output_tokens: 65 },
        context_window_size: 200000,
        total_output_tokens: 65,
      });
      fixture.detectChanges();
      expect(rootText()).toContain('in:');
      expect(rootText()).toContain('3');
    });

    it('renders nothing for in/out when usage is undefined', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      // No usage → no in/out segments rendered.
      expect(rootText()).not.toContain('in:');
      expect(rootText()).not.toContain('out:');
    });

    it('renders ctx bar from per-step usage', () => {
      fixture.componentRef.setInput('stats', {
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
      });
      fixture.detectChanges();
      const txt = rootText();
      expect(txt).toContain('ctx');
      // ~2% = 22,565 / 1,000,000
      expect(txt).toContain('2%');
    });

    it('renders in/out from usage in mockup-shaped form', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0.05,
        usage: {
          input_tokens: 1234,
          output_tokens: 65,
          cache_read_tokens: 22562,
          cache_write_tokens: 75,
        },
        context_window_size: 1000000,
        total_output_tokens: 65,
      });
      fixture.detectChanges();
      const txt = rootText();
      // in: = input_tokens only (new uncached input), NOT input + cache.
      // cache_read (22,562 = re-sent history) must NOT inflate `in:`.
      expect(txt).toContain('in:');
      expect(txt).toContain('1,234');
      expect(txt).not.toContain('23,871'); // 1234 + 22562 + 75 — the old (wrong) totalInput
      expect(txt).toContain('out:');
      expect(txt).toContain('65');
    });

    it('renders cost in dollars to 4 decimal places under the `session:` label', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0.018,
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      expect(rootText()).toContain('session:');
      expect(rootText()).toContain('$0.0180');
    });

    it('formats thousands with commas in en-US', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0.05,
        usage: { input_tokens: 12345, output_tokens: 0 },
        context_window_size: 200000,
        total_output_tokens: 67890,
      });
      fixture.detectChanges();
      const txt = rootText();
      expect(txt).toContain('12,345');
      expect(txt).toContain('67,890');
    });

    it('renders rate-limit block when rate_limit is set, including reset time', () => {
      const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        rate_limit: { status: 'allowed_warning', utilization: 65, resets_at: resetEpoch },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      const txt = rootText();
      expect(txt).toContain('limit');
      expect(txt).toContain('65%');
      expect(txt).toContain('resets');
    });

    it('renders compact used/max label next to ctx bar', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        usage: { input_tokens: 100, output_tokens: 0, cache_read_tokens: 116_000 },
        context_window_size: 200_000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      expect(rootText()).toContain('116k/200k');
    });
  });

  // ── regression: `in:` must not echo the context numerator ───────────────
  describe('in: vs ctx separation (regression)', () => {
    it('reproduces the screenshot: short chat shows small `in:` but full ctx gauge', () => {
      // Real session: a tiny new message (181 input) on top of a large
      // re-sent prompt served from cache (181,532). The ctx gauge correctly
      // shows the full occupancy (~182k / 1M = 18%), but `in:` must show only
      // the 181 new tokens — NOT the 181,713 it used to echo from the gauge.
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0.5,
        usage: {
          input_tokens: 181,
          output_tokens: 65,
          cache_read_tokens: 181_532,
          cache_write_tokens: 0,
        },
        context_window_size: 1_000_000,
        total_output_tokens: 1621,
      });
      fixture.detectChanges();
      // ctx gauge unchanged — full occupancy is correct.
      expect(component.ctxTotal()).toBe(181_713);
      expect(component.ctxPct()).toBe(18);
      expect(component.ctxUsedMax()).toBe('182k/1M');
      // `in:` shows only the new uncached input, not the gauge numerator.
      expect(component.inboundTokens()).toBe(181);
      const txt = rootText();
      expect(txt).toContain('181');
      expect(txt).not.toContain('181,713');
    });

    it('does not sum input across turns — gauge reflects only the latest turn', () => {
      // Each turn re-sends history, so cache_read grows turn over turn. The
      // gauge must track the LATEST turn (replacement), never the running sum.
      const set = (cacheRead: number) =>
        fixture.componentRef.setInput('stats', {
          session_id: 'abc',
          total_cost: 0,
          usage: { input_tokens: 200, output_tokens: 50, cache_read_tokens: cacheRead },
          context_window_size: 1_000_000,
          total_output_tokens: 50,
        });
      set(20_000);
      fixture.detectChanges();
      expect(component.ctxPct()).toBe(2);
      set(90_000);
      fixture.detectChanges();
      expect(component.ctxPct()).toBe(9);
      set(181_000);
      fixture.detectChanges();
      // Latest turn → 181,200 / 1M = 18%. NOT the sum (~291k → 29%).
      expect(component.ctxTotal()).toBe(181_200);
      expect(component.ctxPct()).toBe(18);
    });

    it('handles a local model (no prompt cache): in: equals the whole prompt', () => {
      // Local LLM has no prompt cache — cache fields are absent. `in:` then
      // equals input_tokens (the whole prompt), and the gauge matches it.
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        usage: { input_tokens: 4500, output_tokens: 120 },
        context_window_size: 32_768,
        total_output_tokens: 120,
      });
      fixture.detectChanges();
      expect(component.inboundTokens()).toBe(4500);
      expect(component.ctxTotal()).toBe(4500);
      expect(component.ctxPct()).toBe(14); // 4500 / 32768
    });

    it('hides the ctx gauge for a local model with unknown window (ADR-041)', () => {
      // No advertised window → ctxPct null → gauge hidden, never fabricated.
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        usage: { input_tokens: 4500, output_tokens: 120 },
        context_window_size: null,
        total_output_tokens: 120,
      });
      fixture.detectChanges();
      expect(component.inboundTokens()).toBe(4500);
      expect(component.ctxPct()).toBeNull();
      expect(rootText()).toContain('in:');
    });
  });

  // ── edge cases ─────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('hides ctx segment when no usage', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      expect(rootText()).not.toContain('ctx');
    });

    it('hides rate-limit segment when rate_limit is absent', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      expect(rootText()).not.toContain('limit');
    });

    it('hides session cost label when total_cost is 0', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      expect(rootText()).not.toContain('$');
      expect(rootText()).not.toContain('session:');
    });

    it('renders in/out without cr/cw breakdown when cache tokens are absent', () => {
      // The terminal-minimal layout collapses cr/cw into the `in:` total —
      // cr/cw are no longer surfaced as their own segments.
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0.05,
        usage: { input_tokens: 500, output_tokens: 100 },
        context_window_size: 200000,
        total_output_tokens: 100,
      });
      fixture.detectChanges();
      const txt = rootText();
      expect(txt).toContain('in:');
      expect(txt).toContain('500');
      expect(txt).not.toContain('cr ');
      expect(txt).not.toContain('cw ');
      expect(txt).toContain('out:');
      expect(txt).toContain('100');
    });

    it('uses configured context_window_size (not default)', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        usage: { input_tokens: 3, output_tokens: 0, cache_read_tokens: 20000 },
        context_window_size: 1_000_000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      // ~20k / 1M = 2%
      expect(component.ctxPct()).toBe(2);
    });

    it('clamps ctxPct to 100 when usage exceeds window', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        usage: { input_tokens: 500_000, output_tokens: 0, cache_read_tokens: 500_000 },
        context_window_size: 200_000,
        total_output_tokens: 0,
      });
      expect(component.ctxPct()).toBe(100);
    });
  });

  // ── percentage bucket colors (state transitions) ───────────────────────
  describe('percentage bucket colors', () => {
    it('applies green for 0–49%', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        usage: { input_tokens: 20000, output_tokens: 0 },
        context_window_size: 200000, // 10%
        total_output_tokens: 0,
      });
      expect(component.ctxBarColor()).toBe('bg-[var(--green)]');
    });

    it('applies amber for 50–76%', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        rate_limit: { status: 'allowed', utilization: 60, resets_at: null },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      expect(component.rlBarColor()).toBe('bg-[var(--amber)]');
    });

    it('applies amber at boundary 50', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        rate_limit: { status: 'allowed', utilization: 50, resets_at: null },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      expect(component.rlBarColor()).toBe('bg-[var(--amber)]');
    });

    it('applies red-500 for ≥77%', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        rate_limit: { status: 'rejected', utilization: 90, resets_at: null },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      expect(component.rlBarColor()).toBe('bg-red-500');
    });

    it('applies red-500 at boundary 77', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        rate_limit: { status: 'rejected', utilization: 77, resets_at: null },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      expect(component.rlBarColor()).toBe('bg-red-500');
    });

    it('rounds 30% → 2 filled (out of 5)', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        usage: { input_tokens: 60_000, output_tokens: 0 },
        context_window_size: 200_000, // 30%
        total_output_tokens: 0,
      });
      expect(component.ctxPct()).toBe(30);
      expect(component.ctxFilled()).toBe(2);
    });

    it('rounds 80% → 4 filled (out of 5)', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        usage: { input_tokens: 160_000, output_tokens: 0 },
        context_window_size: 200_000, // 80%
        total_output_tokens: 0,
      });
      expect(component.ctxPct()).toBe(80);
      expect(component.ctxFilled()).toBe(4);
    });

    it('fills 5 segments at 100%', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        rate_limit: { status: 'rejected', utilization: 100, resets_at: null },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      expect(component.rlFilled()).toBe(5);
    });

    it('fills 0 segments at 0%', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        rate_limit: { status: 'allowed', utilization: 0, resets_at: null },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      expect(component.rlFilled()).toBe(0);
    });
  });

  // ── ARIA ───────────────────────────────────────────────────────────────
  describe('ARIA', () => {
    it('sets aria-label on ctx bar describing percentage', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        usage: { input_tokens: 1000, output_tokens: 0 },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const bars = el.querySelectorAll('[aria-label^="Context:"]');
      expect(bars.length).toBe(1);
      expect(bars[0].getAttribute('aria-label')).toMatch(/Context: \d+% used/);
    });

    it('sets aria-label on rate-limit bar describing percentage', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        rate_limit: { status: 'allowed', utilization: 42, resets_at: null },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const bars = el.querySelectorAll('[aria-label^="Rate limit:"]');
      expect(bars.length).toBe(1);
      expect(bars[0].getAttribute('aria-label')).toBe('Rate limit: 42% used');
    });
  });

  // ── cumulative output tokens ───────────────────────────────────────────
  describe('cumulative output tokens', () => {
    it('shows cumulative total_output_tokens (not per-step output)', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0.05,
        usage: { input_tokens: 3, output_tokens: 100 },
        context_window_size: 200000,
        total_output_tokens: 500,
      });
      fixture.detectChanges();
      // Out shows cumulative total, not per-step
      expect(rootText()).toContain('out:');
      expect(rootText()).toContain('500');
    });
  });

  // ── git branch chip ────────────────────────────────────────────────────
  describe('git branch chip', () => {
    it('hides the chip when branch input is null', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0.01,
        usage: { input_tokens: 1, output_tokens: 1 },
        context_window_size: 200000,
        total_output_tokens: 1,
      });
      fixture.componentRef.setInput('branch', null);
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="session-stats-branch"]')
      ).toBeNull();
    });

    it('renders the branch name when branch input is set', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0.01,
        usage: { input_tokens: 1, output_tokens: 1 },
        context_window_size: 200000,
        total_output_tokens: 1,
      });
      fixture.componentRef.setInput('branch', 'feat/terminal-minimal');
      fixture.detectChanges();
      const chip = fixture.nativeElement.querySelector(
        '[data-testid="session-stats-branch"]'
      ) as HTMLElement | null;
      expect(chip).not.toBeNull();
      expect(chip!.textContent).toContain('feat/terminal-minimal');
    });

    it('renders the branch chip in the placeholder (null stats) row', () => {
      fixture.componentRef.setInput('stats', null);
      fixture.componentRef.setInput('branch', 'main');
      fixture.detectChanges();
      const chip = fixture.nativeElement.querySelector(
        '[data-testid="session-stats-branch"]'
      ) as HTMLElement | null;
      expect(chip).not.toBeNull();
      expect(chip!.textContent).toContain('main');
    });
  });
});
