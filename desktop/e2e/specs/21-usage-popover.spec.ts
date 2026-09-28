import { switchToProject, activeProjectSlug } from '../helpers/projects';
import { openChat, openSettings, sendMessageAndWait, startNewConversation } from '../helpers/llm';
import { invokeOr } from '../helpers/tauri-invoke';

const ROUTED_PROJECT = 'e2e-test';
const ANTHROPIC_PROJECT = 'e2e-second';
const PLAN_WINDOW_ORDER = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'model_scoped',
];
const TRANSPARENT = ['', 'none', 'transparent', 'rgba(0, 0, 0, 0)'];

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PopoverPaint {
  box: Box;
  viewportWidth: number;
  viewportHeight: number;
  centerHitsPopover: boolean;
}

interface UsageWindow {
  utilization: number | null;
  resets_at: string | null;
}

interface PlanUsage {
  rate_limits_available: boolean;
  rate_limits: {
    five_hour: UsageWindow | null;
    seven_day: UsageWindow | null;
    seven_day_opus: UsageWindow | null;
    seven_day_sonnet: UsageWindow | null;
    model_scoped: UsageWindow[];
  } | null;
}

function isShownWindow(w: UsageWindow, nowMs: number): boolean {
  if (w.utilization === null || !Number.isFinite(w.utilization)) return false;
  if (!w.resets_at) return true;
  const resetsAt = Date.parse(w.resets_at.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(resetsAt) || resetsAt > nowMs;
}

async function waitForRing(timeoutMs: number): Promise<void> {
  await $('[data-testid="usage-ring"]').waitForDisplayed({
    timeout: timeoutMs,
    timeoutMsg: 'usage-ring never appeared in the session stats',
  });
}

async function openPopover(): Promise<void> {
  await (await $('[data-testid="usage-ring"]')).click();
  await $('[data-testid="usage-popover"]').waitForDisplayed({
    timeout: 10_000,
    timeoutMsg: 'usage-popover never opened after a click on the ring',
  });
}

async function waitForPopoverClosed(): Promise<void> {
  await $('[data-testid="usage-popover"]').waitForExist({
    timeout: 10_000,
    reverse: true,
    timeoutMsg: 'usage-popover stayed open',
  });
}

async function closePopoverIfOpen(): Promise<void> {
  if (await $('[data-testid="usage-popover"]').isExisting()) {
    await browser.keys('Escape');
    await waitForPopoverClosed();
  }
}

async function waitForFocusOn(testid: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => document.activeElement?.getAttribute('data-testid') ?? null)) ===
      testid,
    { timeout: 5_000, timeoutMsg: `focus never moved to ${testid}` }
  );
}

async function popoverPaint(): Promise<PopoverPaint> {
  return browser.execute(() => {
    const popover = document.querySelector('[data-testid="usage-popover"]') as HTMLElement;
    const r = popover.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      centerHitsPopover: hit !== null && popover.contains(hit),
    };
  });
}

async function planUsage(project: string): Promise<PlanUsage | null> {
  return invokeOr<PlanUsage | null>(null, 'get_plan_usage', { project });
}

