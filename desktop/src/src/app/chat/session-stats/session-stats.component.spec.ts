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

  function ring(): HTMLButtonElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector('[data-testid="usage-ring"]');
  }

  function ringFill(): string | null {
    fixture.detectChanges();
    return (
      (fixture.nativeElement as HTMLElement)
        .querySelector('[data-testid="usage-ring-fill"]')
        ?.getAttribute('stroke-dasharray') ?? null
    );
  }

  function popover(): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector('[data-testid="usage-popover"]');
  }

  describe('null stats', () => {
    it('renders the zero row when stats is null (one always-present row)', () => {
      fixture.componentRef.setInput('stats', null);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="session-stats"]')).not.toBeNull();
      const txt = rootText();
      expect(txt).toContain('in:');
      expect(txt).toContain('out:');
      expect(txt).toContain('—');
      expect(ring()).toBeNull();
    });

    it('renders the zero row + an empty ring for a seeded resume (known window, no usage)', () => {
      fixture.componentRef.setInput('stats', {
        session_id: '11111111-1111-1111-1111-111111111111',
        total_cost: null,
        total_output_tokens: 0,
        context_window_size: 200000,
      });
      fixture.detectChanges();
      const txt = rootText();
      expect(txt).toContain('in:');
      expect(txt).toContain('out:');
      expect(txt).toContain('—');
      expect(ringFill()).toBe('0 100');
    });
  });

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
      const txt = rootText();
      expect(txt).toContain('in:');
      expect(txt).toContain('out:');
    });

    it('fills the ring from the last API call usage', () => {
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
      expect(ringFill()).toBe('2 100');
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
      expect(txt).toContain('in:');
      expect(txt).toContain('1,234');
      expect(txt).not.toContain('23,871');
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

    it('names used/max in the ring label', () => {
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
      expect(ring()?.getAttribute('aria-label')).toBe('Context window 58% used (116k/200k)');
    });
  });

  describe("Claude Code's own context usage", () => {
    it('feeds the ctx meter before the first turn, from used and max alone', () => {
      fixture.componentRef.setInput('stats', {
        session_id: '',
        total_cost: null,
        context: {
          model: 'claude-opus-5[1m]',
          total_tokens: 46_567,
          max_tokens: 1_000_000,
          percentage: 5,
          categories: [{ name: 'System prompt', tokens: 3_902 }],
        },
        context_window_size: 1_000_000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();

      expect(component.ctxTotal()).toBe(46_567);
      expect(component.ctxPct()).toBe(5);
      expect(component.ctxUsedMax()).toBe('47k/1M');
    });

    it('wins over the usage of the last API call', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: null,
        context_usage: {
          input_tokens: 190_000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        context: {
          model: 'claude-haiku-4-5',
          total_tokens: 62_767,
          max_tokens: 200_000,
          percentage: 31,
          categories: [],
        },
        context_window_size: 200_000,
        total_output_tokens: 0,
      });

      expect(component.ctxTotal()).toBe(62_767);
      expect(component.ctxPct()).toBe(31);
    });

    it('hides the meter while the window is unknown instead of assuming one', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: null,
        context_usage: {
          input_tokens: 50_000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        context_window_size: null,
        total_output_tokens: 0,
      });
      fixture.detectChanges();

      expect(component.ctxPct()).toBeNull();
      expect(component.ctxUsedMax()).toBe('');
      expect(ring()).toBeNull();
    });
  });

  describe('turn-sum usage vs ctx separation (regression)', () => {
    it('one tool-heavy turn: turn-sum usage exceeds the window but ctx stays truthful', () => {
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
      expect(component.ctxPct()).toBe(36);
      expect(component.ctxUsedMax()).toBe('72k/200k');
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
      expect(component.ctxPct()).toBe(14);
    });

    it('hides the ctx gauge for a local model with unknown window (ADR-041)', () => {
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

  describe('context window sized by the conversation model', () => {
    it('a 1M-window conversation model reports 65%, not a 200k subagent window clamped to 100%', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0.5,
        context_usage: {
          input_tokens: 100_000,
          output_tokens: 1_000,
          cache_read_tokens: 550_000,
          cache_write_tokens: 0,
        },
        context_window_size: 1_000_000,
        total_output_tokens: 1_000,
      });
      fixture.detectChanges();
      expect(component.ctxTotal()).toBe(650_000);
      expect(component.ctxUsedMax()).toBe('650k/1M');
      expect(component.ctxPct()).toBe(65);
    });
  });

  describe('edge cases', () => {
    it('shows an empty ring when no usage', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      expect(ringFill()).toBe('0 100');
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

    it('renders in/out without cr/cw breakdown when cache tokens are absent', () => {
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
      expect(component.ctxPct()).toBe(2);
    });

    it('ignores the per-turn usage sums entirely — no context_usage means 0%', () => {
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
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      expect(component.ringColor()).toBe('text-[var(--green)]');
    });

    it('applies amber for 50–76%', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_usage: {
          input_tokens: 120000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      expect(component.ringColor()).toBe('text-[var(--amber)]');
    });

    it('applies amber at boundary 50', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_usage: {
          input_tokens: 100000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      expect(component.ringColor()).toBe('text-[var(--amber)]');
    });

    it('applies red-500 for ≥77%', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_usage: {
          input_tokens: 180000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      expect(component.ringColor()).toBe('text-red-500');
    });

    it('applies red-500 at boundary 77', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_usage: {
          input_tokens: 154000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      expect(component.ringColor()).toBe('text-red-500');
    });

    it('fills 30% of the ring at 30%', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_usage: {
          input_tokens: 60_000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        context_window_size: 200_000,
        total_output_tokens: 0,
      });
      expect(component.ctxPct()).toBe(30);
      expect(ringFill()).toBe('30 100');
    });

    it('fills 80% of the ring at 80%', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_usage: {
          input_tokens: 160_000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        context_window_size: 200_000,
        total_output_tokens: 0,
      });
      expect(component.ctxPct()).toBe(80);
      expect(ringFill()).toBe('80 100');
    });

    it('fills the whole ring at 100%', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_usage: {
          input_tokens: 200000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      expect(ringFill()).toBe('100 100');
    });

    it('leaves the ring empty at 0%', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        context_usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      expect(ringFill()).toBe('0 100');
    });
  });

  describe('usage ring and popover', () => {
    const NOW = Date.parse('2026-09-18T10:00:00Z');
    const STATS = {
      session_id: 'abc',
      total_cost: null,
      usage: { input_tokens: 1200, output_tokens: 300 },
      context: {
        model: 'claude-opus-5[1m]',
        total_tokens: 46_567,
        max_tokens: 1_000_000,
        percentage: 5,
        categories: [{ name: 'System prompt', tokens: 3_902 }],
      },
      context_window_size: 1_000_000,
      total_output_tokens: 300,
    };
    const LIMITS = {
      subscription_type: 'max',
      windows: [
        { key: 'five_hour', model: null, utilization: 15, resets_at: NOW + 9_600_000 },
        { key: 'seven_day', model: null, utilization: 70, resets_at: NOW + 400_000_000 },
      ],
      extra_usage: null,
    };
    const WARNING = {
      status: 'allowed_warning',
      rate_limit_type: 'five_hour',
      utilization_percent: 60,
      resets_at: NOW / 1000 + 3600,
      overage_status: null,
      is_using_overage: false,
    };

    beforeEach(() => {
      fixture.componentRef.setInput('stats', STATS);
      fixture.componentRef.setInput('now', NOW);
      fixture.componentRef.setInput('branch', 'main');
      fixture.detectChanges();
    });

    it('replaces the ctx and limit bars; in, out, branch and cost stay', () => {
      const txt = rootText();
      expect(txt).not.toMatch(/\bctx\b/);
      expect(txt).not.toMatch(/\blimit\b/);
      expect(txt).toContain('in: 1,200');
      expect(txt).toContain('out: 300');
      expect(txt).toContain('main');
      expect(txt).toContain('chat: —');
      expect(ring()).not.toBeNull();
    });

    it('fills the ring with the context percentage', () => {
      expect(ringFill()).toBe('5 100');
    });

    it('is closed until the ring is clicked', () => {
      expect(popover()).toBeNull();
    });

    it('opens the popover on click and asks the owner to re-read the limits', () => {
      let opened = 0;
      component.usageOpened.subscribe(() => (opened += 1));

      ring()?.click();
      fixture.detectChanges();

      expect(opened).toBe(1);
      expect(ring()?.getAttribute('aria-expanded')).toBe('true');
      expect(popover()?.getAttribute('role')).toBe('dialog');
      expect(popover()?.getAttribute('aria-label')).toBe('Context window and plan usage limits');
      expect(popover()?.textContent).toContain('47k / 1M · 5%');
    });

    it('moves focus into the popover and back to the ring when Escape closes it', () => {
      document.body.appendChild(fixture.nativeElement);
      ring()?.click();
      fixture.detectChanges();
      TestBed.tick();
      expect(document.activeElement).toBe(popover());

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      fixture.detectChanges();

      expect(popover()).toBeNull();
      expect(document.activeElement).toBe(ring());
      fixture.nativeElement.remove();
    });

    it('closes on a backdrop click and on a second ring click without re-announcing', () => {
      let opened = 0;
      component.usageOpened.subscribe(() => (opened += 1));
      ring()?.click();
      fixture.detectChanges();

      (fixture.nativeElement as HTMLElement)
        .querySelector<HTMLButtonElement>('[data-testid="usage-popover-backdrop"]')
        ?.click();
      fixture.detectChanges();
      expect(popover()).toBeNull();

      ring()?.click();
      fixture.detectChanges();
      ring()?.click();
      fixture.detectChanges();
      expect(popover()).toBeNull();
      expect(opened).toBe(2);
    });

    it('lists the plan windows of an OAuth account', () => {
      fixture.componentRef.setInput('limits', LIMITS);
      ring()?.click();
      fixture.detectChanges();

      const rows = popover()?.querySelectorAll('[data-testid="usage-plan-row"]') ?? [];
      expect(Array.from(rows).map((r) => r.getAttribute('data-window'))).toEqual([
        'five_hour',
        'seven_day',
      ]);
    });

    it('shows only the context section with an API key', () => {
      fixture.componentRef.setInput('limits', null);
      ring()?.click();
      fixture.detectChanges();

      expect(popover()?.querySelector('[data-testid="usage-context"]')).not.toBeNull();
      expect(popover()?.querySelector('[data-testid="usage-plan"]')).toBeNull();
    });

    it('marks the ring amber on a warning and red once a limit is reached', () => {
      const marker = (): HTMLElement | null =>
        (fixture.nativeElement as HTMLElement).querySelector('[data-testid="usage-ring-warning"]');
      expect(marker()).toBeNull();

      fixture.componentRef.setInput('limitSignal', WARNING);
      fixture.detectChanges();
      expect(marker()?.getAttribute('data-status')).toBe('allowed_warning');
      expect(marker()?.className).toContain('bg-[var(--amber)]');
      expect(ring()?.getAttribute('aria-label')).toContain('Plan usage limit warning');

      fixture.componentRef.setInput('limitSignal', { ...WARNING, status: 'rejected' });
      fixture.detectChanges();
      expect(marker()?.className).toContain('bg-red-500');
      expect(ring()?.getAttribute('aria-label')).toContain('Plan usage limit reached');
    });

    it('leaves the ring unmarked for an allowed status and once the signalled window has reset', () => {
      const marker = (): HTMLElement | null =>
        (fixture.nativeElement as HTMLElement).querySelector('[data-testid="usage-ring-warning"]');

      fixture.componentRef.setInput('limitSignal', { ...WARNING, status: 'allowed' });
      fixture.detectChanges();
      expect(marker()).toBeNull();

      fixture.componentRef.setInput('limitSignal', { ...WARNING, resets_at: NOW / 1000 - 60 });
      fixture.detectChanges();
      expect(marker()).toBeNull();
    });

    it('keeps the marker for a warning without a reset time', () => {
      fixture.componentRef.setInput('limitSignal', { ...WARNING, resets_at: null });
      fixture.detectChanges();

      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[data-testid="usage-ring-warning"]')
      ).not.toBeNull();
    });

    it('hides the ring, and with it the popover, while the window is unknown', () => {
      fixture.componentRef.setInput('stats', {
        ...STATS,
        context: undefined,
        context_window_size: null,
      });
      fixture.detectChanges();

      expect(ring()).toBeNull();
    });
  });

  describe('ARIA', () => {
    it('names the ring by the context percentage', () => {
      fixture.componentRef.setInput('stats', {
        session_id: 'abc',
        total_cost: 0,
        usage: { input_tokens: 1000, output_tokens: 0 },
        context_window_size: 200000,
        total_output_tokens: 0,
      });
      fixture.detectChanges();
      expect(ring()?.getAttribute('aria-label')).toMatch(/^Context window \d+% used/);
      expect(ring()?.getAttribute('aria-haspopup')).toBe('dialog');
      expect(ring()?.getAttribute('aria-expanded')).toBe('false');
    });
  });

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
      expect(rootText()).toContain('out:');
      expect(rootText()).toContain('500');
    });
  });

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
