import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
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
import { eventValue } from '../../shared/dom-event';
import { AuthTerminalComponent } from '../auth-terminal.component';
import { OauthCompletionWatcher } from './oauth-completion-watcher';
import type { AuthStatusResponse } from '../../services/project-state.service';
import {
  AnthropicModel,
  DiscoveredModel,
  DiscoverResult,
  ExtraProviderId,
  FlatProviderId,
  formatContextLabel,
  LEGACY_LOCAL_PROVIDERS,
  LlmActive,
  LlmConfigResponse,
  LlmProviderEntry,
  LlmProviderKind,
  ProviderCardId,
  ProviderTarget,
} from '../../models/llm';

/** Edit-state row of a remote (proxy-routed) provider (ADR-073). Key VALUE lives in `keyInput` until Save; config carries the `hasKey` presence flag. */
interface ExtraProviderEdit {
  id: ExtraProviderId;
  kind: 'open_router';
  baseUrl: string;
  model: string;
  keyInput: string;
  keyTouched: boolean;
  hasKey: boolean;
  /** Catalog models (openrouter rows); null until discovery ran. */
  models: DiscoveredModel[] | null;
  discovering: boolean;
  /** Classified failure of the last catalog discovery; null when none/cleared. */
  discoverError: { reason: DiscoveryFailureReason; status?: number } | null;
  /** Context window of the selected catalog model. */
  contextTokens: number | null;
}

/** The permanent remote row (`openrouter`) — rendered like the anthropic/local cards; an unconfigured row is simply not persisted. */
function fixedExtraRows(): ExtraProviderEdit[] {
  const empty = (id: ExtraProviderId, kind: ExtraProviderEdit['kind']): ExtraProviderEdit => ({
    id,
    kind,
    baseUrl: '',
    model: '',
    keyInput: '',
    keyTouched: false,
    hasKey: false,
    models: null,
    discovering: false,
    discoverError: null,
    contextTokens: null,
  });
  return [empty('openrouter', 'open_router')];
}

/**
 * Tri-state credential value for a touched field: empty/blank → null (delete), otherwise the value; callers gate on the field's touched flag first.
 * @param value - the raw field value
 * @returns the trimmed-non-empty value, or null when blank
 */
function nullIfEmpty(value: string): string | null {
  return value.trim() === '' ? null : value;
}

/** Discovery state for the LLM model listing (discriminated union). `in-flight.id` matches the monotonic counter; non-latest responses are discarded as stale. */
type DiscoveryFailureReason = 'offline' | 'unsupported' | 'other' | 'auth' | 'server-error';

type DiscoveryState =
  | { kind: 'idle' }
  | { kind: 'in-flight'; url: string; id: number }
  | { kind: 'ready'; url: string; models: DiscoveredModel[] }
  | { kind: 'failed'; url: string; reason: DiscoveryFailureReason; status?: number };

/** Backend Err-string prefix (discovery.rs) for a non-auth HTTP status. */
const HTTP_STATUS_ERR_PREFIX = 'LLM server returned HTTP ';

/** Shared inline message for the `auth` discovery sentinel (local + remote cards). */
const AUTH_FAILURE_MESSAGE = 'Authentication failed — check the API key.';

/**
 * Maps a discovery Err string to a reason + status (contract: discovery.rs).
 * @param msg - backend Err string from `discover_llm_models`
 */
function classifyDiscoveryFailure(msg: string): {
  reason: DiscoveryFailureReason;
  status?: number;
} {
  if (msg === 'unsupported') return { reason: 'unsupported' };
  if (msg === 'empty') return { reason: 'other' };
  if (msg === 'auth') return { reason: 'auth' };
  if (msg === 'LLM server returned an HTML response') return { reason: 'server-error' };
  if (msg.startsWith(HTTP_STATUS_ERR_PREFIX)) {
    const n = parseInt(msg.slice(HTTP_STATUS_ERR_PREFIX.length), 10);
    return Number.isNaN(n) ? { reason: 'server-error' } : { reason: 'server-error', status: n };
  }
  return { reason: 'offline' };
}

