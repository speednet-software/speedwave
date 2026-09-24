import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UsagePopoverComponent } from './usage-popover.component';
import type { ClaudeContextCategory, ClaudeExtraUsage } from '../../models/claude-control';
import type { PlanLimitWindow, PlanLimits } from '../../models/plan-limits';

const NOW = Date.parse('2026-09-18T10:00:00Z');
const IN_TWO_HOURS = NOW + 2 * 3_600_000 + 40 * 60_000;
const NEXT_TUESDAY = Date.parse('2026-09-22T21:00:00Z');

const CATEGORIES: ClaudeContextCategory[] = [
  { name: 'System prompt', tokens: 3_902 },
  { name: 'System tools', tokens: 31_484 },
  { name: 'Custom agents', tokens: 238 },
  { name: 'Memory files', tokens: 6_529 },
  { name: 'Skills', tokens: 4_414 },
  { name: 'Autocompact buffer', tokens: 33_000 },
  { name: 'Brand new category', tokens: 1_000 },
  { name: 'Messages', tokens: 0 },
];

const FIVE_HOUR: PlanLimitWindow = {
  key: 'five_hour',
  model: null,
  utilization: 15,
  resets_at: IN_TWO_HOURS,
};
const WEEKLY: PlanLimitWindow = {
  key: 'seven_day',
  model: null,
  utilization: 70,
  resets_at: NEXT_TUESDAY,
};
const WEEKLY_FABLE: PlanLimitWindow = {
  key: 'model_scoped',
  model: 'Fable',
  utilization: 67.4,
  resets_at: NEXT_TUESDAY,
};

function extra(overrides: Partial<ClaudeExtraUsage> = {}): ClaudeExtraUsage {
  return {
    is_enabled: true,
    monthly_limit: null,
    used_credits: null,
    utilization: 25,
    currency: null,
    ...overrides,
  };
}

function limits(
  windows: PlanLimitWindow[],
  extraUsage: ClaudeExtraUsage | null = null
): PlanLimits {
  return { subscription_type: 'max', windows, extra_usage: extraUsage };
}

