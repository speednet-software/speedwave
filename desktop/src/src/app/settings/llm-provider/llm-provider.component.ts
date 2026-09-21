import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
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
import { ChatStateService } from '../../services/chat-state.service';
import { LoggerService } from '../../services/logger.service';
import { SettingsDirtyService } from '../settings-dirty.service';
import { TooltipDirective } from '../../shared/tooltip.directive';
import { eventValue } from '../../shared/dom-event';
import { AuthTerminalComponent } from '../auth-terminal.component';
import { OauthCompletionWatcher, type SignInDisplay } from './oauth-completion-watcher';
import type { AuthStatusResponse } from '../../services/project-state.service';
import {
  DiscoveredModel,
  DiscoverResult,
  ExtraProviderId,
  FlatProviderId,
  LEGACY_LOCAL_PROVIDERS,
  LlmActive,
  LlmConfigResponse,
  LlmProviderEntry,
  LlmProviderKind,
  ProviderCardId,
  ProviderTarget,
} from '../../models/llm';

interface ExtraProviderEdit {
  id: ExtraProviderId;
  kind: 'open_router';
  baseUrl: string;
  model: string;
  keyInput: string;
  keyTouched: boolean;
  hasKey: boolean;
  models: DiscoveredModel[] | null;
  discovering: boolean;
  discoverError: { reason: DiscoveryFailureReason; status?: number } | null;
  contextTokens: number | null;
  savedFp: string;
  lastTest: { fp: string; passed: boolean } | null;
  inFlight: Promise<void> | null;
}

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
    savedFp: extraKeyFingerprint(false, false, ''),
    lastTest: null,
    inFlight: null,
  });
  return [empty('openrouter', 'open_router')];
}

function extraKeyFingerprint(hasKey: boolean, keyTouched: boolean, keyInput: string): string {
  return keyTouched ? `v:${keyInput}` : `s:${hasKey}`;
}

const NEVER_SAVED_LOCAL_FP = ' never-saved';

function localConnectionFingerprint(
  effectiveUrl: string,
  hasApiKey: boolean,
  apiKeyTouched: boolean,
  apiKeyValue: string
): string {
  return `${effectiveUrl}|${apiKeyTouched ? `v:${apiKeyValue}` : `s:${hasApiKey}`}`;
}

function nullIfEmpty(value: string): string | null {
  return value.trim() === '' ? null : value;
}

type DiscoveryFailureReason =
  'offline' | 'unsupported' | 'other' | 'auth' | 'server-error' | 'messages-endpoint';

type DiscoveryState =
  | { kind: 'idle' }
  | { kind: 'in-flight'; url: string; id: number }
  | { kind: 'ready'; url: string; models: DiscoveredModel[] }
  | { kind: 'failed'; url: string; reason: DiscoveryFailureReason; status?: number };

const HTTP_STATUS_ERR_PREFIX = 'LLM server returned HTTP ';

