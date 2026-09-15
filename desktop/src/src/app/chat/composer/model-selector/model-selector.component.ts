import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TooltipDirective } from '../../../shared/tooltip.directive';
import { TauriService } from '../../../services/tauri.service';
import { AnthropicModelsService } from '../../../services/anthropic-models.service';
import { LoggerService } from '../../../services/logger.service';
import type { ActiveProviderSummary, AnthropicModel, DiscoverResult } from '../../../models/llm';
import { isAnthropicKind } from '../../../models/llm';
import { normalizeObserved, wireModelId } from './wire-model-id';
import { EffortSliderComponent, capitalizeLevel } from './effort-slider.component';

/** One row in the combobox, normalized across the three provider sources. */
interface ModelOption {
  id: string;
  label: string;
  contextTokens: number | null;
  promptPrice?: number;
  completionPrice?: number;
}

/** The single event this component emits on any selection (Task 16 contract). */
export interface ModelSelection {
  catalogId: string;
  wireId: string;
  providerId: string;
  kind: string;
}

/**
 * Clickable model badge opening a searchable combobox; sources depend on the
 * active provider kind (anthropic catalog / local discovery / OpenRouter catalog).
 * Emits exactly ONE `modelSelected` event per pick; all session-live/pending/
 * write-through decisions live in `ChatStateService.applyModelSelection`.
 */
@Component({
  selector: 'app-model-selector',
  imports: [FormsModule, TooltipDirective, EffortSliderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'onEscape()' },
  template: `
    <div class="relative inline-flex items-center gap-2">
      <button
        type="button"
        data-testid="composer-model-badge"
        class="hidden text-[var(--teal)] hover:underline md:inline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
        [disabled]="streaming()"
        [attr.title]="streaming() ? 'Model locked while a turn is streaming' : 'Change model'"
        (click)="openCombobox()"
      >
        {{ displayModelLabel() }}
      </button>
      @if (showEffortSegment()) {
        <button
          type="button"
          data-testid="effort-segment"
          class="hidden text-[var(--ink-mute)] hover:text-[var(--ink)] hover:underline md:inline"
          appTooltip="Reasoning effort - applies to the current session and persists for new ones"
          placement="top"
          (click)="toggleEffortPopover()"
        >
          {{ effortSegmentLabel() }}
        </button>
      }
      @if (modelError()) {
        <span data-testid="model-selection-error" role="alert" class="ml-2 text-red-300">{{
          modelError()
        }}</span>
      }
      @if (open()) {
        <button
          type="button"
          data-testid="model-selector-backdrop"
          aria-label="Close model list"
          tabindex="-1"
          class="fixed inset-0 z-30 cursor-default"
          (click)="open.set(false)"
        ></button>
        <div
          class="absolute bottom-full right-0 z-40 mb-2 w-80 overflow-hidden rounded border border-[var(--line-strong)] bg-[var(--bg-1)] shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
          role="dialog"
        >
          <div class="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2">
            <input
              data-testid="model-selector-search"
              type="text"
              class="mono w-full bg-transparent text-[12px] text-[var(--ink)] placeholder-[var(--ink-mute)] focus:outline-none"
              [ngModel]="query()"
              (ngModelChange)="onQueryChange($event)"
              placeholder="Search models..."
            />
            <button
              type="button"
              aria-label="Close model list"
              class="text-[var(--ink-mute)] hover:text-[var(--ink)]"
              (click)="open.set(false)"
            >
              &#x2715;
            </button>
          </div>
          <div class="max-h-72 overflow-y-auto py-1">
            @if (loading()) {
              <div
                data-testid="model-selector-loading"
                class="mono px-3 py-2 text-[11px] text-[var(--ink-mute)]"
              >
                Loading models...
              </div>
            } @else if (error()) {
              <div
                data-testid="model-selector-error"
                class="mono flex items-center gap-2 px-3 py-2 text-[11px] text-[var(--ink-mute)]"
              >
                {{ error() }}
                <button
                  type="button"
                  data-testid="model-selector-retry"
                  class="hover-bg rounded border border-[var(--line-strong)] px-2 py-0.5 text-[10px] text-[var(--ink)]"
                  (click)="fetchOptions(true)"
                >
                  Retry
                </button>
              </div>
            } @else {
              @for (opt of filteredOptions(); track opt.id) {
                <button
                  type="button"
                  [attr.data-testid]="'model-selector-option-' + opt.id"
                  class="mono hover-bg flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[11px] text-[var(--ink)]"
                  (click)="select(opt)"
                >
                  <span>{{ opt.label }}</span>
                  @if (opt.promptPrice !== undefined) {
                    <span class="text-[var(--ink-mute)]"
                      >\${{ opt.promptPrice }}/\${{ opt.completionPrice }}</span
                    >
                  }
                </button>
              }
            }
          </div>
        </div>
      }
      @if (effortOpen()) {
        <button
          type="button"
          data-testid="effort-popover-backdrop"
          aria-label="Close effort popover"
          tabindex="-1"
          class="fixed inset-0 z-30 cursor-default"
          (click)="effortOpen.set(false)"
        ></button>
        <div
          data-testid="effort-popover"
          class="absolute bottom-full right-0 z-40 mb-2 overflow-hidden rounded border border-[var(--line-strong)] bg-[var(--bg-1)] shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
          role="dialog"
        >
          <app-effort-slider
            [stops]="effortStops()"
            [activeLevel]="effectiveEffortLevel() ?? ''"
            [pinned]="currentEffortPin() !== null"
            (levelSelected)="onEffortSliderSelect($event)"
          />
        </div>
      }
    </div>
  `,
})
export class ModelSelectorComponent {
  private readonly tauri = inject(TauriService);
  private readonly anthropicModels = inject(AnthropicModelsService);
  private readonly log = inject(LoggerService);

