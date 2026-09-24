import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TooltipDirective } from '../../../shared/tooltip.directive';
import { TauriService } from '../../../services/tauri.service';
import { AnthropicModelsService } from '../../../services/anthropic-models.service';
import { ClaudeControlService } from '../../../services/claude-control.service';
import { ModelPickerService } from '../../../services/model-picker.service';
import { DiscoveredModelsService } from '../../../services/discovered-models.service';
import { LoggerService } from '../../../services/logger.service';
import type { ActiveProviderSummary, AnthropicModel, DiscoveredModel } from '../../../models/llm';
import { isAnthropicKind } from '../../../models/llm';
import type { ModelPicker, ModelPickerRow } from '../../../models/model-picker';
import { normalizeObserved, wireModelId } from './wire-model-id';
import { EffortSliderComponent, capitalizeLevel } from './effort-slider.component';

const MODEL_LIST_UNAVAILABLE = 'Model list unavailable.';
const LOAD_FAILED = 'Failed to load models.';

interface ModelOption {
  id: string;
  label: string;
  wireId: string;
  isDefault: boolean;
  contextTokens: number | null;
  description: string | null;
  requiresUsageCredits: boolean;
  promptPrice?: number;
  completionPrice?: number;
}

/** The single event this component emits on any selection (Task 16 contract). */
export interface ModelSelection {
  catalogId: string;
  wireId: string;
  providerId: string;
  kind: string;
  isDefault: boolean;
  contextTokens: number | null;
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
        [disabled]="streaming() || pickerPending()"
        [attr.title]="badgeTitle()"
        (click)="openCombobox()"
      >
        {{ displayModelLabel() }}
      </button>
      @if (showEffortSegment()) {
        <button
          type="button"
          data-testid="effort-segment"
          class="hidden text-[var(--ink-mute)] hover:text-[var(--ink)] hover:underline md:inline"
          appTooltip="Reasoning effort - saved for this project's sessions"
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
          @if (stale()) {
            <div
              data-testid="model-selector-stale"
              class="mono flex items-center gap-2 border-b border-[var(--line)] px-3 py-2 text-[11px] text-[var(--ink-mute)]"
            >
              <span>Could not refresh. Showing the last known list.</span>
              <button
                type="button"
                data-testid="model-selector-retry"
                class="hover-bg rounded border border-[var(--line-strong)] px-2 py-0.5 text-[10px] text-[var(--ink)]"
                (click)="fetchOptions(true)"
              >
                Retry
              </button>
            </div>
          }
          <div class="max-h-72 overflow-y-auto py-1">
            @if (listLoading()) {
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
                  [attr.aria-current]="opt.id === activeOptionId() ? 'true' : null"
                  (click)="select(opt)"
                >
                  <span class="flex min-w-0 items-start gap-2">
                    @if (showEffortControl()) {
                      <span class="inline-block w-3 shrink-0 text-[var(--teal)]" aria-hidden="true">
                        @if (opt.id === activeOptionId()) {
                          <span data-testid="model-selector-active-mark">&#x2713;</span>
                        }
                      </span>
                    }
                    <span class="flex min-w-0 flex-col gap-0.5">
                      <span class="flex items-center gap-2">
                        <span>{{ opt.label }}</span>
                        @if (opt.isDefault) {
                          <span
                            data-testid="model-selector-default-badge"
                            class="rounded border border-[var(--line-strong)] px-1 text-[9px] uppercase tracking-wide text-[var(--ink-mute)]"
                            >Default</span
                          >
                        }
                        @if (opt.requiresUsageCredits) {
                          <span
                            data-testid="model-selector-usage-credits-badge"
                            class="rounded border border-amber-500/60 px-1 text-[9px] uppercase tracking-wide text-amber-300"
                            >Usage credits</span
                          >
                        }
                      </span>
                      @if (opt.description) {
                        <span
                          [attr.data-testid]="'model-selector-description-' + opt.id"
                          class="whitespace-normal text-[10px] leading-tight text-[var(--ink-mute)]"
                          >{{ opt.description }}</span
                        >
                      }
                    </span>
                  </span>
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
  private readonly control = inject(ClaudeControlService);
  private readonly picker = inject(ModelPickerService);
  private readonly discovered = inject(DiscoveredModelsService);
  private readonly log = inject(LoggerService);

  readonly projectId = input.required<string>();
  readonly streaming = input(false);

  readonly modelError = input('');

  readonly sessionModel = input('');

  readonly modelSelected = output<ModelSelection>();

  readonly effortSelected = output<string>();

  readonly open = signal(false);
  readonly query = signal('');
  readonly loading = signal(false);
  readonly error = signal('');
  protected readonly stale = signal(false);
  protected readonly summary = signal<ActiveProviderSummary | null>(null);
  private summaryProjectId: string | null = null;
  private readonly options = signal<ModelOption[]>([]);

  private optionsFetch: Promise<void> = Promise.resolve();

  private listInfoState = '';

  private probedKey = '';

  protected readonly currentEffortPin = signal<string | null>(null);
  protected readonly effortOpen = signal(false);

  private readonly lastPicked = signal('');

  private readonly modelHint = signal('');

  protected readonly showEffortControl = computed(() => {
    const summary = this.summary();
    return summary !== null && isAnthropicKind(summary.kind);
  });

  protected readonly pickerPending = computed(
    () =>
      this.showEffortControl() &&
      this.control.sessionInfoState(this.projectId()).state === 'pending'
  );

  protected readonly listLoading = computed(
    () => this.loading() || (this.pickerPending() && this.options().length === 0)
  );

  protected readonly badgeTitle = computed<string>(() => {
    if (this.streaming()) return 'Model locked while a turn is streaming';
    return this.pickerPending() ? 'Loading models...' : 'Change model';
  });

  protected readonly activeOptionId = computed<string | null>(() => this.activeRow()?.id ?? null);

  private readonly activeRow = computed<ModelPickerRow | null>(() =>
    this.showEffortControl() ? this.picker.rowFor(this.projectId(), this.displayModel()) : null
  );

  private readonly currentModelEntry = computed<AnthropicModel | null>(() =>
    this.anthropicModels.entryFor(this.activeOptionId() ?? this.displayModel())
  );

  private readonly canonicalOrder = computed<string[]>(
    () => this.picker.picker(this.projectId())?.effort_order ?? []
  );

  protected readonly effortStops = computed<string[]>(
    () =>
      this.activeRow()?.effort_levels ??
      this.currentModelEntry()?.effort_levels ??
      this.canonicalOrder()
  );

  private readonly catalogDefaultEffort = computed<string | null>(() => {
    const row = this.activeRow();
    return row ? row.default_effort : (this.currentModelEntry()?.default_effort ?? null);
  });

  protected readonly showEffortSegment = computed(
    () => this.showEffortControl() && this.effortStops().length > 0
  );

  protected readonly effectiveEffortLevel = computed<string | null>(() => {
    const stops = this.effortStops();
    if (stops.length === 0) return null;
    const pin = this.currentEffortPin();
    if (!pin) return this.catalogDefaultEffort();
    if (stops.includes(pin)) return pin;
    const order = this.canonicalOrder();
    const idx = order.indexOf(pin);
    if (idx === -1) return this.catalogDefaultEffort() ?? stops[0];
    for (let i = idx - 1; i >= 0; i--) {
      if (stops.includes(order[i])) return order[i];
    }
    return stops[0];
  });

  protected readonly effortSegmentLabel = computed<string>(() => {
    if (this.currentEffortPin() === null) return 'Default';
    const level = this.effectiveEffortLevel();
    return level ? capitalizeLevel(level) : 'Default';
  });

  protected readonly displayModelLabel = computed<string>(() =>
    this.picker.label(this.displayModel(), this.projectId())
  );

  private lastSessionModel = '';

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
      if (this.showEffortControl() && id) void this.anthropicModels.list();
    });
    effect(() => {
      const id = this.projectId();
      if (this.showEffortControl() && id) void this.control.refreshSessionInfo(id);
    });
    effect(() => {
      const id = this.projectId();
      if (!this.showEffortControl() || !id) return;
      const state = this.control.sessionInfoState(id).state;
      if (state === 'pending') {
        this.listInfoState = state;
        return;
      }
      untracked(() => {
        if (this.open() && state !== this.listInfoState) this.optionsFetch = this.fetchOptions();
        else void this.picker.refresh(id);
      });
    });
    effect(() => {
      const live = this.sessionModel();
      const changed = live !== '' && live !== this.lastSessionModel;
      const ended = live === '' && this.lastSessionModel !== '';
      this.lastSessionModel = live;
      const id = this.projectId();
      if (changed && this.showEffortControl() && id) void this.loadEffortState(id);
      if (ended) {
        this.lastPicked.set('');
        if (id && !this.summary()?.model) void this.loadModelHint(id);
      }
    });
    effect(() => {
      const err = this.modelError();
      const changed = err !== '' && err !== this.lastModelError;
      this.lastModelError = err;
      const id = this.projectId();
      if (changed && this.showEffortControl() && id) void this.loadEffortState(id);
    });
  }

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
    return all.filter(
      (o) =>
        o.id.toLowerCase().includes(q) ||
        o.label.toLowerCase().includes(q) ||
        o.description?.toLowerCase().includes(q)
    );
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

  private anthropicOptionsFrom(picker: ModelPicker, projectId: string): ModelOption[] {
    return picker.rows.map((row) => ({
      id: row.id,
      label: this.picker.label(row.id, projectId),
      wireId: row.wire_id,
      isDefault: row.is_default,
      contextTokens: null,
      description: row.description,
      requiresUsageCredits: row.requires_usage_credits,
    }));
  }

  private discoveredOptionsFrom(models: DiscoveredModel[]): ModelOption[] {
    return models.map((m) => ({
      id: m.id,
      label: m.id,
      wireId: m.id,
      isDefault: false,
      contextTokens: m.context_tokens ?? null,
      description: null,
      requiresUsageCredits: false,
    }));
  }

  /**
   * Fetches the option list for the active provider kind (badge combobox source).
   * A selector instance probes a local/OpenRouter provider once per `kind|base_url`; pass
   * `force` to re-probe. A failed probe falls back to the last known list, marked stale.
   * @param force - Re-issue the discovery probe even when this instance already probed.
   */
  async fetchOptions(force = false): Promise<void> {
    const summary = this.summary();
    if (!summary) return;
    this.loading.set(true);
    this.error.set('');
    this.stale.set(false);
    try {
      if (isAnthropicKind(summary.kind)) {
        const projectId = this.projectId();
        this.listInfoState = this.control.sessionInfoState(projectId).state;
        await this.anthropicModels.list();
        const picker = await this.picker.refresh(projectId);
        if (!picker) {
          this.options.set([]);
          this.error.set(MODEL_LIST_UNAVAILABLE);
          return;
        }
        this.options.set(this.anthropicOptionsFrom(picker, projectId));
      } else {
        const isOpenRouter = summary.kind === 'open_router';
        if (!isOpenRouter && !summary.base_url) {
          throw new Error('local provider has no base_url configured');
        }
        const provider = isOpenRouter ? 'openrouter' : 'local';
        const baseUrl = isOpenRouter ? '' : (summary.base_url as string);
        const key = `${provider}|${baseUrl}`;
        const held = this.discovered.cached(provider, baseUrl);
        if (!force && this.probedKey === key && held) {
          this.options.set(this.discoveredOptionsFrom(held));
        } else {
          const res = await this.discovered.refresh(provider, baseUrl);
          if (!res) {
            this.options.set([]);
            this.error.set(LOAD_FAILED);
            return;
          }
          if (res.fresh) this.probedKey = key;
          this.stale.set(!res.fresh);
          this.options.set(this.discoveredOptionsFrom(res.models));
        }
      }
      if (this.options().length === 0) this.error.set('No models available.');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`model-selector: fetch failed: ${msg}`);
      this.error.set(LOAD_FAILED);
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
    if (
      opt.requiresUsageCredits &&
      !confirm(
        `${opt.label} requires usage credits for this account. Speedwave runs Claude Code non-interactively, so Anthropic may charge those credits without another prompt. Continue?`
      )
    ) {
      return;
    }
    const wireId = isAnthropicKind(summary.kind)
      ? opt.wireId
      : wireModelId(summary.kind, summary.provider_id, opt.id);
    this.modelSelected.emit({
      catalogId: opt.id,
      wireId,
      providerId: summary.provider_id,
      kind: summary.kind,
      isDefault: opt.isDefault,
      contextTokens: opt.contextTokens,
    });
    this.lastPicked.set(opt.id);
    this.open.set(false);
  }

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

  protected toggleEffortPopover(): void {
    this.open.set(false);
    this.effortOpen.update((v) => !v);
  }

  protected onEffortSliderSelect(level: string): void {
    this.currentEffortPin.set(level);
    this.effortOpen.set(false);
    this.effortSelected.emit(level);
  }
}
