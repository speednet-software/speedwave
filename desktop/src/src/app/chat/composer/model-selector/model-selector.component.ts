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
  imports: [FormsModule, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
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
        {{ displayModel() }}
      </button>
      @if (modelError()) {
        <span data-testid="model-selection-error" role="alert" class="ml-2 text-red-300">{{
          modelError()
        }}</span>
      }
      @if (open()) {
        <div
          class="absolute bottom-full left-0 z-40 mb-2 w-80 overflow-hidden rounded border border-[var(--line-strong)] bg-[var(--bg-1)] shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
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
      @if (showEffortControl()) {
        <div data-testid="effort-control" class="hidden items-center gap-1 md:flex">
          <span
            class="mono text-[10px] text-[var(--ink-mute)]"
            appTooltip="Reasoning effort pin - applies from the next session (Claude Code reads it at session start)"
            placement="top"
            >{{ currentEffortPin() ?? 'auto' }}</span
          >
          @for (level of effortLevels(); track level) {
            <button
              type="button"
              [attr.data-testid]="'effort-option-' + level"
              [disabled]="streaming()"
              class="mono rounded border px-1.5 py-0.5 text-[10px] disabled:cursor-not-allowed disabled:opacity-50"
              [class]="
                effectiveEffort() === level
                  ? 'border-[var(--teal)] text-[var(--teal)]'
                  : 'border-[var(--line)] text-[var(--ink-mute)] hover:text-[var(--ink)]'
              "
              (click)="selectEffortLevel(level)"
            >
              {{ level }}
            </button>
          }
          @if (pendingEffortPin(); as pending) {
            <span data-testid="effort-pending" class="mono ml-1 text-[10px] text-[var(--amber)]"
              >{{ pending }} - next session</span
            >
          }
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

  /** The one event this component emits; routed to `ChatStateService.applyModelSelection`. */
  readonly modelSelected = output<ModelSelection>();

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

  protected readonly effortLevels = signal<string[]>([]);
  protected readonly currentEffortPin = signal<string | null>(null);
  protected readonly pendingEffortPin = signal<string | null>(null);
  /** Level highlighted in the segmented control: the freshly-picked pin, else the stored one. */
  protected readonly effectiveEffort = computed(
    () => this.pendingEffortPin() ?? this.currentEffortPin()
  );

  /** Optimistic badge value after a live anthropic pick (no config write to re-read it from). */
  private readonly lastPicked = signal('');

  /** CC-parity pre-session hint: settings.json model pin, else the newest transcript's model. */
  private readonly modelHint = signal('');

  /** Anthropic-only: `effortLevel` is a Claude Code settings.json concept, not a provider one. */
  protected readonly showEffortControl = computed(() => {
    const summary = this.summary();
    return summary !== null && isAnthropicKind(summary.kind);
  });

  /** Last `sessionModel` seen by the reload effect; detects a genuine session-start transition. */
  private lastSessionModel = '';

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
    // A new session applies any pending effort pin; re-read it so the badge clears.
    effect(() => {
      const live = this.sessionModel();
      const changed = live !== '' && live !== this.lastSessionModel;
      this.lastSessionModel = live;
      const id = this.projectId();
      if (changed && this.showEffortControl() && id) void this.loadEffortState(id);
    });
  }

  /**
   * Badge text, never empty: config model (normalized) -> optimistic live pick ->
   * observed session model -> CC's own pin / last-transcript model -> 'default'
   * (only a virgin project, where CC itself resolves the unknowable license default).
   */
  readonly displayModel = computed<string>(() => {
    const s = this.summary();
    if (s?.model) return normalizeObserved(s.model, s.provider_id);
    const picked = this.lastPicked();
    if (picked) return picked;
    const live = this.sessionModel();
    if (live) return s ? normalizeObserved(live, s.provider_id) : live;
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
    this.open.set(true);
    const id = this.projectId();
    if (this.summaryProjectId !== id) await this.loadSummary(id);
    this.optionsFetch = this.fetchOptions();
  }

  /** Resolves once the current option fetch settles (test synchronization). */
  whenOptionsSettled(): Promise<void> {
    return this.optionsFetch;
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
   * Loads the persistable-level list and the current launch-effort pin for the project.
   * Drops the result if the project changed while the fetch was in flight.
   * @param projectId - Active project id to read the pin for.
   */
  private async loadEffortState(projectId: string): Promise<void> {
    try {
      const [levels, pin] = await Promise.all([
        this.tauri.invoke<string[]>('list_effort_levels'),
        this.tauri.invoke<string | null>('get_effort_pin', { projectId }),
      ]);
      if (this.projectId() !== projectId) return;
      this.effortLevels.set(levels);
      this.currentEffortPin.set(pin);
      this.pendingEffortPin.set(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`model-selector: effort pin load failed: ${msg}`);
    }
  }

  /**
   * Writes the next-session effort pin and refreshes the pending-vs-current display.
   * @param level - One of `PERSISTABLE_EFFORT_LEVELS`, from an `effort-option-*` click.
   */
  protected async selectEffortLevel(level: string): Promise<void> {
    if (this.streaming()) return;
    const projectId = this.projectId();
    try {
      await this.tauri.invoke('set_effort_pin', { projectId, level });
      const pin = await this.tauri.invoke<string | null>('get_effort_pin', { projectId });
      this.pendingEffortPin.set(pin !== this.currentEffortPin() ? pin : null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`model-selector: set_effort_pin failed: ${msg}`);
    }
  }
}
