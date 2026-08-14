import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LlmProviderComponent } from './llm-provider.component';
import { OauthCompletionWatcher } from './oauth-completion-watcher';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService, type AuthStatusResponse } from '../../services/project-state.service';
import { AnthropicModelsService } from '../../services/anthropic-models.service';
import { ChatStateService } from '../../services/chat-state.service';
import { LoggerService } from '../../services/logger.service';
import { type LlmProviderEntry } from '../../models/llm';
import { MockTauriService } from '../../testing/mock-tauri.service';

function makeMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  ollama: 'http://host.docker.internal:11434',
  lmstudio: 'http://host.docker.internal:1234',
  llamacpp: 'http://host.docker.internal:8080',
};

/**
 * Drains pending non-Zone microtasks.
 * @param cycles - how many `await Promise.resolve()` ticks to drain
 */
async function flushMicrotasks(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    await Promise.resolve();
  }
}

/** Stable test fixture mirroring `speedwave_runtime::defaults::AnthropicModelInfo`; keep `context_tokens` in sync with `crates/speedwave-runtime/src/defaults.rs`. */
const TEST_ANTHROPIC_MODELS = [
  {
    id: 'claude-fable-5',
    family: 'Fable 5',
    context_tokens: 200_000,
    latest: true,
    premium: true,
    selectable: true,
  },
  {
    id: 'claude-opus-4-8',
    family: 'Opus 4.8',
    context_tokens: 1_000_000,
    latest: true,
    premium: true,
    selectable: true,
  },
  {
    id: 'claude-sonnet-4-6',
    family: 'Sonnet 4.6',
    context_tokens: 1_000_000,
    latest: true,
    premium: false,
    selectable: true,
  },
  {
    id: 'claude-haiku-4-5',
    family: 'Haiku 4.5',
    context_tokens: 200_000,
    latest: true,
    premium: false,
    selectable: true,
  },
  {
    id: 'claude-opus-4-7',
    family: 'Opus 4.7',
    context_tokens: 1_000_000,
    latest: false,
    premium: true,
    selectable: false,
  },
  {
    id: 'claude-opus-4-6',
    family: 'Opus 4.6',
    context_tokens: 1_000_000,
    latest: false,
    premium: true,
    selectable: false,
  },
];

function setupMockTauri(mockTauri: MockTauriService, provider = 'anthropic'): void {
  mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case 'get_llm_config':
        return {
          provider,
          model: null,
          base_url: null,
          default_base_url: DEFAULT_BASE_URLS[provider] ?? null,
        };
      case 'get_default_base_url':
        return DEFAULT_BASE_URLS[(args?.['provider'] as string) ?? ''] ?? null;
      case 'list_anthropic_models':
        return TEST_ANTHROPIC_MODELS;
      case 'update_llm_config':
        return undefined;
      case 'discover_llm_models':
        // Default: empty list so the component falls back to text input.
        // Individual tests override this.
        throw new Error('offline');
      default:
        return undefined;
    }
  };
}

