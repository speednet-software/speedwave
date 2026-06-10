import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnInit,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { AnthropicModelsService } from '../../services/anthropic-models.service';
import { ChatStateService } from '../../services/chat-state.service';
import { LoggerService } from '../../services/logger.service';
import { TooltipDirective } from '../../shared/tooltip.directive';
import {
  AnthropicModel,
  DiscoveredModel,
  DiscoverResult,
  formatContextLabel,
  LEGACY_LOCAL_PROVIDERS,
  LlmConfigResponse,
  MessagesEndpointStatus,
} from '../../models/llm';

/**
 * Discovery state for the LLM model listing. Discriminated union makes the
 * allowed transitions explicit and prevents inconsistent combinations of
 * `discovering + discoveryFailed + discoveredModels` booleans.
 *
 * The `id` on `in-flight` matches the component's monotonic counter — arriving
 * responses whose id is not the latest counter value are discarded as stale
 * (handles rapid blur / provider change races).
 */
type DiscoveryState =
  | { kind: 'idle' }
  | { kind: 'in-flight'; url: string; id: number }
  | { kind: 'ready'; url: string; models: DiscoveredModel[] }
  | { kind: 'failed'; url: string; reason: 'offline' | 'refused' | 'unsupported' | 'other' };

/** Static catalog of provider cards rendered at the top of the section. */
interface ProviderCard {
  readonly id: 'anthropic' | 'local';
  readonly label: string;
  readonly tag: string;
}

const PROVIDER_CARDS: readonly ProviderCard[] = [
  { id: 'anthropic', label: 'anthropic', tag: 'cloud · default' },
  { id: 'local', label: 'local', tag: 'any anthropic messages server' },
] as const;