/** Manages LLM provider selection and configuration. */
@Component({
  selector: 'app-llm-provider',
  imports: [CommonModule, TooltipDirective, AuthTerminalComponent],
  providers: [OauthCompletionWatcher],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section id="section-llm-provider">
      <h2 class="view-title view-title-section text-[var(--ink)]">LLM providers</h2>

      @if (legacyMigrationProvider()) {
        <div
          class="mono mt-3 rounded border border-[var(--accent-dim)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] text-[var(--accent)]"
          data-testid="settings-llm-legacy-migration-banner"
        >
          Provider name <code>{{ legacyMigrationProvider() }}</code> is legacy and will be saved as
          <code>local</code> on next Save. Same behavior, unified naming.
        </div>
      }

      <!-- ── anthropic row ─────────────────────────────────────────────── -->
      <div
        class="mt-4 rounded border"
        [class]="
          selectedTarget() === 'anthropic'
            ? 'border-[var(--accent-dim)] bg-[var(--accent-soft)]'
            : 'border-[var(--line)] bg-[var(--bg-1)]'
        "
      >
        <button
          type="button"
          role="radio"
          [attr.aria-checked]="selectedTarget() === 'anthropic'"
          class="mono flex w-full items-center justify-between px-3 py-2 text-left text-[11px] font-medium"
          [class]="
            selectedTarget() === 'anthropic' ? 'text-[var(--accent)]' : 'text-[var(--ink-dim)]'
          "
          data-testid="settings-llm-provider-anthropic"
          (click)="selectProvider('anthropic')"
        >
          <span>
            {{ selectedTarget() === 'anthropic' ? '● ' : '○ ' }}anthropic
            <span class="text-[10px] text-[var(--ink-mute)]"> · cloud</span>
          </span>
          <span class="flex items-center gap-2" data-testid="auth-status-row">
            @if (apiKeyConfigured() || oauthAuthenticated()) {
              <span class="pill green" data-testid="auth-status-value">● connected</span>
              <span class="pill green" data-testid="auth-status-method">{{
                apiKeyConfigured() ? 'api key' : 'oauth'
              }}</span>
            } @else {
              <span class="pill amber" data-testid="auth-status-value">not configured</span>
            }
          </span>
        </button>

        @if (selectedTarget() === 'anthropic') {
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
                [attr.aria-checked]="authMethod() === 'oauth'"
                class="mono flex-1 border-r border-[var(--line)] px-3 py-2 text-[11px] transition-colors"
                [class]="
                  authMethod() === 'oauth'
                    ? 'bg-[var(--bg-2)] text-[var(--ink)]'
                    : 'text-[var(--ink-mute)] hover:text-[var(--ink)]'
                "
                data-testid="settings-auth-method-oauth"
                (click)="authMethod.set('oauth')"
              >
                subscription (oauth · claude.ai)
              </button>
              <button
                type="button"
                role="radio"
                [attr.aria-checked]="authMethod() === 'api_key'"
                class="mono flex-1 px-3 py-2 text-[11px] transition-colors"
                [class]="
                  authMethod() === 'api_key'
                    ? 'bg-[var(--bg-2)] text-[var(--ink)]'
                    : 'text-[var(--ink-mute)] hover:text-[var(--ink)]'
                "
                data-testid="settings-auth-method-api-key"
                (click)="authMethod.set('api_key')"
              >
                api key
              </button>
            </div>

            @if (authMethod() === 'api_key') {
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
                  [value]="anthropicApiKeyInput()"
                  (input)="anthropicApiKeyInput.set(inputValue($event))"
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
                  [disabled]="anthropicApiKeySaving() || !anthropicApiKeyInput()"
                >
                  {{ anthropicApiKeySaving() ? 'saving...' : 'save key' }}
                </button>
                <button
                  type="button"
                  class="mono rounded border border-[var(--line-strong)] bg-[var(--bg-2)] px-3 py-1 text-[11px] text-[var(--ink)] hover:bg-[var(--bg-3)] disabled:opacity-40 disabled:cursor-not-allowed"
                  data-testid="settings-api-key-remove"
                  (click)="deleteAnthropicApiKey()"
                  [disabled]="!apiKeyConfigured()"
                >
                  remove key
                </button>
                @if (anthropicApiKeySaved()) {
                  <span class="mono text-[11px] text-[var(--green)]">saved!</span>
                }
              </div>
            }
            @if (authMethod() === 'oauth' && activeProject(); as project) {
              @if (oauthAuthenticated()) {
                <div class="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    class="mono rounded bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    data-testid="settings-oauth-logout"
                    [disabled]="loggingOut()"
                    (click)="anthropicLogout(project)"
                  >
                    {{ loggingOut() ? 'logging out...' : 'log out' }}
                  </button>
                  <span class="text-[11.5px] text-[var(--ink-dim)]"
                    >Removes this project's Anthropic credentials.</span
                  >
                </div>
              } @else {
                <div class="mt-3">
                  <app-auth-terminal [project]="project" (done)="onOAuthDone($event)" />
                </div>
              }
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
                [value]="model()"
                (change)="model.set(inputValue($event))"
                class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                data-testid="settings-llm-model"
              >
                <!-- Empty value = no ANTHROPIC_DEFAULT_MODEL injected; real default is
                     plan-dependent (Pro→Sonnet, Max→Opus), unseen by Speedwave. -->
                <option value="">Default — depends on your plan (switchable via /model)</option>
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
                @if (model() && !modelInCatalog(model())) {
                  <option [value]="model()">{{ model() }} (not in catalog)</option>
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
          selectedTarget() === 'local'
            ? 'border-[var(--accent-dim)] bg-[var(--accent-soft)]'
            : 'border-[var(--line)] bg-[var(--bg-1)]'
        "
      >
        <button
          type="button"
          role="radio"
          [attr.aria-checked]="selectedTarget() === 'local'"
          class="mono flex w-full items-center justify-between px-3 py-2 text-left text-[11px] font-medium"
          [class]="selectedTarget() === 'local' ? 'text-[var(--accent)]' : 'text-[var(--ink-dim)]'"
          data-testid="settings-llm-provider-local"
          (click)="selectProvider('local')"
        >
          <span>
            {{ selectedTarget() === 'local' ? '● ' : '○ ' }}local
            <span class="text-[10px] text-[var(--ink-mute)]"> · own server</span>
          </span>
          @if (selectedTarget() !== 'local' && baseUrlByProviderView()) {
            <span class="mono text-[10px] text-[var(--ink-mute)]">{{
              baseUrlByProviderView()
            }}</span>
          }
        </button>

        @if (selectedTarget() === 'local') {
          <div class="border-t border-[var(--line)] px-3 py-3">
            <!-- Order: base_url → api_key → discover → model (only after a
                 successful discover or a saved model) → advanced. -->
            <div>
              <label
                class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                for="llm-base-url"
                >base_url</label
              >
              <input
                id="llm-base-url"
                type="text"
                [value]="baseUrl()"
                (input)="onBaseUrlInput(inputValue($event))"
                [placeholder]="defaultBaseUrl()"
                class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                data-testid="settings-llm-base-url"
              />
            </div>

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
                [value]="apiKey()"
                (input)="onApiKeyInput(inputValue($event))"
                [placeholder]="
                  hasApiKey()
                    ? '••••• (key saved — type to replace, clear to remove)'
                    : 'Bearer token (e.g. sk-…)'
                "
                class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                data-testid="settings-llm-api-key"
              />
            </div>

            <button
              type="button"
              data-testid="settings-llm-refresh"
              class="mono mt-3 inline-flex items-center gap-1 rounded bg-[var(--accent)] px-3 py-1.5 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              [disabled]="discoveryState().kind === 'in-flight'"
              (click)="discoverModels(true)"
              appTooltip="Fetch the list of models from the server"
              placement="top"
            >
              @if (discoveryState().kind === 'in-flight') {
                &#8635; discovering...
              } @else {
                &#8635; discover models
              }
            </button>

            @if (discoveryState().kind === 'failed') {
              <p
                class="mono mt-1 text-[11px] text-[var(--amber)]"
                data-testid="settings-llm-discovery-error"
              >
                {{ discoveryFailureMessage() }}
              </p>
            }
            @let inflight = discoveryState();
            @if (inflight.kind === 'in-flight') {
              <p
                class="mono mt-1 text-[11px] text-[var(--ink-mute)]"
                data-testid="settings-llm-discovering"
              >
                Probing {{ inflight.url }}...
              </p>
            }

            @if (messagesEndpointOk() === false) {
              <div
                class="mono mt-3 rounded border border-[var(--amber)] bg-[var(--amber)]/10 px-3 py-2 text-[11px] text-[var(--amber)]"
                data-testid="settings-llm-messages-endpoint-warning"
              >
                <strong>Warning:</strong> the server returned a model list but did not respond to
                <code>POST /v1/messages</code> (Anthropic Messages API). Save is allowed, but chat
                will fail.
              </div>
            }

            @if (discoveryState().kind === 'ready' || hasSavedModel()) {
              <div class="mt-3">
                <label
                  class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                  for="llm-model"
                  >default_model</label
                >
                @let ds = discoveryState();
                <select
                  id="llm-model"
                  (change)="onLocalModelChange(inputValue($event))"
                  class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                  data-testid="settings-llm-model"
                >
                  @if (ds.kind === 'ready') {
                    @if (model() && !discoveredModelIds().includes(model())) {
                      <option [value]="model()" [selected]="true">
                        {{ model() }} (not on server)
                      </option>
                    }
                    @for (m of ds.models; track m.id) {
                      <option [value]="m.id" [selected]="m.id === model()">
                        {{ formatLocalModelLabel(m) }}
                      </option>
                    }
                  } @else {
                    <!-- Saved config: show the model without re-probing. -->
                    <option [value]="model()" [selected]="true">{{ model() }}</option>
                  }
                </select>
              </div>
            }

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
                  [value]="customHeaders()"
                  (input)="onCustomHeadersInput(inputValue($event))"
                  [placeholder]="
                    hasCustomHeaders()
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
      @for (entry of extraProviders(); track entry.id) {
        <div
          class="mt-2 rounded border"
          [class]="
            selectedTarget() === entry.id
              ? 'border-[var(--accent-dim)] bg-[var(--accent-soft)]'
              : 'border-[var(--line)] bg-[var(--bg-1)]'
          "
          [attr.data-testid]="'settings-llm-extra-' + entry.id"
        >
          <button
            type="button"
            role="radio"
            [attr.aria-checked]="selectedTarget() === entry.id"
            class="mono flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-medium"
            [class]="
              selectedTarget() === entry.id ? 'text-[var(--accent)]' : 'text-[var(--ink-dim)]'
            "
            [attr.data-testid]="'settings-llm-extra-select-' + entry.id"
            (click)="onExtraHeaderClick(entry)"
          >
            {{ selectedTarget() === entry.id ? '●' : '○' }} {{ entry.id }}
            <span class="text-[10px] text-[var(--ink-mute)]"> · openrouter </span>
          </button>
          @if (expandedExtraId === entry.id) {
            <!-- Order: api_key → discover → model (only after catalog loads),
                 matching the local card. -->
            <div class="border-t border-[var(--line)] px-3 py-3">
              <label
                class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                [attr.for]="'extra-key-' + entry.id"
                >api_key</label
              >
              <input
                [id]="'extra-key-' + entry.id"
                type="password"
                autocomplete="off"
                spellcheck="false"
                [value]="entry.keyInput"
                (input)="onExtraKeyInput(entry, inputValue($event))"
                [placeholder]="
                  entry.hasKey ? '••••• (key saved — type to replace, clear to remove)' : 'api key'
                "
                class="mono w-full rounded border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1.5 text-[12px] text-[var(--ink)]"
                [attr.data-testid]="'settings-llm-extra-key-' + entry.id"
              />

              <button
                type="button"
                class="mono mt-3 inline-flex items-center gap-1 rounded bg-[var(--accent)] px-3 py-1.5 text-[11px] font-medium text-[var(--on-accent)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                [disabled]="entry.discovering || !canDiscoverExtra(entry)"
                (click)="discoverExtraModels(entry)"
                [attr.data-testid]="'settings-llm-extra-refresh-' + entry.id"
              >
                {{ entry.discovering ? '↻ discovering...' : '↻ discover models' }}
              </button>

              @if (entry.discoverError) {
                <p
                  class="mono mt-1 text-[11px] text-[var(--amber)]"
                  [attr.data-testid]="'settings-llm-extra-discovery-error-' + entry.id"
                >
                  {{ extraDiscoveryErrorMessage(entry) }}
                </p>
              }

              @if (entry.models && entry.models.length > 0) {
                <div class="mt-3">
                  <label
                    class="mono mb-1 block text-[10px] uppercase tracking-widest text-[var(--ink-mute)]"
                    [attr.for]="'extra-model-' + entry.id"
                    >default_model</label
                  >
                  <!-- Selection lives on the options, not a [value] binding: catalog options load async. -->
                  <select
                    [id]="'extra-model-' + entry.id"
                    (change)="onExtraModelSelect(entry, inputValue($event))"
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
                </div>
              }
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
          [disabled]="saving() || !canSave()"
        >
          {{ saving() ? 'saving...' : 'save' }}
        </button>
        @if (saved()) {
          <span class="mono text-[11px] text-[var(--green)]" data-testid="settings-llm-saved"
            >saved!</span
          >
        }
      </div>
    </section>
  `,
})
export class LlmProviderComponent implements OnInit, OnDestroy {
  provider = signal<FlatProviderId>('anthropic');
  model = signal('');
  baseUrl = signal('');
  defaultBaseUrl = signal('');
  saving = signal(false);
  saved = signal(false);

  /** Local-LLM API key (Bearer), form-only — backend stores it per-project and exposes only `has_api_key`; `apiKeyTouched` gates the unchanged/empty/value tri-state. */
  apiKey = signal('');
  apiKeyTouched = signal(false);
  hasApiKey = signal(false);

  /** Optional custom HTTP headers (Azure APIM, corporate gateways); same touched-flag pattern as apiKey. Format: one `Name: Value` per line. */
  customHeaders = signal('');
  customHeadersTouched = signal(false);
  hasCustomHeaders = signal(false);

  /** Result of the latest discovery probe — populated for `provider==="local"`. */
  messagesEndpointOk = signal<boolean | null>(null);

  /** Active project — drives the auth-status load and the OAuth terminal. */
  readonly activeProject = input<string | null>(null);

  /** Anthropic auth — OAuth default, api-key tab one click away. The key VALUE goes via `save_api_key` to `secrets/<project>/anthropic_api_key`, never LlmConfig. */
  authMethod = signal<'oauth' | 'api_key'>('oauth');
  anthropicApiKeyInput = signal('');
  anthropicApiKeySaving = signal(false);
  anthropicApiKeySaved = signal(false);
  apiKeyConfigured = signal(false);
  oauthAuthenticated = signal(false);
  loggingOut = signal(false);

  /** Detects an external-terminal OAuth login and runs the embedded autosave path. */
  private readonly oauthWatcher = inject(OauthCompletionWatcher);

  /** Remote (proxy-routed) providers (ADR-073). Parsed from the v2 `providers` list on load (anthropic/local stay on cards); Save sends the full set. */
  extraProviders = signal<ExtraProviderEdit[]>(fixedExtraRows());

  /** Which target is active: `'anthropic'`, `'local'`, or an extra provider id. The cards and the extra rows share this one radio state. */
  selectedTarget = signal<ProviderTarget>('anthropic');

  /** `provider_id|model` snapshot on load. Unchanged at Save → proxy-only hot reload (session survives); any change → full project restart (claude env). */
  private loadedActiveKey = '';

  /** Whole-form fingerprint on load, gating `canSave` (see `computeFormSnapshot`); a signal so `isDirty`'s `computed()` invalidates on every reassignment. */
  private loadedFormSnapshot = signal('');

  /** Join state for the initial load race — see `maybeSnapshotInitialLoad`. */
  private initialConfigLoaded = false;
  private initialAuthStatusLoaded = false;

  /** Legacy provider name (`ollama`/`lmstudio`/`llamacpp`) in persisted config, else `null`. Drives the migration banner; rewrite to `local` waits for Save. */
  legacyMigrationProvider = signal<string | null>(null);

  /** Persisted `context_tokens`, seeded on load. Fallback for `resolveContextTokensForSave` until discovery yields the picked model's value. */
  private loadedLocalContextTokens: number | null = null;

  /** Current state of the model discovery probe. See `DiscoveryState` docstring. */
  discoveryState = signal<DiscoveryState>({ kind: 'idle' });

  /** Monotonic counter bumped per discovery trigger; a response whose `id` differs from it is stale (superseded trigger) and discarded. */
  private discoveryCounter = 0;

  /** Tracks the provider value from the previous `onProviderChange` call so we can detect actual changes (ngModelChange can fire without a user edit). */
  private lastKnownProvider: FlatProviderId = 'anthropic';

  /** Per-provider session cache of the last Base URL, restored on switch-back instead of the often-wrong default. Seeded from config on init. */
  private baseUrlByProvider: Partial<Record<FlatProviderId, string>> = {};

  /** Loaded `local` entry — passed through Save while the card is inactive. */
  private loadedLocalEntry: LlmProviderEntry | null = null;

  /** Loaded anthropic model — preserved when another provider is active. */
  private loadedAnthropicModel: string | null = null;

  /** Per-provider default base URL cache (via `get_default_base_url`). */
  private defaultBaseUrlsByProvider: Partial<Record<FlatProviderId, string>> = {};

  readonly providerChange = output<FlatProviderId>();
  readonly errorOccurred = output<string>();

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);

  /** Reloads the Anthropic auth status whenever the active project changes. */
  constructor() {
    this.oauthWatcher.attach({
      activeProject: () => this.activeProject(),
      isAuthenticated: () => this.oauthAuthenticated(),
      // Only probe while on the Anthropic card — no IPC when configuring local/OpenRouter.
      shouldProbe: () => this.effectiveTarget() === 'anthropic',
      onLoginDetected: () => this.onOAuthDone(true),
    });
    effect(() => {
      if (this.activeProject()) {
        // Only the first firing races the initial load; later firings are refreshes,
        // and re-snapshotting there would mask real dirty state.
        const isInitialLoad = !this.initialAuthStatusLoaded;
        void this.loadAuthStatus().then(() => {
          if (isInitialLoad) this.maybeSnapshotInitialLoad('authStatus');
        });
        this.oauthWatcher.startPoll();
      }
    });
  }

  private anthropicModels = inject(AnthropicModelsService);
  private chatState = inject(ChatStateService);
  private log = inject(LoggerService);

  /** Cached SSOT Anthropic model catalog (`list_anthropic_models`). Empty until the first fetch settles; optgroups render nothing while loading. */
  protected readonly anthropicCatalog = signal<readonly AnthropicModel[]>([]);

  /** Models flagged `latest = true` — rendered in the "Latest" optgroup. */
  protected readonly latestAnthropicModels = computed<readonly AnthropicModel[]>(() =>
    this.anthropicCatalog().filter((m) => m.latest)
  );

  /** Remaining still-available snapshots — rendered in the "Legacy" optgroup. */
  protected readonly legacyAnthropicModels = computed<readonly AnthropicModel[]>(() =>
    this.anthropicCatalog().filter((m) => !m.latest)
  );

  /** Loads the LLM configuration + the SSOT model catalog from the backend on init. */
  ngOnInit(): void {
    this.loadConfig();
    void this.loadAnthropicCatalog();
    this.oauthWatcher.watchWindowFocus();
  }

  /** Tears down the external-login watcher (poll + focus listener). */
  ngOnDestroy(): void {
    this.oauthWatcher.destroy();
  }

  /**
   * Format a catalog entry into the dropdown label, e.g. `"Opus 4.7 · 1M ctx (claude-opus-4-7)"` — the id keeps copied aliases honest.
   * @param m - the catalog entry to format
   */
  protected formatModelLabel(m: AnthropicModel): string {
    return `${m.family} · ${formatContextLabel(m.context_tokens)} ctx (${m.id})`;
  }

  /**
   * Whether the given model id is present in the SSOT catalog.
   * @param id - the model id to look up
   */
  protected modelInCatalog(id: string): boolean {
    return this.anthropicCatalog().some((m) => m.id === id);
  }

  /**
   * Format a discovered local model into a dropdown label: `id · 32k ctx` when a context window is known, otherwise the bare id.
   * @param m - the discovered model to format
   */
  protected formatLocalModelLabel(m: DiscoveredModel): string {
    if (m.context_tokens && m.context_tokens > 0) {
      return `${m.id} · ${formatContextLabel(m.context_tokens)} ctx`;
    }
    return m.id;
  }

  /** Ids of every model returned by the most recent discovery probe. */
  protected readonly discoveredModelIds = computed<string[]>(() => {
    const s = this.discoveryState();
    return s.kind === 'ready' ? s.models.map((m) => m.id) : [];
  });

  /** True when a non-empty model should render while discovery is idle. */
  protected readonly hasSavedModel = computed<boolean>(
    () => this.discoveryState().kind === 'idle' && !!this.model()
  );

  /**
   * Local-model `<select>` change handler. `context_tokens` are derived on demand from `discoveryState.models` (one source), not cached here.
   * @param id - the selected model id
   */
  protected onLocalModelChange(id: string): void {
    this.model.set(id);
  }

  /**
   * Base-URL edit resets stale discovery + model, so Save re-gates on a fresh discover against the new server.
   * @param value - the new base URL input value
   */
  protected onBaseUrlInput(value: string): void {
    this.baseUrl.set(value);
    this.discoveryState.set({ kind: 'idle' });
    this.model.set('');
    this.messagesEndpointOk.set(null);
  }

  /**
   * Touched-flag handler — see `apiKeyTouched` doc for the tri-state rationale.
   * @param value - the new API key input value
   */
  protected onApiKeyInput(value: string): void {
    this.apiKey.set(value);
    this.apiKeyTouched.set(true);
  }

  /**
   * Touched-flag handler — see `customHeadersTouched` doc.
   * @param value - the new custom-headers input value
   */
  protected onCustomHeadersInput(value: string): void {
    this.customHeaders.set(value);
    this.customHeadersTouched.set(true);
  }

  /** `context_tokens` to save: anthropic→catalog lookup; local+discovery→picked model's window; local pre-discovery→loaded config value; else `null`. */
  private resolveContextTokensForSave(): number | null {
    const model = this.model();
    if (!model) return null;
    if (this.provider() === 'anthropic') {
      return this.anthropicCatalog().find((m) => m.id === model)?.context_tokens ?? null;
    }
    const s = this.discoveryState();
    if (s.kind === 'ready') {
      const picked = s.models.find((m) => m.id === model);
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
   * Provider-card click handler. Routes through `onProviderChange` so URL caching, default fetching, and probe gating stay intact.
   * @param id - the clicked provider card id
   */
  async selectProvider(id: ProviderCardId): Promise<void> {
    this.selectedTarget.set(id);
    if (this.provider() === id) return;
    this.provider.set(id);
    await this.onProviderChange();
  }

  /** Currently expanded (editable) remote row — independent of the radio. */
  expandedExtraId: ExtraProviderId | null = null;

  /**
   * Whole-bar click: first click activates the row (and expands it); a click on the already-active row toggles the edit panel.
   * @param entry - the clicked remote provider row
   */
  onExtraHeaderClick(entry: ExtraProviderEdit): void {
    if (this.selectedTarget() !== entry.id) {
      this.selectExtraProvider(entry);
    } else {
      this.toggleExtraExpanded(entry);
    }
  }

  /**
   * Makes the row the active provider (and expands it).
   * @param entry - the remote provider row to activate
   */
  selectExtraProvider(entry: ExtraProviderEdit): void {
    this.snapshotAnthropicModel();
    this.selectedTarget.set(entry.id);
    this.expandedExtraId = entry.id;
    // No auto-discover on expand — discovery is explicit and gated on the key.
  }

  /**
   * Toggles the row's edit panel without changing the active provider.
   * @param entry - the remote provider row to toggle
   */
  toggleExtraExpanded(entry: ExtraProviderEdit): void {
    this.expandedExtraId = this.expandedExtraId === entry.id ? null : entry.id;
  }

  /**
   * OpenRouter discovery is gated on a non-empty API key.
   * @param entry - the remote provider row to check
   */
  protected canDiscoverExtra(entry: ExtraProviderEdit): boolean {
    return entry.kind === 'open_router' && !!entry.keyInput.trim();
  }

  /**
   * Fetches the OpenRouter catalog (host-side, tool-capable models), sending the transient key so the catalog probe authenticates.
   * @param entry - the remote provider row to discover models for
   */
  async discoverExtraModels(entry: ExtraProviderEdit): Promise<void> {
    if (entry.kind !== 'open_router' || entry.discovering) {
      return;
    }
    entry.discovering = true;
    entry.discoverError = null;
    this.extraProviders.set([...this.extraProviders()]);
    this.cdr.markForCheck();
    try {
      const apiKey = entry.keyInput.trim() ? entry.keyInput.trim() : undefined;
      const res = await this.tauri.invoke<DiscoverResult>('discover_llm_models', {
        args: { provider: 'openrouter', baseUrl: '', apiKey },
      });
      const models = res?.models ?? [];
      const row = this.extraProviders().find((p) => p.id === entry.id);
      if (row && models.length > 0) {
        row.models = models;
        row.discoverError = null;
        if (row.model) {
          row.contextTokens =
            models.find((m) => m.id === row.model)?.context_tokens ?? row.contextTokens;
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Same classification contract as the local card (discovery.rs sentinels).
      const row = this.extraProviders().find((p) => p.id === entry.id);
      if (row) row.discoverError = classifyDiscoveryFailure(msg);
      this.log.warn(`openrouter catalog discovery failed: ${msg}`);
    } finally {
      entry.discovering = false;
      this.extraProviders.set([...this.extraProviders()]);
      this.cdr.markForCheck();
    }
  }

  /**
   * Inline error for a remote row's failed catalog discovery. The `auth` sentinel maps to the shared key message; anything else gets a generic hint.
   * @param entry - the remote provider row to render an error for
   */
  protected extraDiscoveryErrorMessage(entry: ExtraProviderEdit): string {
    const failure = entry.discoverError;
    if (!failure) return '';
    if (failure.reason === 'auth') return AUTH_FAILURE_MESSAGE;
    return failure.status
      ? `Model discovery failed — the server returned HTTP ${failure.status}.`
      : 'Model discovery failed — check the network connection and try again.';
  }

  /**
   * Dropdown selection handler for an openrouter row — records the model and its catalog context window.
   * @param entry - the remote provider row being edited
   * @param modelId - the selected model id
   */
  onExtraModelSelect(entry: ExtraProviderEdit, modelId: string): void {
    entry.model = modelId;
    entry.contextTokens = entry.models?.find((m) => m.id === modelId)?.context_tokens ?? null;
    this.extraProviders.set([...this.extraProviders()]);
  }

  /**
   * Whether the discovered catalog contains `modelId` — drives the extra `<option>` preserving a previously saved model that left the catalog.
   * @param entry - the remote provider row to check
   * @param modelId - the model id to look up
   */
  catalogHasModel(entry: ExtraProviderEdit, modelId: string): boolean {
    return !!entry.models?.some((m) => m.id === modelId);
  }

  /**
   * Context window as a short label (`128k`, `1M`) for dropdown options.
   * @param tokens - the context window size in tokens
   */
  ctxLabel(tokens: number): string {
    return formatContextLabel(tokens);
  }

  /**
   * Key-field input handler for a remote provider row.
   * @param entry - the remote provider row being edited
   * @param value - the new API key input value
   */
  onExtraKeyInput(entry: ExtraProviderEdit, value: string): void {
    entry.keyInput = value;
    entry.keyTouched = true;
    // A new key invalidates the previous failure (mirrors onBaseUrlInput).
    entry.discoverError = null;
    this.extraProviders.set([...this.extraProviders()]);
  }

  /** Placeholder model name per provider. Anthropic derives it from the SSOT catalog (latest everyday Sonnet); empty while loading to avoid a stale id. */
  readonly modelPlaceholder = computed<string>(() => {
    if (this.provider() === 'anthropic') {
      return this.anthropicModels.latestEverydayModelId() ?? '';
    }
    return 'llama3.3';
  });

  /** Human-readable reason the discovery probe failed, shown inline under the discover button. */
  discoveryFailureMessage(): string {
    const s = this.discoveryState();
    if (s.kind !== 'failed') return '';
    const url = s.url;
    const label = this.providerDisplayLabel();
    switch (s.reason) {
      case 'offline':
        return `${label} server not reachable at ${url}. Make sure it's running and the local server is enabled.`;
      case 'auth':
        return AUTH_FAILURE_MESSAGE;
      case 'server-error': {
        const code = s.status;
        return code
          ? `${label} at ${url} is reachable but returned HTTP ${code}.`
          : `${label} at ${url} is reachable but returned an unexpected (non-JSON) response.`;
      }
      case 'unsupported':
        return `${label} does not support model discovery. Switch to a provider with an OpenAI-compatible /v1/models endpoint.`;
      case 'other':
        return `${label} at ${url} returned no models (the server is up but no model is loaded).`;
    }
  }

  /** Returns the UI-friendly label for the current provider. */
  private readonly providerDisplayLabel = computed<string>(() =>
    this.provider() === 'local' ? 'Local LLM server' : 'Provider'
  );

  /** Provider-dropdown change. Resets baseUrl (per-provider default ports), re-probes against the new default, and bumps the counter to drop stale probes. */
  async onProviderChange(): Promise<void> {
    const provider = this.provider();
    if (provider === this.lastKnownProvider) {
      // Guard against redundant ngModelChange fires — no-op.
      return;
    }
    // Cache the URL per provider to restore on switch back in the same session.
    const previousProvider = this.lastKnownProvider;
    const previousBaseUrl = this.baseUrl();
    if (previousProvider !== 'anthropic' && previousBaseUrl) {
      this.baseUrlByProvider[previousProvider] = previousBaseUrl;
    }
    // Snapshot the anthropic model when leaving the card so it is restored below.
    this.snapshotAnthropicModel(previousProvider);
    this.lastKnownProvider = provider;
    this.discoveryCounter++;
    // Clear state now; model is provider-specific and restored from snapshot.
    this.model.set(
      provider === 'anthropic'
        ? (this.loadedAnthropicModel ?? '')
        : (this.loadedLocalEntry?.model ?? '')
    );
    this.discoveryState.set({ kind: 'idle' });
    this.providerChange.emit(provider);
    this.cdr.markForCheck();
    // Fetch backend-authoritative default if not cached (compose.rs is SSOT).
    if (provider !== 'anthropic' && !this.defaultBaseUrlsByProvider[provider]) {
      try {
        const freshDefault = await this.tauri.invoke<string | null>('get_default_base_url', {
          provider,
        });
        if (freshDefault) {
          this.defaultBaseUrlsByProvider[provider] = freshDefault;
        }
      } catch {
        // Not in Tauri or unknown provider — cache stays empty for this provider.
      }
    }
    const defaultBaseUrl = this.defaultBaseUrlsByProvider[provider] ?? '';
    this.defaultBaseUrl.set(defaultBaseUrl);
    // Restore the cached URL for this provider, else fall back to the provider's
    // backend-authoritative default. Anthropic has no baseUrl.
    const cached = this.baseUrlByProvider[provider];
    this.baseUrl.set(provider === 'anthropic' ? '' : cached || defaultBaseUrl);
    // No auto-probe on switch — discovery is explicit (the discover button only).
  }

  /**
   * Probes the local LLM server for models. Fires only from the explicit "Discover models" button — never automatically (no blur/load/switch probes).
   * @param isRefresh - true when re-probing the same URL while a probe is already in-flight
   */
  async discoverModels(isRefresh: boolean): Promise<void> {
    const provider = this.provider();
    if (provider === 'anthropic') return;
    const effectiveUrl = this.baseUrl() || this.defaultBaseUrl();
    if (!effectiveUrl) return;

    // Dedupe: skip same-URL non-refresh triggers while a probe is in-flight.
    const current = this.discoveryState();
    if (!isRefresh && current.kind === 'in-flight' && current.url === effectiveUrl) {
      return;
    }

    const id = ++this.discoveryCounter;
    this.discoveryState.set({ kind: 'in-flight', url: effectiveUrl, id });

    try {
      // Tri-state via `LlmConfigUpdate.api_key` (see types.rs).
      const args: {
        provider: string;
        baseUrl: string;
        apiKey?: string | null;
        customHeaders?: string | null;
      } = { provider, baseUrl: effectiveUrl };
      if (this.apiKeyTouched()) {
        args.apiKey = nullIfEmpty(this.apiKey());
      }
      if (this.customHeadersTouched()) {
        args.customHeaders = nullIfEmpty(this.customHeaders());
      }
      const result = await this.tauri.invoke<DiscoverResult>('discover_llm_models', {
        args,
      });
      // Stale-discard: drop responses whose id doesn't match the latest trigger.
      const live = this.discoveryState();
      if (live.kind !== 'in-flight' || live.id !== id) return;
      // Invariant: do_discover_llm_models maps empty lists to Err("empty"), so a resolved Ok always carries a non-empty array.
      this.discoveryState.set({ kind: 'ready', url: effectiveUrl, models: result.models });
      this.messagesEndpointOk.set(result.messages_endpoint_ok ?? null);
      // Auto-select only when blank (a3): a restored-but-unlisted model is deliberate — keep it (template offers "not on server").
      if (!this.model() && result.models[0]?.id) {
        this.model.set(result.models[0].id);
      }
    } catch (e: unknown) {
      const live = this.discoveryState();
      if (live.kind !== 'in-flight' || live.id !== id) return;
      const msg = e instanceof Error ? e.message : String(e);
      const { reason, status } = classifyDiscoveryFailure(msg);
      this.discoveryState.set({ kind: 'failed', url: effectiveUrl, reason, status });
      // No errorOccurred.emit — discovery failure is silent degradation.
    }
  }

  /** Collapsed-row summary of the local server URL. */
  readonly baseUrlByProviderView = computed<string>(
    () => this.baseUrl() || this.baseUrlByProvider['local'] || ''
  );

  /** Loads the current Anthropic authentication status from the backend. */
  async loadAuthStatus(): Promise<void> {
    const project = this.activeProject();
    if (!project) return;
    try {
      const status = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', { project });
      this.apiKeyConfigured.set(status.api_key_configured);
      this.oauthAuthenticated.set(status.oauth_authenticated);
      this.projectState.applyAuthStatus(status);
    } catch {
      // Auth status check failed — container may not be running.
    }
    this.cdr.markForCheck();
  }

  /** Saves the Anthropic API key to the project's secrets directory. */
  async saveAnthropicApiKey(): Promise<void> {
    const project = this.activeProject();
    const apiKey = this.anthropicApiKeyInput();
    if (!project || !apiKey) return;
    this.anthropicApiKeySaving.set(true);
    this.anthropicApiKeySaved.set(false);
    this.errorOccurred.emit('');
    try {
      await this.tauri.invoke('save_api_key', {
        project,
        apiKey,
      });
      this.anthropicApiKeySaved.set(true);
      this.anthropicApiKeyInput.set('');
      await this.loadAuthStatus();
      setTimeout(() => {
        this.anthropicApiKeySaved.set(false);
        this.cdr.markForCheck();
      }, 2000);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.anthropicApiKeySaving.set(false);
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
   * Auto-selects + saves Anthropic on OAuth success, unconditionally: the prior active provider may still be routing live, so saveConfig must run even if the card was already showing Anthropic.
   * @param _success - unused; the handler re-checks auth status instead of trusting the caller's flag
   */
  async onOAuthDone(_success: boolean): Promise<void> {
    await this.loadAuthStatus();
    if (this.oauthAuthenticated()) {
      this.selectedTarget.set('anthropic');
      this.provider.set('anthropic');
      // Force a full restart: the saved `active` may already read 'anthropic' while the running
      // container still routes to a stale provider, so a proxy reload would skip the needed claude restart.
      await this.saveConfig(true);
    }
    this.cdr.markForCheck();
  }

  /**
   * Removes the project's Anthropic credentials and clears the active provider, leaving the user with no provider, then refreshes the status.
   * @param project - the active project name
   */
  async anthropicLogout(project: string): Promise<void> {
    this.loggingOut.set(true);
    try {
      await this.tauri.invoke<void>('anthropic_logout', { project });
      await this.tauri.invoke<void>('clear_active_llm_provider');
      // Deliberate action — bypass applyAuthStatus's never-downgrade guard so
      // a live chat view blanks to the no_provider screen.
      this.projectState.forceUnconfigured();
      await this.loadAuthStatus();
      // The poll self-stopped while authenticated; restart it so a subsequent
      // external-terminal re-login on this same project is detected again.
      this.oauthWatcher.startPoll();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.error(`anthropic_logout failed: ${msg}`);
    } finally {
      this.loggingOut.set(false);
      this.cdr.markForCheck();
    }
  }

  /**
   * Builds the full v2 provider set (ADR-073): cards map to `anthropic`/`local` entries, remote rows append verbatim.
   * @param anthropicHasApiKey - whether the Anthropic card has a configured API key
   */
  private buildProviderSet(anthropicHasApiKey: boolean): LlmProviderEntry[] {
    // Resolve the active target once — it's stable for this invocation.
    const target = this.effectiveTarget();
    const model = this.model();
    // Anthropic card active → `this.model`; else the load-time snapshot, so
    // an explicit Anthropic model survives activating another provider.
    const anthropicModel = target === 'anthropic' ? model : this.loadedAnthropicModel;
    const providers: LlmProviderEntry[] = [
      {
        id: 'anthropic',
        kind: anthropicHasApiKey ? 'anthropic_api_key' : 'anthropic_oauth',
        model: anthropicModel || null,
        has_api_key: anthropicHasApiKey,
      },
    ];
    // Local card not being edited → pass its loaded entry verbatim; rebuilding
    // from the card fields silently erased base_url and model.
    const editingLocal = target === 'local';
    if (!editingLocal && this.loadedLocalEntry) {
      providers.push({ ...this.loadedLocalEntry });
    } else {
      const localUrl = editingLocal
        ? this.baseUrl() || this.defaultBaseUrl()
        : this.baseUrlByProvider['local'] || '';
      if (localUrl) {
        providers.push({
          id: 'local',
          kind: 'local',
          base_url: localUrl,
          model: (editingLocal ? model : this.loadedLocalEntry?.model) || null,
          has_api_key: this.hasApiKey() || (this.apiKeyTouched() && this.apiKey().trim() !== ''),
          has_custom_headers:
            this.hasCustomHeaders() ||
            (this.customHeadersTouched() && this.customHeaders().trim() !== ''),
          context_tokens: this.resolveContextTokensForSave(),
        });
      }
    }
    for (const extra of this.extraProviders()) {
      // Only configured rows persist; hasKey drops when the field is cleared.
      const hasKey = extra.keyTouched ? extra.keyInput.trim() !== '' : extra.hasKey;
      const configured = hasKey || extra.model.trim() !== '';
      if (!configured) {
        continue;
      }
      providers.push({
        id: extra.id,
        kind: extra.kind,
        base_url: null,
        model: extra.model || null,
        has_api_key: hasKey,
        context_tokens: extra.contextTokens,
      });
    }
    return providers;
  }

  /** Resolves the radio state to a concrete target id. With no matching extra row, the cards win — `provider` decides (covers programmatic mutation). */
  private readonly effectiveTarget = computed<ProviderTarget>(() => {
    const selectedTarget = this.selectedTarget();
    if (this.extraProviders().some((p) => p.id === selectedTarget)) {
      return selectedTarget;
    }
    return this.provider() === 'anthropic' ? 'anthropic' : 'local';
  });

  /** Whole-form fingerprint of dirty-relevant fields, compared to `loadedFormSnapshot` for `canSave`. */
  private computeFormSnapshot(): string {
    const extras = this.extraProviders()
      .map((e) => `${e.id}:${e.model}:${e.keyTouched}`)
      .join(',');
    return [
      this.selectedTarget(),
      this.provider(),
      this.authMethod(),
      this.apiKeyConfigured(),
      this.model(),
      this.oauthAuthenticated(),
      this.baseUrl(),
      this.apiKeyTouched(),
      this.customHeadersTouched(),
      extras,
    ].join('|');
  }

  /**
   * Snapshots once both load legs settle, whichever finishes second. With no active project, `authStatus` is vacuously satisfied since it never fires.
   * @param half - which load leg just completed
   */
  private maybeSnapshotInitialLoad(half: 'config' | 'authStatus'): void {
    if (half === 'config') {
      this.initialConfigLoaded = true;
    } else {
      this.initialAuthStatusLoaded = true;
    }
    const authHalfDone = this.initialAuthStatusLoaded || !this.activeProject();
    if (this.initialConfigLoaded && authHalfDone) {
      this.loadedFormSnapshot.set(this.computeFormSnapshot());
    }
  }

  /** True once the live form differs from the snapshot captured at load/save. */
  protected readonly isDirty = computed<boolean>(
    () => this.computeFormSnapshot() !== this.loadedFormSnapshot()
  );

  /** Save is allowed only when the active non-anthropic provider has a model AND the user has actually changed something since load/last save. */
  protected readonly canSave = computed<boolean>(() => {
    if (!this.isDirty()) return false;
    const target = this.effectiveTarget();
    // Anthropic needs no model but DOES need credentials (oauth or api key).
    if (target === 'anthropic') return this.oauthAuthenticated() || this.apiKeyConfigured();
    const extra = this.extraProviders().find((p) => p.id === target);
    if (extra) return !!extra.model.trim();
    return !!this.model().trim();
  });

  /**
   * Finds a permanent remote row by exact id, falling back to kind so legacy generated ids (`openrouter-2`) still land on their fixed row.
   * @param id - the persisted provider id to look up
   * @param kind - fallback provider kind when the exact id isn't found
   */
  private findExtraRow(id: string, kind?: LlmProviderKind): ExtraProviderEdit | undefined {
    const rows = this.extraProviders();
    return rows.find((r) => r.id === id) ?? (kind ? rows.find((r) => r.kind === kind) : undefined);
  }

  /**
   * A `provider/model`-shaped id is foreign to Anthropic (ADR-073). Mirror of the Rust `is_foreign_anthropic_model` SSOT — frontend can't call Rust.
   * @param model - the model id to check
   */
  private isForeignModel(model: string): boolean {
    return model.includes('/');
  }

  /**
   * Snapshots the anthropic-card model before leaving the card, so a later Save doesn't fall back to a stale snapshot (F2/a1). Foreign ids never stick.
   * @param fromTarget - the provider target being left; defaults to the current effective target
   */
  private snapshotAnthropicModel(fromTarget: string = this.effectiveTarget()): void {
    const model = this.model();
    if (fromTarget === 'anthropic' && model && !this.isForeignModel(model)) {
      this.loadedAnthropicModel = model;
    }
  }

  /**
   * Narrows a persisted flat provider to the typed target domain: cards pass through, remote ids
   * land on their fixed row (id first, then kind), anything unknown falls back to the local card.
   * @param raw - the persisted flat provider id
   * @param kind - fallback provider kind when the exact id isn't a known remote row
   */
  private narrowFlatProvider(raw: string, kind?: LlmProviderKind): ProviderTarget {
    if (raw === 'anthropic' || raw === 'local') return raw;
    return this.findExtraRow(raw, kind)?.id ?? 'local';
  }

  /** Value of an input/select/textarea event target, exposed for template bindings. */
  protected readonly inputValue = eventValue;

  /** The active selection Save will persist, derived from the radio state. */
  private buildActive(): LlmActive {
    const target = this.effectiveTarget();
    const extra = this.extraProviders().find((p) => p.id === target);
    if (extra) {
      return { provider_id: extra.id, model: extra.model || null };
    }
    return {
      provider_id: target,
      model: this.model() || null,
    };
  }

  /**
   * Restart-discriminator over claude-env inputs (provider, model, kind, custom-headers); excludes
   * proxy-path base_url + proxy_enabled (ADR-073 R6). A change in the returned key forces a full restart vs. a proxy reload.
   * @param providerId - the active provider id
   * @param model - the active model, if any
   * @param providers - the full provider set to resolve kind/custom-headers from
   */
  private computeActiveKey(
    providerId: string,
    model: string | null | undefined,
    providers: LlmProviderEntry[]
  ): string {
    const entry = providers.find((p) => p.id === providerId);
    const kind = entry?.kind ?? '';
    const customHeaders = entry?.has_custom_headers ? '1' : '0';
    return `${providerId}|${model ?? ''}|${kind}|${customHeaders}`;
  }

  /**
   * Persists the LLM provider configuration to the backend.
   * @param forceRestart - forces a full restart even if `active` is unchanged, so a running container can't stay routed to a stale provider
   */
  async saveConfig(forceRestart = false): Promise<void> {
    // Surface the model-required error at Save time; compose::apply_llm_config
    // also rejects it but only at container start (no immediate feedback).
    const provider = this.provider();
    const localIsActive = this.effectiveTarget() === 'local';
    if (provider !== 'anthropic' && !this.model() && localIsActive) {
      this.errorOccurred.emit('A model name is required for local providers');
      return;
    }
    const activeExtra = this.extraProviders().find((p) => p.id === this.effectiveTarget());
    if (activeExtra && !activeExtra.model.trim()) {
      this.errorOccurred.emit(`Provider '${activeExtra.id}' requires a model name`);
      return;
    }
    this.saving.set(true);
    this.saved.set(false);
    try {
      const active = this.buildActive();
      // Fall back to provider default if baseUrl blank; compose injects ANTHROPIC_BASE_URL.
      const effectiveBaseUrl =
        active.provider_id === 'local' ? this.baseUrl() || this.defaultBaseUrl() || null : null;
      // Input signal — the single project source (drives the restart below).
      const project = this.activeProject();
      // Reuse the cached auth state (loadAuthStatus) — no redundant round-trip.
      const anthropicHasApiKey = this.apiKeyConfigured();
      // Flat fields mirror v2 providers/active for backend routing; remote row active = remote id.
      const activeIsRemote = this.extraProviders().some((p) => p.id === active.provider_id);
      const flatProvider = activeIsRemote ? active.provider_id : provider;
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
      if (this.apiKeyTouched()) {
        update.api_key = nullIfEmpty(this.apiKey());
      }
      if (this.customHeadersTouched()) {
        update.custom_headers = nullIfEmpty(this.customHeaders());
      }
      // Write keys before config so a failure prevents the config commit (ADR-073).
      const touchedExtras = this.extraProviders().filter((e) => e.keyTouched);
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
      this.extraProviders.set([...this.extraProviders()]);
      this.saved.set(true);
      // Reset touched flags; update the has_* flags from persisted values.
      if (this.apiKeyTouched()) {
        this.hasApiKey.set(!!update.api_key);
        this.apiKey.set('');
        this.apiKeyTouched.set(false);
      }
      if (this.customHeadersTouched()) {
        this.hasCustomHeaders.set(!!update.custom_headers);
        this.customHeaders.set('');
        this.customHeadersTouched.set(false);
      }
      // Push context tokens so the chat footer updates immediately.
      void this.chatState.refreshLlmConfigCache();
      this.providerChange.emit(provider);
      // Changes to claude-env (kind / custom-headers → proxy-vs-direct path)
      // need a full restart; proxy-path-only changes (base_url) = proxy reload.
      const activeKey = this.computeActiveKey(active.provider_id, active.model, update.providers);
      // Hot-reload only against a LIVE stack; a lone proxy on a down project
      // would "succeed" while claude stays dead — route through requestRestart.
      const stackReady = this.projectState.status() === 'ready';
      if (!forceRestart && activeKey === this.loadedActiveKey && project && stackReady) {
        // Only base_url changed (same provider/model/kind) — hot-reload the
        // proxy instead of a full claude restart.
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
        // forceRestart, a changed active key, or a fresh no_provider project —
        // requestRestart starts containers when they were never running.
        this.projectState.requestRestart();
      }
      this.loadedActiveKey = activeKey;
      // Touched flags are already cleared above, so this reflects the saved state.
      this.loadedFormSnapshot.set(this.computeFormSnapshot());
      setTimeout(() => {
        this.saved.set(false);
        this.cdr.markForCheck();
      }, 2000);
    } catch (e: unknown) {
      this.errorOccurred.emit(e instanceof Error ? e.message : String(e));
    }
    this.saving.set(false);
    this.cdr.markForCheck();
  }

  private async loadConfig(): Promise<void> {
    try {
      const config = await this.tauri.invoke<LlmConfigResponse>('get_llm_config');
      const persistedProvider = config.provider || 'anthropic';
      // Legacy provider names (`ollama`/`lmstudio`/`llamacpp`) show the `local`
      // card + banner; persisted value rewritten only on next Save (downgrade-safe).
      if (LEGACY_LOCAL_PROVIDERS.includes(persistedProvider)) {
        this.legacyMigrationProvider.set(persistedProvider);
        this.provider.set('local');
      } else {
        this.legacyMigrationProvider.set(null);
        const persistedKind = (config.providers ?? []).find(
          (p) => p.id === persistedProvider
        )?.kind;
        this.provider.set(this.narrowFlatProvider(persistedProvider, persistedKind));
      }
      const provider = this.provider();
      const baseUrl = config.base_url || '';
      const defaultBaseUrl = config.default_base_url || '';
      this.model.set(config.model || '');
      this.baseUrl.set(baseUrl);
      this.defaultBaseUrl.set(defaultBaseUrl);
      // Seed the context cache so a save preserves the persisted value without discovery.
      this.loadedLocalContextTokens =
        provider !== 'anthropic' ? (config.context_tokens ?? null) : null;
      this.hasApiKey.set(!!config.has_api_key);
      this.hasCustomHeaders.set(!!config.has_custom_headers);
      this.lastKnownProvider = provider;
      if (provider !== 'anthropic' && defaultBaseUrl) {
        this.defaultBaseUrlsByProvider[provider] = defaultBaseUrl;
      }
      // Seed the URL cache so switching away and back preserves the user's URL.
      if (provider !== 'anthropic' && baseUrl) {
        this.baseUrlByProvider[provider] = baseUrl;
      }

      // v2 provider list: anthropic/local on cards, the rest become remote rows (ADR-073).
      this.loadedLocalEntry = (config.providers ?? []).find((p) => p.id === 'local') ?? null;
      if (this.loadedLocalEntry?.base_url && !this.baseUrlByProvider['local']) {
        this.baseUrlByProvider['local'] = this.loadedLocalEntry.base_url;
      }
      // Anthropic model snapshot from entry/active/flat; a foreign (`/`-shaped)
      // id is dropped to account default (F1, ADR-073 provenance).
      const anthropicEntry = (config.providers ?? []).find((p) => p.id === 'anthropic');
      const candidate =
        anthropicEntry?.model ??
        (config.active?.provider_id === 'anthropic' ? config.active?.model : null) ??
        // Legacy/v1 response with no providers[]: fall back to the flat model.
        (provider === 'anthropic' ? this.model() || null : null);
      this.loadedAnthropicModel = candidate && !this.isForeignModel(candidate) ? candidate : null;
      if (provider === 'anthropic') {
        this.model.set(this.loadedAnthropicModel ?? '');
      }
      // Overlay persisted entries onto the two permanent rows (id first,
      // then kind so entries saved under older generated ids still land).
      this.extraProviders.set(fixedExtraRows());
      for (const p of config.providers ?? []) {
        if (p.kind !== 'open_router') {
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
        this.selectedTarget.set(activeRow.id);
        this.expandedExtraId = activeRow.id;
        // Entry wins (mirror Rust effective_active_model): the row already
        // carries the entry model; use active.model only as a fallback.
        activeRow.model = activeRow.model || config.active?.model || '';
        if (activeRow.kind === 'open_router') {
          void this.discoverExtraModels(activeRow);
        }
      } else {
        this.selectedTarget.set(provider === 'anthropic' ? 'anthropic' : 'local');
      }
      // Publish the row mutations applied above into the signal.
      this.extraProviders.set([...this.extraProviders()]);
      const loadedProviderId = config.active?.provider_id ?? this.selectedTarget();
      this.loadedActiveKey = this.computeActiveKey(
        loadedProviderId,
        config.active?.model ?? config.model ?? null,
        config.providers ?? []
      );
      this.providerChange.emit(provider);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Silently ignore the common "not in Tauri" case (browser dev mode).
      // Log anything else so real backend errors aren't hidden.
      if (!msg.toLowerCase().includes('tauri') && !msg.toLowerCase().includes('invoke')) {
        this.log.error(`loadConfig: unexpected error loading LLM config: ${msg}`);
      }
    }
    // Always mark this half done, even on error — else the join hangs forever
    // and isDirty()/canSave() get stuck wrong (see maybeSnapshotInitialLoad).
    this.maybeSnapshotInitialLoad('config');
    this.cdr.markForCheck();
    // No auto-probe on load — a saved model renders from config; discovery is explicit.
  }
}