describe('LlmProviderComponent', () => {
  let component: LlmProviderComponent;
  let fixture: ComponentFixture<LlmProviderComponent>;
  let mockTauri: MockTauriService;
  let mockLogger: ReturnType<typeof makeMockLogger>;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    mockLogger = makeMockLogger();
    setupMockTauri(mockTauri);

    await TestBed.configureTestingModule({
      imports: [LlmProviderComponent],
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: mockLogger },
      ],
    }).compileComponents();

    // AnthropicModelsService is providedIn root and caches the catalog
    // across tests — reset so each spec sees its own mock response.
    TestBed.inject(AnthropicModelsService).resetForTesting();

    fixture = TestBed.createComponent(LlmProviderComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    // Runs ngOnDestroy so the OAuth completion setInterval is cleared — without
    // this each test that sets activeProject leaks a 1500ms timer into later tests.
    fixture?.destroy();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('has correct default values', () => {
    expect(component.provider()).toBe('anthropic');
    expect(component.model()).toBe('');
    expect(component.baseUrl()).toBe('');
    expect(component.saving()).toBe(false);
    expect(component.saved()).toBe(false);
  });

  it('loads config on init (legacy `ollama` auto-migrates to `local` with banner)', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_llm_config':
          return {
            provider: 'ollama',
            model: 'llama3.3',
            base_url: 'http://localhost:11434',
            default_base_url: 'http://host.docker.internal:11434',
          };
        default:
          return undefined;
      }
    };

    component.ngOnInit();
    await fixture.whenStable();

    // Legacy provider name auto-migrated to `local` for the UI; the
    // legacyMigrationProvider flag drives the migration banner.
    expect(component.provider()).toBe('local');
    expect(component.legacyMigrationProvider()).toBe('ollama');
    expect(component.provider()).not.toBe('ollama');
    expect(component.model()).toBe('llama3.3');
    expect(component.baseUrl()).toBe('http://localhost:11434');
    expect(component.defaultBaseUrl()).toBe('http://host.docker.internal:11434');
  });

  it('emits providerChange on load', async () => {
    const spy = vi.fn();
    component.providerChange.subscribe(spy);

    component.ngOnInit();
    await fixture.whenStable();

    expect(spy).toHaveBeenCalledWith('anthropic');
  });

  it('logs a real backend error during loadConfig via the logger', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_llm_config') throw new Error('backend serialization broke');
      return undefined;
    };

    component.ngOnInit();
    await flushMicrotasks();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('backend serialization broke')
    );
  });

  it('stays silent during loadConfig in browser dev mode (not-in-tauri error)', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_llm_config') throw new Error('window.__TAURI__ invoke unavailable');
      return undefined;
    };

    component.ngOnInit();
    await flushMicrotasks();

    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('a loadConfig error still settles the initial-load join (no permanently-dirty Save)', async () => {
    // If get_llm_config throws while get_auth_status succeeds, the join must
    // still close — else isDirty() is stuck true and Save never disables.
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_llm_config') throw new Error('backend unavailable');
      if (cmd === 'get_auth_status')
        return {
          api_key_configured: false,
          oauth_authenticated: true,
          needs_anthropic_auth: true,
          provider_configured: true,
        };
      return undefined;
    };
    fixture.componentRef.setInput('activeProject', 'proj');
    component.ngOnInit();
    await flushMicrotasks();
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(true);
  });

  it('emits providerChange when provider selection changes', async () => {
    const spy = vi.fn();
    component.providerChange.subscribe(spy);

    component.provider.set('ollama');
    await component.onProviderChange();

    expect(spy).toHaveBeenCalledWith('ollama');
  });

  it('saves config and sets saved flag', async () => {
    component.provider.set('ollama');
    component.model.set('llama3.3');
    component.baseUrl.set('http://localhost:11434');

    let invokedArgs: Record<string, unknown> = {};
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'update_llm_config') {
        invokedArgs = args ?? {};
        return undefined;
      }
      return undefined;
    };

    await component.saveConfig();

    const update = invokedArgs['update'] as Record<string, unknown>;
    expect(update['provider']).toBe('ollama');
    expect(update['model']).toBe('llama3.3');
    expect(update['base_url']).toBe('http://localhost:11434');
    expect(component.saved()).toBe(true);
    expect(component.saving()).toBe(false);
  });

  it('emits error on save failure', async () => {
    const errorSpy = vi.fn();
    component.errorOccurred.subscribe(errorSpy);

    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'update_llm_config') {
        throw new Error('save failed');
      }
      return undefined;
    };

    await component.saveConfig();

    expect(errorSpy).toHaveBeenCalledWith('save failed');
    expect(component.saving()).toBe(false);
    expect(component.saved()).toBe(false);
  });

  it('emits providerChange on successful save', async () => {
    const spy = vi.fn();
    component.providerChange.subscribe(spy);
    component.provider.set('ollama');
    component.model.set('llama3.3');

    await component.saveConfig();

    expect(spy).toHaveBeenCalledWith('ollama');
  });

  it('requests container restart on successful save', async () => {
    const projectState = TestBed.inject(ProjectStateService);
    projectState.needsRestart = false;
    projectState.status.set('ready'); // save on an already-running project
    component.provider.set('ollama');
    component.model.set('llama3.3');

    await component.saveConfig();

    expect(projectState.needsRestart).toBe(true);
  });

  it('does not request restart when save fails', async () => {
    const projectState = TestBed.inject(ProjectStateService);
    projectState.needsRestart = false;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'update_llm_config') {
        throw new Error('save failed');
      }
      return undefined;
    };

    await component.saveConfig();

    expect(projectState.needsRestart).toBe(false);
  });

  it('starts containers (not just restart) when the project had no provider', async () => {
    const projectState = TestBed.inject(ProjectStateService);
    projectState.status.set('no_provider');
    projectState.needsRestart = false;
    const ensureSpy = vi.spyOn(projectState, 'ensureContainersRunning').mockResolvedValue();
    component.provider.set('ollama');
    component.model.set('llama3.3');

    await component.saveConfig();

    // First provider on a fresh project: start containers, don't just flag a restart.
    expect(ensureSpy).toHaveBeenCalled();
    expect(projectState.needsRestart).toBe(false);
  });

  it('sends null for empty optional fields', async () => {
    let invokedArgs: Record<string, unknown> = {};
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'update_llm_config') {
        invokedArgs = args ?? {};
        return undefined;
      }
      return undefined;
    };

    component.provider.set('anthropic');
    component.model.set('');
    component.baseUrl.set('');

    await component.saveConfig();

    const update = invokedArgs['update'] as Record<string, unknown>;
    expect(update['model']).toBeNull();
    expect(update['base_url']).toBeNull();
    expect(update['apiKeyEnv']).toBeUndefined();
  });

  it('hot-reloads the proxy with the input-signal project, not projectState', async () => {
    // T10 regression: saveConfig reads the active project from the activeProject() input, not ProjectStateService.
    fixture.componentRef.setInput('activeProject', 'proj-from-input');
    const projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject.set('wrong-project');
    projectState.status.set('ready'); // hot-reload requires a live stack

    let restartProject: unknown = null;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'restart_llm_proxy') {
        restartProject = args?.['project'];
        return undefined;
      }
      return undefined;
    };

    component.provider.set('anthropic');
    component.model.set('');
    // Make the active selection unchanged so the hot-reload branch fires —
    // derive the key the same way saveConfig will (R6: kind/headers-aware).
    component['loadedActiveKey'] = component['computeActiveKey'](
      'anthropic',
      null,
      component['buildProviderSet'](false)
    );

    await component.saveConfig();

    expect(restartProject).toBe('proj-from-input');
    expect(projectState.needsRestart).toBe(false);
  });

  it('writes provider keys before the config and aborts the config on key failure', async () => {
    // T11 regression: a per-provider key write must precede update_llm_config.
    const errorSpy = vi.fn();
    component.errorOccurred.subscribe(errorSpy);

    const calls: string[] = [];
    mockTauri.invokeHandler = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'set_llm_provider_key') {
        throw new Error('key write failed');
      }
      return undefined;
    };

    // Configure the openrouter row with a touched key so the loop runs.
    const row = component.extraProviders().find((r) => r.id === 'openrouter');
    expect(row).toBeDefined();
    row!.keyInput = 'sk-or-test';
    row!.keyTouched = true;

    await component.saveConfig();

    expect(calls).toContain('set_llm_provider_key');
    expect(calls).not.toContain('update_llm_config');
    expect(errorSpy).toHaveBeenCalledWith('key write failed');
    expect(component.saved()).toBe(false);
    // The failed key stays editable (not optimistically cleared).
    expect(row!.keyTouched).toBe(true);
    expect(row!.keyInput).toBe('sk-or-test');
  });

  describe('resolveContextTokensForSave (via saveConfig payload)', () => {
    async function captureUpdate(): Promise<Record<string, unknown>> {
      let captured: Record<string, unknown> = {};
      const prevHandler = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'update_llm_config') {
          captured = (args?.['update'] as Record<string, unknown>) ?? {};
          return undefined;
        }
        return prevHandler(cmd, args);
      };
      await component.saveConfig();
      return captured;
    }

    it('sends null context_tokens for anthropic (no model control writes it)', async () => {
      component.provider.set('anthropic');
      const update = await captureUpdate();
      expect(update['context_tokens']).toBeNull();
    });

    it('sends the loadedLocalContextTokens value for local providers', async () => {
      // Simulates a saved context window from get_llm_config: saving without clicking
      // "Refresh models" must not wipe the persisted value.
      const cmp = component as unknown as {
        loadedLocalContextTokens: number | null;
        loadedLocalEntry: LlmProviderEntry | null;
      };
      cmp.loadedLocalContextTokens = 16_384;
      cmp.loadedLocalEntry = {
        id: 'local',
        kind: 'local',
        base_url: 'http://localhost:11434',
        model: 'llama3.3',
        has_api_key: false,
        context_tokens: 16_384,
        has_custom_headers: false,
      };
      component.provider.set('ollama');
      component.baseUrl.set('http://localhost:11434');
      const update = await captureUpdate();
      expect(update['context_tokens']).toBe(16_384);
    });

    it('sends null context_tokens for local when nothing was loaded', async () => {
      const cmp = component as unknown as { loadedLocalEntry: LlmProviderEntry | null };
      // A stored model (without a stored context window) still satisfies the
      // save-time model-required guard, so the update actually goes through.
      cmp.loadedLocalEntry = {
        id: 'local',
        kind: 'local',
        base_url: 'http://localhost:11434',
        model: 'llama3.3',
        has_api_key: false,
        context_tokens: null,
        has_custom_headers: false,
      };
      component.provider.set('ollama');
      component.baseUrl.set('http://localhost:11434');
      const update = await captureUpdate();
      expect(update['context_tokens']).toBeNull();
    });
  });

  it('refreshes ChatStateService cache after a successful save', async () => {
    // Without this, the chat footer keeps showing the previous model's
    // context window until the next session starts.
    const chatState = TestBed.inject(ChatStateService);
    const refreshSpy = vi.spyOn(chatState, 'refreshLlmConfigCache').mockResolvedValue();
    component.provider.set('ollama');
    component.model.set('llama3.3');
    component.baseUrl.set('http://localhost:11434');
    await component.saveConfig();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('does not refresh ChatStateService cache when save fails', async () => {
    const chatState = TestBed.inject(ChatStateService);
    const refreshSpy = vi.spyOn(chatState, 'refreshLlmConfigCache').mockResolvedValue();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'update_llm_config') throw new Error('save failed');
      return undefined;
    };
    component.provider.set('ollama');
    component.model.set('llama3.3');
    await component.saveConfig();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('renders two provider cards (anthropic + local) in a radiogroup', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();

    const cards = fixture.nativeElement.querySelectorAll('[data-testid^="settings-llm-provider-"]');
    expect(cards.length).toBe(2);
    const ids = Array.from(cards).map((c) =>
      (c as HTMLElement).getAttribute('data-testid')?.replace('settings-llm-provider-', '')
    );
    expect(ids).toEqual(['anthropic', 'local']);
  });

  it('marks the active provider card with aria-checked=true', async () => {
    component.provider.set('anthropic');
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const anthropicCard = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-provider-anthropic"]'
    );
    const localCard = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-provider-local"]'
    );
    expect(anthropicCard.getAttribute('aria-checked')).toBe('true');
    expect(localCard.getAttribute('aria-checked')).toBe('false');
  });

  it('renders no model selector for the anthropic provider (no base_url field either)', async () => {
    component.provider.set('anthropic');
    component.selectedTarget.set('anthropic');
    component.ngOnInit();
    await fixture.whenStable();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    // The unified-list redesign (ADR-073) drops the read-only base_url field for anthropic.
    const baseUrlInput = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-base-url"]'
    );
    expect(baseUrlInput).toBeNull();

    const modelEl = fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]');
    expect(modelEl).toBeNull();
  });

  it('never sends a model for the anthropic provider on save', async () => {
    component.selectedTarget.set('anthropic');
    component.provider.set('anthropic');
    component.apiKeyConfigured.set(true);
    let captured: Record<string, unknown> | null = null;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'update_llm_config') captured = args?.['update'] as Record<string, unknown>;
      return undefined;
    };
    fixture.detectChanges();
    await component.saveConfig();

    expect(captured).not.toBeNull();
    const update = captured!;
    expect(update['model']).toBeNull();
    const providers = update['providers'] as Array<Record<string, unknown>>;
    const anthropicEntry = providers.find((p) => p['id'] === 'anthropic');
    expect(anthropicEntry?.['model']).toBeNull();
  });

  it('openrouter_discover_disabled_without_key', () => {
    // Discover button is disabled when the API key is empty (gate).
    const row = component.extraProviders().find((p) => p.id === 'openrouter');
    expect(row).toBeTruthy();
    component.selectExtraProvider(row!);
    component.onExtraKeyInput(row!, '');
    fixture.detectChanges();
    const sel = '[data-testid="settings-llm-extra-refresh-openrouter"]';
    expect(fixture.nativeElement.querySelector(sel).disabled).toBe(true);
  });

  it('openrouter_discover_enabled_with_key', () => {
    // Key present at first render → button enabled (no OnPush mutation timing).
    const row = component.extraProviders().find((p) => p.id === 'openrouter');
    component.selectExtraProvider(row!);
    component.onExtraKeyInput(row!, 'sk-or-x');
    fixture.detectChanges();
    const sel = '[data-testid="settings-llm-extra-refresh-openrouter"]';
    expect(fixture.nativeElement.querySelector(sel).disabled).toBe(false);
  });

  it('disables_save_for_local_without_model', () => {
    component.provider.set('local');
    component.selectedTarget.set('local');
    component.model.set('');
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(true);
  });

  it('enables_save_for_local_with_model', () => {
    component.provider.set('local');
    component.selectedTarget.set('local');
    component.model.set('gemma');
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(false);
  });

  it('switching cards back and forth and entering a URL enables Save (server auto-defaults the model)', async () => {
    // Real-world flow on a fresh project: load, switch card, type URL. No
    // model control exists anymore (Task 18) — the backend auto-selects a
    // model from discovery at save time (Task 11), so a base_url is enough.
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_llm_config':
          return { provider: 'anthropic', model: null, base_url: null, default_base_url: null };
        case 'get_auth_status':
          return {
            api_key_configured: false,
            oauth_authenticated: false,
            needs_anthropic_auth: false,
            provider_configured: false,
          };
        case 'get_default_base_url':
          return null;
        case 'discover_llm_models':
          return { models: [{ id: 'unsloth/Qwen3.6-35B-A3B' }], messages_endpoint_ok: true };
        default:
          return undefined;
      }
    };
    fixture.componentRef.setInput('activeProject', 'proj');
    component.ngOnInit();
    await flushMicrotasks();

    component.provider.set('local');
    await component.onProviderChange();
    component.provider.set('anthropic');
    await component.onProviderChange();
    component.provider.set('local');
    await component.onProviderChange();
    component.baseUrl.set('http://10.155.3.101:4000');
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(false);
  });

  it('enables_save_for_authenticated_anthropic_without_model', () => {
    // Anthropic needs no model, but DOES need credentials (oauth or api key);
    // oauthAuthenticated flipping true from its default false is itself a change.
    component.provider.set('anthropic');
    component.selectedTarget.set('anthropic');
    component.model.set('');
    component.oauthAuthenticated.set(true);
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(false);
  });

  it('no_op_load_keeps_save_disabled_for_already_connected_anthropic', async () => {
    // Bug repro: a freshly-loaded, already-connected Anthropic card must not
    // show an enabled Save button until the user actually changes something.
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_llm_config':
          return {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            base_url: null,
            default_base_url: null,
            providers: [{ id: 'anthropic', kind: 'anthropic_oauth', model: 'claude-sonnet-4-6' }],
            active: { provider_id: 'anthropic', model: 'claude-sonnet-4-6' },
          };
        case 'get_auth_status':
          return { api_key_configured: false, oauth_authenticated: true };
        case 'list_anthropic_models':
          return TEST_ANTHROPIC_MODELS;
        default:
          return undefined;
      }
    };

    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(true);
  });

  it('no_op_load_keeps_save_disabled_when_auth_status_resolves_after_config_with_active_project', async () => {
    // Real-world race: the constructor effect's loadAuthStatus() runs concurrently with
    // ngOnInit's loadConfig(); get_auth_status resolving after get_llm_config must not make isDirty() true with zero user edits.
    let resolveAuthStatus: ((value: AuthStatusResponse) => void) | undefined;
    const authStatusPromise = new Promise<AuthStatusResponse>((resolve) => {
      resolveAuthStatus = resolve;
    });
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_llm_config':
          return {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            base_url: null,
            default_base_url: null,
            providers: [{ id: 'anthropic', kind: 'anthropic_oauth', model: 'claude-sonnet-4-6' }],
            active: { provider_id: 'anthropic', model: 'claude-sonnet-4-6' },
          };
        case 'get_auth_status':
          return authStatusPromise;
        case 'list_anthropic_models':
          return TEST_ANTHROPIC_MODELS;
        default:
          return undefined;
      }
    };

    // setInput fires the constructor effect's loadAuthStatus() (get_auth_status,
    // held pending below); detectChanges runs ngOnInit's loadConfig() alongside it.
    fixture.componentRef.setInput('activeProject', 'proj');
    fixture.detectChanges();
    // Let loadConfig() (get_llm_config) settle while get_auth_status is still pending.
    await flushMicrotasks();

    // Now the in-flight auth probe resolves with the real, already-connected state.
    resolveAuthStatus?.({
      api_key_configured: false,
      oauth_authenticated: true,
      needs_anthropic_auth: false,
      provider_configured: true,
    });
    await flushMicrotasks();
    fixture.detectChanges();

    expect(component.oauthAuthenticated()).toBe(true);
    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(true);
  });

  it('editing_the_anthropic_model_enables_save', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_llm_config':
          return {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            base_url: null,
            default_base_url: null,
            providers: [{ id: 'anthropic', kind: 'anthropic_oauth', model: 'claude-sonnet-4-6' }],
            active: { provider_id: 'anthropic', model: 'claude-sonnet-4-6' },
          };
        case 'get_auth_status':
          return { api_key_configured: false, oauth_authenticated: true };
        case 'list_anthropic_models':
          return TEST_ANTHROPIC_MODELS;
        default:
          return undefined;
      }
    };

    // loadConfig() (ngOnInit) and the constructor effect's loadAuthStatus() race for real
    // here — the initial-load join must still land on a clean snapshot once both settle.
    fixture.componentRef.setInput('activeProject', 'proj');
    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.oauthAuthenticated()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]').disabled).toBe(
      true
    );

    component.model.set('claude-opus-4-8');
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(false);
  });

  it('switching_auth_method_tab_enables_save', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_llm_config':
          return {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            base_url: null,
            default_base_url: null,
            providers: [{ id: 'anthropic', kind: 'anthropic_oauth', model: 'claude-sonnet-4-6' }],
            active: { provider_id: 'anthropic', model: 'claude-sonnet-4-6' },
          };
        case 'get_auth_status':
          return { api_key_configured: false, oauth_authenticated: true };
        case 'list_anthropic_models':
          return TEST_ANTHROPIC_MODELS;
        default:
          return undefined;
      }
    };

    // loadConfig() (ngOnInit) and the constructor effect's loadAuthStatus() race for real
    // here — the initial-load join must still land on a clean snapshot once both settle.
    fixture.componentRef.setInput('activeProject', 'proj');
    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.oauthAuthenticated()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]').disabled).toBe(
      true
    );

    component.authMethod.set('api_key');
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(false);
  });

  it('shows_logout_not_login_when_oauth_authenticated', () => {
    fixture.componentRef.setInput('activeProject', 'proj');
    component.provider.set('anthropic');
    component.selectedTarget.set('anthropic');
    component.authMethod.set('oauth');
    component.oauthAuthenticated.set(true);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="settings-oauth-logout"]')
    ).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-auth-terminal')).toBeFalsy();
  });

  it('shows_login_not_logout_when_not_authenticated', () => {
    fixture.componentRef.setInput('activeProject', 'proj');
    component.provider.set('anthropic');
    component.selectedTarget.set('anthropic');
    component.authMethod.set('oauth');
    component.oauthAuthenticated.set(false);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="settings-oauth-logout"]')
    ).toBeFalsy();
    expect(fixture.nativeElement.querySelector('app-auth-terminal')).toBeTruthy();
  });

  it('logout_button_invokes_anthropic_logout_clears_provider_and_reloads_status', async () => {
    const calls: string[] = [];
    const prev = mockTauri.invokeHandler;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd === 'anthropic_logout') return undefined;
      if (cmd === 'clear_active_llm_provider') return undefined;
      if (cmd === 'get_auth_status')
        return {
          // Logout leaves the project with no active provider.
          api_key_configured: false,
          oauth_authenticated: false,
          needs_anthropic_auth: true,
          provider_configured: false,
        };
      return prev(cmd, args);
    };
    fixture.componentRef.setInput('activeProject', 'proj');
    component.provider.set('anthropic');
    component.selectedTarget.set('anthropic');
    component.authMethod.set('oauth');
    component.oauthAuthenticated.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    // Discard the initial render's auth-status probe; assert only the logout sequence.
    calls.length = 0;
    const btn = fixture.nativeElement.querySelector('[data-testid="settings-oauth-logout"]');
    btn.click();
    await fixture.whenStable();
    // Logout must clear credentials AND the active provider (no-provider state),
    // then reload status so the UI reflects the cleared selection.
    expect(calls).toContain('anthropic_logout');
    expect(calls).toContain('clear_active_llm_provider');
    expect(calls).toContain('get_auth_status');
    expect(calls.indexOf('anthropic_logout')).toBeLessThan(
      calls.indexOf('clear_active_llm_provider')
    );
    expect(calls.indexOf('clear_active_llm_provider')).toBeLessThan(
      calls.indexOf('get_auth_status')
    );
  });

  it('logout forces no_provider even from a live ready chat session', async () => {
    // Reproduces the bug: a deliberate logout while status is already 'ready'
    // must blank the chat view, not silently stay on 'ready'.
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'anthropic_logout') return undefined;
      if (cmd === 'clear_active_llm_provider') return undefined;
      if (cmd === 'get_auth_status')
        return {
          api_key_configured: false,
          oauth_authenticated: false,
          needs_anthropic_auth: true,
          provider_configured: false,
        };
      return undefined;
    };
    fixture.componentRef.setInput('activeProject', 'proj');
    const projectState = TestBed.inject(ProjectStateService);
    projectState.status.set('ready');

    await component.anthropicLogout('proj');

    expect(projectState.status()).toBe('no_provider');
  });

  it('onOAuthDone_success_selects_anthropic_and_saves', async () => {
    const calls: string[] = [];
    const prev = mockTauri.invokeHandler;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd === 'get_auth_status')
        return {
          api_key_configured: false,
          oauth_authenticated: true,
          needs_anthropic_auth: true,
          provider_configured: true,
        };
      if (cmd === 'update_llm_config') return undefined;
      return prev(cmd, args);
    };
    fixture.componentRef.setInput('activeProject', 'proj');
    // Local is the active provider before the user logs in to Anthropic.
    component.provider.set('local');
    component.selectedTarget.set('local');

    await component.onOAuthDone(true);

    expect(component.selectedTarget()).toBe('anthropic');
    expect(calls).toContain('update_llm_config');
  });

  it('onOAuthDone_saves_and_forces_full_restart_even_when_already_on_anthropic_card', async () => {
    // Regression: guarding on effectiveTarget() !== 'anthropic' skipped autosave when already
    // on the Anthropic card. Login must always commit active=anthropic and force a full restart.
    const projectState = TestBed.inject(ProjectStateService);
    projectState.needsRestart = false;
    projectState.status.set('ready'); // OAuth login self-heal on a running project
    const restartSpy = vi.spyOn(projectState, 'requestRestart');
    const calls: string[] = [];
    const prev = mockTauri.invokeHandler;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd === 'get_auth_status')
        return {
          api_key_configured: false,
          oauth_authenticated: true,
          needs_anthropic_auth: true,
          provider_configured: true,
        };
      if (cmd === 'update_llm_config') return undefined;
      return prev(cmd, args);
    };
    fixture.componentRef.setInput('activeProject', 'proj');
    // User is already on the Anthropic card when they log in (the common path).
    component.provider.set('anthropic');
    component.selectedTarget.set('anthropic');

    await component.onOAuthDone(true);

    expect(component.selectedTarget()).toBe('anthropic');
    expect(calls).toContain('update_llm_config');
    // Full restart, not a light proxy reload — this is the self-heal.
    expect(restartSpy).toHaveBeenCalled();
    expect(projectState.needsRestart).toBe(true);
    expect(calls).not.toContain('restart_llm_proxy');
  });

  it('external-terminal login (watcher detects oauth false→true) auto-saves Anthropic', async () => {
    // The external "Open terminal and log in" path has no frontend callback, so
    // the watcher detects the credentials flip and runs the embedded autosave.
    const calls: string[] = [];
    const prev = mockTauri.invokeHandler;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd === 'get_auth_status')
        return {
          api_key_configured: false,
          oauth_authenticated: true,
          needs_anthropic_auth: true,
          provider_configured: true,
        };
      if (cmd === 'update_llm_config') return undefined;
      return prev(cmd, args);
    };
    fixture.componentRef.setInput('activeProject', 'proj');
    // Fresh project: not yet authenticated; the external terminal just completed.
    component.oauthAuthenticated.set(false);

    await fixture.debugElement.injector.get(OauthCompletionWatcher).checkNow();

    expect(component.selectedTarget()).toBe('anthropic');
    expect(calls).toContain('update_llm_config');
  });

  it('watcher probe does not auto-save when already authenticated (no double-save)', async () => {
    const calls: string[] = [];
    const prev = mockTauri.invokeHandler;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd === 'get_auth_status')
        return {
          api_key_configured: false,
          oauth_authenticated: true,
          needs_anthropic_auth: true,
          provider_configured: true,
        };
      return prev(cmd, args);
    };
    fixture.componentRef.setInput('activeProject', 'proj');
    // Already authenticated (e.g. embedded path handled it) → no false→true edge.
    component.oauthAuthenticated.set(true);

    await fixture.debugElement.injector.get(OauthCompletionWatcher).checkNow();

    expect(calls).not.toContain('update_llm_config');
  });

  it('logout restarts the completion poll so a later external re-login is detected', async () => {
    fixture.componentRef.setInput('activeProject', 'proj');
    const watcher = fixture.debugElement.injector.get(OauthCompletionWatcher);
    // Authenticated state stops the poll on its next tick / via the probe.
    component.oauthAuthenticated.set(true);
    watcher.stopPoll();
    expect(watcher.isPolling()).toBe(false);

    await component.anthropicLogout('proj');

    // A fresh poll is running again after logout.
    expect(watcher.isPolling()).toBe(true);
  });

  it('poll ticks probe only while the Anthropic card is active (context wiring)', () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const prev = mockTauri.invokeHandler;
      mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
        calls.push(cmd);
        return prev(cmd, args);
      };
      fixture.componentRef.setInput('activeProject', 'proj');
      const watcher = fixture.debugElement.injector.get(OauthCompletionWatcher);
      component.oauthAuthenticated.set(false);
      component.provider.set('local');
      component.selectedTarget.set('local');
      watcher.startPoll();

      vi.advanceTimersByTime(1500);
      expect(calls).not.toContain('get_auth_status');

      component.provider.set('anthropic');
      component.selectedTarget.set('anthropic');
      vi.advanceTimersByTime(1500);
      expect(calls).toContain('get_auth_status');
    } finally {
      vi.useRealTimers();
    }
  });

  it('window regaining focus forces an immediate auth check (past poll throttling)', async () => {
    // The OS/webview throttles setInterval in an unfocused window, so a window
    // focus event must trigger the same check independent of the poll cadence.
    const calls: string[] = [];
    const prev = mockTauri.invokeHandler;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd === 'get_auth_status')
        return {
          api_key_configured: false,
          oauth_authenticated: true,
          needs_anthropic_auth: true,
          provider_configured: true,
        };
      if (cmd === 'update_llm_config') return undefined;
      return prev(cmd, args);
    };
    fixture.componentRef.setInput('activeProject', 'proj');
    component.oauthAuthenticated.set(false);
    component.ngOnInit();
    await flushMicrotasks();

    mockTauri.dispatchEvent('window_focused', undefined);
    await flushMicrotasks();

    expect(calls).toContain('get_auth_status');
    expect(calls).toContain('update_llm_config');
  });

  it('ngOnDestroy clears the focus listener', async () => {
    fixture.componentRef.setInput('activeProject', 'proj');
    component.ngOnInit();
    await flushMicrotasks();
    expect(mockTauri.listenHandlers['window_focused']).toBeDefined();

    component.ngOnDestroy();

    expect(mockTauri.listenHandlers['window_focused']).toBeUndefined();
  });

  it('onOAuthDone_failure_does_not_save', async () => {
    const calls: string[] = [];
    const prev = mockTauri.invokeHandler;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd === 'get_auth_status')
        return {
          api_key_configured: false,
          oauth_authenticated: false,
          needs_anthropic_auth: true,
          provider_configured: true,
        };
      return prev(cmd, args);
    };
    fixture.componentRef.setInput('activeProject', 'proj');
    component.provider.set('local');
    component.selectedTarget.set('local');

    await component.onOAuthDone(false);

    expect(component.selectedTarget()).toBe('local');
    expect(calls).not.toContain('update_llm_config');
  });

  it('disables_save_for_unconfigured_anthropic', () => {
    component.provider.set('anthropic');
    component.selectedTarget.set('anthropic');
    component.model.set('');
    component.oauthAuthenticated.set(false);
    component.apiKeyConfigured.set(false);
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(true);
  });

  it('enables_save_for_anthropic_with_api_key', () => {
    // apiKeyConfigured flipping true from its default false is itself a change.
    component.provider.set('anthropic');
    component.selectedTarget.set('anthropic');
    component.apiKeyConfigured.set(true);
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(false);
  });

  it('renders_local_fields_in_order_url_key_discover', () => {
    component.provider.set('local');
    component.selectedTarget.set('local');
    fixture.detectChanges();
    const html = fixture.nativeElement.innerHTML as string;
    const url = html.indexOf('settings-llm-base-url');
    const key = html.indexOf('settings-llm-api-key');
    const disc = html.indexOf('settings-llm-refresh');
    expect(url).toBeGreaterThan(-1);
    expect(url).toBeLessThan(key);
    expect(key).toBeLessThan(disc);
  });

  it('shows base URL field for ollama provider; model field hidden until discovery', async () => {
    component.provider.set('ollama');
    component.selectedTarget.set('local');
    component.model.set('');
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const baseUrlInput = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-base-url"]'
    );
    expect(baseUrlInput).not.toBeNull();
    // No model field on a fresh form — it appears only after discovery.
    const modelInput = fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]');
    expect(modelInput).toBeNull();
  });

  it('shows model and base URL fields for lmstudio provider', async () => {
    component.provider.set('lmstudio');
    component.selectedTarget.set('local');
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const baseUrlInput = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-base-url"]'
    );
    expect(baseUrlInput).not.toBeNull();
  });

  it('shows model and base URL fields for llamacpp provider', async () => {
    component.provider.set('llamacpp');
    component.selectedTarget.set('local');
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const baseUrlInput = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-base-url"]'
    );
    expect(baseUrlInput).not.toBeNull();
  });

  it('uses default_base_url from backend as placeholder', async () => {
    component.provider.set('ollama');
    component.selectedTarget.set('local');
    component.defaultBaseUrl.set('http://host.docker.internal:11434');
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const baseUrlInput = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-base-url"]'
    );
    expect(baseUrlInput).not.toBeNull();
    expect(baseUrlInput.placeholder).toBe('http://host.docker.internal:11434');
  });

  it('does not send api key env var field', async () => {
    let invokedArgs: Record<string, unknown> = {};
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'update_llm_config') {
        invokedArgs = args ?? {};
        return undefined;
      }
      return undefined;
    };

    component.provider.set('ollama');
    await component.saveConfig();

    expect(Object.keys(invokedArgs)).not.toContain('apiKeyEnv');
  });

  it('renders save button', () => {
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn).not.toBeNull();
    expect(btn.textContent.trim().toLowerCase()).toContain('save');
  });

  // ── Model discovery (ADR-041) ────────────────────────────────────────

  function setupDiscoveryMock(
    mockTauri: MockTauriService,
    opts: {
      provider?: string;
      baseUrl?: string;
      defaultBaseUrl?: string;
      model?: string;
      // String shape is accepted for test convenience — we lift it to the
      // new `DiscoveredModel { id, context_tokens? }` DTO before returning.
      discover?: (args?: Record<string, unknown>) => Promise<string[]>;
    } = {}
  ): { discoverCalls: Array<Record<string, unknown> | undefined> } {
    const discoverCalls: Array<Record<string, unknown> | undefined> = [];
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'get_llm_config':
          return {
            provider: opts.provider ?? 'ollama',
            model: opts.model ?? null,
            base_url: opts.baseUrl ?? null,
            default_base_url: opts.defaultBaseUrl ?? 'http://host.docker.internal:11434',
          };
        case 'get_default_base_url': {
          const p = (args?.['provider'] as string) ?? '';
          const defaults: Record<string, string> = {
            ollama: opts.defaultBaseUrl ?? 'http://host.docker.internal:11434',
            lmstudio: 'http://host.docker.internal:1234',
            llamacpp: 'http://host.docker.internal:8080',
          };
          return defaults[p] ?? null;
        }
        case 'list_anthropic_models':
          return [];
        case 'update_llm_config':
          return undefined;
        case 'discover_llm_models':
          discoverCalls.push(args);
          if (opts.discover) {
            const ids = await opts.discover(args);
            return { models: ids.map((id) => ({ id })) };
          }
          return { models: [] };
        default:
          return undefined;
      }
    };
    return { discoverCalls };
  }

  it('renders a hint instead of a model select once discovery is ready', async () => {
    setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      discover: async () => ['llama3.3', 'qwen2.5'],
    });
    component.ngOnInit();
    await flushMicrotasks();
    // Discovery is explicit now — no auto-probe on load.
    component.baseUrl.set('http://host.docker.internal:11434');
    await component.discoverModels(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="settings-llm-local-model-hint"]')
    ).not.toBeNull();
  });

  it('editing_base_url_resets_discovery_state', async () => {
    // Configured (ready list), then the user edits the URL → the stale
    // discovery state must clear so a fresh discover is required.
    setupDiscoveryMock(mockTauri, { provider: 'ollama', discover: async () => ['m1', 'm2'] });
    component.ngOnInit();
    await flushMicrotasks();
    component.baseUrl.set('http://host.docker.internal:11434');
    await component.discoverModels(true);
    expect(component.discoveryState().kind).toBe('ready');
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-base-url"]'
    ) as HTMLInputElement;
    input.value = 'http://host.docker.internal:1234';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(component.baseUrl()).toBe('http://host.docker.internal:1234');
    expect(component.discoveryState().kind).toBe('idle');
    // Save stays enabled: the new base_url alone satisfies the local gate
    // (server-side auto-default, Task 11) even with no picked model.
    const saveBtn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(saveBtn.disabled).toBe(false);
  });

  it('discovery no longer auto-selects into the model signal (Task 18)', async () => {
    setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      discover: async () => ['llama3.3', 'qwen2.5'],
    });
    component.ngOnInit();
    await flushMicrotasks();
    component.baseUrl.set('http://host.docker.internal:11434');
    await component.discoverModels(true);
    fixture.detectChanges();

    expect(component.discoveryState().kind).toBe('ready');
    expect(component.model()).toBe('');
  });

  it('keeps_input_on_offline_failure', async () => {
    const errorSpy = vi.fn();
    component.errorOccurred.subscribe(errorSpy);
    setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      discover: async () => {
        throw new Error('offline');
      },
    });
    component.ngOnInit();
    await flushMicrotasks();
    component.baseUrl.set('http://host.docker.internal:11434');
    component.model.set('');
    await component.discoverModels(true);
    fixture.detectChanges();

    // No free-text fallback — the model field is hidden on failure (Task 2).
    const el = fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]');
    expect(el).toBeNull();
    expect(component.discoveryState().kind).toBe('failed');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('skips_discovery_for_anthropic', async () => {
    const { discoverCalls } = setupDiscoveryMock(mockTauri, { provider: 'anthropic' });
    await component.ngOnInit();
    await fixture.whenStable();
    expect(discoverCalls.length).toBe(0);
  });

  it('does_not_probe_on_load_or_switch', async () => {
    // Explicit-discovery: neither init/load nor a provider switch probes.
    const { discoverCalls } = setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      defaultBaseUrl: 'http://host.docker.internal:11434',
      discover: async () => ['m1'],
    });
    await component.ngOnInit();
    await fixture.whenStable();
    expect(discoverCalls.length).toBe(0);
    // Only the explicit button probes.
    component.baseUrl.set('http://host.docker.internal:11434');
    await component.discoverModels(true);
    expect(discoverCalls.length).toBe(1);
  });

  it('refresh_button_invokes_discovery_bypassing_dedupe', async () => {
    // Two sequential refreshes on the same URL must both fire.
    const { discoverCalls } = setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      discover: async () => ['m'],
    });
    await component.ngOnInit();
    await fixture.whenStable();
    const before = discoverCalls.length;
    await component.discoverModels(true);
    await component.discoverModels(true);
    expect(discoverCalls.length).toBe(before + 2);
  });

  it('discovery does not overwrite a restored model absent from the list (a3)', async () => {
    setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      discover: async () => ['m1', 'm2'],
    });
    await component.ngOnInit();
    await fixture.whenStable();
    // A restored model the server no longer lists must survive discovery
    // (discovery never writes `model` anymore — Task 18 — so this is now
    // trivially true, but stays pinned as a regression guard).
    component.model.set('restored-not-on-server');
    await component.discoverModels(true);
    expect(component.model()).toBe('restored-not-on-server');
  });

  it('dedupes_provider_change_and_blur_on_same_url', async () => {
    // While a probe is in-flight against URL X, a second same-URL trigger is deduped.
    let resolveFirst: (v: string[]) => void = () => {};
    const hanging = new Promise<string[]>((resolve) => {
      resolveFirst = resolve;
    });
    const { discoverCalls } = setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      discover: async () => await hanging,
    });
    // Bypass ngOnInit — set state directly so we can control timing.
    component.provider.set('ollama');
    component.baseUrl.set('http://localhost:11434');
    const firstCall = component.discoverModels(false);
    // Same URL, while first is pending → must dedupe.
    await component.discoverModels(false);
    expect(discoverCalls.length).toBe(1);
    resolveFirst(['m']);
    await firstCall;
  });

  it('discards_stale_response_on_rapid_blur', async () => {
    // On rapid URL change, final state reflects the latest URL, not the stale slow response.
    let resolveFirst: (v: string[]) => void = () => {};
    const slow = new Promise<string[]>((r) => {
      resolveFirst = r;
    });
    let callIdx = 0;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'discover_llm_models') {
        callIdx += 1;
        if (callIdx === 1) return await slow;
        return { models: [{ id: 'model-from-second' }] };
      }
      return undefined;
    };
    component.provider.set('ollama');
    component.baseUrl.set('http://a.invalid');
    const firstCall = component.discoverModels(false);
    // Flush the first invoke so its await on `slow` is reached before we
    // mutate baseUrl (otherwise a change-detection flush may conflate them).
    await Promise.resolve();
    component.baseUrl.set('http://b.invalid');
    await component.discoverModels(false);
    // Now let the first probe finish with a stale result.
    resolveFirst(['model-from-first']);
    await firstCall;
    await fixture.whenStable();
    const st = component.discoveryState();
    expect(st.kind).toBe('ready');
    if (st.kind === 'ready') {
      expect(st.models).toEqual([{ id: 'model-from-second' }]);
      expect(st.url).toBe('http://b.invalid');
    }
  });

  it('onProviderChange_clears_stale_models', async () => {
    setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      discover: async () => ['m'],
    });
    component.ngOnInit();
    await flushMicrotasks();
    // Explicit discovery to reach a `ready` state.
    component.baseUrl.set('http://host.docker.internal:11434');
    await component.discoverModels(true);
    expect(component.discoveryState().kind).toBe('ready');
    // Switching provider resets state to idle — no auto-probe on switch.
    component.provider.set('lmstudio');
    await component.onProviderChange();
    expect(component.discoveryState().kind).toBe('idle');
  });

  it('preserves_legacy_model_spoza_listy', async () => {
    // A persisted model survives loadConfig without auto-discovery; no select
    // control renders it anymore (Task 18).
    setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      model: 'legacy',
      baseUrl: 'http://localhost:11434',
      discover: async () => ['a', 'b'],
    });
    await component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.model()).toBe('legacy');
    expect(component.discoveryState().kind).toBe('idle');
    expect(fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]')).toBeNull();
  });

  it('shows_saved_model_without_discovery', async () => {
    // A loaded config with a local provider entry preserves the model
    // signal, with no discovery probe and no model control rendering it.
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_llm_config') {
        return {
          provider: 'local',
          model: 'gemma',
          base_url: 'http://host.docker.internal:8888',
          providers: [
            {
              id: 'local',
              kind: 'local',
              base_url: 'http://host.docker.internal:8888',
              model: 'gemma',
              has_api_key: false,
              has_custom_headers: false,
            },
          ],
          active: { provider_id: 'local', model: 'gemma' },
        };
      }
      if (cmd === 'list_anthropic_models') return [];
      return undefined;
    };
    await component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.model()).toBe('gemma');
    expect(fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]')).toBeNull();
  });

  it('hides_model_field_on_discovery_failure', async () => {
    setupDiscoveryMock(mockTauri, {
      provider: 'local',
      discover: async () => {
        throw new Error('auth');
      },
    });
    component.provider.set('local');
    component.selectedTarget.set('local');
    component.model.set('');
    component.baseUrl.set('http://host.docker.internal:8888');
    await component.discoverModels(true);
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    expect(component.discoveryState().kind).toBe('failed');
    expect(fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]')).toBeNull();
    const err = fixture.nativeElement.querySelector('[data-testid="settings-llm-discovery-error"]');
    expect(err.textContent).toContain('API key');
  });

  it('explicit_discovery_renders_a_hint_and_keeps_the_listed_model_signal', async () => {
    // No auto-probe on load. After an explicit discover the catalog is fetched
    // and the persisted model signal is untouched, but no <select> renders it.
    setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      model: 'legacy',
      baseUrl: null as unknown as string,
      defaultBaseUrl: 'http://host.docker.internal:11434',
      discover: async () => ['legacy', 'a', 'b'],
    });
    component.ngOnInit();
    await flushMicrotasks();
    await component.discoverModels(true);
    fixture.detectChanges();

    expect(component.model()).toBe('legacy');
    expect(component.discoveryState().kind).toBe('ready');
    expect(fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="settings-llm-local-model-hint"]')
    ).not.toBeNull();
  });

  it('non_default_stored_base_url_stays_idle_on_init', async () => {
    // Non-default URL (incl. link-local/RFC1918) must NOT be auto-probed on startup;
    // discoveryState stays idle until the user explicitly clicks Refresh or blurs Base URL.
    const { discoverCalls } = setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      baseUrl: 'http://169.254.169.254',
      discover: async () => {
        throw new Error('URL host 169.254.169.254: private/reserved');
      },
    });
    await component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(discoverCalls.length).toBe(0);
    expect(component.discoveryState().kind).toBe('idle');
    // No saved model + no discovery → no model field (no free-text fallback).
    const el = fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]');
    expect(el).toBeNull();
  });

  it('non_default_stored_base_url_probes_on_explicit_refresh', async () => {
    // After init (no auto-probe), user clicking Refresh must trigger discovery
    // even for a non-default URL.
    const { discoverCalls } = setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      baseUrl: 'http://169.254.169.254',
      discover: async () => {
        throw new Error('URL host 169.254.169.254: private/reserved');
      },
    });
    await component.ngOnInit();
    await fixture.whenStable();
    expect(discoverCalls.length).toBe(0);

    await component.discoverModels(true);
    expect(discoverCalls.length).toBe(1);
    expect(component.discoveryState().kind).toBe('failed');
  });

  it('skips_auto_probe_for_persisted_non_default_url', async () => {
    // A cloned malicious repo could set base_url to an internal RFC1918 host; opening
    // Settings must NOT silently probe it — the user must explicitly click Refresh or blur.
    const { discoverCalls } = setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      baseUrl: 'http://192.168.1.50:11434',
      defaultBaseUrl: 'http://host.docker.internal:11434',
      discover: async () => ['malicious-model'],
    });

    await component.ngOnInit();
    await fixture.whenStable();

    expect(discoverCalls.length).toBe(0);
    expect(component.discoveryState().kind).toBe('idle');
  });

  it('onProviderChange_increments_counter_before_state_reset', async () => {
    // Invariant: discoveryCounter is bumped synchronously inside onProviderChange, so an
    // in-flight response from the previous provider (carrying the OLD id) is discarded on arrival.
    setupDiscoveryMock(mockTauri, { provider: 'ollama' });
    // Seed the counter at a known value via a private-field cast.
    (component as unknown as Record<string, number>)['discoveryCounter'] = 5;
    component.provider.set('ollama');
    // Plant a stale in-flight state with the current (pre-bump) id.
    component.discoveryState.set({
      kind: 'in-flight',
      url: 'http://prev',
      id: 5, // matches seeded counter — will be stale after bump
    });
    component.provider.set('lmstudio');
    await component.onProviderChange();

    // Counter must have grown beyond 5 (bumped at least once in onProviderChange,
    // possibly again inside discoverModels). Any response carrying id=5 is now stale.
    const currentCounter = (component as unknown as Record<string, number>)['discoveryCounter'];
    expect(currentCounter).toBeGreaterThan(5);

    // If a discoverModels probe is in-flight, its id must also be > 5,
    // confirming the stale id=5 response would be rejected on arrival.
    const stInflight = component.discoveryState();
    if (stInflight.kind === 'in-flight') {
      expect(stInflight.id).toBeGreaterThan(5);
    }
  });

  // ── DiscoveryState.reason: unsupported / empty categories ────────────

  it('maps_unsupported_error_to_unsupported_reason', async () => {
    // Backend returns Err("unsupported") for anthropic-like providers; the component must
    // map it to reason='unsupported' with a message distinct from the offline case.
    setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      discover: async () => {
        throw new Error('unsupported');
      },
    });
    component.provider.set('ollama');
    component.baseUrl.set('http://localhost:11434');
    await component.discoverModels(false);

    expect(component.discoveryState().kind).toBe('failed');
    const fs = component.discoveryState();
    if (fs.kind === 'failed') {
      expect(fs.reason).toBe('unsupported');
    }
    const unsupportedMsg = component.discoveryFailureMessage();
    expect(unsupportedMsg.length).toBeGreaterThan(0);
    // Must differ from the offline message produced by reason='offline'.
    const offlineMsg = (() => {
      const saved = component.discoveryState();
      component.discoveryState.set({
        kind: 'failed',
        url: 'http://localhost:11434',
        reason: 'offline',
      });
      const m = component.discoveryFailureMessage();
      component.discoveryState.set(saved);
      return m;
    })();
    expect(unsupportedMsg).not.toBe(offlineMsg);
  });

  it('maps_empty_error_to_other_reason', async () => {
    // Backend returns Err("empty") when the server is up but has no models loaded.
    // The component must map the "empty" message to reason='other'.
    setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      discover: async () => {
        throw new Error('empty');
      },
    });
    component.provider.set('ollama');
    component.baseUrl.set('http://localhost:11434');
    await component.discoverModels(false);

    expect(component.discoveryState().kind).toBe('failed');
    const fs = component.discoveryState();
    if (fs.kind === 'failed') {
      expect(fs.reason).toBe('other');
    }
    const otherMsg = component.discoveryFailureMessage();
    expect(otherMsg.length).toBeGreaterThan(0);
    // Must differ from the offline message.
    const offlineMsg = (() => {
      const saved = component.discoveryState();
      component.discoveryState.set({
        kind: 'failed',
        url: 'http://localhost:11434',
        reason: 'offline',
      });
      const m = component.discoveryFailureMessage();
      component.discoveryState.set(saved);
      return m;
    })();
    expect(otherMsg).not.toBe(offlineMsg);
  });

  // ── DiscoveryState.reason: auth / server-error categories ────────────

  // Helper: the message reason='offline' would produce, for not-equal asserts.
  const offlineMessageFor = (url: string): string => {
    const saved = component.discoveryState();
    component.discoveryState.set({ kind: 'failed', url, reason: 'offline' });
    const m = component.discoveryFailureMessage();
    component.discoveryState.set(saved);
    return m;
  };

  it('maps_auth_error_to_auth_reason', async () => {
    // Backend returns Err("auth") for HTTP 401/403 — bad or missing API key.
    setupDiscoveryMock(mockTauri, {
      provider: 'local',
      discover: async () => {
        throw new Error('auth');
      },
    });
    component.provider.set('local');
    component.baseUrl.set('http://host.docker.internal:8888');
    await component.discoverModels(false);

    expect(component.discoveryState().kind).toBe('failed');
    const fs = component.discoveryState();
    if (fs.kind === 'failed') {
      expect(fs.reason).toBe('auth');
    }
    const msg = component.discoveryFailureMessage();
    expect(msg).toContain('API key');
    // The core bug: 401 must NOT be reported as offline/not reachable.
    expect(msg).not.toBe(offlineMessageFor('http://host.docker.internal:8888'));
  });

  it('maps_http_status_error_to_server_error_reason', async () => {
    setupDiscoveryMock(mockTauri, {
      provider: 'local',
      discover: async () => {
        throw new Error('LLM server returned HTTP 500');
      },
    });
    component.provider.set('local');
    component.baseUrl.set('http://host.docker.internal:8888');
    await component.discoverModels(false);

    expect(component.discoveryState().kind).toBe('failed');
    const fs = component.discoveryState();
    if (fs.kind === 'failed') {
      expect(fs.reason).toBe('server-error');
      expect(fs.status).toBe(500);
    }
    const msg = component.discoveryFailureMessage();
    expect(msg).toContain('500');
    expect(msg).not.toBe(offlineMessageFor('http://host.docker.internal:8888'));
  });

  it('maps_html_response_to_server_error_without_status', async () => {
    setupDiscoveryMock(mockTauri, {
      provider: 'local',
      discover: async () => {
        throw new Error('LLM server returned an HTML response');
      },
    });
    component.provider.set('local');
    component.baseUrl.set('http://host.docker.internal:8888');
    await component.discoverModels(false);

    expect(component.discoveryState().kind).toBe('failed');
    const fs = component.discoveryState();
    if (fs.kind === 'failed') {
      expect(fs.reason).toBe('server-error');
      expect(fs.status).toBeUndefined();
    }
    expect(component.discoveryFailureMessage().length).toBeGreaterThan(0);
  });

  it('keeps_connect_failure_as_offline', async () => {
    // A true connection failure must stay offline — regression guard.
    setupDiscoveryMock(mockTauri, {
      provider: 'local',
      discover: async () => {
        throw new Error('LLM model discovery: request failed: error sending request');
      },
    });
    component.provider.set('local');
    component.baseUrl.set('http://host.docker.internal:8888');
    await component.discoverModels(false);

    expect(component.discoveryState().kind).toBe('failed');
    const fs = component.discoveryState();
    if (fs.kind === 'failed') {
      expect(fs.reason).toBe('offline');
    }
    expect(component.discoveryFailureMessage()).toContain('not reachable');
  });

  // ── saveConfig: effectiveBaseUrl fallback for local providers ─────────

  it('save_falls_back_to_default_base_url_for_local_provider_with_blank_url', async () => {
    // A blank Base URL for a local provider must fall back to defaultBaseUrl so compose can
    // inject ANTHROPIC_BASE_URL — an empty string or null leaves the container without one.
    let invokedArgs: Record<string, unknown> = {};
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'update_llm_config') {
        invokedArgs = args ?? {};
        return undefined;
      }
      return undefined;
    };

    component.provider.set('ollama');
    component.baseUrl.set('');
    component.defaultBaseUrl.set('http://host.docker.internal:11434');
    component.model.set('llama3.3');

    await component.saveConfig();

    const update = invokedArgs['update'] as Record<string, unknown>;
    expect(update['base_url']).toBe('http://host.docker.internal:11434');
    expect(update['base_url']).not.toBeNull();
    expect(update['base_url']).not.toBe('');
  });

  it('save_rejects_local_provider_with_no_model_and_no_base_url', async () => {
    // UX guard: compose::apply_llm_config rejects a null model for local providers, but that
    // error only surfaces at container start — catching it at Save time gives immediate feedback.
    // A base_url alone now satisfies the gate (server-side auto-default, Task 11), so this only
    // rejects when NEITHER a model nor a base_url exists to auto-default from.
    let invokeCalled = false;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'update_llm_config') {
        invokeCalled = true;
      }
      return undefined;
    };

    let emittedError = '';
    component.errorOccurred.subscribe((msg: string) => {
      emittedError = msg;
    });

    component.provider.set('ollama');
    component.baseUrl.set('');
    component.model.set('');

    await component.saveConfig();

    expect(invokeCalled).toBe(false);
    expect(emittedError).toContain('model name is required');
  });

  it('canSave and saveConfig agree a whitespace-only local model is no model (Defect 19)', async () => {
    // Both gates share `localModelSatisfied()` — a model of "   " must be
    // treated as absent by BOTH, not just the trimmed canSave() computed.
    let invokeCalled = false;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'update_llm_config') {
        invokeCalled = true;
      }
      return undefined;
    };

    let emittedError = '';
    component.errorOccurred.subscribe((msg: string) => {
      emittedError = msg;
    });

    component.provider.set('ollama');
    component.baseUrl.set('');
    component.defaultBaseUrl.set('');
    component.model.set('   ');

    expect(component['canSave']()).toBe(false);

    await component.saveConfig();

    expect(invokeCalled).toBe(false);
    expect(emittedError).toContain('model name is required');
  });

  it('save_allows_anthropic_with_empty_model', async () => {
    // Anthropic infers the model from ANTHROPIC_MODEL env or Claude's
    // default — no model in config is legal.
    let invokeCalled = false;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'update_llm_config') {
        invokeCalled = true;
      }
      return undefined;
    };

    component.provider.set('anthropic');
    component.baseUrl.set('');
    component.model.set('');

    await component.saveConfig();

    expect(invokeCalled).toBe(true);
  });

  // ── Remote providers (ADR-073) ──────────────────────────────────────────

  it('renders the openrouter permanent remote row with no add or remove controls', () => {
    expect(component.extraProviders().map((p) => p.id)).toEqual(['openrouter']);
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="settings-llm-extra-openrouter"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="settings-llm-add-openrouter"]')).toBeNull();
    expect(el.querySelector('[data-testid="settings-llm-extra-remove-openrouter"]')).toBeNull();
  });

  it('does not persist unconfigured permanent rows', async () => {
    let captured: Record<string, unknown> | null = null;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'update_llm_config') captured = args?.['update'] as Record<string, unknown>;
      if (cmd === 'get_auth_status')
        return { api_key_configured: false, provider_configured: true };
      return undefined;
    };

    component.provider.set('anthropic');
    component.selectedTarget.set('anthropic');
    await component.saveConfig();

    const ids = (captured!['providers'] as Array<Record<string, unknown>>).map((p) => p['id']);
    expect(ids).not.toContain('openrouter');
  });

  it('toggles a row open and closed without changing the active provider', () => {
    const entry = component.extraProviders()[0];
    const activeBefore = component.selectedTarget();

    component.toggleExtraExpanded(entry);
    expect(component.expandedExtraId).toBe(entry.id);
    component.toggleExtraExpanded(entry);
    expect(component.expandedExtraId).toBeNull();
    expect(component.selectedTarget()).toBe(activeBefore);
  });

  it('whole-bar click activates a row; second click toggles its panel', () => {
    const entry = component.extraProviders()[0];

    component.onExtraHeaderClick(entry);
    expect(component.selectedTarget()).toBe('openrouter');
    expect(component.expandedExtraId).toBe('openrouter');

    component.onExtraHeaderClick(entry);
    expect(component.selectedTarget()).toBe('openrouter');
    expect(component.expandedExtraId).toBeNull();

    component.onExtraHeaderClick(entry);
    expect(component.expandedExtraId).toBe('openrouter');
  });

  it('preserves the inactive local entry verbatim across a save', async () => {
    // The user's local server config must survive saves made while another
    // provider is active — rebuilding it from card state erased it.
    let captured: Record<string, unknown> | null = null;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_llm_config') {
        return {
          provider: 'anthropic',
          model: null,
          base_url: null,
          default_base_url: null,
          providers: [
            { id: 'anthropic', kind: 'anthropic_oauth', has_api_key: false },
            {
              id: 'local',
              kind: 'local',
              base_url: 'http://host.docker.internal:9000',
              model: 'unsloth/Qwen3.6-35B-A3B',
              has_api_key: true,
              context_tokens: 262144,
            },
            { id: 'openrouter', kind: 'open_router', has_api_key: true },
          ],
          active: { provider_id: 'openrouter', model: 'deepseek/deepseek-v4-flash' },
        };
      }
      if (cmd === 'update_llm_config') captured = args?.['update'] as Record<string, unknown>;
      if (cmd === 'get_auth_status')
        return { api_key_configured: false, provider_configured: true };
      if (cmd === 'discover_llm_models') throw new Error('offline');
      return undefined;
    };

    component.ngOnInit();
    await fixture.whenStable();
    await component.saveConfig();

    const providers = captured!['providers'] as Array<Record<string, unknown>>;
    const local = providers.find((p) => p['id'] === 'local')!;
    expect(local['base_url']).toBe('http://host.docker.internal:9000');
    expect(local['model']).toBe('unsloth/Qwen3.6-35B-A3B');
    expect(local['has_api_key']).toBe(true);
    expect(local['context_tokens']).toBe(262144);
    // The remote row's model rides on its provider entry too.
    const or = providers.find((p) => p['id'] === 'openrouter')!;
    expect(or['model']).toBe('deepseek/deepseek-v4-flash');
  });

  it('restores the local model and url when switching back to the local card', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_llm_config') {
        return {
          provider: 'anthropic',
          model: null,
          base_url: null,
          default_base_url: null,
          providers: [
            { id: 'anthropic', kind: 'anthropic_oauth', has_api_key: false },
            {
              id: 'local',
              kind: 'local',
              base_url: 'http://host.docker.internal:9000',
              model: 'unsloth/Qwen3.6-35B-A3B',
            },
          ],
          active: { provider_id: 'anthropic', model: null },
        };
      }
      if (cmd === 'discover_llm_models') throw new Error('offline');
      return undefined;
    };

    component.ngOnInit();
    await fixture.whenStable();
    await component.selectProvider('local');

    expect(component.baseUrl()).toBe('http://host.docker.internal:9000');
    expect(component.model()).toBe('unsloth/Qwen3.6-35B-A3B');
  });

  it('saves an api key on a non-active row without requiring a model', async () => {
    const keyCalls: Array<Record<string, unknown>> = [];
    let captured: Record<string, unknown> | null = null;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'update_llm_config') captured = args?.['update'] as Record<string, unknown>;
      if (cmd === 'set_llm_provider_key') keyCalls.push(args ?? {});
      if (cmd === 'get_auth_status')
        return { api_key_configured: false, provider_configured: true };
      return undefined;
    };

    component.provider.set('anthropic');
    component.selectedTarget.set('anthropic');
    component.toggleExtraExpanded(component.extraProviders()[0]);
    component.onExtraKeyInput(component.extraProviders()[0], 'sk-or-v1-fresh');

    await component.saveConfig();

    expect(keyCalls).toEqual([{ providerId: 'openrouter', key: 'sk-or-v1-fresh' }]);
    const active = captured!['active'] as Record<string, unknown>;
    expect(active['provider_id']).toBe('anthropic');
  });

  it('save sends the full v2 provider set and active selection', async () => {
    let captured: Record<string, unknown> | null = null;
    const keyCalls: Array<Record<string, unknown>> = [];
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'update_llm_config') captured = args?.['update'] as Record<string, unknown>;
      if (cmd === 'set_llm_provider_key') keyCalls.push(args ?? {});
      if (cmd === 'get_auth_status')
        return { api_key_configured: false, provider_configured: true };
      return undefined;
    };

    component.toggleExtraExpanded(component.extraProviders()[0]);
    const extra = component.extraProviders()[0];
    extra.model = 'qwen/qwen3-coder';
    component.onExtraKeyInput(extra, 'sk-or-v1-test');
    component.selectExtraProvider(extra);

    await component.saveConfig();

    expect(captured).not.toBeNull();
    const update = captured!;
    const providers = update['providers'] as Array<Record<string, unknown>>;
    expect(providers.map((p) => p['id'])).toContain('anthropic');
    expect(providers.map((p) => p['id'])).toContain('openrouter');
    const or = providers.find((p) => p['id'] === 'openrouter')!;
    expect(or['kind']).toBe('open_router');
    expect(or['has_api_key']).toBe(true);
    const active = update['active'] as Record<string, unknown>;
    expect(active['provider_id']).toBe('openrouter');
    expect(active['model']).toBe('qwen/qwen3-coder');
    // The key value went through set_llm_provider_key, not the config DTO.
    expect(JSON.stringify(update)).not.toContain('sk-or-v1-test');
    expect(keyCalls).toEqual([{ providerId: 'openrouter', key: 'sk-or-v1-test' }]);
  });

  it('openrouter rows fetch the tool-capable catalog but render no model selector', async () => {
    const discoverArgs: Array<Record<string, unknown>> = [];
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'discover_llm_models') {
        discoverArgs.push((args?.['args'] as Record<string, unknown>) ?? {});
        return {
          models: [
            { id: 'deepseek/deepseek-v3.2', context_tokens: 163840 },
            { id: 'qwen/qwen3-coder', context_tokens: 262144 },
          ],
        };
      }
      return undefined;
    };

    component.toggleExtraExpanded(component.extraProviders()[0]);
    // Explicit discovery (gated on key) — no auto-discover on expand.
    component.extraProviders()[0].keyInput = 'sk-or-x';
    await component.discoverExtraModels(component.extraProviders()[0]);
    await flushMicrotasks();
    fixture.detectChanges();

    expect(discoverArgs).toEqual([{ provider: 'openrouter', baseUrl: '', apiKey: 'sk-or-x' }]);
    expect(component.extraProviders()[0].models).toEqual([
      { id: 'deepseek/deepseek-v3.2', context_tokens: 163840 },
      { id: 'qwen/qwen3-coder', context_tokens: 262144 },
    ]);
    expect(
      fixture.nativeElement.querySelector('[data-testid="settings-llm-extra-model-openrouter"]')
    ).toBeNull();
  });

  it('openrouter catalog failure hides the model field (no fallback)', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'discover_llm_models') throw new Error('empty');
      return undefined;
    };

    component.toggleExtraExpanded(component.extraProviders()[0]);
    component.extraProviders()[0].keyInput = 'sk-or-x';
    await component.discoverExtraModels(component.extraProviders()[0]);
    await flushMicrotasks();
    fixture.detectChanges();

    // No catalog → no model field (model select appears only after success).
    expect(
      fixture.nativeElement.querySelector('[data-testid="settings-llm-extra-model-openrouter"]')
    ).toBeNull();
    expect(component.extraProviders()[0].models).toBeNull();
  });

  it('openrouter auth failure shows the inline key error (no silent dead end)', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'discover_llm_models') throw new Error('auth');
      return undefined;
    };

    component.toggleExtraExpanded(component.extraProviders()[0]);
    component.onExtraKeyInput(component.extraProviders()[0], 'sk-or-bad');
    await component.discoverExtraModels(component.extraProviders()[0]);
    await flushMicrotasks();
    fixture.detectChanges();

    const err = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-extra-discovery-error-openrouter"]'
    );
    expect(err).not.toBeNull();
    expect(err.textContent).toContain('Authentication failed — check the API key.');
    // Still no model field — the error message is the user's signal.
    expect(
      fixture.nativeElement.querySelector('[data-testid="settings-llm-extra-model-openrouter"]')
    ).toBeNull();
  });

  it('openrouter non-auth failure shows a generic inline discovery error', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'discover_llm_models') throw new Error('connection refused');
      return undefined;
    };

    component.toggleExtraExpanded(component.extraProviders()[0]);
    component.onExtraKeyInput(component.extraProviders()[0], 'sk-or-x');
    await component.discoverExtraModels(component.extraProviders()[0]);
    await flushMicrotasks();
    fixture.detectChanges();

    const err = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-extra-discovery-error-openrouter"]'
    );
    expect(err).not.toBeNull();
    expect(err.textContent).toContain('Model discovery failed');
  });

  it('openrouter HTTP-status failure surfaces the status code inline', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'discover_llm_models') throw new Error('LLM server returned HTTP 500');
      return undefined;
    };

    component.toggleExtraExpanded(component.extraProviders()[0]);
    component.onExtraKeyInput(component.extraProviders()[0], 'sk-or-x');
    await component.discoverExtraModels(component.extraProviders()[0]);
    await flushMicrotasks();
    fixture.detectChanges();

    const err = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-extra-discovery-error-openrouter"]'
    );
    expect(err.textContent).toContain('HTTP 500');
  });

  it('a successful re-discovery clears the openrouter inline error', async () => {
    let fail = true;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'discover_llm_models') {
        if (fail) throw new Error('auth');
        return { models: [{ id: 'qwen/qwen3-coder', context_tokens: 262144 }] };
      }
      return undefined;
    };
    const errSelector = '[data-testid="settings-llm-extra-discovery-error-openrouter"]';

    component.toggleExtraExpanded(component.extraProviders()[0]);
    component.onExtraKeyInput(component.extraProviders()[0], 'sk-or-x');
    await component.discoverExtraModels(component.extraProviders()[0]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(errSelector)).not.toBeNull();

    fail = false;
    await component.discoverExtraModels(component.extraProviders()[0]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(errSelector)).toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="settings-llm-extra-model-openrouter"]')
    ).toBeNull();
    expect(
      fixture.nativeElement.querySelector(
        '[data-testid="settings-llm-extra-model-hint-openrouter"]'
      )
    ).not.toBeNull();
  });

  it('editing the openrouter key resets the inline discovery error', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'discover_llm_models') throw new Error('auth');
      return undefined;
    };
    const errSelector = '[data-testid="settings-llm-extra-discovery-error-openrouter"]';

    component.toggleExtraExpanded(component.extraProviders()[0]);
    component.onExtraKeyInput(component.extraProviders()[0], 'sk-or-bad');
    await component.discoverExtraModels(component.extraProviders()[0]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(errSelector)).not.toBeNull();

    component.onExtraKeyInput(component.extraProviders()[0], 'sk-or-new');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(errSelector)).toBeNull();
  });

  it('reloading config resets a stale openrouter discovery error (fresh rows)', async () => {
    component.extraProviders()[0].discoverError = { reason: 'auth' };

    component.ngOnInit();
    await fixture.whenStable();
    await flushMicrotasks();

    expect(component.extraProviders()[0].discoverError).toBeNull();
  });

  it('save persists the loaded context window for remote providers (no live pick)', async () => {
    let captured: Record<string, unknown> | null = null;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_llm_config') {
        return {
          provider: 'anthropic',
          model: null,
          base_url: null,
          default_base_url: null,
          providers: [
            { id: 'anthropic', kind: 'anthropic_oauth', has_api_key: false },
            {
              id: 'openrouter',
              kind: 'open_router',
              model: 'qwen/qwen3-coder',
              has_api_key: true,
              context_tokens: 262144,
            },
          ],
          active: { provider_id: 'openrouter', model: 'qwen/qwen3-coder' },
        };
      }
      if (cmd === 'update_llm_config') captured = args?.['update'] as Record<string, unknown>;
      if (cmd === 'get_auth_status')
        return { api_key_configured: false, provider_configured: true };
      if (cmd === 'discover_llm_models') throw new Error('offline');
      return undefined;
    };

    component.ngOnInit();
    await fixture.whenStable();
    await component.saveConfig();

    const providers = captured!['providers'] as Array<Record<string, unknown>>;
    const or = providers.find((p) => p['id'] === 'openrouter')!;
    expect(or['model']).toBe('qwen/qwen3-coder');
    expect(or['context_tokens']).toBe(262144);
  });

  it('save rejects an active remote provider with neither model nor key', async () => {
    let invoked = false;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'update_llm_config') invoked = true;
      return undefined;
    };
    let emitted = '';
    component.errorOccurred.subscribe((msg: string) => (emitted = msg));

    component.toggleExtraExpanded(component.extraProviders()[0]);
    component.selectExtraProvider(component.extraProviders()[0]);
    await component.saveConfig();

    expect(invoked).toBe(false);
    expect(emitted).toContain('requires an API key');
  });

  it('save accepts a keyed remote provider without a model (backend auto-defaults, ADR-085 §8)', async () => {
    let captured: Record<string, unknown> | null = null;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'update_llm_config') captured = args?.['update'] as Record<string, unknown>;
      return undefined;
    };
    let emitted = '';
    component.errorOccurred.subscribe((msg: string) => (emitted = msg));

    const row = component.extraProviders()[0];
    component.toggleExtraExpanded(row);
    component.selectExtraProvider(row);
    component.onExtraKeyInput(row, 'sk-or-fresh-key');
    fixture.detectChanges();
    expect(component['canSave']()).toBe(true);
    await component.saveConfig();

    expect(emitted).toBe('');
    expect(captured).not.toBeNull();
    const providers = captured!['providers'] as Array<Record<string, unknown>>;
    const or = providers.find((p) => p['id'] === 'openrouter')!;
    expect(or['model'] ?? null).toBeNull();
  });

  it('loadConfig never adopts a foreign model under the anthropic card (F1)', async () => {
    // Corrupted config: anthropic active + flat model both carry an OR id.
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'get_llm_config':
          return {
            provider: 'anthropic',
            model: 'nex-agi/nex-n2-pro:free',
            base_url: null,
            default_base_url: null,
            providers: [
              { id: 'anthropic', kind: 'anthropic_oauth', model: 'nex-agi/nex-n2-pro:free' },
            ],
            active: { provider_id: 'anthropic', model: 'nex-agi/nex-n2-pro:free' },
          };
        case 'list_anthropic_models':
          return TEST_ANTHROPIC_MODELS;
        case 'get_default_base_url':
          return DEFAULT_BASE_URLS[(args?.['provider'] as string) ?? ''] ?? null;
        default:
          return undefined;
      }
    };
    component.ngOnInit();
    await fixture.whenStable();
    await flushMicrotasks();

    expect(component['loadedAnthropicModel']).toBeNull();
    expect(component.model()).toBe('');
  });

  it('selectExtraProvider snapshots a freshly-edited anthropic model (F2/a1)', () => {
    component.provider.set('anthropic');
    component.selectedTarget.set('anthropic');
    component.model.set('claude-opus-4-8');
    component.selectExtraProvider(component.extraProviders()[0]);
    // The fresh card model is captured so a later Save won't lose it.
    expect(component['loadedAnthropicModel']).toBe('claude-opus-4-8');
  });

  it('onProviderChange snapshots the anthropic model when leaving the card (S4)', async () => {
    component.model.set('claude-opus-4-8');

    component.provider.set('local');
    await component.onProviderChange();

    expect(component['loadedAnthropicModel']).toBe('claude-opus-4-8');
  });

  it('onProviderChange never snapshots a foreign model from the anthropic card (S4)', async () => {
    component['loadedAnthropicModel'] = 'claude-opus-4-8';
    // Corrupted card state: a `provider/model` id must not poison the snapshot.
    component.model.set('vendor/foreign-model');

    component.provider.set('local');
    await component.onProviderChange();

    expect(component['loadedAnthropicModel']).toBe('claude-opus-4-8');
  });

  it('narrows an unknown persisted flat provider to the local card (typed domain)', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_llm_config')
        return { provider: 'mystery-llm', model: null, base_url: null, default_base_url: null };
      if (cmd === 'list_anthropic_models') return TEST_ANTHROPIC_MODELS;
      return undefined;
    };

    component.ngOnInit();
    await fixture.whenStable();
    await flushMicrotasks();

    expect(component.provider()).toBe('local');
    expect(component.selectedTarget()).toBe('local');
  });

  it('narrows a legacy generated openrouter id onto its fixed row by kind', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_llm_config':
          return {
            provider: 'openrouter-2',
            model: 'z-ai/glm-5.2',
            base_url: null,
            default_base_url: null,
            providers: [
              { id: 'anthropic', kind: 'anthropic_oauth', model: null },
              {
                id: 'openrouter-2',
                kind: 'open_router',
                model: 'z-ai/glm-5.2',
                has_api_key: true,
              },
            ],
            active: { provider_id: 'openrouter-2', model: 'z-ai/glm-5.2' },
          };
        case 'list_anthropic_models':
          return TEST_ANTHROPIC_MODELS;
        case 'discover_llm_models':
          return { models: [{ id: 'z-ai/glm-5.2', context_tokens: 200000 }] };
        default:
          return undefined;
      }
    };

    component.ngOnInit();
    await fixture.whenStable();
    await flushMicrotasks();

    expect(component.provider()).toBe('openrouter');
    expect(component.selectedTarget()).toBe('openrouter');
    expect(component.extraProviders()[0].model).toBe('z-ai/glm-5.2');
  });

  it('reload after OpenRouter-active save does not poison the anthropic card (F-5/b2)', async () => {
    // Backend config persisted while OpenRouter was active (flat masquerade = anthropic, but
    // providers[] anthropic entry stays clean) — on reload the anthropic card must not pick it up.
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'get_llm_config':
          return {
            provider: 'anthropic',
            model: null,
            base_url: null,
            default_base_url: null,
            providers: [
              { id: 'anthropic', kind: 'anthropic_oauth', model: null },
              { id: 'openrouter', kind: 'open_router', model: 'z-ai/glm-5.2', has_api_key: true },
            ],
            active: { provider_id: 'openrouter', model: 'z-ai/glm-5.2' },
          };
        case 'list_anthropic_models':
          return TEST_ANTHROPIC_MODELS;
        case 'get_default_base_url':
          return DEFAULT_BASE_URLS[(args?.['provider'] as string) ?? ''] ?? null;
        default:
          return undefined;
      }
    };
    component.ngOnInit();
    await fixture.whenStable();
    await flushMicrotasks();

    expect(component['loadedAnthropicModel']).toBeNull();
    // Switching to anthropic + building the provider set keeps the entry clean.
    component.provider.set('anthropic');
    component.selectedTarget.set('anthropic');
    const built = component['buildProviderSet'](false);
    const anthropic = built.find((p) => p.id === 'anthropic');
    expect(anthropic?.model ?? null).toBeNull();
  });

  it('loadConfig: entry model wins over a disagreeing active.model (CR#2)', async () => {
    // On-disk disagreement: openrouter entry='z-ai/glm-5.2' but active points
    // at a stale id. Entry must win (mirror Rust effective_active_model).
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'get_llm_config':
          return {
            provider: 'openrouter',
            model: 'z-ai/glm-5.2',
            base_url: null,
            default_base_url: null,
            providers: [
              { id: 'anthropic', kind: 'anthropic_oauth', model: null },
              { id: 'openrouter', kind: 'open_router', model: 'z-ai/glm-5.2', has_api_key: true },
            ],
            active: { provider_id: 'openrouter', model: 'stale/old-model' },
          };
        case 'list_anthropic_models':
          return TEST_ANTHROPIC_MODELS;
        case 'get_default_base_url':
          return DEFAULT_BASE_URLS[(args?.['provider'] as string) ?? ''] ?? null;
        default:
          return undefined;
      }
    };
    component.ngOnInit();
    await fixture.whenStable();
    await flushMicrotasks();

    const row = component.extraProviders().find((p) => p.id === 'openrouter');
    expect(row?.model).toBe('z-ai/glm-5.2');
  });

  it('save hot-reloads the proxy when the active selection is unchanged', async () => {
    const calls: string[] = [];
    mockTauri.invokeHandler = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'get_auth_status')
        return { api_key_configured: false, provider_configured: true };
      return undefined;
    };
    const projectState = TestBed.inject(ProjectStateService);
    projectState.status.set('ready'); // hot-reload requires a live stack
    const restartSpy = vi.spyOn(projectState, 'requestRestart');
    // The active project comes from the input signal (not projectState).
    fixture.componentRef.setInput('activeProject', 'proj');

    // Anthropic card active, default model — same as the loaded snapshot.
    component.provider.set('anthropic');
    component.selectedTarget.set('anthropic');
    component['loadedActiveKey'] = component['computeActiveKey'](
      'anthropic',
      null,
      component['buildProviderSet'](false)
    );
    await component.saveConfig();

    expect(calls).toContain('restart_llm_proxy');
    expect(restartSpy).not.toHaveBeenCalled();

    // Switching the active provider (no model control writes it anymore —
    // Task 18) still flips to the full restart.
    calls.length = 0;
    component.provider.set('local');
    component.selectedTarget.set('local');
    component.baseUrl.set('http://localhost:11434');
    component['loadedLocalEntry'] = {
      id: 'local',
      kind: 'local',
      base_url: 'http://localhost:11434',
      model: 'llama3.3',
      has_api_key: false,
      context_tokens: null,
      has_custom_headers: false,
    };
    await component.saveConfig();
    expect(calls).not.toContain('restart_llm_proxy');
    expect(restartSpy).toHaveBeenCalled();
  });

  it('base-url-only save on a DOWN stack requests a restart, not a hot-reload', async () => {
    // A lone proxy would accept the reload while claude stays dead — the
    // save must route through requestRestart (which also starts containers).
    const calls: string[] = [];
    mockTauri.invokeHandler = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'get_auth_status')
        return { api_key_configured: false, provider_configured: true };
      return undefined;
    };
    const projectState = TestBed.inject(ProjectStateService);
    projectState.status.set('no_provider'); // containers down
    const restartSpy = vi.spyOn(projectState, 'requestRestart');
    fixture.componentRef.setInput('activeProject', 'proj');

    component.provider.set('anthropic');
    component.selectedTarget.set('anthropic');
    component['loadedActiveKey'] = component['computeActiveKey'](
      'anthropic',
      null,
      component['buildProviderSet'](false)
    );
    await component.saveConfig();

    expect(calls).not.toContain('restart_llm_proxy');
    expect(restartSpy).toHaveBeenCalled();
  });

  it('computeActiveKey distinguishes kind and custom-headers (R6)', () => {
    const base = [
      { id: 'local', kind: 'local' as const, model: 'qwen3', has_custom_headers: false },
    ];
    const withHeaders = [
      { id: 'local', kind: 'local' as const, model: 'qwen3', has_custom_headers: true },
    ];
    const k1 = component['computeActiveKey']('local', 'qwen3', base);
    const k2 = component['computeActiveKey']('local', 'qwen3', withHeaders);
    expect(k1).not.toBe(k2);
    // Same inputs → same key (stable).
    expect(component['computeActiveKey']('local', 'qwen3', base)).toBe(k1);
    // Kind change (anthropic_oauth → anthropic_api_key) flips the key.
    const oauth = [{ id: 'anthropic', kind: 'anthropic_oauth' as const }];
    const apikey = [{ id: 'anthropic', kind: 'anthropic_api_key' as const }];
    expect(component['computeActiveKey']('anthropic', null, oauth)).not.toBe(
      component['computeActiveKey']('anthropic', null, apikey)
    );
    // I1: base_url is EXCLUDED — a base_url-only change keeps the SAME key
    // (proxy reload, not full restart).
    const url1 = [
      { id: 'local', kind: 'local' as const, model: 'qwen3', base_url: 'http://a:9000' },
    ];
    const url2 = [
      { id: 'local', kind: 'local' as const, model: 'qwen3', base_url: 'http://b:9000' },
    ];
    expect(component['computeActiveKey']('local', 'qwen3', url1)).toBe(
      component['computeActiveKey']('local', 'qwen3', url2)
    );
  });

  // ── Save dirty-check gating ──────────────────────────────────────────────

  function setupLocalLoadedConfig(mockTauri: MockTauriService): void {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_llm_config':
          return {
            provider: 'local',
            model: 'llama3.3',
            base_url: 'http://host.docker.internal:11434',
            default_base_url: 'http://host.docker.internal:11434',
            providers: [
              {
                id: 'local',
                kind: 'local',
                base_url: 'http://host.docker.internal:11434',
                model: 'llama3.3',
              },
            ],
            active: { provider_id: 'local', model: 'llama3.3' },
          };
        case 'get_auth_status':
          return { api_key_configured: false, provider_configured: true };
        case 'list_anthropic_models':
          return [];
        case 'discover_llm_models':
          throw new Error('offline');
        default:
          return undefined;
      }
    };
  }

  it('no_op_load_keeps_save_disabled_for_already_configured_local', async () => {
    setupLocalLoadedConfig(mockTauri);

    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(true);
  });

  it('editing_local_base_url_enables_save', async () => {
    // Editing base_url resets the live `model` signal, but the stored entry's
    // model (Task 18: no local UI control writes it) still satisfies canSave.
    setupLocalLoadedConfig(mockTauri);

    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]').disabled).toBe(
      true
    );

    const input = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-base-url"]'
    ) as HTMLInputElement;
    input.value = 'http://host.docker.internal:1234';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(false);
  });

  it('editing_an_active_extra_row_key_enables_save', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_llm_config':
          return {
            provider: 'anthropic',
            model: null,
            base_url: null,
            default_base_url: null,
            providers: [
              { id: 'anthropic', kind: 'anthropic_oauth', has_api_key: false },
              { id: 'openrouter', kind: 'open_router', model: 'deepseek/v4', has_api_key: true },
            ],
            active: { provider_id: 'openrouter', model: 'deepseek/v4' },
          };
        case 'get_auth_status':
          return { api_key_configured: false, provider_configured: true };
        case 'list_anthropic_models':
          return [];
        case 'discover_llm_models':
          throw new Error('offline');
        default:
          return undefined;
      }
    };

    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]').disabled).toBe(
      true
    );

    const row = component.extraProviders().find((p) => p.id === 'openrouter')!;
    component.onExtraKeyInput(row, 'sk-or-new');
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(false);
  });

  it('switching_to_a_different_already_valid_provider_enables_save', async () => {
    // Switching the active target changes what Save would persist (`active`),
    // even though both anthropic and local are independently already valid.
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'get_llm_config':
          return {
            provider: 'anthropic',
            model: null,
            base_url: null,
            default_base_url: 'http://host.docker.internal:11434',
            providers: [
              { id: 'anthropic', kind: 'anthropic_oauth', has_api_key: false },
              {
                id: 'local',
                kind: 'local',
                base_url: 'http://host.docker.internal:11434',
                model: 'llama3.3',
              },
            ],
            active: { provider_id: 'anthropic', model: null },
          };
        case 'get_auth_status':
          return { api_key_configured: false, oauth_authenticated: true };
        case 'list_anthropic_models':
          return [];
        case 'discover_llm_models':
          throw new Error('offline');
        default:
          return undefined;
      }
    };

    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]').disabled).toBe(
      true
    );

    await component.selectProvider('local');
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(false);
  });

  it('save_then_reload_then_no_edit_ends_with_save_disabled_again', async () => {
    setupLocalLoadedConfig(mockTauri);

    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]').disabled).toBe(
      true
    );

    // No model control to edit anymore (Task 18) — drive dirty state via base_url instead.
    component['onBaseUrlInput']('http://host.docker.internal:9999');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]').disabled).toBe(
      false
    );

    let invokedArgs: Record<string, unknown> = {};
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'update_llm_config') {
        invokedArgs = args ?? {};
        return undefined;
      }
      if (cmd === 'get_auth_status')
        return { api_key_configured: false, provider_configured: true };
      return undefined;
    };

    await component.saveConfig();
    expect((invokedArgs['update'] as Record<string, unknown>)['base_url']).toBe(
      'http://host.docker.internal:9999'
    );
    // The local entry's model must survive the resave untouched (no control writes it).
    const update = invokedArgs['update'] as Record<string, unknown>;
    const providers = update['providers'] as Array<Record<string, unknown>>;
    expect(providers.find((p) => p['id'] === 'local')?.['model']).toBe('llama3.3');
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn.disabled).toBe(true);
  });

  // ── Anthropic auth, absorbed from the former Authentication section ─────

  it('loads auth status and renders the connected pills', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') {
        return { api_key_configured: false, oauth_authenticated: true, provider_configured: true };
      }
      return undefined;
    };
    fixture.componentRef.setInput('activeProject', 'proj');
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();

    expect(component.oauthAuthenticated()).toBe(true);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="auth-status-value"]')?.textContent).toContain(
      'connected'
    );
    expect(el.querySelector('[data-testid="auth-status-method"]')?.textContent).toContain('oauth');
  });

  it('saves and removes the anthropic api key via the secrets commands', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (cmd === 'get_auth_status') {
        return { api_key_configured: true, oauth_authenticated: false, provider_configured: true };
      }
      return undefined;
    };
    fixture.componentRef.setInput('activeProject', 'proj');
    component.anthropicApiKeyInput.set('sk-ant-test');

    await component.saveAnthropicApiKey();
    expect(calls.some(([c, a]) => c === 'save_api_key' && a?.['apiKey'] === 'sk-ant-test')).toBe(
      true
    );
    expect(component.anthropicApiKeyInput()).toBe('');
    expect(component.apiKeyConfigured()).toBe(true);

    await component.deleteAnthropicApiKey();
    expect(calls.some(([c]) => c === 'delete_api_key')).toBe(true);
  });

  it('refreshes auth status when the oauth terminal completes', async () => {
    let statusCalls = 0;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') {
        statusCalls += 1;
        return { api_key_configured: false, oauth_authenticated: true, provider_configured: true };
      }
      return undefined;
    };
    fixture.componentRef.setInput('activeProject', 'proj');

    await component.onOAuthDone(true);
    expect(statusCalls).toBeGreaterThan(0);
    expect(component.oauthAuthenticated()).toBe(true);
  });

  it('renders the not-configured pill when neither auth method is set up', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') {
        return { api_key_configured: false, oauth_authenticated: false, provider_configured: true };
      }
      return undefined;
    };
    fixture.componentRef.setInput('activeProject', 'proj');
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="auth-status-value"]')?.textContent).toContain(
      'not configured'
    );
    expect(el.querySelector('[data-testid="auth-status-method"]')).toBeNull();
  });

  it('guards the anthropic key commands when no project is active', async () => {
    const calls: string[] = [];
    mockTauri.invokeHandler = async (cmd: string) => {
      calls.push(cmd);
      return undefined;
    };
    fixture.componentRef.setInput('activeProject', null);
    component.anthropicApiKeyInput.set('sk-ant-test');

    await component.saveAnthropicApiKey();
    await component.deleteAnthropicApiKey();

    expect(calls).not.toContain('save_api_key');
    expect(calls).not.toContain('delete_api_key');
  });

  it('emits the error when saving or deleting the anthropic key fails', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'save_api_key') throw new Error('keychain locked');
      if (cmd === 'delete_api_key') throw new Error('delete failed');
      return undefined;
    };
    const errors: string[] = [];
    component.errorOccurred.subscribe((m: string) => errors.push(m));
    fixture.componentRef.setInput('activeProject', 'proj');
    component.anthropicApiKeyInput.set('sk-ant-test');

    await component.saveAnthropicApiKey();
    expect(errors).toContain('keychain locked');

    await component.deleteAnthropicApiKey();
    expect(errors).toContain('delete failed');
  });
});