  /** Active project id, used for the summary fetch and discovery calls. */
  readonly projectId = input.required<string>();
  /** True while a turn is streaming; disables the badge (ADR-045-style lock). */
  readonly streaming = input(false);

  /** Write-through error from `ChatStateService.applyModelSelection`; '' when none. */
  readonly modelError = input('');

  /** Live session model (SystemInit); the anthropic badge fallback, since config carries no model. */
  readonly sessionModel = input('');

  /** Routed to `ChatStateService.applyModelSelection`. */
  readonly modelSelected = output<ModelSelection>();

  /** Effort pick, routed to `ChatStateService.applyEffortSelection` (live wire `/effort`). */
  readonly effortSelected = output<string>();

  readonly open = signal(false);
  readonly query = signal('');
  readonly loading = signal(false);
  readonly error = signal('');
  protected readonly summary = signal<ActiveProviderSummary | null>(null);
  /** Project id the current `summary` was fetched for; drives staleness checks. */
  private summaryProjectId: string | null = null;
  private readonly options = signal<ModelOption[]>([]);

  /** In-flight option fetch, awaited by tests to settle the fire-and-forget open. */
  private optionsFetch: Promise<void> = Promise.resolve();

  /**
   * Last-successful local/OpenRouter discovery result, keyed by `kind|base_url` so a
   * provider or summary change invalidates it; re-opening the combobox for the same
   * key reuses it instead of re-issuing a live `discover_llm_models` VM+host probe.
   */
  private discoverCache: { key: string; options: ModelOption[] } | null = null;

  /** Full Anthropic catalog (selectable and legacy entries), the slider stops' SSOT. */
  private readonly anthropicCatalog = signal<AnthropicModel[]>([]);
  protected readonly currentEffortPin = signal<string | null>(null);
  protected readonly effortOpen = signal(false);

  /** Optimistic badge value after a live anthropic pick (no config write to re-read it from). */
  private readonly lastPicked = signal('');

  /** CC-parity pre-session hint: settings.json model pin, else the newest transcript's model. */
  private readonly modelHint = signal('');

  /** Anthropic-only: `effortLevel` is a Claude Code settings.json concept, not a provider one. */
  protected readonly showEffortControl = computed(() => {
    const summary = this.summary();
    return summary !== null && isAnthropicKind(summary.kind);
  });

  /** Full catalog entry backing the displayed model id (`[1m]` suffix stripped). */
  private readonly currentModelEntry = computed<AnthropicModel | null>(() => {
    const bare = this.displayModel().replace(/(\[1m\])+$/, '');
    return this.anthropicCatalog().find((m) => m.id === bare) ?? null;
  });

