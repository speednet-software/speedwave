import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  input,
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
import { AuthTerminalComponent } from '../auth-terminal.component';
import type { AuthStatusResponse } from '../../services/project-state.service';
import {
  AnthropicModel,
  DiscoveredModel,
  DiscoverResult,
  formatContextLabel,
  LEGACY_LOCAL_PROVIDERS,
  LlmActive,
  LlmConfigResponse,
  LlmProviderEntry,
  LlmProviderKind,
} from '../../models/llm';

/**
 * Edit-state row of a remote (proxy-routed) provider — ADR-073. The key
 * VALUE lives only in `keyInput` until Save sends it through
 * `set_llm_provider_key`; config carries the `hasKey` presence flag.
 */
interface ExtraProviderEdit {
  id: string;
  kind: 'open_router' | 'open_ai_compat';
  baseUrl: string;
  model: string;
  keyInput: string;
  keyTouched: boolean;
  hasKey: boolean;
  /** Catalog models (openrouter rows); null until discovery ran. */
  models: DiscoveredModel[] | null;
  discovering: boolean;
  /** Context window of the selected catalog model. */
  contextTokens: number | null;
}

/**
 * The two permanent remote rows (`openrouter`, `compat`) — rendered like the
 * anthropic/local cards; an unconfigured row is simply not persisted.
 */
function fixedExtraRows(): ExtraProviderEdit[] {
  const empty = (id: string, kind: ExtraProviderEdit['kind']): ExtraProviderEdit => ({
    id,
    kind,
    baseUrl: '',
    model: '',
    keyInput: '',
    keyTouched: false,
    hasKey: false,
    models: null,
    discovering: false,
    contextTokens: null,
  });
  return [empty('openrouter', 'open_router'), empty('compat', 'open_ai_compat')];
}

/**
 * Tri-state credential value for a touched field: empty/blank → null (delete),
 * otherwise the value. Callers gate on the field's touched flag first.
 * @param value - The raw field value.
 * @returns The trimmed-non-empty value, or null when blank.
 */
function nullIfEmpty(value: string): string | null {
  return value.trim() === '' ? null : value;
}

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
  | { kind: 'failed'; url: string; reason: 'offline' | 'unsupported' | 'other' };