/** Manages LLM provider selection and configuration. */
@Component({
  selector: 'app-llm-provider',
  imports: [CommonModule, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section id="section-llm-provider">
      <h2 class="view-title view-title-section text-[var(--ink)]">LLM provider</h2>
      <p class="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
        Where Claude Code routes model requests. Local providers keep everything on-device.
      </p>

      @if (legacyMigrationProvider) {
        <div
          class="mono mt-3 rounded border border-[var(--accent-dim)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] text-[var(--accent)]"
          data-testid="settings-llm-legacy-migration-banner"
        >
          Provider name <code>{{ legacyMigrationProvider }}</code> is legacy and will be saved as
          <code>local</code> on next Save. Same behavior, unified naming.
        </div>
      }

      <!-- Provider cards (2-column grid: anthropic + local) -->
      <div class="mt-4 grid grid-cols-2 gap-2" role="radiogroup" aria-label="LLM provider">
        @for (p of providerCards; track p.id) {
          <button
            type="button"
            role="radio"
            [attr.aria-checked]="provider === p.id"
            [attr.data-testid]="'settings-llm-provider-' + p.id"
            class="rounded border px-3 py-2 text-left transition-colors"
            [class]="
              provider === p.id
                ? 'border-[var(--accent-dim)] bg-[var(--accent-soft)]'
                : 'border-[var(--line)] bg-[var(--bg-1)] hover:border-[var(--line-strong)]'
            "
            (click)="selectProvider(p.id)"
          >
            <div
              class="mono text-[11px] font-medium"
              [class]="provider === p.id ? 'text-[var(--accent)]' : 'text-[var(--ink-dim)]'"
            >
              {{ p.label }}
            </div>
            <div class="mono mt-0.5 text-[10px] text-[var(--ink-mute)]">{{ p.tag }}</div>
          </button>
        }
      </div>

      <!-- Always-visible usage hint — shown for both anthropic and local -->
      <p
        class="mono mt-3 text-[11px] leading-relaxed text-[var(--ink-mute)]"
        data-testid="settings-llm-usage-hint"
      >
        {{ usageHint() }}
      </p>

      <!-- BASE_URL + DEFAULT_MODEL row -->
      <div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label
            class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            for="llm-base-url"
            >base_url</label
          >
          <input
            id="llm-base-url"
            type="text"
            [value]="baseUrl"
            (input)="baseUrl = $any($event.target).value"
            [placeholder]="defaultBaseUrl || anthropicBaseUrlHint()"
            [readOnly]="provider === 'anthropic'"
            (blur)="discoverModels(false)"
            class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
            data-testid="settings-llm-base-url"
          />
          @if (provider !== 'anthropic') {
            <p
              class="mono mt-1 text-[10px] text-[var(--ink-mute)]"
              data-testid="settings-llm-base-url-host-hint"
            >
              Use <code>host.docker.internal</code> (not <code>localhost</code>,
              <code>127.0.0.1</code>, or <code>0.0.0.0</code>). Claude Code runs inside a container
              — <code>localhost</code> there means the container itself, not your machine.
              <code>0.0.0.0</code> is a bind address and is rejected.
            </p>
            @if (containerLocalHostWarning(); as warning) {
              <p
                class="mono mt-1 text-[11px] text-[var(--amber)]"
                data-testid="settings-llm-container-local-warning"
              >
                ⚠ {{ warning }}
              </p>
            }
          }
        </div>
        <div>
          <label
            class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            for="llm-model"
            >default_model</label
          >
          @if (provider !== 'anthropic' && discoveryState.kind === 'ready') {
            <select
              id="llm-model"
              [value]="model"
              (change)="onLocalModelChange($any($event.target).value)"
              class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
              data-testid="settings-llm-model"
            >
              @if (model && !discoveredModelIds().includes(model)) {
                <option [value]="model">{{ model }} (not on server)</option>
              }
              @for (m of discoveryState.models; track m.id) {
                <option [value]="m.id">{{ formatLocalModelLabel(m) }}</option>
              }
            </select>
          } @else if (provider === 'anthropic') {
            <select
              id="llm-model"
              [value]="model"
              (change)="model = $any($event.target).value"
              class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
              data-testid="settings-llm-model"
            >
              <!-- Empty value = no ANTHROPIC_MODEL injected; Claude Code
                   picks its built-in default via ANTHROPIC_DEFAULT_OPUS_MODEL
                   (set by compose::apply_llm_config). The label resolves the
                   Opus family from the SSOT so the user knows what they
                   actually get. Three-state render: undefined keeps the
                   option blank-but-valid while the SSOT label is in flight
                   (so a model=null config still has something selectable
                   and we do not flash the misleading generic wording);
                   string renders the dynamic hint; null (resolved without
                   a label, e.g. older backend) falls back to the generic
                   wording. -->
              @if (defaultAnthropicLabel() === undefined) {
                <option value=""></option>
              } @else if (defaultAnthropicLabel(); as label) {
                <option value="">Default — {{ label }} (switchable via /model)</option>
              } @else {
                <option value="">(default — let Claude Code choose)</option>
              }
              @if (latestAnthropicModels().length > 0) {
                <optgroup label="Latest">
                  @for (m of latestAnthropicModels(); track m.id) {
                    <option [value]="m.id">{{ formatModelLabel(m) }}</option>
                  }
                </optgroup>
              }
              @if (legacyAnthropicModels().length > 0) {
                <optgroup label="Legacy">
                  @for (m of legacyAnthropicModels(); track m.id) {
                    <option [value]="m.id">{{ formatModelLabel(m) }}</option>
                  }
                </optgroup>
              }
              <!-- Preserve a previously-saved model that the SSOT no longer
                   carries (e.g. config persisted before a model was
                   deprecated) so the user sees what's actually in their
                   config rather than an empty selection. -->
              @if (model && !modelInCatalog(model)) {
                <option [value]="model">{{ model }} (not in catalog)</option>
              }
            </select>
          } @else {
            <input
              id="llm-model"
              type="text"
              [value]="model"
              (input)="model = $any($event.target).value"
              [placeholder]="modelPlaceholder()"
              class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
              data-testid="settings-llm-model"
            />
          }
          @if (discoveryState.kind === 'failed') {
            <p
              class="mono mt-1 text-[11px] text-[var(--amber)]"
              data-testid="settings-llm-discovery-error"
            >
              {{ discoveryFailureMessage() }}
            </p>
          }
          @if (discoveryState.kind === 'in-flight') {
            <p
              class="mono mt-1 text-[11px] text-[var(--ink-mute)]"
              data-testid="settings-llm-discovering"
            >
              Probing {{ discoveryState.url }}...
            </p>
          }
        </div>
      </div>

      @if (provider !== 'anthropic') {
        <!-- API key (optional) — Bearer token for servers requiring auth. -->
        <div class="mt-4">
          <label
            class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            for="llm-api-key"
            >api_key (optional)</label
          >
          <input
            id="llm-api-key"
            type="password"
            autocomplete="off"
            spellcheck="false"
            [value]="apiKey"
            (input)="onApiKeyInput($any($event.target).value)"
            [placeholder]="
              hasApiKey
                ? '••••• (key saved — type to replace, clear to remove)'
                : 'Bearer token (e.g. sk-…)'
            "
            class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
            data-testid="settings-llm-api-key"
          />
        </div>

        <!-- Custom headers (optional) — Azure APIM, corporate gateways. -->
        <div class="mt-3">
          <label
            class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
            for="llm-custom-headers"
            >custom_headers (optional)</label
          >
          <textarea
            id="llm-custom-headers"
            rows="3"
            spellcheck="false"
            [value]="customHeaders"
            (input)="onCustomHeadersInput($any($event.target).value)"
            [placeholder]="
              hasCustomHeaders
                ? '••••• (saved — type to replace, clear to remove)'
                : 'X-Tenant-ID: foo
Ocp-Apim-Subscription-Key: bar'
            "
            class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
            data-testid="settings-llm-custom-headers"
          ></textarea>
          <p class="mono mt-1 text-[10px] text-[var(--ink-mute)]">
            One header per line, format <code>Name: Value</code>. Cannot set Authorization (use
            api_key) or hop-by-hop headers.
          </p>
        </div>

        <button
          type="button"
          data-testid="settings-llm-refresh"
          class="mono mt-3 text-[11px] text-[var(--accent)] hover:underline disabled:opacity-40 disabled:no-underline"
          [disabled]="discoveryState.kind === 'in-flight'"
          (click)="discoverModels(true)"
          appTooltip="Fetch the list of models from the server"
          placement="top"
        >
          @if (discoveryState.kind === 'in-flight') {
            &#8635; discovering...
          } @else {
            &#8635; discover models
          }
        </button>
        <p class="mono mt-1 text-[10px] text-[var(--ink-mute)]">
          Sends a 1-token test request to verify chat endpoint compatibility.
        </p>

        @if (messagesEndpointStatus === 'strict_system_role') {
          <div
            class="mono mt-3 rounded border border-[var(--amber)] bg-[var(--amber)]/10 px-3 py-2 text-[11px] text-[var(--amber)]"
            data-testid="settings-llm-strict-system-warning"
          >
            <strong>Warning:</strong> the server implements <code>POST /v1/messages</code> but
            rejects Claude Code's request shape — it refuses a <code>system</code> role inside
            <code>messages[]</code> (HTTP 422). Claude Code sends the system prompt inside
            <code>messages[]</code>, so chat will fail with this server. Speedwave cannot reshape
            the request (no proxy). Use a server that accepts Claude Code's Anthropic Messages
            payload (Ollama 0.14+, LM Studio 0.4.1+, llama.cpp Jan 2026+).
          </div>
        }
        @if (messagesEndpointStatus === 'missing') {
          <div
            class="mono mt-3 rounded border border-[var(--amber)] bg-[var(--amber)]/10 px-3 py-2 text-[11px] text-[var(--amber)]"
            data-testid="settings-llm-messages-endpoint-warning"
          >
            <strong>Warning:</strong> the server returned a model list but did not respond to
            <code>POST /v1/messages</code> (Anthropic Messages API). Save is allowed, but chat will
            fail. Use a server with Anthropic Messages support (Ollama 0.14+, LM Studio 0.4.1+,
            llama.cpp Jan 2026+, or LiteLLM via <code>/anthropic</code>).
          </div>
        }
        @if (messagesEndpointStatus === 'unknown') {
          <p class="mono mt-2 text-[10px] text-[var(--ink-mute)]">
            Could not verify chat-endpoint compatibility (server busy or unreachable during probe).
          </p>
        }
      }

      <div class="mt-3 flex items-center gap-3">
        <button
          type="button"
          class="mono rounded bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="settings-llm-save"
          (click)="saveConfig()"
          [disabled]="saving"
        >
          {{ saving ? 'saving...' : 'save' }}
        </button>
        @if (saved) {
          <span class="mono text-[11px] text-[var(--green)]" data-testid="settings-llm-saved"
            >saved!</span
          >
        }
      </div>
    </section>
  `,
})
export class LlmProviderComponent implements OnInit {
  provider = 'anthropic';
  model = '';
  baseUrl = '';
  defaultBaseUrl = '';
  saving = false;
  saved = false;

  /**
   * Local-LLM API key (Bearer). Form-only — the value never round-trips
   * through `get_llm_config`; backend stores it in a per-project token file
   * and exposes only `has_api_key` to the frontend. `apiKeyTouched` flips on
   * any user edit so Save can distinguish "leave unchanged" from "set to
   * empty" from "set to value".
   */
  apiKey = '';
  apiKeyTouched = false;
  hasApiKey = false;

  /**
   * Optional custom HTTP headers (Azure APIM, corporate gateways). Same
   * touched-flag pattern as apiKey. Format: one `Name: Value` per line.
   */
  customHeaders = '';
  customHeadersTouched = false;
  hasCustomHeaders = false;

  /** Compatibility status of the Anthropic Messages endpoint from the last discovery probe. */
  messagesEndpointStatus: MessagesEndpointStatus | null = null;

  /**
   * Legacy provider name (`ollama`/`lmstudio`/`llamacpp`) detected in the
   * persisted config. `null` when the config carries the current `local`
   * name or `anthropic`. Drives the auto-migration banner above the
   * provider cards — the rewrite to `local` only happens on the next Save,
   * which keeps downgrade safety until the user opts in.
   */
  legacyMigrationProvider: string | null = null;

  /**
   * Context window persisted in `claude.llm.context_tokens` for the active
   * project — seeded from `get_llm_config` on load. Used as a fallback by
   * `resolveContextTokensForSave` when the discovery probe hasn't run yet
   * (typical right after a fresh app start with a saved local provider).
   * Once discovery yields a value for the picked model, the discoveryState
   * payload becomes the source of truth and this seed is no longer read.
   */
  private loadedLocalContextTokens: number | null = null;

  /** Cards rendered at the top of the section (mockup-aligned). */
  readonly providerCards: readonly ProviderCard[] = PROVIDER_CARDS;

  /** Current state of the model discovery probe. See `DiscoveryState` docstring. */
  discoveryState: DiscoveryState = { kind: 'idle' };

  /**
   * Monotonic counter incremented on every discovery trigger. An arriving
   * response whose `id` is not equal to the counter is a stale response from
   * a superseded trigger and must be discarded.
   */
  private discoveryCounter = 0;

  /**
   * Tracks the provider value from the previous `onProviderChange` call so we
   * can detect actual changes (ngModelChange can fire without a user edit).
   */
  private lastKnownProvider = 'anthropic';

  /**
   * Session cache of the last URL the user had in the Base URL field per
   * provider. Lets us restore their previous entry when they switch back to
   * a provider instead of overwriting it with the hard-coded default
   * (which is often wrong for the user's specific setup — e.g. llama.cpp
   * default is :8080 but many users run it on a different port).
   * Seeded from the persisted config on init for the config's provider.
   */
  private baseUrlByProvider: Record<string, string> = {};

  /**
   * Cache of the backend-authoritative default base URL per provider.
   * Populated on ngOnInit via `get_default_base_url` for each local provider
   * so that `isDefaultBaseUrl` stays synchronous (no await on the hot path).
   * Backend is SSOT for these values (see `speedwave_runtime::compose::default_base_url`).
   */
  private defaultBaseUrlsByProvider: Record<string, string> = {};

  readonly providerChange = output<string>();
  readonly errorOccurred = output<string>();

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private anthropicModels = inject(AnthropicModelsService);
  private chatState = inject(ChatStateService);
  private log = inject(LoggerService);

  /**
   * Cached SSOT catalog of Anthropic models from the backend
   * (`list_anthropic_models`). Empty until the first fetch settles; UI
   * gracefully renders nothing in the optgroups while loading.
   */
  protected readonly anthropicCatalog = signal<readonly AnthropicModel[]>([]);

  /** Models flagged `latest = true` — rendered in the "Latest" optgroup. */
  protected readonly latestAnthropicModels = computed<readonly AnthropicModel[]>(() =>
    this.anthropicCatalog().filter((m) => m.latest)
  );

  /** Remaining still-available snapshots — rendered in the "Legacy" optgroup. */
  protected readonly legacyAnthropicModels = computed<readonly AnthropicModel[]>(() =>
    this.anthropicCatalog().filter((m) => !m.latest)
  );

  /**
   * Family label of the Opus model that the dropdown's `(default)` option
   * resolves to at runtime. Sourced from `get_default_anthropic_model_label`
   * (backend SSOT). Three-state to avoid the on-init placeholder flash:
   *   - `undefined` → fetch still in flight; template hides the option
   *     until we know what to render.
   *   - `null` → fetch resolved with no label (older backend, dev mode
   *     without Tauri) — template renders the generic placeholder.
   *   - `string` → render the dynamic "Default — <family>" hint.
   */
  protected readonly defaultAnthropicLabel = signal<string | null | undefined>(undefined);

  /** Loads the LLM configuration + the SSOT model catalog from the backend on init. */
  ngOnInit(): void {
    this.loadConfig();
    void this.loadAnthropicCatalog();
    void this.loadDefaultAnthropicLabel();
  }

  /**
   * Format a catalog entry into the dropdown label, e.g.
   * `"Opus 4.7 · 1M ctx (claude-opus-4-7)"`. Showing the API id keeps users
   * who copy values into config files honest about which alias they picked.
   * @param m - Catalog entry returned by the backend SSOT.
   */
  protected formatModelLabel(m: AnthropicModel): string {
    return `${m.family} · ${formatContextLabel(m.context_tokens)} ctx (${m.id})`;
  }

  /**
   * Whether the given model id is present in the SSOT catalog.
   * @param id - Model id (API alias) to check against the cached catalog.
   */
  protected modelInCatalog(id: string): boolean {
    return this.anthropicCatalog().some((m) => m.id === id);
  }

  /**
   * Format a discovered local model into a dropdown label. When the
   * provider exposed a context window we render `id · 32k ctx`; otherwise
   * we show the bare id so the option still reads honestly.
   * @param m - Discovered model returned by the backend probe.
   */
  protected formatLocalModelLabel(m: DiscoveredModel): string {
    if (m.context_tokens && m.context_tokens > 0) {
      return `${m.id} · ${formatContextLabel(m.context_tokens)} ctx`;
    }
    return m.id;
  }

  /** Ids of every model returned by the most recent discovery probe. */
  protected discoveredModelIds(): string[] {
    return this.discoveryState.kind === 'ready' ? this.discoveryState.models.map((m) => m.id) : [];
  }

  /**
   * Local-model `<select>` change handler. The `context_tokens` for the
   * picked entry are derived on demand by `resolveContextTokensForSave`
   * from `discoveryState.models`, so we don't cache them here — keeping
   * one source of truth (the discovery payload).
   * @param id - Model id from the dropdown's value attribute.
   */
  protected onLocalModelChange(id: string): void {
    this.model = id;
  }

  /**
   * Touched-flag handler — see `apiKeyTouched` doc for the tri-state rationale.
   * @param value - New value typed by the user.
   */
  protected onApiKeyInput(value: string): void {
    this.apiKey = value;
    this.apiKeyTouched = true;
  }

  /**
   * Touched-flag handler — see `customHeadersTouched` doc.
   * @param value - New value typed by the user (multi-line `Name: Value`).
   */
  protected onCustomHeadersInput(value: string): void {
    this.customHeaders = value;
    this.customHeadersTouched = true;
  }

  /**
   * Resolves the value to send as `context_tokens` on save.
   *
   * - Anthropic + non-empty model id → SSOT catalog lookup.
   * - Local provider + discovery loaded → context window from the picked
   *   `discoveryState.models[]` entry (single source of truth).
   * - Local provider + discovery not loaded yet → fall back to the value
   *   we loaded from config so saving without re-running discovery doesn't
   *   wipe the persisted token count.
   * - Anything else → `null` (chat fallback chain takes over).
   */
  private resolveContextTokensForSave(): number | null {
    if (!this.model) return null;
    if (this.provider === 'anthropic') {
      return this.anthropicCatalog().find((m) => m.id === this.model)?.context_tokens ?? null;
    }
    if (this.discoveryState.kind === 'ready') {
      const picked = this.discoveryState.models.find((m) => m.id === this.model);
      return picked?.context_tokens ?? null;
    }
    return this.loadedLocalContextTokens;
  }

  /** Loads the catalog through the shared service and pushes it into the signal. */
  private async loadAnthropicCatalog(): Promise<void> {
    const list = await this.anthropicModels.list();
    this.anthropicCatalog.set(list);
    this.cdr.markForCheck();
  }

  /**
   * Fetches the SSOT family label of the Opus model that anchors the
   * `(default)` dropdown option. Failure is silent — the template falls
   * back to the generic placeholder when the signal stays null (e.g. dev
   * mode without Tauri, or a backend that pre-dates this command).
   */
  private async loadDefaultAnthropicLabel(): Promise<void> {
    try {
      const label = await this.tauri.invoke<string | null>('get_default_anthropic_model_label');
      // Backend may return null when the catalog has no `latest=true` Opus.
      // Treat both cases (resolved-as-null, resolved-as-string) as "fetched";
      // collapse `undefined` from older invokeHandlers to `null` so the
      // template's loading branch only triggers while genuinely in flight.
      this.defaultAnthropicLabel.set(label ?? null);
      this.cdr.markForCheck();
    } catch {
      // Mark as resolved-with-no-label so the template falls back to the
      // generic placeholder instead of staying invisible.
      this.defaultAnthropicLabel.set(null);
      this.cdr.markForCheck();
    }
  }

  /**
   * Click handler for provider cards. Routes through the existing
   * `onProviderChange` so URL caching, default fetching, and discovery probe
   * gating all stay intact — the cards are just a different control surface.
   * @param id - Provider identifier matching a `ProviderCard.id`.
   */
  async selectProvider(id: ProviderCard['id']): Promise<void> {
    if (this.provider === id) return;
    this.provider = id;
    await this.onProviderChange();
  }

  /** Placeholder shown for the read-only Anthropic base URL field. */
  anthropicBaseUrlHint(): string {
    return this.provider === 'anthropic' ? 'https://api.anthropic.com' : '';
  }

  /**
   * Returns a placeholder model name based on the selected LLM provider. For
   * Anthropic it derives the hint from the SSOT catalog (latest non-Opus, i.e.
   * the everyday Sonnet) rather than a hard-coded string, mirroring how
   * `baseUrlPlaceholder()` defers to the backend — empty while the catalog
   * loads so we never flash a stale model id.
   */
  modelPlaceholder(): string {
    if (this.provider === 'anthropic') {
      return this.anthropicModels.latestNonOpusModelId() ?? '';
    }
    return 'llama3.3';
  }

  /** Returns a fallback base URL placeholder when backend default_base_url is unavailable. */
  baseUrlPlaceholder(): string {
    // Backend is SSOT for known-provider defaults (see default_base_url in
    // compose.rs); this is just a fallback hint if the backend response
    // arrives late.
    return '';
  }

  /**
   * Human-readable explanation of why model discovery failed, shown inline
   * under the Model field so the user understands why the select fell back
   * to a free-text input.
   */
  discoveryFailureMessage(): string {
    if (this.discoveryState.kind !== 'failed') return '';
    const url = this.discoveryState.url;
    const label = this.providerDisplayLabel();
    switch (this.discoveryState.reason) {
      case 'refused':
        return `Could not connect to ${url} (connection refused). Inside the container, localhost/127.0.0.1 cannot reach your host — use host.docker.internal. Also confirm the server is running and bound to an externally reachable interface (-H 0.0.0.0).`;
      case 'offline':
        return `${label} server not reachable at ${url}. Make sure it's running and the local server is enabled.`;
      case 'unsupported':
        return `${label} does not support model discovery — type the model name manually.`;
      case 'other':
        return `${label} at ${url} returned no models (the server is up but no model is loaded).`;
    }
  }

  /** Returns the UI-friendly label for the current provider. */
  private providerDisplayLabel(): string {
    return this.provider === 'local' ? 'Local LLM server' : 'Provider';
  }

  /**
   * Always-visible usage hint rendered regardless of the selected provider.
   * Anthropic: explains the CLI-login flow. Local: explains how to point
   * base_url at the host LLM server via host.docker.internal.
   */
  usageHint(): string {
    if (this.provider === 'anthropic') {
      return 'Claude Code authenticates via your CLI session. Run claude login (or set ANTHROPIC_API_KEY) on the host — Speedwave injects the auth token into the container.';
    }
    return 'No Anthropic login required. Point base_url at any Anthropic Messages-compatible server on your machine using host.docker.internal (not localhost).';
  }

  /**
   * Returns an amber warning when the user typed a container-local hostname
   * (localhost / 127.0.0.1 / 0.0.0.0) into base_url. These resolve to the
   * container itself at runtime, not the host where the LLM server runs.
   * Returns null when the base_url is safe or empty.
   */
  containerLocalHostWarning(): string | null {
    const url = this.baseUrl.trim();
    if (!url) return null;
    let hostname: string;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      // Malformed URL — fall back to substring heuristic.
      const lower = url.toLowerCase();
      if (lower.includes('localhost') || lower.includes('127.0.0.1') || lower.includes('0.0.0.0')) {
        hostname = lower.includes('localhost')
          ? 'localhost'
          : lower.includes('127.0.0.1')
            ? '127.0.0.1'
            : '0.0.0.0';
      } else {
        return null;
      }
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return `${hostname} resolves to the container itself, not your machine. Use host.docker.internal instead.`;
    }
    if (hostname === '0.0.0.0') {
      return '0.0.0.0 is a bind address, not a destination — use host.docker.internal as base_url (and -H 0.0.0.0 on the server side to accept connections).';
    }
    return null;
  }

  /**
   * Handles a change of the provider dropdown.
   *
   * Each provider has a different default port, so baseUrl must be reset on
   * any real change — keeping an Ollama URL around for LM Studio would send
   * probes to the wrong server. After the reset, defaultBaseUrl is shown as
   * the input placeholder and discovery is kicked off against it; if the
   * server isn't running the UI gracefully falls back to the text input.
   *
   * Counter bump invalidates any in-flight probe from the previous provider
   * so its response is discarded on arrival.
   */
  async onProviderChange(): Promise<void> {
    if (this.provider === this.lastKnownProvider) {
      // Guard against redundant ngModelChange fires (HMR reinit, identical
      // selection etc.) — don't wipe state on no-op.
      return;
    }
    // Stash the URL we were just on so the user gets it back if they switch
    // back to this provider during the same session (e.g. they typed :8001
    // for llama.cpp, switched to Ollama to check something, came back — we
    // restore :8001 instead of the hardcoded :8080 default).
    const previousProvider = this.lastKnownProvider;
    if (previousProvider !== 'anthropic' && this.baseUrl) {
      this.baseUrlByProvider[previousProvider] = this.baseUrl;
    }
    this.lastKnownProvider = this.provider;
    this.discoveryCounter++;
    // Clear stale state synchronously so the UI reflects the provider change
    // immediately — even while the async default-URL fetch is in-flight.
    // Model is provider-specific; clearing prevents stale options on the new provider.
    this.model = '';
    this.discoveryState = { kind: 'idle' };
    this.providerChange.emit(this.provider);
    this.cdr.markForCheck();
    // Fetch the backend-authoritative default for the new provider if not yet cached.
    // This keeps compose.rs as the SSOT and avoids duplicating URL strings here.
    // Done AFTER the synchronous state reset above so the UI is consistent.
    if (this.provider !== 'anthropic' && !this.defaultBaseUrlsByProvider[this.provider]) {
      try {
        const freshDefault = await this.tauri.invoke<string | null>('get_default_base_url', {
          provider: this.provider,
        });
        if (freshDefault) {
          this.defaultBaseUrlsByProvider[this.provider] = freshDefault;
        }
      } catch {
        // Not in Tauri or unknown provider — cache stays empty for this provider.
      }
    }
    this.defaultBaseUrl = this.defaultBaseUrlsByProvider[this.provider] ?? '';
    // Restore the cached URL for this provider if we have one; otherwise fall
    // back to the provider's backend-authoritative default. Anthropic has no baseUrl.
    const cached = this.baseUrlByProvider[this.provider];
    this.baseUrl = this.provider === 'anthropic' ? '' : cached || this.defaultBaseUrl;
    // discoverModels self-gates on anthropic and empty URL — no outer guard needed.
    if (this.baseUrl) {
      await this.discoverModels(false);
    }
  }

  /**
   * Probes the local LLM server for the list of available models.
   * Fires only on explicit intent: user blur on baseUrl, Refresh click, or
   * initial load with persisted baseUrl. Provider switches do NOT probe
   * automatically — the new provider's default URL is typically wrong for
   * this user (different port, server not running).
   * @param isRefresh When true, bypass the same-URL dedupe check. Used by the
   *   Refresh button to let the user force a re-probe.
   */
  async discoverModels(isRefresh: boolean): Promise<void> {
    if (this.provider === 'anthropic') return;
    const effectiveUrl = this.baseUrl || this.defaultBaseUrl;
    if (!effectiveUrl) return;

    // Dedupe: skip same-URL non-refresh triggers while a probe is in-flight.
    if (
      !isRefresh &&
      this.discoveryState.kind === 'in-flight' &&
      this.discoveryState.url === effectiveUrl
    ) {
      return;
    }

    const id = ++this.discoveryCounter;
    this.discoveryState = { kind: 'in-flight', url: effectiveUrl, id };
    this.cdr.markForCheck();

    try {
      // Tri-state via `LlmConfigUpdate.api_key` (see types.rs).
      const args: {
        provider: string;
        baseUrl: string;
        apiKey?: string | null;
        customHeaders?: string | null;
      } = { provider: this.provider, baseUrl: effectiveUrl };
      if (this.apiKeyTouched) {
        args.apiKey = this.apiKey.trim() === '' ? null : this.apiKey;
      }
      if (this.customHeadersTouched) {
        args.customHeaders = this.customHeaders.trim() === '' ? null : this.customHeaders;
      }
      const result = await this.tauri.invoke<DiscoverResult>('discover_llm_models', {
        args,
      });
      // Stale-discard: drop responses whose id doesn't match the latest trigger.
      if (this.discoveryState.kind !== 'in-flight' || this.discoveryState.id !== id) return;
      // Invariant: do_discover_llm_models maps empty lists to Err("empty"),
      // so a resolved Ok always carries a non-empty array — the success path
      // never observes length === 0.
      this.discoveryState = { kind: 'ready', url: effectiveUrl, models: result.models };
      this.messagesEndpointStatus = result.messages_endpoint_status ?? null;
      // Auto-select the first discovered model when the current value is
      // blank or not on the list — otherwise the <select> renders with no
      // active <option> and Save would persist an empty model name.
      const ids = result.models.map((m) => m.id);
      if (!this.model || !ids.includes(this.model)) {
        this.model = result.models[0].id;
      }
    } catch (e: unknown) {
      if (this.discoveryState.kind !== 'in-flight' || this.discoveryState.id !== id) return;
      const msg = e instanceof Error ? e.message : String(e);
      let reason: 'offline' | 'refused' | 'unsupported' | 'other' = 'offline';
      if (msg === 'unsupported') {
        reason = 'unsupported';
      } else if (msg === 'empty') {
        reason = 'other';
      } else if (
        msg.toLowerCase().includes('connection refused') ||
        msg.toLowerCase().includes('error sending request') ||
        msg.toLowerCase().includes('connect error')
      ) {
        // reqwest wraps connection-refused as "request failed: <detail>".
        reason = 'refused';
      }
      this.discoveryState = { kind: 'failed', url: effectiveUrl, reason };
      // No errorOccurred.emit — discovery failure is silent degradation
      // (UI falls back to the free-text input).
    } finally {
      // Always mark for check, even when early-returning via stale-discard.
      this.cdr.markForCheck();
    }
  }

  /** Persists the LLM provider configuration to the backend. */
  async saveConfig(): Promise<void> {
    // Surface the model-required error at Save time. compose::apply_llm_config
    // also rejects this, but its error only surfaces at container start —
    // a user who clicks Save sees no immediate feedback otherwise.
    if (this.provider !== 'anthropic' && !this.model) {
      this.errorOccurred.emit('A model name is required for local providers');
      return;
    }
    this.saving = true;
    this.saved = false;
    try {
      // If the user left baseUrl blank for a local provider, fall back to the
      // provider default so compose can inject ANTHROPIC_BASE_URL. Anthropic
      // ignores baseUrl entirely, so null is correct there.
      const effectiveBaseUrl =
        this.provider === 'anthropic' ? null : this.baseUrl || this.defaultBaseUrl || null;
      const update: {
        provider: string;
        model: string | null;
        base_url: string | null;
        context_tokens: number | null;
        api_key?: string | null;
        custom_headers?: string | null;
      } = {
        provider: this.provider,
        model: this.model || null,
        base_url: effectiveBaseUrl,
        context_tokens: this.resolveContextTokensForSave(),
      };
      if (this.apiKeyTouched) {
        update.api_key = this.apiKey.trim() === '' ? null : this.apiKey;
      }
      if (this.customHeadersTouched) {
        update.custom_headers = this.customHeaders.trim() === '' ? null : this.customHeaders;
      }
      await this.tauri.invoke('update_llm_config', { update });
      this.saved = true;
      // Reset touched flags so subsequent saves don't re-send the credentials
      // unless the user edits the fields again. Update the `has_*` flags
      // optimistically based on what we just persisted.
      if (this.apiKeyTouched) {
        this.hasApiKey = !!update.api_key;
        this.apiKey = '';
        this.apiKeyTouched = false;
      }
      if (this.customHeadersTouched) {
        this.hasCustomHeaders = !!update.custom_headers;
        this.customHeaders = '';
        this.customHeadersTouched = false;
      }
      // Push the freshly-persisted context_tokens into ChatStateService so
      // the chat footer's `used / max` reflects the new model immediately,
      // not after the next session start.
      void this.chatState.refreshLlmConfigCache();
      this.providerChange.emit(this.provider);
      this.projectState.requestRestart();
      setTimeout(() => {
        this.saved = false;
        this.cdr.markForCheck();
      }, 2000);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.saving = false;
    this.cdr.markForCheck();
  }

  /**
   * Returns true when `url` exactly matches the backend-authoritative default
   * for `provider`. Uses the `defaultBaseUrlsByProvider` cache (populated on
   * init via `get_default_base_url` — backend is SSOT, see compose.rs).
   * Used by `loadConfig` to distinguish a known-safe default from a
   * user-supplied URL so we never silently probe arbitrary hosts on startup
   * (SSRF mitigation).
   * @param provider The selected provider (e.g. `ollama`, `lmstudio`, `llamacpp`).
   * @param url The base URL to check against the provider's cached default.
   */
  private isDefaultBaseUrl(provider: string, url: string): boolean {
    const def = this.defaultBaseUrlsByProvider[provider];
    return !!def && url === def;
  }

  private async loadConfig(): Promise<void> {
    try {
      const config = await this.tauri.invoke<LlmConfigResponse>('get_llm_config');
      const persistedProvider = config.provider || 'anthropic';
      // Auto-migration UX: configs with legacy provider names
      // (`ollama`/`lmstudio`/`llamacpp`) display the unified `local` card
      // and a one-time banner. The persisted value is only rewritten on
      // the user's next Save, preserving downgrade-safety until then.
      if (LEGACY_LOCAL_PROVIDERS.includes(persistedProvider)) {
        this.legacyMigrationProvider = persistedProvider;
        this.provider = 'local';
      } else {
        this.legacyMigrationProvider = null;
        this.provider = persistedProvider;
      }
      this.model = config.model || '';
      this.baseUrl = config.base_url || '';
      this.defaultBaseUrl = config.default_base_url || '';
      // Seed the local-model context cache so a Save right after load
      // (without re-running discovery) preserves the persisted value
      // instead of nulling it out.
      this.loadedLocalContextTokens =
        this.provider !== 'anthropic' ? (config.context_tokens ?? null) : null;
      this.hasApiKey = !!config.has_api_key;
      this.hasCustomHeaders = !!config.has_custom_headers;
      this.lastKnownProvider = this.provider;
      // Seed the per-provider cache with the backend-authoritative default for
      // the persisted provider so `isDefaultBaseUrl` can compare without a
      // round-trip (backend is SSOT via get_default_base_url / compose.rs).
      if (this.provider !== 'anthropic' && this.defaultBaseUrl) {
        this.defaultBaseUrlsByProvider[this.provider] = this.defaultBaseUrl;
      }
      // Seed the per-provider URL cache with the persisted URL so switching away
      // and back doesn't lose it.
      if (this.provider !== 'anthropic' && this.baseUrl) {
        this.baseUrlByProvider[this.provider] = this.baseUrl;
      }
      this.providerChange.emit(this.provider);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Silently ignore the common "not in Tauri" case (browser dev mode).
      // Log anything else so real backend errors aren't hidden.
      if (!msg.toLowerCase().includes('tauri') && !msg.toLowerCase().includes('invoke')) {
        this.log.error(`loadConfig: unexpected error loading LLM config: ${msg}`);
      }
    }
    this.cdr.markForCheck();
    // Auto-probe only when the effective URL is a known-safe default. Any
    // user-supplied URL (even one persisted in config) must NOT be probed
    // silently — a cloned malicious repo could set base_url to an internal
    // RFC1918 host, turning Settings open into an SSRF probe. The user must
    // explicitly click Refresh or blur the Base URL field to trigger a probe
    // against a non-default URL.
    const effectiveUrl = this.baseUrl || this.defaultBaseUrl;
    const isSafeToAutoProbe =
      this.provider !== 'anthropic' &&
      !!effectiveUrl &&
      (this.baseUrl === '' || this.isDefaultBaseUrl(this.provider, this.baseUrl));
    if (isSafeToAutoProbe) {
      await this.discoverModels(false);
    }
  }
}