  /**
   * Any full 5-level catalog entry — the stop-list fallback for a display state with
   * no resolved catalog id (the pre-session "default" state, or an unrecognized pin).
   */
  private readonly fullLevelEntry = computed<AnthropicModel | null>(
    () => this.anthropicCatalog().find((m) => m.effort_levels.length === 5) ?? null
  );

  /** Slider stops for the active model, `low`→`max`; empty hides the segment (Haiku 4.5). */
  protected readonly effortStops = computed<string[]>(
    () => this.currentModelEntry()?.effort_levels ?? this.fullLevelEntry()?.effort_levels ?? []
  );

  /** The active model's own default effort (`high`, `xhigh` on Opus 4.7), shown unpinned. */
  private readonly catalogDefaultEffort = computed<string | null>(
    () => this.currentModelEntry()?.default_effort ?? this.fullLevelEntry()?.default_effort ?? null
  );

  /** Canonical `low`→`max` order, read from a full 5-level entry (never a hardcoded list). */
  private readonly canonicalOrder = computed<string[]>(
    () => this.fullLevelEntry()?.effort_levels ?? []
  );

  /** Hidden entirely when the active model has no effort levels (Haiku 4.5) or provider is routed. */
  protected readonly showEffortSegment = computed(
    () => this.showEffortControl() && this.effortStops().length > 0
  );

  /**
   * The level the handle/segment show: the pin if supported, else the highest supported
   * level at or below it (Claude Code's own clamp); unpinned, the model's catalog default.
   */
  protected readonly effectiveEffortLevel = computed<string | null>(() => {
    const stops = this.effortStops();
    if (stops.length === 0) return null;
    const pin = this.currentEffortPin();
    if (!pin) return this.catalogDefaultEffort();
    if (stops.includes(pin)) return pin;
    const order = this.canonicalOrder();
    const idx = order.indexOf(pin);
    for (let i = idx - 1; i >= 0; i--) {
      if (stops.includes(order[i])) return order[i];
    }
    return stops[0];
  });

  /** Pill segment text: capitalized effective level, or "Default" with no pin. */
  protected readonly effortSegmentLabel = computed<string>(() => {
    if (this.currentEffortPin() === null) return 'Default';
    const level = this.effectiveEffortLevel();
    return level ? capitalizeLevel(level) : 'Default';
  });

  /** Pill model segment: catalog family label (+ ` [1m]`) for a known id, else verbatim. */
  protected readonly displayModelLabel = computed<string>(() => {
    const id = this.displayModel();
    const entry = this.currentModelEntry();
    if (!entry) return id;
    return id.endsWith('[1m]') ? `${entry.family} [1m]` : entry.family;
  });

  /** Last `sessionModel` seen by the reload effect; detects a genuine session-start transition. */
  private lastSessionModel = '';

  /** Last `modelError` seen by the resync effect; detects a genuine new failure. */
  private lastModelError = '';

  /** Reloads the active-provider summary whenever the project id changes. */
  constructor() {
    effect(() => {
      const id = this.projectId();
      if (id) void this.loadSummary(id);
    });
    effect(() => {
      const id = this.projectId();
      if (this.showEffortControl() && id) void this.loadEffortState(id);
    });
    effect(() => {
      const id = this.projectId();
      if (this.showEffortControl() && id) void this.loadAnthropicCatalog();
    });
    // A new session applies any pending effort pin; re-read it so the badge clears.
    effect(() => {
      const live = this.sessionModel();
      const changed = live !== '' && live !== this.lastSessionModel;
      const ended = live === '' && this.lastSessionModel !== '';
      this.lastSessionModel = live;
      const id = this.projectId();
      if (changed && this.showEffortControl() && id) void this.loadEffortState(id);
      // Session over (new conversation/reset): a wire pick was session-scoped, so
      // drop the optimistic badge and re-read the next-session hint.
      if (ended) {
        this.lastPicked.set('');
        if (id && !this.summary()?.model) void this.loadModelHint(id);
      }
    });
    // A failed pin write-through (ChatStateService.applyEffortSelection)
    // must not leave the optimistic badge on a level that never persisted.
    effect(() => {
      const err = this.modelError();
      const changed = err !== '' && err !== this.lastModelError;
      this.lastModelError = err;
      const id = this.projectId();
      if (changed && this.showEffortControl() && id) void this.loadEffortState(id);
    });
  }