describe('UsagePopoverComponent', () => {
  let fixture: ComponentFixture<UsagePopoverComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [UsagePopoverComponent] }).compileComponents();
    fixture = TestBed.createComponent(UsagePopoverComponent);
    fixture.componentRef.setInput('used', 46_567);
    fixture.componentRef.setInput('max', 1_000_000);
    fixture.componentRef.setInput('categories', CATEGORIES);
    fixture.componentRef.setInput('now', NOW);
  });

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function rows(): HTMLElement[] {
    return Array.from(el().querySelectorAll<HTMLElement>('[data-testid="usage-plan-row"]'));
  }

  function render(planLimits: PlanLimits | null): void {
    fixture.componentRef.setInput('limits', planLimits);
    fixture.detectChanges();
  }

  describe('context section', () => {
    it('shows used, max and percent', () => {
      render(null);

      expect(el().querySelector('[data-testid="usage-context-total"]')?.textContent?.trim()).toBe(
        '47k / 1M · 5%'
      );
    });

    it('draws one bar segment per category in the context, sized by its share of the window', () => {
      render(null);

      const segments = Array.from(
        el().querySelectorAll<HTMLElement>('[data-testid="usage-context-segment"]')
      );
      expect(segments.map((s) => s.getAttribute('data-category'))).toEqual([
        'System prompt',
        'System tools',
        'Custom agents',
        'Memory files',
        'Skills',
        'Autocompact buffer',
        'Brand new category',
      ]);
      expect(parseFloat(segments[1].style.width)).toBeCloseTo(3.1484, 4);
    });

    it('draws no empty category', () => {
      render(null);

      const text = el().querySelector('[data-testid="usage-context"]')?.textContent ?? '';
      expect(text).not.toContain('Messages');
    });

    it('gives known categories their own colour, the buffer a subdued one and unknown ones a neutral one', () => {
      render(null);

      const colorOf = (name: string): string =>
        el().querySelector(`[data-category="${name}"]`)?.className ?? '';
      expect(colorOf('System prompt')).toContain('bg-[var(--violet)]');
      expect(colorOf('System tools')).toContain('bg-[var(--teal)]');
      expect(colorOf('Autocompact buffer')).toContain('opacity-40');
      expect(colorOf('Brand new category')).toBe('bg-[var(--ink-mute)]');
    });

    it('lists the categories with their token counts', () => {
      render(null);

      const legend = Array.from(
        el().querySelectorAll('[data-testid="usage-context-category"]')
      ).map((li) => li.textContent?.replace(/\s+/g, ' ').trim());
      expect(legend).toContain('System tools31k');
      expect(legend).toContain('Memory files7k');
      expect(legend.length).toBe(7);
    });

    it('shows only the used tokens while the window is unknown: no max, no percent, no bar', () => {
      fixture.componentRef.setInput('max', null);
      render(null);

      expect(el().querySelector('[data-testid="usage-context-total"]')?.textContent?.trim()).toBe(
        '47k'
      );
      expect(el().querySelector('[data-testid="usage-context-bar"]')).toBeNull();
    });

    it('labels the bar for screen readers', () => {
      render(null);

      expect(
        el().querySelector('[data-testid="usage-context-bar"]')?.getAttribute('aria-label')
      ).toBe('Context window 5% used');
    });
  });

  describe('plan usage limits section', () => {
    it('is absent without limits data: an API key has no plan limits', () => {
      render(null);

      expect(el().querySelector('[data-testid="usage-plan"]')).toBeNull();
      expect(el().textContent).not.toContain('Plan usage limits');
      expect(el().textContent).not.toContain('0%');
    });

    it('renders one window', () => {
      render(limits([FIVE_HOUR]));

      expect(rows().length).toBe(1);
      expect(rows()[0].getAttribute('data-window')).toBe('five_hour');
      expect(rows()[0].textContent).toContain('5-hour limit');
      expect(rows()[0].textContent).toContain('15%');
      expect(rows()[0].querySelector('[data-testid="usage-plan-reset"]')?.textContent?.trim()).toBe(
        'Resets in 2 hr 40 min'
      );
    });

    it('renders several windows in the order 5-hour, weekly all models, weekly per model', () => {
      render(limits([FIVE_HOUR, WEEKLY, WEEKLY_FABLE]));

      expect(rows().map((r) => r.getAttribute('data-window'))).toEqual([
        'five_hour',
        'seven_day',
        'model_scoped',
      ]);
      expect(rows()[1].textContent).toContain('Weekly · all models');
      expect(rows()[1].querySelector('[data-testid="usage-plan-reset"]')?.textContent).toMatch(
        /^\s*Resets \S+ \d/
      );
    });

    it('labels a model-scoped window with the model name and rounds its percent', () => {
      render(limits([WEEKLY_FABLE]));

      expect(rows()[0].textContent).toContain('Weekly · Fable');
      expect(rows()[0].textContent).toContain('67%');
    });

    it('names the plan in the header', () => {
      render(limits([FIVE_HOUR]));

      expect(el().querySelector('#usage-plan-title')?.textContent?.trim()).toBe(
        'Plan usage limits · Max'
      );
    });

    it('omits the plan name when Claude Code reports none', () => {
      render({ subscription_type: null, windows: [FIVE_HOUR], extra_usage: null });

      expect(el().querySelector('#usage-plan-title')?.textContent?.trim()).toBe(
        'Plan usage limits'
      );
    });

    it('shows extra usage only when it is enabled', () => {
      render(limits([FIVE_HOUR], extra()));
      expect(el().querySelector('[data-testid="usage-extra"]')?.textContent).toContain('25%');

      render(limits([FIVE_HOUR], null));
      expect(el().querySelector('[data-testid="usage-extra"]')).toBeNull();

      render(limits([FIVE_HOUR], extra({ is_enabled: false })));
      expect(el().querySelector('[data-testid="usage-extra"]')).toBeNull();
    });

    it('never invents a percent for enabled extra usage without a utilization', () => {
      render(limits([], extra({ utilization: null })));

      const row = el().querySelector('[data-testid="usage-extra"]');
      expect(row?.textContent).toContain('On');
      expect(row?.textContent).not.toContain('%');
    });

    it('keeps the extra usage row last', () => {
      render(limits([FIVE_HOUR, WEEKLY], extra()));

      const plan = el().querySelector('[data-testid="usage-plan"]') as HTMLElement;
      const order = Array.from(
        plan.querySelectorAll('[data-testid="usage-plan-row"], [data-testid="usage-extra"]')
      ).map((n) => n.getAttribute('data-testid'));
      expect(order).toEqual(['usage-plan-row', 'usage-plan-row', 'usage-extra']);
    });

    it('drops a window whose reset time has passed since the limits were read', () => {
      fixture.componentRef.setInput('now', IN_TWO_HOURS + 1);
      render(limits([FIVE_HOUR, WEEKLY]));

      expect(rows().map((r) => r.getAttribute('data-window'))).toEqual(['seven_day']);
    });

    it('is absent when every window has reset and extra usage is off', () => {
      fixture.componentRef.setInput('now', NEXT_TUESDAY + 1);
      render(limits([FIVE_HOUR, WEEKLY]));

      expect(el().querySelector('[data-testid="usage-plan"]')).toBeNull();
    });

    it('shows a window without a reset time, without a reset line', () => {
      render(limits([{ ...FIVE_HOUR, resets_at: null }]));

      expect(rows().length).toBe(1);
      expect(rows()[0].querySelector('[data-testid="usage-plan-reset"]')).toBeNull();
    });

    it('colours the bar by the usage thresholds and exposes it as a progressbar', () => {
      render(
        limits([
          { ...FIVE_HOUR, utilization: 49 },
          { ...WEEKLY, utilization: 50 },
          { ...WEEKLY_FABLE, utilization: 77 },
        ])
      );

      const bars = rows().map((r) => r.querySelector('[role="progressbar"]') as HTMLElement);
      expect(bars.map((b) => b.querySelector('span')?.className)).toEqual([
        'block h-full bg-[var(--green)]',
        'block h-full bg-[var(--amber)]',
        'block h-full bg-red-500',
      ]);
      expect(bars[1].getAttribute('aria-valuenow')).toBe('50');
      expect(bars[1].getAttribute('aria-label')).toBe('Weekly · all models');
    });

    it('clamps an over-limit utilization to a full bar', () => {
      render(limits([{ ...FIVE_HOUR, utilization: 104 }]));

      expect(rows()[0].textContent).toContain('100%');
    });
  });
});
