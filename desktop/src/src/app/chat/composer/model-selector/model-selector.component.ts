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
import { TauriService } from '../../../services/tauri.service';
import { AnthropicModelsService } from '../../../services/anthropic-models.service';
import { LoggerService } from '../../../services/logger.service';
import type { ActiveProviderSummary, AnthropicModel, DiscoverResult } from '../../../models/llm';
import { wireModelId } from './wire-model-id';

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
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      data-testid="composer-model-badge"
      class="hidden text-[var(--teal)] md:inline disabled:cursor-not-allowed disabled:opacity-50"
      [disabled]="streaming()"
      [attr.title]="streaming() ? 'Model locked while a turn is streaming' : 'Change model'"
      (click)="openCombobox()"
    >
      {{ displayModel() }}
    </button>
    @if (open()) {
      <div class="model-selector-popover" role="dialog">
        <input
          data-testid="model-selector-search"
          type="text"
          [ngModel]="query()"
          (ngModelChange)="onQueryChange($event)"
          placeholder="Search models..."
        />
        @if (loading()) {
          <div data-testid="model-selector-loading">Loading models...</div>
        } @else if (error()) {
          <div data-testid="model-selector-error">
            {{ error() }}
            <button type="button" data-testid="model-selector-retry" (click)="fetchOptions()">
              Retry
            </button>
          </div>
        } @else {
          @for (opt of filteredOptions(); track opt.id) {
            <button
              type="button"
              [attr.data-testid]="'model-selector-option-' + opt.id"
              (click)="select(opt)"
            >
              {{ opt.label }}
              @if (opt.promptPrice !== undefined) {
                <span>\${{ opt.promptPrice }}/\${{ opt.completionPrice }}</span>
              }
            </button>
          }
        }
      </div>
    }
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

  /** The one event this component emits; routed to `ChatStateService.applyModelSelection`. */
  readonly modelSelected = output<ModelSelection>();

  readonly open = signal(false);
  readonly query = signal('');
  readonly loading = signal(false);
  readonly error = signal('');
  protected readonly summary = signal<ActiveProviderSummary | null>(null);
  private readonly options = signal<ModelOption[]>([]);

  /** In-flight option fetch, awaited by tests to settle the fire-and-forget open. */
  private optionsFetch: Promise<void> = Promise.resolve();

  /** Reloads the active-provider summary whenever the project id changes. */
  constructor() {
    effect(() => {
      const id = this.projectId();
      if (id) void this.loadSummary(id);
    });
  }

  /** Model shown on the badge, normalized (no `<entry_id>/` wire prefix). */
  readonly displayModel = computed<string>(() => {
    const s = this.summary();
    if (!s?.model) return '';
    const idx = s.model.indexOf('/');
    // Anthropic ids never carry a slash; a proxy-routed id is "<entry_id>/<catalog_id>".
    return idx === -1 || s.kind === 'anthropic_oauth' || s.kind === 'anthropic_api_key'
      ? s.model
      : s.model.slice(idx + 1);
  });

  readonly filteredOptions = computed<ModelOption[]>(() => {
    const q = this.query().trim().toLowerCase();
    const all = this.options();
    if (!q) return all;
    return all.filter((o) => o.id.toLowerCase().includes(q) || o.label.toLowerCase().includes(q));
  });

  /**
   * Opens the combobox and starts the option fetch. Awaits the summary if it is
   * still loading, then kicks off `fetchOptions` without awaiting it, so the
   * combobox can render its loading state while the catalog request is in flight.
   */
  async openCombobox(): Promise<void> {
    if (this.streaming()) return;
    this.open.set(true);
    if (!this.summary()) await this.loadSummary(this.projectId());
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
   * Expands a 1M-capable selectable Anthropic entry into two options: the bare
   * 200k-session id and the `[1m]` 1M-session id (Task 7 catalog contract).
   * @param list - Full Anthropic catalog from `list_anthropic_models`.
   * @returns The selectable options, `[1m]` variants included.
   */
  private anthropicOptionsFrom(list: AnthropicModel[]): ModelOption[] {
    const rows: ModelOption[] = [];
    for (const m of list) {
      if (!m.selectable) continue;
      rows.push({ id: m.id, label: m.family, contextTokens: m.context_tokens });
      if (m.context_tokens >= 1_000_000) {
        rows.push({
          id: `${m.id}[1m]`,
          label: `${m.family} (1M)`,
          contextTokens: m.context_tokens,
        });
      }
    }
    return rows;
  }

  /** Fetches the option list for the active provider kind (badge combobox source). */
  async fetchOptions(): Promise<void> {
    const summary = this.summary();
    if (!summary) return;
    this.loading.set(true);
    this.error.set('');
    try {
      if (summary.kind === 'anthropic_oauth' || summary.kind === 'anthropic_api_key') {
        const list = await this.anthropicModels.list();
        this.options.set(this.anthropicOptionsFrom(list));
      } else if (summary.kind === 'open_router') {
        const res = await this.tauri.invoke<DiscoverResult>('discover_llm_models', {
          args: { provider: 'openrouter', baseUrl: '', apiKey: undefined },
        });
        this.options.set(
          (res?.models ?? []).map((m) => ({
            id: m.id,
            label: m.id,
            contextTokens: m.context_tokens ?? null,
          }))
        );
      } else {
        if (!summary.base_url) {
          throw new Error('local provider has no base_url configured');
        }
        const res = await this.tauri.invoke<DiscoverResult>('discover_llm_models', {
          args: { provider: 'local', baseUrl: summary.base_url, apiKey: undefined },
        });
        this.options.set(
          (res?.models ?? []).map((m) => ({
            id: m.id,
            label: m.id,
            contextTokens: m.context_tokens ?? null,
          }))
        );
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
      this.summary.set(summary);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`model-selector: get_active_provider_summary failed: ${msg}`);
    }
  }
}
