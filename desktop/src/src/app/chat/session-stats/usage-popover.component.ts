import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { ClaudeContextCategory } from '../../models/claude-control';
import { formatContextLabel } from '../../models/llm';
import { formatResetTime, planWindowLabel, type PlanLimits } from '../../models/plan-limits';
import { usageColor } from './usage-color';

const CATEGORY_COLORS: Readonly<Record<string, string>> = {
  'System prompt': 'bg-[var(--violet)]',
  'System tools': 'bg-[var(--teal)]',
  'MCP tools': 'bg-[var(--accent)]',
  'Custom agents': 'bg-[var(--amber)]',
  'Memory files': 'bg-[var(--green)]',
  Skills: 'bg-[var(--ink-dim)]',
  Messages: 'bg-[var(--ink)]',
};
const BUFFER_CATEGORIES: readonly string[] = ['Autocompact buffer', 'Compact buffer'];
const BUFFER_COLOR = 'bg-[var(--ink-mute)] opacity-40';
const UNKNOWN_COLOR = 'bg-[var(--ink-mute)]';

interface ContextSegment {
  name: string;
  tokens: string;
  color: string;
  widthPct: number;
}

interface PlanRow {
  id: string;
  key: string;
  label: string;
  pct: number;
  color: string;
  resets: string;
}

/**
 * Popover behind the session-stats ring: the context window by category and, when Claude Code
 * reports them, the plan usage limits. A section without data is not rendered.
 */
@Component({
  selector: 'app-usage-popover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="mono w-72 px-3 py-3 text-[11px] text-[var(--ink)]">
      <section data-testid="usage-context" aria-labelledby="usage-context-title">
        <div class="flex items-baseline justify-between gap-3">
          <h3 id="usage-context-title" class="text-[11px] font-normal text-[var(--ink)]">
            Context window
          </h3>
          <span data-testid="usage-context-total" class="text-[var(--ink-dim)]">{{
            contextTotal()
          }}</span>
        </div>
        @if (max()) {
          <div
            data-testid="usage-context-bar"
            role="img"
            class="mt-2 flex h-1.5 w-full overflow-hidden rounded-sm bg-[var(--line-strong)]"
            [attr.aria-label]="'Context window ' + contextPct() + '% used'"
          >
            @for (seg of segments(); track seg.name) {
              <span
                data-testid="usage-context-segment"
                [attr.data-category]="seg.name"
                [class]="seg.color"
                [style.width.%]="seg.widthPct"
              ></span>
            }
          </div>
        }
        @if (segments().length > 0) {
          <ul class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-[var(--ink-mute)]">
            @for (seg of segments(); track seg.name) {
              <li data-testid="usage-context-category" class="flex items-center gap-1.5">
                <span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full" [class]="seg.color">
                </span>
                <span class="truncate">{{ seg.name }}</span>
                <span class="ml-auto text-[var(--ink-dim)]">{{ seg.tokens }}</span>
              </li>
            }
          </ul>
        }
      </section>

      @if (planRows().length > 0 || extraUsage()) {
        <section
          data-testid="usage-plan"
          class="mt-3 border-t border-[var(--line)] pt-3"
          aria-labelledby="usage-plan-title"
        >
          <h3 id="usage-plan-title" class="text-[11px] font-normal text-[var(--ink)]">
            {{ planTitle() }}
          </h3>
          @for (row of planRows(); track row.id) {
            <div data-testid="usage-plan-row" [attr.data-window]="row.key" class="mt-2">
              <div class="flex items-baseline justify-between gap-3">
                <span>{{ row.label }}</span>
                <span class="text-[var(--ink-dim)]">{{ row.pct }}%</span>
              </div>
              <div
                role="progressbar"
                class="mt-1 h-1 w-full overflow-hidden rounded-sm bg-[var(--line-strong)]"
                aria-valuemin="0"
                aria-valuemax="100"
                [attr.aria-valuenow]="row.pct"
                [attr.aria-label]="row.label"
              >
                <span class="block h-full" [class]="row.color" [style.width.%]="row.pct"></span>
              </div>
              @if (row.resets) {
                <div data-testid="usage-plan-reset" class="mt-1 text-[10px] text-[var(--ink-mute)]">
                  {{ row.resets }}
                </div>
              }
            </div>
          }
          @if (extraUsage(); as extra) {
            <div data-testid="usage-extra" class="mt-2 flex items-baseline justify-between gap-3">
              <span>Extra usage</span>
              <span class="text-[var(--ink-dim)]">{{ extra }}</span>
            </div>
          }
        </section>
      }
    </div>
  `,
})
export class UsagePopoverComponent {
  /** Tokens in the context window. */
  readonly used = input(0);

  /** Context window in tokens, or `null` while unknown. */
  readonly max = input<number | null>(null);

  /** Context categories to draw; the backend picks them. */
  readonly categories = input<readonly ClaudeContextCategory[]>([]);

  /** Plan usage limits, or `null` when there are none (API key, no data). */
  readonly limits = input<PlanLimits | null>(null);

  /** Time the popover was opened at; a window that has reset since is not shown. */
  readonly now = input(0);

  protected readonly contextPct = computed<number>(() => {
    const max = this.max();
    if (!max || max <= 0) return 0;
    return Math.min(100, Math.round((this.used() / max) * 100));
  });

  protected readonly contextTotal = computed<string>(() => {
    const used = formatContextLabel(this.used());
    const max = this.max();
    return max ? `${used} / ${formatContextLabel(max)} · ${this.contextPct()}%` : used;
  });

  protected readonly segments = computed<ContextSegment[]>(() => {
    const max = this.max();
    return this.categories().map((c) => ({
      name: c.name,
      tokens: formatContextLabel(c.tokens),
      color: BUFFER_CATEGORIES.includes(c.name)
        ? BUFFER_COLOR
        : (CATEGORY_COLORS[c.name] ?? UNKNOWN_COLOR),
      widthPct: max && max > 0 ? Math.min(100, (c.tokens / max) * 100) : 0,
    }));
  });

  protected readonly planRows = computed<PlanRow[]>(() => {
    const now = this.now();
    return (this.limits()?.windows ?? [])
      .filter((w) => w.resets_at === null || w.resets_at > now)
      .map((w) => {
        const pct = Math.min(100, Math.max(0, Math.round(w.utilization)));
        return {
          id: `${w.key}:${w.model ?? ''}`,
          key: w.key,
          label: planWindowLabel(w),
          pct,
          color: usageColor(pct).bar,
          resets: formatResetTime(w.resets_at, now),
        };
      });
  });

  protected readonly extraUsage = computed<string | null>(() => {
    const extra = this.limits()?.extra_usage;
    if (!extra?.is_enabled) return null;
    return extra.utilization === null ? 'On' : `${Math.round(extra.utilization)}%`;
  });

  protected readonly planTitle = computed<string>(() => {
    const plan = this.limits()?.subscription_type;
    if (!plan) return 'Plan usage limits';
    return `Plan usage limits · ${plan[0].toUpperCase()}${plan.slice(1)}`;
  });
}