  /**
   * Badge text, never empty: optimistic anthropic pick -> observed session model
   * (the CURRENT-session truth: a wire /model can diverge from the stored config,
   * which is only the next-session default) -> config model -> CC's own pin /
   * last-transcript hint -> 'default' (a virgin project, CC resolves its default).
   */
  readonly displayModel = computed<string>(() => {
    const s = this.summary();
    const picked = this.lastPicked();
    if (picked) return picked;
    const live = this.sessionModel();
    if (live) return s ? normalizeObserved(live, s.provider_id) : live;
    if (s?.model) return normalizeObserved(s.model, s.provider_id);
    const hint = this.modelHint();
    if (hint) return s ? normalizeObserved(hint, s.provider_id) : hint;
    return 'default';
  });

  readonly filteredOptions = computed<ModelOption[]>(() => {
    const q = this.query().trim().toLowerCase();
    const all = this.options();
    if (!q) return all;
    return all.filter((o) => o.id.toLowerCase().includes(q) || o.label.toLowerCase().includes(q));
  });

  /**
   * Opens the combobox and starts the option fetch. Awaits the summary if it is
   * missing or stale for the current project, then kicks off `fetchOptions`
   * without awaiting it, so the combobox can render its loading state while the
   * catalog request is in flight.
   */
  async openCombobox(): Promise<void> {
    if (this.streaming()) return;
    this.effortOpen.set(false);
    this.open.set(true);
    const id = this.projectId();
    if (this.summaryProjectId !== id) await this.loadSummary(id);
    this.optionsFetch = this.fetchOptions();
  }

  /** Resolves once the current option fetch settles (test synchronization). */
  whenOptionsSettled(): Promise<void> {
    return this.optionsFetch;
  }

  /** Escape closes whichever popover (model list or effort slider) is open. */
  protected onEscape(): void {
    if (this.open()) this.open.set(false);
    if (this.effortOpen()) this.effortOpen.set(false);
  }

  /**
   * Updates the search query the combobox filters on.
   * @param value - New search text from the input.
   */
  onQueryChange(value: string): void {
    this.query.set(value);
  }

  /**
   * Expands a 1M-priced selectable Anthropic entry into two options: the bare
   * id and the `[1m]` 1M-priced-alias id (Task 7 catalog contract). Gated on
   * `has_1m` (backend `pricing_1m.is_some()`), NOT `context_tokens >= 1_000_000`
   * — claude-fable-5 reports a 200k bare context yet still prices a `[1m]` alias.
   * @param list - Full Anthropic catalog from `list_anthropic_models`.
   * @returns The selectable options, `[1m]` variants included.
   */
  private anthropicOptionsFrom(list: AnthropicModel[]): ModelOption[] {
    const rows: ModelOption[] = [];
    for (const m of list) {
      if (!m.selectable) continue;
      rows.push({ id: m.id, label: m.family, contextTokens: m.context_tokens });
      if (m.has_1m) {
        rows.push({
          id: `${m.id}[1m]`,
          label: `${m.family} (1M)`,
          contextTokens: m.context_tokens,
        });
      }
    }
    return rows;
  }

  /**
   * Runs a `discover_llm_models` probe for one provider and maps the result into
   * combobox options; the single source both the OpenRouter and local branches call.
   * @param provider - Wire provider id (`'openrouter'` or `'local'`).
   * @param baseUrl - Server base URL (`''` for OpenRouter, the summary's URL for local).
   */
  private async fetchDiscoverOptions(provider: string, baseUrl: string): Promise<ModelOption[]> {
    const res = await this.tauri.invoke<DiscoverResult>('discover_llm_models', {
      args: { provider, baseUrl, apiKey: undefined },
    });
    return (res?.models ?? []).map((m) => ({
      id: m.id,
      label: m.id,
      contextTokens: m.context_tokens ?? null,
    }));
  }

