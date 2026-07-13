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
    it('renders the zero row when stats is null (one always-present row)', () => {
      fixture.componentRef.setInput('stats', null);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      // One row, always present — new chat, resume, and live all share it.
      expect(el.querySelector('[data-testid="session-stats"]')).not.toBeNull();
      const txt = rootText();
      expect(txt).toContain('in:');
      expect(txt).toContain('out:');
      // No stats → cost unpriced → "—", never a fabricated $0.0000.
      expect(txt).toContain('—');
      // Window unknown (no stats) → ctx gauge hidden, not fabricated (ADR-041).
      expect(txt).not.toContain('ctx');
    });

    it('renders the zero row + ctx 0% for a seeded resume (known window, no usage)', () => {
      // The exact shape seedSessionId produces before any Result arrives.
      fixture.componentRef.setInput('stats', {
        session_id: '11111111-1111-1111-1111-111111111111',
        total_cost: null,
        total_output_tokens: 0,
        context_window_size: 200000,
      });
      fixture.detectChanges();
      const txt = rootText();
      // Must NOT collapse to an empty/invisible row — shows zeros like a new chat.
      expect(txt).toContain('in:');
      expect(txt).toContain('out:');
      // Unpriced seed → "—" (not $0.0000).
      expect(txt).toContain('—');
      // Known window → ctx shows 0% (not hidden).
      expect(txt).toContain('ctx');
      expect(txt).toContain('0%');
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

    it('renders in/out as zeros when usage is undefined', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      // No usage → zeros, never an empty/invisible row.
      const txt = rootText();
      expect(txt).toContain('in:');
      expect(txt).toContain('out:');
    });

    it('renders ctx bar from the last API call usage', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0.05,
        usage: { input_tokens: 3, output_tokens: 65 },
        context_usage: {
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
      expect(txt).toContain('in:');
      expect(txt).toContain('1,234');
      expect(txt).not.toContain('23,871'); // 1234 + 22562 + 75 — the old (wrong) totalInput
      expect(txt).toContain('out:');
      expect(txt).toContain('65');
    });

    it('renders cost in dollars to 4 decimal places under the `chat:` label', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0.018,
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      expect(rootText()).toContain('chat:');
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
        context_usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_read_tokens: 116_000,
          cache_write_tokens: 0,
        },
        context_window_size: 200_000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      expect(rootText()).toContain('116k/200k');
    });
  });

  // ── regression: ctx must ignore the per-turn `usage` sums ───────────────
  describe('turn-sum usage vs ctx separation (regression)', () => {
    it('one tool-heavy turn: turn-sum usage exceeds the window but ctx stays truthful', () => {
      // Real capture: 1 user turn = 11 API calls; summed usage (474k) is over
      // twice the 200k window, while the last call's context is ~74k (37%).
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0.5,
        usage: {
          input_tokens: 4_864,
          output_tokens: 1_808,
          cache_read_tokens: 464_000,
          cache_write_tokens: 5_500,
        },
        context_usage: {
          input_tokens: 2,
          output_tokens: 1_660,
          cache_read_tokens: 66_844,
          cache_write_tokens: 4_920,
        },
        context_window_size: 200_000,
        total_output_tokens: 1_808,
      });
      fixture.detectChanges();
      expect(component.ctxTotal()).toBe(71_766);
      expect(component.ctxPct()).toBe(36); // never the clamped 100%
      expect(component.ctxUsedMax()).toBe('72k/200k');
      // `in:` keeps the per-turn fresh-input total.
      expect(component.inboundTokens()).toBe(4_864);
    });

    it('gauge tracks the latest call (replacement), never a running sum', () => {
      const set = (cacheRead: number) =>
        fixture.componentRef.setInput('stats', {
          session_id: 'abc',
          total_cost: 0,
          context_usage: {
            input_tokens: 200,
            output_tokens: 0,
            cache_read_tokens: cacheRead,
            cache_write_tokens: 0,
          },
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
      // Latest call → 181,200 / 1M = 18%. NOT the sum (~291k → 29%).
      expect(component.ctxTotal()).toBe(181_200);
      expect(component.ctxPct()).toBe(18);
    });

    it('handles a local model (no prompt cache): the whole prompt fills the gauge', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        usage: { input_tokens: 4500, output_tokens: 120 },
        context_usage: {
          input_tokens: 4500,
          output_tokens: 120,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
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
    // The strip is one fixed shape: every segment shows zeros until live data
    // replaces them, so a new chat and a resumed one look identical.
    it('shows ctx at 0% when no usage', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      const txt = rootText();
      expect(txt).toContain('ctx');
      expect(txt).toContain('0%');
    });

    it('shows rate-limit at 0% when rate_limit is absent', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      expect(rootText()).toContain('limit');
    });

    it('shows chat cost as $0.0000 when total_cost is a real 0 (free/local)', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      expect(rootText()).toContain('chat:');
      // A real 0 (free/local priced) shows $0.0000; only null/unpriced shows "—".
      expect(rootText()).toContain('$0.0000');
    });

    it('shows "—" (not $0.0000) when total_cost is null (subscription/unpriced)', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: null,
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      expect(rootText()).toContain('chat:');
      expect(rootText()).toContain('—');
      expect(rootText()).not.toContain('$0.0000');
    });

    it('hides the limit gauge for a local model (unknown window), like ctx', () => {
      // Regression: the rate-limit segment must not show a fabricated "limit 0%"
      // when there is no rate-limit data and the window is unknown (local model).
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        usage: { input_tokens: 10, output_tokens: 5 },
        context_window_size: null,
        total_output_tokens: 5,
      });
      fixture.detectChanges();
      expect(rootText()).not.toContain('limit');
      expect(rootText()).not.toContain('ctx');
    });

    it('shows the limit gauge for a cloud session (known window) even with no rate-limit data', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      expect(rootText()).toContain('limit');
    });

    it('renders in/out without cr/cw breakdown when cache tokens are absent', () => {
      // cr/cw collapse into the `in:` total, not surfaced as own segments.
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
        context_usage: {
          input_tokens: 3,
          output_tokens: 0,
          cache_read_tokens: 20000,
          cache_write_tokens: 0,
        },
        context_window_size: 1_000_000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      // ~20k / 1M = 2%
      expect(component.ctxPct()).toBe(2);
    });

    it('ignores the per-turn usage sums entirely — no context_usage means 0%', () => {
      // The inflated turn-sum alone must not move the gauge (the 100%-after-
      // one-query bug); only `context_usage` may.
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        usage: { input_tokens: 500_000, output_tokens: 0, cache_read_tokens: 500_000 },
        context_window_size: 200_000,
        total_output_tokens: 0,
      });
      expect(component.ctxPct()).toBe(0);
    });

    it('clamps ctxPct to 100 when a genuine overflow is reported', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_usage: {
          input_tokens: 150_000,
          output_tokens: 0,
          cache_read_tokens: 60_000,
          cache_write_tokens: 0,
        },
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
        context_usage: {
          input_tokens: 20000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
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
        context_usage: {
          input_tokens: 60_000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
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
        context_usage: {
          input_tokens: 160_000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
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