/** Manages LLM provider selection and configuration. */
@Component({
  selector: 'app-llm-provider',
  imports: [CommonModule, TooltipDirective, AuthTerminalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section id="section-llm-provider">
      <h2 class="view-title view-title-section text-[var(--ink)]">LLM providers</h2>
      <p class="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
        One active provider per project — every session routes through the local proxy.
        <code>/model</code> switches between the configured providers' models in-session.
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

      <!-- ── anthropic row ─────────────────────────────────────────────── -->
      <div
        class="mt-4 rounded border"
        [class]="
          selectedTarget === 'anthropic'
            ? 'border-[var(--accent-dim)] bg-[var(--accent-soft)]'
            : 'border-[var(--line)] bg-[var(--bg-1)]'
        "
      >
        <button
          type="button"
          role="radio"
          [attr.aria-checked]="selectedTarget === 'anthropic'"
          class="mono flex w-full items-center justify-between px-3 py-2 text-left text-[11px] font-medium"
          [class]="
            selectedTarget === 'anthropic' ? 'text-[var(--accent)]' : 'text-[var(--ink-dim)]'
          "
          data-testid="settings-llm-provider-anthropic"
          (click)="selectProvider('anthropic')"
        >
          <span>
            {{ selectedTarget === 'anthropic' ? '● ' : '○ ' }}anthropic
            <span class="text-[10px] text-[var(--ink-mute)]"> · cloud</span>
          </span>
          <span class="flex items-center gap-2" data-testid="auth-status-row">
            @if (apiKeyConfigured || oauthAuthenticated) {
              <span class="pill green" data-testid="auth-status-value">● connected</span>
              <span class="pill green" data-testid="auth-status-method">{{
                apiKeyConfigured ? 'api key' : 'oauth'
              }}</span>
            } @else {
              <span class="pill amber" data-testid="auth-status-value">not configured</span>
            }
          </span>
        </button>

        @if (selectedTarget === 'anthropic') {
          <div class="border-t border-[var(--line)] px-3 py-3">
            <!-- Auth method: subscription (oauth) vs raw API key -->
            <div
              class="flex overflow-hidden rounded border border-[var(--line)]"
              role="radiogroup"
              aria-label="Authentication method"
            >
              <button
                type="button"
                role="radio"
                [attr.aria-checked]="authMethod === 'oauth'"
                class="mono flex-1 border-r border-[var(--line)] px-3 py-2 text-[11px] transition-colors"
                [class]="
                  authMethod === 'oauth'
                    ? 'bg-[var(--bg-2)] text-[var(--ink)]'
                    : 'text-[var(--ink-mute)] hover:text-[var(--ink)]'
                "
                data-testid="settings-auth-method-oauth"
                (click)="authMethod = 'oauth'"
              >
                subscription (oauth · claude.ai)
              </button>
              <button
                type="button"
                role="radio"
                [attr.aria-checked]="authMethod === 'api_key'"
                class="mono flex-1 px-3 py-2 text-[11px] transition-colors"
                [class]="
                  authMethod === 'api_key'
                    ? 'bg-[var(--bg-2)] text-[var(--ink)]'
                    : 'text-[var(--ink-mute)] hover:text-[var(--ink)]'
                "
                data-testid="settings-auth-method-api-key"
                (click)="authMethod = 'api_key'"
              >
                api key
              </button>
            </div>

            @if (authMethod === 'api_key') {
              <div class="mt-3">
                <label
                  class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                  for="api-key-input"
                  >anthropic_api_key</label
                >
                <input
                  id="api-key-input"
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  [value]="anthropicApiKeyInput"
                  (input)="anthropicApiKeyInput = $any($event.target).value"
                  placeholder="sk-ant-..."
                  class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                  data-testid="settings-api-key"
                />
              </div>
              <div class="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  class="mono rounded bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                  data-testid="settings-api-key-save"
                  (click)="saveAnthropicApiKey()"
                  [disabled]="anthropicApiKeySaving || !anthropicApiKeyInput"
                >
                  {{ anthropicApiKeySaving ? 'saving...' : 'save key' }}
                </button>
                <button
                  type="button"
                  class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40 disabled:cursor-not-allowed"
                  data-testid="settings-api-key-remove"
                  (click)="deleteAnthropicApiKey()"
                  [disabled]="!apiKeyConfigured"
                >
                  remove key
                </button>
                @if (anthropicApiKeySaved) {
                  <span class="mono text-[11px] text-[var(--green)]">saved!</span>
                }
              </div>
            }
            @if (authMethod === 'oauth' && activeProject(); as project) {
              <div class="mt-3">
                <app-auth-terminal [project]="project" (done)="onOAuthDone($event)" />
              </div>
            }

            <!-- Default model -->
            <div class="mt-3">
              <label
                class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                for="llm-model"
                >default_model</label
              >
              <select
                id="llm-model"
                [value]="model"
                (change)="model = $any($event.target).value"
                class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                data-testid="settings-llm-model"
              >
                <!-- Empty value = no ANTHROPIC_MODEL injected; the label
                     resolves the Opus family from the SSOT (three-state:
                     in-flight keeps the option blank-but-valid). -->
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
                @if (model && !modelInCatalog(model)) {
                  <option [value]="model">{{ model }} (not in catalog)</option>
                }
              </select>
            </div>
          </div>
        }
      </div>

      <!-- ── local row ─────────────────────────────────────────────────── -->
      <div
        class="mt-2 rounded border"
        [class]="
          selectedTarget === 'local'
            ? 'border-[var(--accent-dim)] bg-[var(--accent-soft)]'
            : 'border-[var(--line)] bg-[var(--bg-1)]'
        "
      >
        <button
          type="button"
          role="radio"
          [attr.aria-checked]="selectedTarget === 'local'"
          class="mono flex w-full items-center justify-between px-3 py-2 text-left text-[11px] font-medium"
          [class]="selectedTarget === 'local' ? 'text-[var(--accent)]' : 'text-[var(--ink-dim)]'"
          data-testid="settings-llm-provider-local"
          (click)="selectProvider('local')"
        >
          <span>
            {{ selectedTarget === 'local' ? '● ' : '○ ' }}local
            <span class="text-[10px] text-[var(--ink-mute)]"> · own server</span>
          </span>
          @if (selectedTarget !== 'local' && baseUrlByProviderView()) {
            <span class="mono text-[10px] text-[var(--ink-mute)]">{{
              baseUrlByProviderView()
            }}</span>
          }
        </button>

        @if (selectedTarget === 'local') {
          <div class="border-t border-[var(--line)] px-3 py-3">
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
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
                  [placeholder]="defaultBaseUrl"
                  (blur)="discoverModels(false)"
                  class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                  data-testid="settings-llm-base-url"
                />
              </div>
              <div>
                <label
                  class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                  for="llm-model"
                  >default_model</label
                >
                @if (discoveryState.kind === 'ready') {
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

            @if (messagesEndpointOk === false) {
              <div
                class="mono mt-3 rounded border border-[var(--amber)] bg-[var(--amber)]/10 px-3 py-2 text-[11px] text-[var(--amber)]"
                data-testid="settings-llm-messages-endpoint-warning"
              >
                <strong>Warning:</strong> the server returned a model list but did not respond to
                <code>POST /v1/messages</code> (Anthropic Messages API). Save is allowed, but chat
                will fail.
              </div>
            }

            <!-- Bearer for servers requiring auth; on a load-balanced cluster
                 a unique per-user value also pins session stickiness. -->
            <div class="mt-3">
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

            <details class="mt-3">
              <summary
                class="mono cursor-pointer text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
              >
                advanced
              </summary>
              <div class="mt-2">
                <label
                  class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                  for="llm-custom-headers"
                  >custom_headers</label
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
                      : 'X-Tenant-ID: foo'
                  "
                  class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                  data-testid="settings-llm-custom-headers"
                ></textarea>
                <p class="mono mt-1 text-[10px] text-[var(--ink-mute)]">
                  One header per line, <code>Name: Value</code>. Cannot set Authorization. Sessions
                  with custom headers bypass the proxy (no usage tracking).
                </p>
              </div>
            </details>
          </div>
        }
      </div>

      <!-- ── remote provider rows (ADR-073) ────────────────────────────── -->
      @for (entry of extraProviders; track entry.id) {
        <div
          class="mt-2 rounded border"
          [class]="
            selectedTarget === entry.id
              ? 'border-[var(--accent-dim)] bg-[var(--accent-soft)]'
              : 'border-[var(--line)] bg-[var(--bg-1)]'
          "
          [attr.data-testid]="'settings-llm-extra-' + entry.id"
        >
          <button
            type="button"
            role="radio"
            [attr.aria-checked]="selectedTarget === entry.id"
            class="mono flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-medium"
            [class]="selectedTarget === entry.id ? 'text-[var(--accent)]' : 'text-[var(--ink-dim)]'"
            [attr.data-testid]="'settings-llm-extra-select-' + entry.id"
            (click)="onExtraHeaderClick(entry)"
          >
            {{ selectedTarget === entry.id ? '●' : '○' }} {{ entry.id }}
            <span class="text-[10px] text-[var(--ink-mute)]">
              · {{ entry.kind === 'open_router' ? 'openrouter' : 'openai-compatible' }}
            </span>
          </button>
          @if (expandedExtraId === entry.id) {
            <div
              class="grid grid-cols-1 gap-2 border-t border-[var(--line)] px-3 py-3 md:grid-cols-2"
            >
              @if (entry.kind === 'open_ai_compat') {
                <input
                  type="text"
                  [value]="entry.baseUrl"
                  (input)="entry.baseUrl = $any($event.target).value"
                  placeholder="base_url (e.g. https://api.example.com/v1)"
                  class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                  [attr.data-testid]="'settings-llm-extra-url-' + entry.id"
                />
              }
              @if (entry.kind === 'open_router' && entry.models && entry.models.length > 0) {
                <div class="flex items-center gap-2">
                  <!-- Selection lives on the options, not a [value] binding: catalog options load async. -->
                  <select
                    (change)="onExtraModelSelect(entry, $any($event.target).value)"
                    class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                    [attr.data-testid]="'settings-llm-extra-model-' + entry.id"
                  >
                    <option value="" disabled [selected]="!entry.model">select model…</option>
                    @if (entry.model && !catalogHasModel(entry, entry.model)) {
                      <option [value]="entry.model" [selected]="true">{{ entry.model }}</option>
                    }
                    @for (m of entry.models; track m.id) {
                      <option [value]="m.id" [selected]="m.id === entry.model">
                        {{ m.id
                        }}{{ m.context_tokens ? ' (' + ctxLabel(m.context_tokens) + ')' : '' }}
                      </option>
                    }
                  </select>
                  <button
                    type="button"
                    class="mono text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
                    [disabled]="entry.discovering"
                    (click)="discoverExtraModels(entry)"
                    [attr.data-testid]="'settings-llm-extra-refresh-' + entry.id"
                  >
                    {{ entry.discovering ? '…' : '↻' }}
                  </button>
                </div>
              } @else {
                <div class="flex items-center gap-2">
                  <input
                    type="text"
                    [value]="entry.model"
                    (input)="entry.model = $any($event.target).value"
                    [placeholder]="
                      entry.kind === 'open_router'
                        ? 'model (e.g. qwen/qwen3-coder)'
                        : 'model (e.g. gpt-5.2)'
                    "
                    class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                    [attr.data-testid]="'settings-llm-extra-model-' + entry.id"
                  />
                  @if (entry.kind === 'open_router') {
                    <button
                      type="button"
                      class="mono text-[11px] text-[var(--ink-mute)] hover:text-[var(--ink)]"
                      [disabled]="entry.discovering"
                      (click)="discoverExtraModels(entry)"
                      [attr.data-testid]="'settings-llm-extra-refresh-' + entry.id"
                    >
                      {{ entry.discovering ? '…' : '↻' }}
                    </button>
                  }
                </div>
              }
              <input
                type="password"
                autocomplete="off"
                spellcheck="false"
                [value]="entry.keyInput"
                (input)="onExtraKeyInput(entry, $any($event.target).value)"
                [placeholder]="
                  entry.hasKey ? '••••• (key saved — type to replace, clear to remove)' : 'api key'
                "
                class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                [attr.data-testid]="'settings-llm-extra-key-' + entry.id"
              />
            </div>
          }
        </div>
      }

      <div class="mt-4 flex items-center gap-3">
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

  /** Result of the latest discovery probe — populated for `provider==="local"`. */
  messagesEndpointOk: boolean | null = null;

  /** Active project — drives the auth-status load and the OAuth terminal. */
  readonly activeProject = input<string | null>(null);

  /**
   * Anthropic auth (absorbed from the former Authentication section):
   * subscription OAuth is the recommended default; the api-key tab is one
   * click away. The key VALUE goes through `save_api_key` into
   * `secrets/<project>/anthropic_api_key` — never through LlmConfig.
   */
  authMethod: 'oauth' | 'api_key' = 'oauth';
  anthropicApiKeyInput = '';
  anthropicApiKeySaving = false;
  anthropicApiKeySaved = false;
  apiKeyConfigured = false;
  oauthAuthenticated = false;

  /**
   * Remote (proxy-routed) providers — ADR-073. Parsed from the v2
   * `providers` list on load (anthropic/local entries stay on the cards);
   * Save sends the reconstructed full set.
   */
  extraProviders: ExtraProviderEdit[] = fixedExtraRows();

  /**
   * Which target is active: `'anthropic'`, `'local'`, or an extra provider
   * id. The cards and the extra rows share this one radio state.
   */
  selectedTarget = 'anthropic';

  /**
   * `provider_id|model` snapshot taken on load. When Save leaves it
   * unchanged, only the proxy config changed (keys, added/removed
   * providers) — a litellm-only hot reload suffices and the running claude
   * session survives. Any change to it requires the full project restart
   * (the claude env carries the active provider/model).
   */
  private loadedActiveKey = '';

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

  /** Loaded `local` entry — passed through Save while the card is inactive. */
  private loadedLocalEntry: LlmProviderEntry | null = null;

  /** Loaded anthropic model — preserved when another provider is active. */
  private loadedAnthropicModel: string | null = null;

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

  /** Reloads the Anthropic auth status whenever the active project changes. */
  constructor() {
    effect(() => {
      if (this.activeProject()) {
        void this.loadAuthStatus();
      }
    });
  }
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
   * @param id - Card-class provider id (`anthropic` | `local`).
   */
  async selectProvider(id: 'anthropic' | 'local'): Promise<void> {
    this.selectedTarget = id;
    if (this.provider === id) return;
    this.provider = id;
    await this.onProviderChange();
  }

  /** Currently expanded (editable) remote row — independent of the radio. */
  expandedExtraId: string | null = null;

  /**
   * Whole-bar click: first click activates the row (and expands it);
   * a click on the already-active row toggles the edit panel.
   * @param entry - The clicked row.
   */
  onExtraHeaderClick(entry: ExtraProviderEdit): void {
    if (this.selectedTarget !== entry.id) {
      this.selectExtraProvider(entry);
    } else {
      this.toggleExtraExpanded(entry);
    }
  }

  /**
   * Makes the row the active provider (and expands it).
   * @param entry - The selected row.
   */
  selectExtraProvider(entry: ExtraProviderEdit): void {
    this.selectedTarget = entry.id;
    this.expandedExtraId = entry.id;
    this.maybeDiscover(entry);
  }

  /**
   * Toggles the row's edit panel without changing the active provider.
   * @param entry - The toggled row.
   */
  toggleExtraExpanded(entry: ExtraProviderEdit): void {
    this.expandedExtraId = this.expandedExtraId === entry.id ? null : entry.id;
    if (this.expandedExtraId === entry.id) {
      this.maybeDiscover(entry);
    }
  }

  private maybeDiscover(entry: ExtraProviderEdit): void {
    if (entry.kind === 'open_router' && entry.models === null && !entry.discovering) {
      void this.discoverExtraModels(entry);
    }
  }

  /**
   * Fetches the OpenRouter catalog (host-side, filtered to tool-capable
   * models). Failure keeps the free-text input — the catalog is a
   * convenience, not a gate.
   * @param entry - The openrouter row to populate.
   */
  async discoverExtraModels(entry: ExtraProviderEdit): Promise<void> {
    if (entry.kind !== 'open_router' || entry.discovering) {
      return;
    }
    entry.discovering = true;
    this.cdr.markForCheck();
    try {
      const res = await this.tauri.invoke<DiscoverResult>('discover_llm_models', {
        args: { provider: 'openrouter', baseUrl: '' },
      });
      const models = res?.models ?? [];
      const row = this.extraProviders.find((p) => p.id === entry.id);
      if (row && models.length > 0) {
        row.models = models;
        if (row.model) {
          row.contextTokens =
            models.find((m) => m.id === row.model)?.context_tokens ?? row.contextTokens;
        }
      }
    } catch (e: unknown) {
      this.log.warn(
        `openrouter catalog discovery failed: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      entry.discovering = false;
      this.cdr.markForCheck();
    }
  }

  /**
   * Dropdown selection handler for an openrouter row — records the model
   * and its catalog context window.
   * @param entry - The edited row.
   * @param modelId - Selected catalog model id.
   */
  onExtraModelSelect(entry: ExtraProviderEdit, modelId: string): void {
    entry.model = modelId;
    entry.contextTokens = entry.models?.find((m) => m.id === modelId)?.context_tokens ?? null;
  }

  /**
   * Whether the discovered catalog contains `modelId` — drives the extra
   * `<option>` preserving a previously saved model that left the catalog.
   * @param entry - The row whose catalog to check.
   * @param modelId - Model id to look up.
   */
  catalogHasModel(entry: ExtraProviderEdit, modelId: string): boolean {
    return !!entry.models?.some((m) => m.id === modelId);
  }

  /**
   * Context window as a short label (`128k`, `1M`) for dropdown options.
   * @param tokens - Context-token count from the catalog.
   */
  ctxLabel(tokens: number): string {
    return formatContextLabel(tokens);
  }

  /**
   * Key-field input handler for a remote provider row.
   * @param entry - The edited row.
   * @param value - Current input value.
   */
  onExtraKeyInput(entry: ExtraProviderEdit, value: string): void {
    entry.keyInput = value;
    entry.keyTouched = true;
  }

  /**
   * Returns a placeholder model name based on the selected LLM provider. For
   * Anthropic it derives the hint from the SSOT catalog (latest non-Opus, i.e.
   * the everyday Sonnet) rather than a hard-coded string — empty while the
   * catalog loads so we never flash a stale model id.
   */
  modelPlaceholder(): string {
    if (this.provider === 'anthropic') {
      return this.anthropicModels.latestEverydayModelId() ?? '';
    }
    return 'llama3.3';
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
      // Guard against redundant ngModelChange fires — no-op.
      return;
    }
    // Cache the URL per provider to restore on switch back in the same session.
    const previousProvider = this.lastKnownProvider;
    if (previousProvider !== 'anthropic' && this.baseUrl) {
      this.baseUrlByProvider[previousProvider] = this.baseUrl;
    }
    // Snapshot the anthropic model when leaving the card so it is restored below.
    if (previousProvider === 'anthropic' && this.model) {
      this.loadedAnthropicModel = this.model;
    }
    this.lastKnownProvider = this.provider;
    this.discoveryCounter++;
    // Clear state now; model is provider-specific and restored from snapshot.
    this.model =
      this.provider === 'anthropic'
        ? (this.loadedAnthropicModel ?? '')
        : (this.loadedLocalEntry?.model ?? '');
    this.discoveryState = { kind: 'idle' };
    this.providerChange.emit(this.provider);
    this.cdr.markForCheck();
    // Fetch backend-authoritative default if not cached (compose.rs is SSOT).
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
        args.apiKey = nullIfEmpty(this.apiKey);
      }
      if (this.customHeadersTouched) {
        args.customHeaders = nullIfEmpty(this.customHeaders);
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
      this.messagesEndpointOk = result.messages_endpoint_ok ?? null;
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
      let reason: 'offline' | 'unsupported' | 'other' = 'offline';
      if (msg === 'unsupported') {
        reason = 'unsupported';
      } else if (msg === 'empty') {
        reason = 'other';
      }
      this.discoveryState = { kind: 'failed', url: effectiveUrl, reason };
      // No errorOccurred.emit — discovery failure is silent degradation
      // (UI falls back to the free-text input).
    } finally {
      // Always mark for check, even when early-returning via stale-discard.
      this.cdr.markForCheck();
    }
  }

  /** Collapsed-row summary of the local server URL. */
  baseUrlByProviderView(): string {
    return this.baseUrl || this.baseUrlByProvider['local'] || '';
  }

  /** Loads the current Anthropic authentication status from the backend. */
  async loadAuthStatus(): Promise<void> {
    const project = this.activeProject();
    if (!project) return;
    try {
      const status = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', { project });
      this.apiKeyConfigured = status.api_key_configured;
      this.oauthAuthenticated = status.oauth_authenticated;
      this.projectState.applyAuthStatus(status);
    } catch {
      // Auth status check failed — container may not be running.
    }
    this.cdr.markForCheck();
  }

  /** Saves the Anthropic API key to the project's secrets directory. */
  async saveAnthropicApiKey(): Promise<void> {
    const project = this.activeProject();
    if (!project || !this.anthropicApiKeyInput) return;
    this.anthropicApiKeySaving = true;
    this.anthropicApiKeySaved = false;
    this.errorOccurred.emit('');
    try {
      await this.tauri.invoke('save_api_key', {
        project,
        apiKey: this.anthropicApiKeyInput,
      });
      this.anthropicApiKeySaved = true;
      this.anthropicApiKeyInput = '';
      await this.loadAuthStatus();
      setTimeout(() => {
        this.anthropicApiKeySaved = false;
        this.cdr.markForCheck();
      }, 2000);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.anthropicApiKeySaving = false;
    this.cdr.markForCheck();
  }

  /** Removes the stored Anthropic API key for the active project. */
  async deleteAnthropicApiKey(): Promise<void> {
    const project = this.activeProject();
    if (!project) return;
    this.errorOccurred.emit('');
    try {
      await this.tauri.invoke('delete_api_key', { project });
      await this.loadAuthStatus();
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.cdr.markForCheck();
  }

  /**
   * OAuth terminal completion — refresh the status pills.
   * @param _success - whether the login succeeded (status reload decides).
   */
  async onOAuthDone(_success: boolean): Promise<void> {
    await this.loadAuthStatus();
    this.cdr.markForCheck();
  }

  /**
   * Builds the full v2 provider set (ADR-073): the two cards map to the
   * `anthropic`/`local` entries, remote rows append verbatim.
   * @param anthropicHasApiKey - Whether the project has an Anthropic API
   * key configured (classifies the anthropic entry's kind).
   */
  private buildProviderSet(anthropicHasApiKey: boolean): LlmProviderEntry[] {
    // Resolve the active target once — it's stable for this invocation.
    const target = this.effectiveTarget();
    // The anthropic entry carries the model too — symmetric with local/remote.
    // When the anthropic card is active `this.model` is authoritative; when
    // another provider is active the card field was cleared, so fall back to
    // the snapshot taken on load (otherwise an explicit Anthropic model is
    // wiped the first time the user activates another provider and saves).
    const anthropicModel = target === 'anthropic' ? this.model : this.loadedAnthropicModel;
    const providers: LlmProviderEntry[] = [
      {
        id: 'anthropic',
        kind: anthropicHasApiKey ? 'anthropic_api_key' : 'anthropic_oauth',
        model: anthropicModel || null,
        has_api_key: anthropicHasApiKey,
      },
    ];
    // When the local card is NOT being edited, its loaded entry passes
    // through verbatim — rebuilding it from the (then anthropic- or
    // extra-derived) card fields silently erased base_url and model.
    const editingLocal = target === 'local';
    if (!editingLocal && this.loadedLocalEntry) {
      providers.push({ ...this.loadedLocalEntry });
    } else {
      const localUrl = editingLocal
        ? this.baseUrl || this.defaultBaseUrl
        : this.baseUrlByProvider['local'] || '';
      if (localUrl) {
        providers.push({
          id: 'local',
          kind: 'local',
          base_url: localUrl,
          model: (editingLocal ? this.model : this.loadedLocalEntry?.model) || null,
          has_api_key: this.hasApiKey || (this.apiKeyTouched && this.apiKey.trim() !== ''),
          has_custom_headers:
            this.hasCustomHeaders ||
            (this.customHeadersTouched && this.customHeaders.trim() !== ''),
          context_tokens: this.resolveContextTokensForSave(),
        });
      }
    }
    for (const extra of this.extraProviders) {
      // Only configured rows persist; hasKey drops when the field is cleared.
      const hasKey = extra.keyTouched ? extra.keyInput.trim() !== '' : extra.hasKey;
      const configured =
        extra.kind === 'open_ai_compat'
          ? extra.baseUrl.trim() !== ''
          : hasKey || extra.model.trim() !== '';
      if (!configured) {
        continue;
      }
      providers.push({
        id: extra.id,
        kind: extra.kind,
        base_url: extra.kind === 'open_ai_compat' ? extra.baseUrl || null : null,
        model: extra.model || null,
        has_api_key: hasKey,
        context_tokens: extra.contextTokens,
      });
    }
    return providers;
  }

  /**
   * Resolves the radio state to a concrete target id. When `selectedTarget`
   * points at no extra row, the cards win — `provider` decides (covers
   * programmatic `provider` mutation that bypasses `selectProvider`).
   */
  private effectiveTarget(): string {
    if (this.extraProviders.some((p) => p.id === this.selectedTarget)) {
      return this.selectedTarget;
    }
    return this.provider === 'anthropic' ? 'anthropic' : 'local';
  }

  /**
   * Finds a permanent remote row by exact id, falling back to kind so entries
   * saved under a legacy generated id (`openrouter-2`, suffixed compat) still
   * land on their fixed row.
   * @param id - Exact provider id to match first.
   * @param kind - Optional kind to fall back on when no id matches.
   * @returns The matching row, or undefined.
   */
  private findExtraRow(id: string, kind?: LlmProviderKind): ExtraProviderEdit | undefined {
    return (
      this.extraProviders.find((r) => r.id === id) ??
      (kind ? this.extraProviders.find((r) => r.kind === kind) : undefined)
    );
  }

  /** The active selection Save will persist, derived from the radio state. */
  private buildActive(): LlmActive {
    const target = this.effectiveTarget();
    const extra = this.extraProviders.find((p) => p.id === target);
    if (extra) {
      return { provider_id: extra.id, model: extra.model || null };
    }
    return {
      provider_id: target,
      model: this.model || null,
    };
  }

  /** Persists the LLM provider configuration to the backend. */
  async saveConfig(): Promise<void> {
    // Surface the model-required error at Save time. compose::apply_llm_config
    // also rejects this, but its error only surfaces at container start —
    // a user who clicks Save sees no immediate feedback otherwise.
    const localIsActive = this.effectiveTarget() === 'local';
    if (this.provider !== 'anthropic' && !this.model && localIsActive) {
      this.errorOccurred.emit('A model name is required for local providers');
      return;
    }
    const activeExtra = this.extraProviders.find((p) => p.id === this.effectiveTarget());
    if (activeExtra && !activeExtra.model.trim()) {
      this.errorOccurred.emit(`Provider '${activeExtra.id}' requires a model name`);
      return;
    }
    if (activeExtra?.kind === 'open_ai_compat' && !activeExtra.baseUrl.trim()) {
      this.errorOccurred.emit(`Provider '${activeExtra.id}' requires a base URL`);
      return;
    }
    this.saving = true;
    this.saved = false;
    try {
      const active = this.buildActive();
      // Fall back to provider default if baseUrl blank; compose injects ANTHROPIC_BASE_URL.
      const effectiveBaseUrl =
        active.provider_id === 'local' ? this.baseUrl || this.defaultBaseUrl || null : null;
      // Input signal — the single project source (drives the restart below).
      const project = this.activeProject();
      // Reuse the cached auth state (loadAuthStatus) — no redundant round-trip.
      const anthropicHasApiKey = this.apiKeyConfigured;
      // Flat fields mirror v2 providers/active for backend routing; remote row active = remote id.
      const activeIsRemote = this.extraProviders.some((p) => p.id === active.provider_id);
      const flatProvider = activeIsRemote ? active.provider_id : this.provider;
      const update: {
        provider: string;
        model: string | null;
        base_url: string | null;
        context_tokens: number | null;
        api_key?: string | null;
        custom_headers?: string | null;
        providers: LlmProviderEntry[];
        active: LlmActive;
      } = {
        provider: flatProvider,
        model: active.model ?? null,
        base_url: effectiveBaseUrl,
        context_tokens: this.resolveContextTokensForSave(),
        providers: this.buildProviderSet(anthropicHasApiKey),
        active,
      };
      if (this.apiKeyTouched) {
        update.api_key = nullIfEmpty(this.apiKey);
      }
      if (this.customHeadersTouched) {
        update.custom_headers = nullIfEmpty(this.customHeaders);
      }
      // Write keys before config so a failure prevents the config commit (ADR-073).
      const touchedExtras = this.extraProviders.filter((e) => e.keyTouched);
      for (const extra of touchedExtras) {
        await this.tauri.invoke('set_llm_provider_key', {
          providerId: extra.id,
          key: nullIfEmpty(extra.keyInput),
        });
      }
      await this.tauri.invoke('update_llm_config', { update });

      // Reset to mirror the save; a stale local entry would resurrect on the next save.
      const savedLocal = update.providers.find((p) => p.id === 'local');
      this.loadedLocalEntry = savedLocal ? { ...savedLocal } : null;
      for (const extra of touchedExtras) {
        extra.hasKey = extra.keyInput.trim() !== '';
        extra.keyInput = '';
        extra.keyTouched = false;
      }
      this.saved = true;
      // Reset touched flags; update the has_* flags from persisted values.
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
      // Push context tokens so the chat footer updates immediately.
      void this.chatState.refreshLlmConfigCache();
      this.providerChange.emit(this.provider);
      // Provider/model change needs full restart; other changes = proxy reload (ADR-073).
      const activeKey = `${active.provider_id}|${active.model ?? ''}`;
      if (activeKey === this.loadedActiveKey && project) {
        try {
          await this.tauri.invoke('restart_llm_proxy', { project });
        } catch (e: unknown) {
          this.log.warn(
            `restart_llm_proxy failed, falling back to full restart: ${
              e instanceof Error ? e.message : String(e)
            }`
          );
          this.projectState.requestRestart();
        }
      } else {
        this.projectState.requestRestart();
      }
      this.loadedActiveKey = activeKey;
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
      // Seed the context cache so a save preserves the persisted value without discovery.
      this.loadedLocalContextTokens =
        this.provider !== 'anthropic' ? (config.context_tokens ?? null) : null;
      this.hasApiKey = !!config.has_api_key;
      this.hasCustomHeaders = !!config.has_custom_headers;
      this.lastKnownProvider = this.provider;
      // Seed the cache with the backend-authoritative default for isDefaultBaseUrl.
      if (this.provider !== 'anthropic' && this.defaultBaseUrl) {
        this.defaultBaseUrlsByProvider[this.provider] = this.defaultBaseUrl;
      }
      // Seed the URL cache so switching away and back preserves the user's URL.
      if (this.provider !== 'anthropic' && this.baseUrl) {
        this.baseUrlByProvider[this.provider] = this.baseUrl;
      }

      // v2 provider list: anthropic/local on cards, the rest become remote rows (ADR-073).
      this.loadedLocalEntry = (config.providers ?? []).find((p) => p.id === 'local') ?? null;
      if (this.loadedLocalEntry?.base_url && !this.baseUrlByProvider['local']) {
        this.baseUrlByProvider['local'] = this.loadedLocalEntry.base_url;
      }
      // Anthropic model snapshot: prefer v2 entry / active, fall back to the flat field.
      const anthropicEntry = (config.providers ?? []).find((p) => p.id === 'anthropic');
      this.loadedAnthropicModel =
        anthropicEntry?.model ??
        (config.active?.provider_id === 'anthropic' ? (config.active?.model ?? null) : null) ??
        (this.provider === 'anthropic' ? this.model || null : null);
      if (this.provider === 'anthropic' && this.loadedAnthropicModel) {
        this.model = this.loadedAnthropicModel;
      }
      // Overlay persisted entries onto the two permanent rows (id first,
      // then kind so entries saved under older generated ids still land).
      this.extraProviders = fixedExtraRows();
      for (const p of config.providers ?? []) {
        if (p.kind !== 'open_router' && p.kind !== 'open_ai_compat') {
          continue;
        }
        const row = this.findExtraRow(p.id, p.kind);
        if (row) {
          row.baseUrl = p.base_url ?? '';
          row.model = p.model ?? '';
          row.hasKey = !!p.has_api_key;
          row.contextTokens = p.context_tokens ?? null;
        }
      }
      // Resolve the active row by id first, then by kind for legacy generated ids.
      const activeId = config.active?.provider_id;
      const activeEntry = (config.providers ?? []).find((p) => p.id === activeId);
      const activeRow = activeId ? this.findExtraRow(activeId, activeEntry?.kind) : undefined;
      if (activeRow) {
        this.selectedTarget = activeRow.id;
        this.expandedExtraId = activeRow.id;
        activeRow.model = config.active?.model ?? activeRow.model;
        if (activeRow.kind === 'open_router') {
          void this.discoverExtraModels(activeRow);
        }
      } else {
        this.selectedTarget = this.provider === 'anthropic' ? 'anthropic' : 'local';
      }
      this.loadedActiveKey = `${config.active?.provider_id ?? this.selectedTarget}|${
        config.active?.model ?? config.model ?? ''
      }`;
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
    // Auto-probe only defaults; user-supplied URLs need an explicit trigger (SSRF mitigation).
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