  /**
   * Fetches the option list for the active provider kind (badge combobox source).
   * Local/OpenRouter results are cached per `kind|base_url`; pass `force` to bypass
   * the cache (retry-after-error, or a fresh open must still catch a server-side change).
   * @param force - Skip the cache and re-issue the discovery probe.
   */
  async fetchOptions(force = false): Promise<void> {
    const summary = this.summary();
    if (!summary) return;
    this.loading.set(true);
    this.error.set('');
    try {
      if (isAnthropicKind(summary.kind)) {
        const list = await this.anthropicModels.list();
        this.options.set(this.anthropicOptionsFrom(list));
      } else {
        const isOpenRouter = summary.kind === 'open_router';
        if (!isOpenRouter && !summary.base_url) {
          throw new Error('local provider has no base_url configured');
        }
        const provider = isOpenRouter ? 'openrouter' : 'local';
        const baseUrl = isOpenRouter ? '' : (summary.base_url as string);
        const cacheKey = `${provider}|${baseUrl}`;
        if (!force && this.discoverCache?.key === cacheKey) {
          this.options.set(this.discoverCache.options);
        } else {
          const opts = await this.fetchDiscoverOptions(provider, baseUrl);
          this.discoverCache = { key: cacheKey, options: opts };
          this.options.set(opts);
        }
      }
      if (this.options().length === 0) this.error.set('No models available.');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`model-selector: fetch failed: ${msg}`);
      this.error.set('Failed to load models.');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Emits the single `modelSelected` event for a picked option and closes.
   * @param opt - The chosen combobox row.
   */
  select(opt: ModelOption): void {
    const summary = this.summary();
    if (!summary) return;
    const wireId = wireModelId(summary.kind, summary.provider_id, opt.id);
    this.modelSelected.emit({
      catalogId: opt.id,
      wireId,
      providerId: summary.provider_id,
      kind: summary.kind,
    });
    if (isAnthropicKind(summary.kind)) this.lastPicked.set(opt.id);
    this.open.set(false);
  }

  /**
   * Drops the result if the project changed while the fetch was in flight.
   * @param projectId - Project id to fetch the active-provider summary for.
   */
  private async loadSummary(projectId: string): Promise<void> {
    try {
      const summary = await this.tauri.invoke<ActiveProviderSummary>(
        'get_active_provider_summary',
        {
          project: projectId,
        }
      );
      if (this.projectId() !== projectId) return;
      this.summary.set(summary);
      this.summaryProjectId = projectId;
      this.lastPicked.set('');
      if (!summary.model) {
        void this.loadModelHint(projectId);
      } else {
        this.modelHint.set('');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`model-selector: get_active_provider_summary failed: ${msg}`);
    }
  }

  /**
   * Loads the pre-session model hint; drops the result if the project changed mid-flight.
   * @param projectId - Project id the hint is fetched for.
   */
  private async loadModelHint(projectId: string): Promise<void> {
    try {
      const hint = await this.tauri.invoke<string | null>('get_model_hint', { projectId });
      if (this.projectId() !== projectId) return;
      this.modelHint.set(hint ?? '');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`model-selector: get_model_hint failed: ${msg}`);
    }
  }

  /**
   * Loads the current launch-effort pin for the project (or `null` when unset).
   * Drops the result if the project changed while the fetch was in flight.
   * @param projectId - Active project id to read the pin for.
   */
  private async loadEffortState(projectId: string): Promise<void> {
    try {
      const pin = await this.tauri.invoke<string | null>('get_effort_pin', { projectId });
      if (this.projectId() !== projectId) return;
      this.currentEffortPin.set(pin);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`model-selector: effort pin load failed: ${msg}`);
    }
  }

  /** Loads the full Anthropic catalog backing the slider stops and the pill's family label. */
  private async loadAnthropicCatalog(): Promise<void> {
    const list = await this.anthropicModels.list();
    this.anthropicCatalog.set(list);
  }

  /** Toggles the effort popover, closing the model combobox if it was open. */
  protected toggleEffortPopover(): void {
    this.open.set(false);
    this.effortOpen.update((v) => !v);
  }

  /**
   * Applies a slider pick: closes the popover, updates the pin display, and emits
   * `effortSelected` (`ChatStateService.applyEffortSelection` persists the pin then wires).
   * @param level - The chosen stop, one of `effortStops()`.
   */
  protected onEffortSliderSelect(level: string): void {
    this.currentEffortPin.set(level);
    this.effortOpen.set(false);
    this.effortSelected.emit(level);
  }
}