const AUTH_FAILURE_MESSAGE = 'Authentication failed — check the API key.';

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
            } @else if (oauthSignIn() === 'pending') {
              <span class="pill" data-testid="auth-status-value">checking sign-in…</span>
            } @else if (oauthSignIn() === 'saved_unverified') {
              <span class="pill" data-testid="auth-status-value">saved sign-in · not verified</span>
            } @else {
              <span class="pill amber" data-testid="auth-status-value">not configured</span>
            }
          </span>
        </button>

        @if (selectedTarget() === 'anthropic') {
          <div class="border-t border-[var(--line)] px-3 py-3">
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
              @if (anthropicSignInUsable()) {
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
              } @else if (oauthSignIn() !== 'pending') {
                <div class="mt-3">
                  <app-auth-terminal [project]="project" (done)="onOAuthDone($event)" />
                </div>
              }
            }

            <div class="mt-3">
              <p class="mono text-[11px] text-[var(--ink-mute)]">
                Choose the model in the chat window — use the model selector in the composer.
              </p>
            </div>
          </div>
        }
      </div>

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
              appTooltip="Test the connection to this server (models list + Messages API)"
              placement="top"
            >
              @if (discoveryState().kind === 'in-flight') {
                &#8635; testing connection...
              } @else {
                &#8635; test connection
              }
            </button>

            @let discovery = discoveryState();
            @if (discovery.kind === 'failed') {
              <p
                class="mono mt-1 text-[11px] text-[var(--amber)]"
                [attr.data-testid]="
                  discovery.reason === 'messages-endpoint'
                    ? 'settings-llm-messages-endpoint-warning'
                    : 'settings-llm-discovery-error'
                "
              >
                {{ discoveryFailureMessage() }} Fix the connection to save.
              </p>
            }
            @if (discovery.kind === 'in-flight') {
              <p
                class="mono mt-1 text-[11px] text-[var(--ink-mute)]"
                data-testid="settings-llm-discovering"
              >
                Probing {{ discovery.url }}...
              </p>
            }

            @if (discovery.kind === 'ready') {
              <p
                class="mono mt-3 text-[11px] text-[var(--ink-mute)]"
                data-testid="settings-llm-test-success"
              >
                Server OK · {{ discovery.models.length }} models · Messages API OK · new sessions
                start on {{ localStartModel(discovery.models) }} until you pick one in chat
              </p>
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
                {{ entry.discovering ? '↻ testing connection...' : '↻ test connection' }}
              </button>

              @if (entry.discoverError) {
                <p
                  class="mono mt-1 text-[11px] text-[var(--amber)]"
                  [attr.data-testid]="'settings-llm-extra-discovery-error-' + entry.id"
                >
                  {{ extraDiscoveryErrorMessage(entry) }} Fix the connection to save.
                </p>
              }

              @if (entry.lastTest?.passed) {
                <p
                  class="mono mt-3 text-[11px] text-[var(--ink-mute)]"
                  [attr.data-testid]="'settings-llm-extra-test-success-' + entry.id"
                >
                  Key OK · new sessions start on {{ extraStartModel(entry) }} until you pick one in
                  chat
                </p>
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

  apiKey = signal('');
  apiKeyTouched = signal(false);
  hasApiKey = signal(false);

  customHeaders = signal('');
  customHeadersTouched = signal(false);
  hasCustomHeaders = signal(false);

  readonly activeProject = input<string | null>(null);

  authMethod = signal<'oauth' | 'api_key'>('oauth');
  anthropicApiKeyInput = signal('');
  anthropicApiKeySaving = signal(false);
  anthropicApiKeySaved = signal(false);
  apiKeyConfigured = signal(false);
  oauthAuthenticated = signal(false);
  /** 'pending' until the first `get_auth_status` for the active project resolves. */
  oauthSignIn = signal<SignInDisplay>('pending');
  loggingOut = signal(false);

  private readonly oauthWatcher = inject(OauthCompletionWatcher);

  extraProviders = signal<ExtraProviderEdit[]>(fixedExtraRows());

  selectedTarget = signal<ProviderTarget>('anthropic');

  private loadedActiveKey = '';

  private loadedFormSnapshot = signal('');

  private initialConfigLoaded = false;
  private initialAuthStatusLoaded = false;

  legacyMigrationProvider = signal<string | null>(null);

  private loadedLocalContextTokens: number | null = null;

  discoveryState = signal<DiscoveryState>({ kind: 'idle' });

  private discoveryCounter = 0;

  private testedLocalConnection: { fp: string; passed: boolean } | null = null;

  private localTestInFlight: { fp: string; done: Promise<void> } | null = null;

  private loadedLocalConnectionFp: string = NEVER_SAVED_LOCAL_FP;

  protected openrouterDefaultModel = signal('');

  private lastKnownProvider: FlatProviderId = 'anthropic';

  private baseUrlByProvider: Partial<Record<FlatProviderId, string>> = {};

  private loadedLocalEntry: LlmProviderEntry | null = null;

  private loadedAnthropicModel: string | null = null;

  private defaultBaseUrlsByProvider: Partial<Record<FlatProviderId, string>> = {};

  readonly providerChange = output<FlatProviderId>();
  readonly errorOccurred = output<string>();

  private cdr = inject(ChangeDetectorRef);
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private readonly dirtyRegistry = inject(SettingsDirtyService);

  /** Reloads the Anthropic auth status whenever the active project changes. */
  constructor() {
    this.oauthWatcher.attach({
      activeProject: () => this.activeProject(),
      lastKnown: () => this.oauthSignIn(),
      shouldProbe: () => this.effectiveTarget() === 'anthropic',
      onLoginDetected: () => this.onOAuthDone(true),
      onVerdict: (project, status) => this.applyAuthStatusFor(project, status),
    });
    effect(() => {
      if (this.activeProject()) {
        this.oauthSignIn.set('pending');
        this.oauthAuthenticated.set(false);
        const isInitialLoad = !this.initialAuthStatusLoaded;
        void this.loadAuthStatus().then(() => {
          if (isInitialLoad) this.maybeSnapshotInitialLoad('authStatus');
        });
        this.oauthWatcher.startPoll();
      }
    });
    const unregister = this.dirtyRegistry.register({
      name: 'LLM provider',
      isDirty: computed(() => this.loadedFormSnapshot() !== '' && this.isDirty()),
      save: () => this.saveConfig(),
    });
    inject(DestroyRef).onDestroy(unregister);
  }

  private chatState = inject(ChatStateService);
  private log = inject(LoggerService);

  /** Loads the LLM configuration from the backend on init. */
  ngOnInit(): void {
    this.loadConfig();
    this.oauthWatcher.watchWindowFocus();
    void this.loadOpenrouterDefaultModel();
  }

  protected localStartModel(models: DiscoveredModel[]): string {
    return this.loadedLocalEntry?.model?.trim() || models[0].id;
  }

  protected extraStartModel(entry: ExtraProviderEdit): string {
    return entry.model.trim() || this.openrouterDefaultModel();
  }

  private async loadOpenrouterDefaultModel(): Promise<void> {
    try {
      const id = await this.tauri.invoke<string>('get_openrouter_default_model');
      this.openrouterDefaultModel.set(id);
      this.cdr.markForCheck();
    } catch {}
  }

  /** Tears down the external-login watcher (poll + focus listener). */
  ngOnDestroy(): void {
    this.oauthWatcher.destroy();
  }

  protected onBaseUrlInput(value: string): void {
    this.baseUrl.set(value);
    this.discoveryState.set({ kind: 'idle' });
    this.model.set('');
    this.testedLocalConnection = null;
  }

  protected onApiKeyInput(value: string): void {
    this.apiKey.set(value);
    this.apiKeyTouched.set(true);
    this.discoveryState.set({ kind: 'idle' });
    this.testedLocalConnection = null;
  }

  protected onCustomHeadersInput(value: string): void {
    this.customHeaders.set(value);
    this.customHeadersTouched.set(true);
  }

  private resolveContextTokensForSave(): number | null {
    return this.provider() === 'anthropic' ? null : this.loadedLocalContextTokens;
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
  }

  /**
   * Toggles the row's edit panel without changing the active provider.
   * @param entry - the remote provider row to toggle
   */
  toggleExtraExpanded(entry: ExtraProviderEdit): void {
    this.expandedExtraId = this.expandedExtraId === entry.id ? null : entry.id;
  }

  protected canDiscoverExtra(entry: ExtraProviderEdit): boolean {
    return entry.kind === 'open_router' && !!entry.keyInput.trim();
  }

  /**
   * Fetches the OpenRouter catalog (host-side, tool-capable models), sending the transient key so the catalog probe authenticates.
   * @param entry - the remote provider row to discover models for
   */
  async discoverExtraModels(entry: ExtraProviderEdit): Promise<void> {
    if (entry.kind !== 'open_router') {
      return;
    }
    if (entry.inFlight) {
      return entry.inFlight;
    }
    entry.inFlight = this.runExtraConnectionTest(entry).finally(() => {
      entry.inFlight = null;
    });
    return entry.inFlight;
  }

  private async runExtraConnectionTest(entry: ExtraProviderEdit): Promise<void> {
    const fp = extraKeyFingerprint(entry.hasKey, entry.keyTouched, entry.keyInput);
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
      if (row) {
        if (models.length > 0) {
          row.models = models;
          row.discoverError = null;
          row.lastTest = { fp, passed: true };
        } else {
          row.discoverError = { reason: 'other' };
          row.lastTest = { fp, passed: false };
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const row = this.extraProviders().find((p) => p.id === entry.id);
      if (row) {
        row.discoverError = classifyDiscoveryFailure(msg);
        row.lastTest = { fp, passed: false };
      }
      this.log.warn(`openrouter catalog discovery failed: ${msg}`);
    } finally {
      entry.discovering = false;
      this.extraProviders.set([...this.extraProviders()]);
      this.cdr.markForCheck();
    }
  }

  protected extraDiscoveryErrorMessage(entry: ExtraProviderEdit): string {
    const failure = entry.discoverError;
    if (!failure) return '';
    if (failure.reason === 'auth') return AUTH_FAILURE_MESSAGE;
    return failure.status
      ? `Model discovery failed — the server returned HTTP ${failure.status}.`
      : 'Model discovery failed — check the network connection and try again.';
  }

  /**
   * Key-field input handler for a remote provider row.
   * @param entry - the remote provider row being edited
   * @param value - the new API key input value
   */
  onExtraKeyInput(entry: ExtraProviderEdit, value: string): void {
    entry.keyInput = value;
    entry.keyTouched = true;
    entry.discoverError = null;
    entry.lastTest = null;
    this.extraProviders.set([...this.extraProviders()]);
  }

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
      case 'messages-endpoint':
        return `${label} at ${url} returned a model list but did not respond to POST /v1/messages (Anthropic Messages API).`;
    }
  }

  private readonly providerDisplayLabel = computed<string>(() =>
    this.provider() === 'local' ? 'Local LLM server' : 'Provider'
  );

  /** Provider-dropdown change. Resets baseUrl (per-provider default ports), re-probes against the new default, and bumps the counter to drop stale probes. */
  async onProviderChange(): Promise<void> {
    const provider = this.provider();
    if (provider === this.lastKnownProvider) {
      return;
    }
    const previousProvider = this.lastKnownProvider;
    const previousBaseUrl = this.baseUrl();
    if (previousProvider !== 'anthropic' && previousBaseUrl) {
      this.baseUrlByProvider[previousProvider] = previousBaseUrl;
    }
    this.snapshotAnthropicModel(previousProvider);
    this.lastKnownProvider = provider;
    this.discoveryCounter++;
    this.model.set(
      provider === 'anthropic'
        ? (this.loadedAnthropicModel ?? '')
        : (this.loadedLocalEntry?.model ?? '')
    );
    this.discoveryState.set({ kind: 'idle' });
    this.providerChange.emit(provider);
    this.cdr.markForCheck();
    if (provider !== 'anthropic' && !this.defaultBaseUrlsByProvider[provider]) {
      try {
        const freshDefault = await this.tauri.invoke<string | null>('get_default_base_url', {
          provider,
        });
        if (freshDefault) {
          this.defaultBaseUrlsByProvider[provider] = freshDefault;
        }
      } catch {}
    }
    const defaultBaseUrl = this.defaultBaseUrlsByProvider[provider] ?? '';
    this.defaultBaseUrl.set(defaultBaseUrl);
    const cached = this.baseUrlByProvider[provider];
    this.baseUrl.set(provider === 'anthropic' ? '' : cached || defaultBaseUrl);
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

    const current = this.discoveryState();
    if (!isRefresh && current.kind === 'in-flight' && current.url === effectiveUrl) {
      return;
    }

    const id = ++this.discoveryCounter;
    this.discoveryState.set({ kind: 'in-flight', url: effectiveUrl, id });
    const fp = localConnectionFingerprint(
      effectiveUrl,
      this.hasApiKey(),
      this.apiKeyTouched(),
      this.apiKey()
    );
    let settle = (): void => undefined;
    const done = new Promise<void>((resolve) => (settle = resolve));
    this.localTestInFlight = { fp, done };

    try {
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
      const messagesOk = result.messages_endpoint_ok ?? null;
      const passed = messagesOk !== false;
      const live = this.discoveryState();
      if (live.kind !== 'in-flight' || live.id !== id) return;
      this.testedLocalConnection = { fp, passed };
      if (!passed) {
        this.discoveryState.set({ kind: 'failed', url: effectiveUrl, reason: 'messages-endpoint' });
        return;
      }
      this.discoveryState.set({ kind: 'ready', url: effectiveUrl, models: result.models });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const { reason, status } = classifyDiscoveryFailure(msg);
      const live = this.discoveryState();
      if (live.kind !== 'in-flight' || live.id !== id) return;
      this.testedLocalConnection = { fp, passed: false };
      this.discoveryState.set({ kind: 'failed', url: effectiveUrl, reason, status });
    } finally {
      if (this.localTestInFlight?.done === done) this.localTestInFlight = null;
      settle();
    }
  }

  readonly baseUrlByProviderView = computed<string>(
    () => this.baseUrl() || this.baseUrlByProvider['local'] || ''
  );

  /** Loads the current Anthropic authentication status from the backend. */
  async loadAuthStatus(): Promise<void> {
    const project = this.activeProject();
    if (!project) return;
    try {
      const status = await this.tauri.invoke<AuthStatusResponse>('get_auth_status', { project });
      this.applyAuthStatusFor(project, status);
    } catch (e) {
      if (this.activeProject() === project && this.oauthSignIn() === 'pending') {
        this.oauthSignIn.set('none');
        this.log.debug(
          `loadAuthStatus: get_auth_status failed for ${project}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    this.cdr.markForCheck();
  }

  /**
   * Applies a loaded/probed auth status to the tile, dropping it when `project`
   * is no longer the active one (a late response for a project the user left).
   * @param project - the project this status was fetched for
   * @param status - the backend auth-status payload
   */
  private applyAuthStatusFor(project: string, status: AuthStatusResponse): void {
    if (this.activeProject() !== project) return;
    this.apiKeyConfigured.set(status.api_key_configured);
    this.oauthAuthenticated.set(status.oauth_authenticated);
    this.oauthSignIn.set(
      status.oauth_sign_in ?? (status.oauth_authenticated ? 'verified' : 'none')
    );
    this.projectState.applyAuthStatus(status);
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

  private oauthDoneInFlight = false;

  /**
   * Auto-selects + saves Anthropic on OAuth success, unconditionally: the prior active provider may still be routing live, so saveConfig must run even if the card was already showing Anthropic.
   * Single-flight: concurrent callers (poll tick, focus probe, terminal emit racing together) return immediately instead of each reloading status and saving again.
   * @param _success - unused; the handler re-checks auth status instead of trusting the caller's flag
   */
  async onOAuthDone(_success: boolean): Promise<void> {
    if (this.oauthDoneInFlight) return;
    this.oauthDoneInFlight = true;
    try {
      await this.loadAuthStatus();
      if (this.oauthAuthenticated()) {
        this.selectedTarget.set('anthropic');
        this.provider.set('anthropic');
        await this.saveConfig(true);
      }
    } finally {
      this.oauthDoneInFlight = false;
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
      this.projectState.forceUnconfigured();
      await this.loadAuthStatus();
      this.oauthWatcher.startPoll();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.error(`anthropic_logout failed: ${msg}`);
    } finally {
      this.loggingOut.set(false);
      this.cdr.markForCheck();
    }
  }

  private buildProviderSet(anthropicHasApiKey: boolean): LlmProviderEntry[] {
    const target = this.effectiveTarget();
    const providers: LlmProviderEntry[] = [
      {
        id: 'anthropic',
        kind: anthropicHasApiKey ? 'anthropic_api_key' : 'anthropic_oauth',
        model: null,
        has_api_key: anthropicHasApiKey,
      },
    ];
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
          model: this.loadedLocalEntry?.model || null,
          has_api_key: this.hasApiKey() || (this.apiKeyTouched() && this.apiKey().trim() !== ''),
          has_custom_headers:
            this.hasCustomHeaders() ||
            (this.customHeadersTouched() && this.customHeaders().trim() !== ''),
          context_tokens: this.resolveContextTokensForSave(),
        });
      }
    }
    for (const extra of this.extraProviders()) {
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

  private readonly effectiveTarget = computed<ProviderTarget>(() => {
    const selectedTarget = this.selectedTarget();
    if (this.extraProviders().some((p) => p.id === selectedTarget)) {
      return selectedTarget;
    }
    return this.provider() === 'anthropic' ? 'anthropic' : 'local';
  });

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
      this.oauthSignIn(),
      this.baseUrl(),
      this.apiKeyTouched(),
      this.customHeadersTouched(),
      extras,
    ].join('|');
  }

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

  protected readonly isDirty = computed<boolean>(
    () => this.computeFormSnapshot() !== this.loadedFormSnapshot()
  );

  /** A verified or saved sign-in lets the card be selected/saved; readiness re-verifies at start. */
  protected readonly anthropicSignInUsable = computed(
    () => this.oauthAuthenticated() || this.oauthSignIn() === 'saved_unverified'
  );

  /** Save is allowed only when the active non-anthropic provider has a model AND the user has actually changed something since load/last save. */
  protected readonly canSave = computed<boolean>(() => {
    if (!this.isDirty()) return false;
    const target = this.effectiveTarget();
    if (target === 'anthropic') return this.anthropicSignInUsable() || this.apiKeyConfigured();
    const extra = this.extraProviders().find((p) => p.id === target);
    if (extra) return !!extra.model.trim() || extra.hasKey || !!extra.keyInput.trim();
    return this.localModelSatisfied();
  });

  private localModelSatisfied(): boolean {
    return (
      !!this.model().trim() ||
      !!this.loadedLocalEntry?.model ||
      !!(this.baseUrl() || this.defaultBaseUrl())
    );
  }

  private findExtraRow(id: string, kind?: LlmProviderKind): ExtraProviderEdit | undefined {
    const rows = this.extraProviders();
    return rows.find((r) => r.id === id) ?? (kind ? rows.find((r) => r.kind === kind) : undefined);
  }

  private isForeignModel(model: string): boolean {
    return model.includes('/');
  }

  private snapshotAnthropicModel(fromTarget: string = this.effectiveTarget()): void {
    const model = this.model();
    if (fromTarget === 'anthropic' && model && !this.isForeignModel(model)) {
      this.loadedAnthropicModel = model;
    }
  }

  private narrowFlatProvider(raw: string, kind?: LlmProviderKind): ProviderTarget {
    if (raw === 'anthropic' || raw === 'local') return raw;
    return this.findExtraRow(raw, kind)?.id ?? 'local';
  }

  protected readonly inputValue = eventValue;

  private buildActive(): LlmActive {
    const target = this.effectiveTarget();
    const extra = this.extraProviders().find((p) => p.id === target);
    if (extra) {
      return { provider_id: extra.id, model: extra.model || null };
    }
    if (target === 'anthropic') {
      return { provider_id: target, model: null };
    }
    return {
      provider_id: target,
      model: this.model() || null,
    };
  }

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

  private needsConnectionProbe(
    fp: string,
    savedFp: string,
    lastTest: { fp: string; passed: boolean } | null
  ): boolean {
    if (lastTest && lastTest.fp === fp) return !lastTest.passed;
    return fp !== savedFp;
  }

  private saveInFlight: Promise<void> | null = null;

  /**
   * Single-flight wrapper: a save already in flight is returned as-is, never started twice.
   * A concurrent call while one is in flight ignores its own `forceRestart` and rides the
   * in-flight save's — acceptable because the UI disables Save while saving, so only the
   * guard (always default `forceRestart`) can race a user-initiated save.
   * @param forceRestart - forces a full restart even if `active` is unchanged, so a running container can't stay routed to a stale provider
   */
  async saveConfig(forceRestart = false): Promise<void> {
    if (this.saveInFlight) return this.saveInFlight;
    this.saveInFlight = this.doSaveConfig(forceRestart).finally(() => {
      this.saveInFlight = null;
    });
    return this.saveInFlight;
  }

  private async doSaveConfig(forceRestart = false): Promise<void> {
    const provider = this.provider();
    const localIsActive = this.effectiveTarget() === 'local';
    if (provider !== 'anthropic' && !this.localModelSatisfied() && localIsActive) {
      this.errorOccurred.emit('A model name is required for local providers');
      return;
    }
    const activeExtra = this.extraProviders().find((p) => p.id === this.effectiveTarget());
    if (
      activeExtra &&
      !activeExtra.model.trim() &&
      !activeExtra.hasKey &&
      !activeExtra.keyInput.trim()
    ) {
      this.errorOccurred.emit(`Provider '${activeExtra.id}' requires an API key`);
      return;
    }
    this.saving.set(true);
    this.saved.set(false);
    this.cdr.markForCheck();

    if (localIsActive) {
      const fp = localConnectionFingerprint(
        this.baseUrl() || this.defaultBaseUrl(),
        this.hasApiKey(),
        this.apiKeyTouched(),
        this.apiKey()
      );
      if (this.needsConnectionProbe(fp, this.loadedLocalConnectionFp, this.testedLocalConnection)) {
        if (this.localTestInFlight?.fp === fp) await this.localTestInFlight.done;
        else await this.discoverModels(true);
        if (this.discoveryState().kind !== 'ready') {
          this.saving.set(false);
          this.cdr.markForCheck();
          return;
        }
      }
    } else if (activeExtra) {
      const fp = extraKeyFingerprint(
        activeExtra.hasKey,
        activeExtra.keyTouched,
        activeExtra.keyInput
      );
      if (this.needsConnectionProbe(fp, activeExtra.savedFp, activeExtra.lastTest)) {
        await this.discoverExtraModels(activeExtra);
        if (activeExtra.lastTest?.fp !== fp) await this.discoverExtraModels(activeExtra);
        if (!(activeExtra.lastTest?.fp === fp && activeExtra.lastTest.passed)) {
          this.saving.set(false);
          this.cdr.markForCheck();
          return;
        }
      }
    }

    try {
      const active = this.buildActive();
      const effectiveBaseUrl =
        active.provider_id === 'local' ? this.baseUrl() || this.defaultBaseUrl() || null : null;
      const project = this.activeProject();
      const anthropicHasApiKey = this.apiKeyConfigured();
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
      const touchedExtras = this.extraProviders().filter((e) => e.keyTouched);
      for (const extra of touchedExtras) {
        await this.tauri.invoke('set_llm_provider_key', {
          providerId: extra.id,
          key: nullIfEmpty(extra.keyInput),
        });
      }
      await this.tauri.invoke('update_llm_config', { update });

      const savedLocal = update.providers.find((p) => p.id === 'local');
      this.loadedLocalEntry = savedLocal ? { ...savedLocal } : null;
      for (const extra of touchedExtras) {
        extra.hasKey = extra.keyInput.trim() !== '';
        extra.keyInput = '';
        extra.keyTouched = false;
        extra.savedFp = extraKeyFingerprint(extra.hasKey, false, '');
      }
      this.extraProviders.set([...this.extraProviders()]);
      this.saved.set(true);
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
      if (localIsActive) {
        this.loadedLocalConnectionFp = localConnectionFingerprint(
          this.loadedLocalEntry?.base_url ?? '',
          !!this.loadedLocalEntry?.has_api_key,
          false,
          ''
        );
      }
      void this.chatState.refreshLlmConfigCache();
      this.providerChange.emit(provider);
      const activeKey = this.computeActiveKey(active.provider_id, active.model, update.providers);
      const stackReady = this.projectState.status() === 'ready';
      if (!forceRestart && activeKey === this.loadedActiveKey && project && stackReady) {
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
    this.testedLocalConnection = null;
    try {
      const config = await this.tauri.invoke<LlmConfigResponse>('get_llm_config');
      const persistedProvider = config.provider || 'anthropic';
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
      this.loadedLocalContextTokens =
        provider !== 'anthropic' ? (config.context_tokens ?? null) : null;
      this.hasApiKey.set(!!config.has_api_key);
      this.hasCustomHeaders.set(!!config.has_custom_headers);
      this.lastKnownProvider = provider;
      if (provider !== 'anthropic' && defaultBaseUrl) {
        this.defaultBaseUrlsByProvider[provider] = defaultBaseUrl;
      }
      if (provider !== 'anthropic' && baseUrl) {
        this.baseUrlByProvider[provider] = baseUrl;
      }

      this.loadedLocalEntry = (config.providers ?? []).find((p) => p.id === 'local') ?? null;
      if (this.loadedLocalEntry?.base_url && !this.baseUrlByProvider['local']) {
        this.baseUrlByProvider['local'] = this.loadedLocalEntry.base_url;
      }
      this.loadedLocalConnectionFp = this.loadedLocalEntry
        ? localConnectionFingerprint(
            this.loadedLocalEntry.base_url ?? '',
            !!this.loadedLocalEntry.has_api_key,
            false,
            ''
          )
        : NEVER_SAVED_LOCAL_FP;
      const anthropicEntry = (config.providers ?? []).find((p) => p.id === 'anthropic');
      const candidate =
        anthropicEntry?.model ??
        (config.active?.provider_id === 'anthropic' ? config.active?.model : null) ??
        (provider === 'anthropic' ? this.model() || null : null);
      this.loadedAnthropicModel = candidate && !this.isForeignModel(candidate) ? candidate : null;
      if (provider === 'anthropic') {
        this.model.set(this.loadedAnthropicModel ?? '');
      }
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
          row.savedFp = extraKeyFingerprint(row.hasKey, false, '');
          row.lastTest = null;
        }
      }
      const activeId = config.active?.provider_id;
      const activeEntry = (config.providers ?? []).find((p) => p.id === activeId);
      const activeRow = activeId ? this.findExtraRow(activeId, activeEntry?.kind) : undefined;
      if (activeRow) {
        this.selectedTarget.set(activeRow.id);
        this.expandedExtraId = activeRow.id;
        activeRow.model = activeRow.model || config.active?.model || '';
        if (activeRow.kind === 'open_router') {
          void this.discoverExtraModels(activeRow);
        }
      } else {
        this.selectedTarget.set(provider === 'anthropic' ? 'anthropic' : 'local');
      }
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
      if (!msg.toLowerCase().includes('tauri') && !msg.toLowerCase().includes('invoke')) {
        this.log.error(`loadConfig: unexpected error loading LLM config: ${msg}`);
      }
    }
    this.maybeSnapshotInitialLoad('config');
    this.cdr.markForCheck();
  }
}