describe('Usage Ring + Popover', function () {
  afterEach(async function () {
    await closePopoverIfOpen();
  });

  describe('proxy-routed provider (OpenRouter)', function () {
    before(async function () {
      this.timeout(300_000);
      if ((await activeProjectSlug()) !== ROUTED_PROJECT) {
        await switchToProject(ROUTED_PROJECT);
      }
      await openChat();
      await startNewConversation();
      await sendMessageAndWait('Say hello in one word.');
      await waitForRing(30_000);
    });

    it('draws the ring fill at the context percentage in a resolved colour', async function () {
      this.timeout(30_000);
      const ring = await $('[data-testid="usage-ring"]');
      expect(await ring.getAttribute('aria-haspopup')).toBe('dialog');
      expect(await ring.getAttribute('aria-expanded')).toBe('false');

      const match = /Context window (\d+)% used/.exec(
        (await ring.getAttribute('aria-label')) ?? ''
      );
      if (!match) throw new Error('usage-ring carries no context percentage in its label');
      const fill = await browser.execute(() => {
        const el = document.querySelector('[data-testid="usage-ring-fill"]');
        const style = el ? getComputedStyle(el) : null;
        return {
          dash: el?.getAttribute('stroke-dasharray') ?? '',
          stroke: style?.stroke ?? '',
          color: style?.color ?? '',
        };
      });
      expect(fill.dash).toBe(`${match[1]} 100`);
      expect(TRANSPARENT).not.toContain(fill.stroke);
      expect(TRANSPARENT).not.toContain(fill.color);
    });

    it('opens a popover the WebView paints on top, inside the window, and focuses it', async function () {
      this.timeout(30_000);
      await openPopover();
      expect(await (await $('[data-testid="usage-ring"]')).getAttribute('aria-expanded')).toBe(
        'true'
      );
      await waitForFocusOn('usage-popover');

      const paint = await popoverPaint();
      expect(paint.box.right - paint.box.left).toBeGreaterThan(0);
      expect(paint.box.bottom - paint.box.top).toBeGreaterThan(0);
      expect(paint.box.left).toBeGreaterThanOrEqual(0);
      expect(paint.box.top).toBeGreaterThanOrEqual(0);
      expect(paint.box.right).toBeLessThanOrEqual(paint.viewportWidth);
      expect(paint.box.bottom).toBeLessThanOrEqual(paint.viewportHeight);
      expect(paint.centerHitsPopover).toBe(true);

      expect(await $('[data-testid="usage-context-bar"]').isDisplayed()).toBe(true);
      expect(await $('[data-testid="usage-plan"]').isExisting()).toBe(false);
    });

    it('covers the composer with the backdrop, and a click on it closes the popover', async function () {
      this.timeout(30_000);
      await openPopover();
      const hit = await browser.execute(() => {
        const popover = (
          document.querySelector('[data-testid="usage-popover"]') as HTMLElement
        ).getBoundingClientRect();
        const input = (
          document.querySelector('[data-testid="chat-input"]') as HTMLElement
        ).getBoundingClientRect();
        const x = input.right - 10;
        const y = input.top + input.height / 2;
        const insidePopover =
          x >= popover.left && x <= popover.right && y >= popover.top && y <= popover.bottom;
        return {
          insidePopover,
          testid: document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? null,
        };
      });
      expect(hit.insidePopover).toBe(false);
      expect(hit.testid).toBe('usage-popover-backdrop');

      await browser.execute(() =>
        (document.querySelector('[data-testid="usage-popover-backdrop"]') as HTMLElement).click()
      );
      await waitForPopoverClosed();
      expect(await (await $('[data-testid="usage-ring"]')).getAttribute('aria-expanded')).toBe(
        'false'
      );
      await waitForFocusOn('usage-ring');
    });

    it('closes on Escape and hands focus back to the ring', async function () {
      this.timeout(30_000);
      await openPopover();
      await waitForFocusOn('usage-popover');
      await browser.keys('Escape');
      await waitForPopoverClosed();
      await waitForFocusOn('usage-ring');
    });
  });

  describe('Anthropic sign-in', function () {
    let method = '';

    before(async function () {
      this.timeout(180_000);
      if ((await activeProjectSlug()) !== ANTHROPIC_PROJECT) {
        await switchToProject(ANTHROPIC_PROJECT);
      }
      await openSettings();
      const anthropicCard = await $('[data-testid="settings-llm-provider-anthropic"]');
      await anthropicCard.waitForExist({ timeout: 15_000 });
      await anthropicCard.click();
      const authPill = await $('[data-testid="auth-status-value"]');
      await authPill.waitForExist({ timeout: 15_000 });
      try {
        await browser.waitUntil(async () => (await authPill.getText()).includes('connected'), {
          timeout: 20_000,
        });
      } catch {
        this.skip();
      }
      method = (await (await $('[data-testid="auth-status-method"]')).getText()).trim();
      await openChat();
      await startNewConversation();
    });

    it('shows the context window of a fresh session before the first turn', async function () {
      this.timeout(120_000);
      await waitForRing(90_000);
      expect((await $$('[data-testid="chat-message"]').getElements()).length).toBe(0);
      await openPopover();
      expect(await $('[data-testid="usage-context-bar"]').isDisplayed()).toBe(true);
      await browser.waitUntil(
        async () => (await $$('[data-testid="usage-context-category"]').getElements()).length > 0,
        { timeout: 15_000, timeoutMsg: 'the popover listed no context category' }
      );
    });

    it('lists the plan windows in order for a subscription, and none for an API key', async function () {
      this.timeout(60_000);
      await openPopover();

      if (method !== 'oauth') {
        expect(await $('[data-testid="usage-plan"]').isExisting()).toBe(false);
        return;
      }

      const usage = await planUsage(ANTHROPIC_PROJECT);
      const limits = usage?.rate_limits_available ? usage.rate_limits : null;
      if (!limits) {
        expect(await $('[data-testid="usage-plan"]').isExisting()).toBe(false);
        return;
      }
      const windows = [
        limits.five_hour,
        limits.seven_day,
        limits.seven_day_opus,
        limits.seven_day_sonnet,
        ...limits.model_scoped,
      ];
      if (!windows.some((w) => !!w && isShownWindow(w, Date.now()))) this.skip();

      await $('[data-testid="usage-plan"]').waitForDisplayed({
        timeout: 30_000,
        timeoutMsg: 'the plan section never rendered for a subscription that reports limits',
      });
      const rows = await $$('[data-testid="usage-plan-row"]').getElements();
      expect(rows.length).toBeGreaterThan(0);
      const order: number[] = [];
      for (const row of rows) {
        const key = (await row.getAttribute('data-window')) ?? '';
        expect(PLAN_WINDOW_ORDER).toContain(key);
        order.push(PLAN_WINDOW_ORDER.indexOf(key));
        const pct = Number(
          await (await row.$('[role="progressbar"]')).getAttribute('aria-valuenow')
        );
        expect(Number.isInteger(pct)).toBe(true);
        expect(pct).toBeGreaterThanOrEqual(0);
        expect(pct).toBeLessThanOrEqual(100);
      }
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });
  });
});
