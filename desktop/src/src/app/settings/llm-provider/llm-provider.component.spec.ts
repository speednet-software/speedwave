import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LlmProviderComponent } from './llm-provider.component';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { AnthropicModelsService } from '../../services/anthropic-models.service';
import { ChatStateService } from '../../services/chat-state.service';
import { LoggerService } from '../../services/logger.service';
import { type AnthropicModel } from '../../models/llm';
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
 * Drains pending microtasks. After triggering `ngOnInit`, the component fires
 * `loadConfig` as fire-and-forget; chained awaits inside it (auto-probe via
 * `discoverModels`) require multiple microtask cycles before the discovery
 * state settles. `whenStable` only flushes Zone tasks — these promises live
 * outside Zone in vitest, so we drain them explicitly.
 * @param cycles - How many `await Promise.resolve()` ticks to drain.
 */
async function flushMicrotasks(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    await Promise.resolve();
  }
}

/**
 * Stable test fixture mirroring `speedwave_runtime::defaults::AnthropicModelInfo`.
 * Keep `context_tokens` values in sync with `crates/speedwave-runtime/src/defaults.rs`.
 */
const TEST_ANTHROPIC_MODELS = [
  {
    id: 'claude-fable-5',
    family: 'Fable 5',
    context_tokens: 1_000_000,
    latest: true,
  },
  {
    id: 'claude-opus-4-8',
    family: 'Opus 4.8',
    context_tokens: 1_000_000,
    latest: true,
  },
  {
    id: 'claude-sonnet-4-6',
    family: 'Sonnet 4.6',
    context_tokens: 1_000_000,
    latest: true,
  },
  {
    id: 'claude-haiku-4-5',
    family: 'Haiku 4.5',
    context_tokens: 200_000,
    latest: true,
  },
  {
    id: 'claude-opus-4-7',
    family: 'Opus 4.7',
    context_tokens: 1_000_000,
    latest: false,
  },
  {
    id: 'claude-opus-4-6',
    family: 'Opus 4.6',
    context_tokens: 1_000_000,
    latest: false,
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
      case 'get_default_anthropic_model_label':
        return 'Opus 4.8';
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

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('has correct default values', () => {
    expect(component.provider).toBe('anthropic');
    expect(component.model).toBe('');
    expect(component.baseUrl).toBe('');
    expect(component.saving).toBe(false);
    expect(component.saved).toBe(false);
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
    expect(component.provider).toBe('local');
    expect(component.legacyMigrationProvider).toBe('ollama');
    expect(component.provider).not.toBe('ollama');
    expect(component.model).toBe('llama3.3');
    expect(component.baseUrl).toBe('http://localhost:11434');
    expect(component.defaultBaseUrl).toBe('http://host.docker.internal:11434');
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

  it('emits providerChange when provider selection changes', async () => {
    const spy = vi.fn();
    component.providerChange.subscribe(spy);

    component.provider = 'ollama';
    await component.onProviderChange();

    expect(spy).toHaveBeenCalledWith('ollama');
  });

  it('returns an empty Anthropic placeholder while the SSOT catalog is loading', () => {
    // No catalog yet (reset in beforeEach) — must not flash a stale hard-coded
    // model id; the hint is derived from the backend SSOT, blank until loaded.
    component.provider = 'anthropic';
    expect(component.modelPlaceholder()).toBe('');
  });

  it('derives the Anthropic placeholder from the SSOT catalog (latest non-Opus)', async () => {
    // Once the catalog loads, the placeholder is the latest non-Opus (Sonnet)
    // model id, not a hard-coded literal.
    await TestBed.inject(AnthropicModelsService).list();
    component.provider = 'anthropic';
    expect(component.modelPlaceholder()).toBe('claude-sonnet-4-6');
  });

  it('returns the local placeholder for non-Anthropic providers', () => {
    component.provider = 'local';
    expect(component.modelPlaceholder()).toBe('llama3.3');
  });

  it('saves config and sets saved flag', async () => {
    component.provider = 'ollama';
    component.model = 'llama3.3';
    component.baseUrl = 'http://localhost:11434';

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
    expect(component.saved).toBe(true);
    expect(component.saving).toBe(false);
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
    expect(component.saving).toBe(false);
    expect(component.saved).toBe(false);
  });

  it('emits providerChange on successful save', async () => {
    const spy = vi.fn();
    component.providerChange.subscribe(spy);
    component.provider = 'ollama';
    component.model = 'llama3.3';

    await component.saveConfig();

    expect(spy).toHaveBeenCalledWith('ollama');
  });

  it('requests container restart on successful save', async () => {
    const projectState = TestBed.inject(ProjectStateService);
    projectState.needsRestart = false;
    component.provider = 'ollama';
    component.model = 'llama3.3';

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

  it('sends null for empty optional fields', async () => {
    let invokedArgs: Record<string, unknown> = {};
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'update_llm_config') {
        invokedArgs = args ?? {};
        return undefined;
      }
      return undefined;
    };

    component.provider = 'anthropic';
    component.model = '';
    component.baseUrl = '';

    await component.saveConfig();

    const update = invokedArgs['update'] as Record<string, unknown>;
    expect(update['model']).toBeNull();
    expect(update['base_url']).toBeNull();
    expect(update['apiKeyEnv']).toBeUndefined();
  });

  it('hot-reloads the proxy with the input-signal project, not projectState', async () => {
    // T10 regression: saveConfig must read the active project from the
    // activeProject() input, not ProjectStateService. When the active
    // selection is unchanged, it hot-reloads litellm for that project.
    fixture.componentRef.setInput('activeProject', 'proj-from-input');
    const projectState = TestBed.inject(ProjectStateService);
    projectState.activeProject = 'wrong-project';

    let restartProject: unknown = null;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'restart_llm_proxy') {
        restartProject = args?.['project'];
        return undefined;
      }
      return undefined;
    };

    component.provider = 'anthropic';
    component.model = '';
    // Make the active selection unchanged so the hot-reload branch fires.
    component['loadedActiveKey'] = 'anthropic|';

    await component.saveConfig();

    expect(restartProject).toBe('proj-from-input');
    expect(projectState.needsRestart).toBe(false);
  });

  it('writes provider keys before the config and aborts the config on key failure', async () => {
    // T11 regression: a per-provider key write must precede update_llm_config,
    // so a key failure leaves config and keys consistent (neither applied).
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
    const row = component.extraProviders.find((r) => r.id === 'openrouter');
    expect(row).toBeDefined();
    row!.keyInput = 'sk-or-test';
    row!.keyTouched = true;

    await component.saveConfig();

    expect(calls).toContain('set_llm_provider_key');
    expect(calls).not.toContain('update_llm_config');
    expect(errorSpy).toHaveBeenCalledWith('key write failed');
    expect(component.saved).toBe(false);
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

    it('resolves Anthropic context_tokens from the SSOT catalog', async () => {
      // Pre-populate the catalog signal that the component uses for the save
      // path. The catalog is loaded via AnthropicModelsService → list_anthropic_models;
      // we set it directly to keep the test focused on the resolution logic.
      const cmp = component as unknown as {
        anthropicCatalog: { set: (v: AnthropicModel[]) => void };
      };
      cmp.anthropicCatalog.set(TEST_ANTHROPIC_MODELS);
      component.provider = 'anthropic';
      component.model = 'claude-opus-4-7';
      const update = await captureUpdate();
      expect(update['context_tokens']).toBe(1_000_000);
    });

    it('resolves local-provider context_tokens from the discovery payload', async () => {
      const cmp = component as unknown as {
        discoveryState: { kind: 'ready'; models: { id: string; context_tokens?: number }[] };
      };
      cmp.discoveryState = {
        kind: 'ready',
        models: [{ id: 'llama3.3', context_tokens: 32_768 }],
      };
      component.provider = 'ollama';
      component.model = 'llama3.3';
      component.baseUrl = 'http://localhost:11434';
      const update = await captureUpdate();
      expect(update['context_tokens']).toBe(32_768);
    });

    it('falls back to loadedLocalContextTokens when discovery has not run', async () => {
      // Simulates: user opens Settings, the cache from get_llm_config carries
      // a previously-discovered context window, the user saves without
      // clicking "Refresh models" — we must not wipe the persisted value.
      const cmp = component as unknown as {
        discoveryState: { kind: string };
        loadedLocalContextTokens: number | null;
      };
      cmp.discoveryState = { kind: 'idle' };
      cmp.loadedLocalContextTokens = 16_384;
      component.provider = 'ollama';
      component.model = 'llama3.3';
      component.baseUrl = 'http://localhost:11434';
      const update = await captureUpdate();
      expect(update['context_tokens']).toBe(16_384);
    });

    it('sends null context_tokens when the model is empty', async () => {
      component.provider = 'anthropic';
      component.model = '';
      const update = await captureUpdate();
      expect(update['context_tokens']).toBeNull();
    });

    it('sends null context_tokens when the model is unknown to the Anthropic catalog', async () => {
      const cmp = component as unknown as {
        anthropicCatalog: { set: (v: AnthropicModel[]) => void };
      };
      cmp.anthropicCatalog.set(TEST_ANTHROPIC_MODELS);
      component.provider = 'anthropic';
      component.model = 'claude-fictional-9-9';
      const update = await captureUpdate();
      expect(update['context_tokens']).toBeNull();
    });
  });

  it('refreshes ChatStateService cache after a successful save', async () => {
    // Without this, the chat footer keeps showing the previous model's
    // context window until the next session starts.
    const chatState = TestBed.inject(ChatStateService);
    const refreshSpy = vi.spyOn(chatState, 'refreshLlmConfigCache').mockResolvedValue();
    component.provider = 'ollama';
    component.model = 'llama3.3';
    component.baseUrl = 'http://localhost:11434';
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
    component.provider = 'ollama';
    component.model = 'llama3.3';
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
    component.provider = 'anthropic';
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

  it('shows a backend-served model dropdown for anthropic (no base_url field)', async () => {
    component.provider = 'anthropic';
    component.selectedTarget = 'anthropic';
    component.ngOnInit();
    await fixture.whenStable();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    // The unified-list redesign (ADR-073) drops the read-only base_url
    // field for anthropic — routing is the proxy's concern, not the user's.
    const baseUrlInput = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-base-url"]'
    );
    expect(baseUrlInput).toBeNull();

    const modelEl = fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]');
    expect(modelEl).not.toBeNull();
    expect(modelEl.tagName).toBe('SELECT');
    const options = Array.from(modelEl.querySelectorAll('option')).map(
      (o) => (o as HTMLOptionElement).value
    );
    // Default option (empty value, "let Claude Code choose") plus every
    // catalog id served by the backend SSOT — the component must not add
    // or drop entries on its own. Order mirrors the catalog: latest first,
    // legacy after.
    expect(options).toEqual([
      '',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'claude-opus-4-7',
      'claude-opus-4-6',
    ]);
    const defaultLabel = (
      modelEl.querySelector('option[value=""]') as HTMLOptionElement
    )?.textContent?.trim();
    // Default option carries the SSOT-resolved Opus family label so the
    // user knows which model the alias-mode actually steers toward. The
    // exact string is verified by the dedicated tests below.
    expect(defaultLabel?.toLowerCase()).toContain('default');

    // Latest entries land in an optgroup labelled "Latest" so users see
    // the recommended families at the top.
    const latestGroup = modelEl.querySelector('optgroup[label="Latest"]') as HTMLOptGroupElement;
    expect(latestGroup).not.toBeNull();
    const latestIds = Array.from(latestGroup.querySelectorAll('option')).map(
      (o) => (o as HTMLOptionElement).value
    );
    expect(latestIds).toEqual([
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);

    // Legacy entries are visible but quarantined to the "Legacy" optgroup.
    const legacyGroup = modelEl.querySelector('optgroup[label="Legacy"]') as HTMLOptGroupElement;
    expect(legacyGroup).not.toBeNull();
    const legacyIds = Array.from(legacyGroup.querySelectorAll('option')).map(
      (o) => (o as HTMLOptionElement).value
    );
    expect(legacyIds).toEqual(['claude-opus-4-7', 'claude-opus-4-6']);

    // Labels carry the family + context window so users see the same
    // ctx value the chat footer reports (1M for Opus 4.8, 200k for Haiku).
    const opus48Label = (
      modelEl.querySelector('option[value="claude-opus-4-8"]') as HTMLOptionElement
    )?.textContent?.trim();
    expect(opus48Label).toContain('Opus 4.8');
    expect(opus48Label).toContain('1M ctx');
    const haikuLabel = (
      modelEl.querySelector('option[value="claude-haiku-4-5"]') as HTMLOptionElement
    )?.textContent?.trim();
    expect(haikuLabel).toContain('200k ctx');
  });

  it('preserves a previously-saved model id that is no longer in the SSOT catalog', async () => {
    // A user might have persisted a model id that has since been pulled
    // from the catalog (deprecated, retired). Surface it as a stand-alone
    // option marked "(not in catalog)" instead of silently resetting the
    // selection — the UI must reflect what is actually in their config.
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'get_llm_config':
          return {
            provider: 'anthropic',
            model: 'claude-opus-4-1',
            base_url: null,
            default_base_url: null,
          };
        case 'get_default_base_url':
          return DEFAULT_BASE_URLS[(args?.['provider'] as string) ?? ''] ?? null;
        case 'list_anthropic_models':
          return TEST_ANTHROPIC_MODELS;
        case 'get_default_anthropic_model_label':
          return 'Opus 4.8';
        default:
          return undefined;
      }
    };
    component.ngOnInit();
    await fixture.whenStable();
    await flushMicrotasks();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const modelEl = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-model"]'
    ) as HTMLSelectElement;
    const stray = Array.from(modelEl.querySelectorAll('option'))
      .map((o) => o as HTMLOptionElement)
      .find((o) => o.value === 'claude-opus-4-1');
    expect(stray).toBeTruthy();
    expect(stray?.textContent).toContain('not in catalog');
  });

  it('renders dynamic Default — <family> label when backend returns a label', async () => {
    // Backend SSOT returns the Opus family label so the dropdown surfaces
    // what `(default)` actually steers toward (alias mode → Opus 4.8 today).
    // Anything but the dynamic form would hide the resolved model from the
    // user — exactly the regression this PR fixes.
    component.ngOnInit();
    await fixture.whenStable();
    await flushMicrotasks();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const modelEl = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-model"]'
    ) as HTMLSelectElement;
    const defaultLabel = (
      modelEl.querySelector('option[value=""]') as HTMLOptionElement
    )?.textContent?.trim();
    expect(defaultLabel).toBe('Default — Opus 4.8 (switchable via /model)');
  });

  it('falls back to the generic placeholder when backend returns null', async () => {
    // Older backends (or backends in dev mode without the new command)
    // may return null. The component must keep the generic placeholder
    // wording rather than render a broken half-string.
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'get_llm_config':
          return {
            provider: 'anthropic',
            model: null,
            base_url: null,
            default_base_url: null,
          };
        case 'get_default_base_url':
          return DEFAULT_BASE_URLS[(args?.['provider'] as string) ?? ''] ?? null;
        case 'list_anthropic_models':
          return TEST_ANTHROPIC_MODELS;
        case 'get_default_anthropic_model_label':
          return null;
        default:
          return undefined;
      }
    };
    component.ngOnInit();
    await fixture.whenStable();
    await flushMicrotasks();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const modelEl = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-model"]'
    ) as HTMLSelectElement;
    const defaultLabel = (
      modelEl.querySelector('option[value=""]') as HTMLOptionElement
    )?.textContent?.trim();
    expect(defaultLabel).toBe('(default — let Claude Code choose)');
  });

  it('shows model and base URL fields for ollama provider', async () => {
    component.provider = 'ollama';
    component.selectedTarget = 'local';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const modelInput = fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]');
    expect(modelInput).not.toBeNull();

    const baseUrlInput = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-base-url"]'
    );
    expect(baseUrlInput).not.toBeNull();
  });

  it('shows model and base URL fields for lmstudio provider', async () => {
    component.provider = 'lmstudio';
    component.selectedTarget = 'local';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const baseUrlInput = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-base-url"]'
    );
    expect(baseUrlInput).not.toBeNull();
  });

  it('shows model and base URL fields for llamacpp provider', async () => {
    component.provider = 'llamacpp';
    component.selectedTarget = 'local';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const baseUrlInput = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-base-url"]'
    );
    expect(baseUrlInput).not.toBeNull();
  });

  it('uses default_base_url from backend as placeholder', async () => {
    component.provider = 'ollama';
    component.selectedTarget = 'local';
    component.defaultBaseUrl = 'http://host.docker.internal:11434';
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

    component.provider = 'ollama';
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

  it('renders_select_on_happy_path', async () => {
    setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      discover: async () => ['llama3.3', 'qwen2.5'],
    });
    component.ngOnInit();
    // loadConfig is fire-and-forget inside ngOnInit; flush all queued micro-
    // tasks (loadConfig → auto-probe discoverModels) before assertions.
    await flushMicrotasks();
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]');
    expect(select).not.toBeNull();
    expect(select.tagName).toBe('SELECT');
    const opts = Array.from(select.querySelectorAll('option') as NodeListOf<Element>).map((o) =>
      (o.textContent || '').trim()
    );
    expect(opts).toContain('llama3.3');
    expect(opts).toContain('qwen2.5');
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
    fixture.detectChanges();

    const el = fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]');
    expect(el).not.toBeNull();
    expect(el.tagName).toBe('INPUT');
    expect(component.discoveryState.kind).toBe('failed');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('skips_discovery_for_anthropic', async () => {
    const { discoverCalls } = setupDiscoveryMock(mockTauri, { provider: 'anthropic' });
    await component.ngOnInit();
    await fixture.whenStable();
    expect(discoverCalls.length).toBe(0);
  });

  it('blur_retriggers_discovery', async () => {
    const { discoverCalls } = setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      defaultBaseUrl: 'http://host.docker.internal:11434',
      discover: async () => ['m1'],
    });
    await component.ngOnInit();
    await fixture.whenStable();
    const callsAfterInit = discoverCalls.length;
    component.baseUrl = 'http://localhost:1234';
    await component.discoverModels(false);
    expect(discoverCalls.length).toBeGreaterThan(callsAfterInit);
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

  it('dedupes_provider_change_and_blur_on_same_url', async () => {
    // While a probe is in-flight against URL X, a second trigger with the
    // same URL must be deduped (return without invoking). Use a hanging
    // promise so we can issue the second trigger before the first resolves.
    let resolveFirst: (v: string[]) => void = () => {};
    const hanging = new Promise<string[]>((resolve) => {
      resolveFirst = resolve;
    });
    const { discoverCalls } = setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      discover: async () => await hanging,
    });
    // Bypass ngOnInit — set state directly so we can control timing.
    component.provider = 'ollama';
    component.baseUrl = 'http://localhost:11434';
    const firstCall = component.discoverModels(false);
    // Same URL, while first is pending → must dedupe.
    await component.discoverModels(false);
    expect(discoverCalls.length).toBe(1);
    resolveFirst(['m']);
    await firstCall;
  });

  it('discards_stale_response_on_rapid_blur', async () => {
    // First blur is slow; change URL; second blur returns fast. Final state
    // must reflect the second URL, not the first.
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
    component.provider = 'ollama';
    component.baseUrl = 'http://a.invalid';
    const firstCall = component.discoverModels(false);
    // Flush the first invoke so its await on `slow` is reached before we
    // mutate baseUrl (otherwise a change-detection flush may conflate them).
    await Promise.resolve();
    component.baseUrl = 'http://b.invalid';
    await component.discoverModels(false);
    // Now let the first probe finish with a stale result.
    resolveFirst(['model-from-first']);
    await firstCall;
    await fixture.whenStable();
    expect(component.discoveryState.kind).toBe('ready');
    if (component.discoveryState.kind === 'ready') {
      expect(component.discoveryState.models).toEqual([{ id: 'model-from-second' }]);
      expect(component.discoveryState.url).toBe('http://b.invalid');
    }
  });

  it('onProviderChange_clears_stale_models', async () => {
    setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      discover: async () => ['m'],
    });
    component.ngOnInit();
    await flushMicrotasks();
    expect(component.discoveryState.kind).toBe('ready');
    // Switching provider resets state synchronously. The new provider has a
    // known defaultBaseUrl so the new discovery probe fires immediately,
    // moving state to `in-flight` — either way the stale `ready` is cleared.
    component.provider = 'lmstudio';
    const p = component.onProviderChange();
    expect(['idle', 'in-flight']).toContain(component.discoveryState.kind);
    expect(component.discoveryState.kind).not.toBe('ready');
    await p;
  });

  it('preserves_legacy_model_spoza_listy', async () => {
    // A persisted model name must survive loadConfig even when the stored
    // base_url is non-default (discovery is not auto-triggered on startup for
    // user-supplied URLs). The model field stays as a text input so the user
    // can see and edit their persisted value.
    setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      model: 'legacy',
      baseUrl: 'http://localhost:11434',
      discover: async () => ['a', 'b'],
    });
    await component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();

    // Model value is preserved from config even without auto-discovery.
    expect(component.model).toBe('legacy');
    // No auto-probe → discoveryState stays idle → model field is a text INPUT.
    expect(component.discoveryState.kind).toBe('idle');
    const el = fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]');
    expect(el).not.toBeNull();
    expect(el.tagName).toBe('INPUT');
  });

  it('preserves_legacy_model_when_default_url_auto_probed', async () => {
    // When baseUrl is empty (falls back to default), auto-probe fires and
    // discovery returns a list. If the persisted model is in the list, it is
    // kept; if not, the first discovered model is auto-selected. Either way
    // the model <select> is rendered with all discovered options.
    setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      model: 'legacy',
      baseUrl: null as unknown as string,
      defaultBaseUrl: 'http://host.docker.internal:11434',
      discover: async () => ['legacy', 'a', 'b'],
    });
    component.ngOnInit();
    await flushMicrotasks();
    fixture.detectChanges();

    expect(component.model).toBe('legacy');
    const select = fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]');
    expect(select).not.toBeNull();
    expect(select.tagName).toBe('SELECT');
    const opts = Array.from(select.querySelectorAll('option') as NodeListOf<Element>).map((o) =>
      (o.getAttribute('value') || '').toString()
    );
    expect(opts).toContain('legacy');
    expect(opts).toContain('a');
    expect(opts).toContain('b');
  });

  it('non_default_stored_base_url_stays_idle_on_init', async () => {
    // Non-default URL (including link-local / RFC1918 addresses) must NOT be
    // auto-probed on startup. discoveryState stays idle; user must explicitly
    // click Refresh or blur the Base URL field to trigger a probe.
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
    expect(component.discoveryState.kind).toBe('idle');
    const el = fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]');
    expect(el.tagName).toBe('INPUT');
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
    expect(component.discoveryState.kind).toBe('failed');
  });

  it('skips_auto_probe_for_persisted_non_default_url', async () => {
    // A cloned malicious repo could set base_url to an internal RFC1918 host.
    // Opening Settings must NOT silently probe that host — the user must
    // explicitly click Refresh or blur the Base URL field.
    const { discoverCalls } = setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      baseUrl: 'http://192.168.1.50:11434',
      defaultBaseUrl: 'http://host.docker.internal:11434',
      discover: async () => ['malicious-model'],
    });

    await component.ngOnInit();
    await fixture.whenStable();

    expect(discoverCalls.length).toBe(0);
    expect(component.discoveryState.kind).toBe('idle');
  });

  it('onProviderChange_increments_counter_before_state_reset', async () => {
    // Invariant: the discoveryCounter is bumped synchronously inside
    // onProviderChange so that any in-flight response from the previous
    // provider (which carries the OLD id) is discarded when it arrives.
    setupDiscoveryMock(mockTauri, { provider: 'ollama' });
    // Seed the counter at a known value via a private-field cast.
    (component as unknown as Record<string, number>)['discoveryCounter'] = 5;
    component.provider = 'ollama';
    // Plant a stale in-flight state with the current (pre-bump) id.
    component.discoveryState = {
      kind: 'in-flight',
      url: 'http://prev',
      id: 5, // matches seeded counter — will be stale after bump
    };
    component.provider = 'lmstudio';
    await component.onProviderChange();

    // Counter must have grown beyond 5 (bumped at least once in onProviderChange,
    // possibly again inside discoverModels). Any response carrying id=5 is now stale.
    const currentCounter = (component as unknown as Record<string, number>)['discoveryCounter'];
    expect(currentCounter).toBeGreaterThan(5);

    // If a discoverModels probe is in-flight, its id must also be > 5,
    // confirming the stale id=5 response would be rejected on arrival.
    if (component.discoveryState.kind === 'in-flight') {
      expect(component.discoveryState.id).toBeGreaterThan(5);
    }
  });

  // ── DiscoveryState.reason: unsupported / empty categories ────────────

  it('maps_unsupported_error_to_unsupported_reason', async () => {
    // Backend returns Err("unsupported") for anthropic-like providers.
    // The component must map the "unsupported" message to reason='unsupported'
    // and show a different message than the offline case.
    setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      discover: async () => {
        throw new Error('unsupported');
      },
    });
    component.provider = 'ollama';
    component.baseUrl = 'http://localhost:11434';
    await component.discoverModels(false);

    expect(component.discoveryState.kind).toBe('failed');
    if (component.discoveryState.kind === 'failed') {
      expect(component.discoveryState.reason).toBe('unsupported');
    }
    const unsupportedMsg = component.discoveryFailureMessage();
    expect(unsupportedMsg.length).toBeGreaterThan(0);
    // Must differ from the offline message produced by reason='offline'.
    const offlineMsg = (() => {
      const saved = component.discoveryState;
      component.discoveryState = {
        kind: 'failed',
        url: 'http://localhost:11434',
        reason: 'offline',
      };
      const m = component.discoveryFailureMessage();
      component.discoveryState = saved;
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
    component.provider = 'ollama';
    component.baseUrl = 'http://localhost:11434';
    await component.discoverModels(false);

    expect(component.discoveryState.kind).toBe('failed');
    if (component.discoveryState.kind === 'failed') {
      expect(component.discoveryState.reason).toBe('other');
    }
    const otherMsg = component.discoveryFailureMessage();
    expect(otherMsg.length).toBeGreaterThan(0);
    // Must differ from the offline message.
    const offlineMsg = (() => {
      const saved = component.discoveryState;
      component.discoveryState = {
        kind: 'failed',
        url: 'http://localhost:11434',
        reason: 'offline',
      };
      const m = component.discoveryFailureMessage();
      component.discoveryState = saved;
      return m;
    })();
    expect(otherMsg).not.toBe(offlineMsg);
  });

  // ── saveConfig: effectiveBaseUrl fallback for local providers ─────────

  it('save_falls_back_to_default_base_url_for_local_provider_with_blank_url', async () => {
    // When the user leaves Base URL blank for a local provider, saveConfig
    // must fall back to defaultBaseUrl so compose can inject ANTHROPIC_BASE_URL.
    // An empty string or null would leave the container without a base URL.
    let invokedArgs: Record<string, unknown> = {};
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'update_llm_config') {
        invokedArgs = args ?? {};
        return undefined;
      }
      return undefined;
    };

    component.provider = 'ollama';
    component.baseUrl = '';
    component.defaultBaseUrl = 'http://host.docker.internal:11434';
    component.model = 'llama3.3';

    await component.saveConfig();

    const update = invokedArgs['update'] as Record<string, unknown>;
    expect(update['base_url']).toBe('http://host.docker.internal:11434');
    expect(update['base_url']).not.toBeNull();
    expect(update['base_url']).not.toBe('');
  });

  it('save_rejects_local_provider_with_empty_model', async () => {
    // UX guard: compose::apply_llm_config rejects a null model for local
    // providers, but that error only surfaces at container start. Catching
    // it at Save time gives immediate feedback.
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

    component.provider = 'ollama';
    component.baseUrl = 'http://localhost:11434';
    component.model = '';

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

    component.provider = 'anthropic';
    component.baseUrl = '';
    component.model = '';

    await component.saveConfig();

    expect(invokeCalled).toBe(true);
  });

  // ── Remote providers (ADR-073) ──────────────────────────────────────────

  it('renders the two permanent remote rows with no add or remove controls', () => {
    expect(component.extraProviders.map((p) => p.id)).toEqual(['openrouter', 'compat']);
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="settings-llm-extra-openrouter"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="settings-llm-extra-compat"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="settings-llm-add-openrouter"]')).toBeNull();
    expect(el.querySelector('[data-testid="settings-llm-add-compat"]')).toBeNull();
    expect(el.querySelector('[data-testid="settings-llm-extra-remove-openrouter"]')).toBeNull();
  });

  it('does not persist unconfigured permanent rows', async () => {
    let captured: Record<string, unknown> | null = null;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'update_llm_config') captured = args?.['update'] as Record<string, unknown>;
      if (cmd === 'get_auth_status') return { api_key_configured: false };
      return undefined;
    };

    component.provider = 'anthropic';
    component.selectedTarget = 'anthropic';
    await component.saveConfig();

    const ids = (captured!['providers'] as Array<Record<string, unknown>>).map((p) => p['id']);
    expect(ids).not.toContain('openrouter');
    expect(ids).not.toContain('compat');
  });

  it('toggles a row open and closed without changing the active provider', () => {
    const entry = component.extraProviders[1];
    const activeBefore = component.selectedTarget;

    component.toggleExtraExpanded(entry);
    expect(component.expandedExtraId).toBe(entry.id);
    component.toggleExtraExpanded(entry);
    expect(component.expandedExtraId).toBeNull();
    expect(component.selectedTarget).toBe(activeBefore);
  });

  it('whole-bar click activates a row; second click toggles its panel', () => {
    const entry = component.extraProviders[0];

    component.onExtraHeaderClick(entry);
    expect(component.selectedTarget).toBe('openrouter');
    expect(component.expandedExtraId).toBe('openrouter');

    component.onExtraHeaderClick(entry);
    expect(component.selectedTarget).toBe('openrouter');
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
      if (cmd === 'get_auth_status') return { api_key_configured: false };
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

    expect(component.baseUrl).toBe('http://host.docker.internal:9000');
    expect(component.model).toBe('unsloth/Qwen3.6-35B-A3B');
  });

  it('saves an api key on a non-active row without requiring a model', async () => {
    const keyCalls: Array<Record<string, unknown>> = [];
    let captured: Record<string, unknown> | null = null;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'update_llm_config') captured = args?.['update'] as Record<string, unknown>;
      if (cmd === 'set_llm_provider_key') keyCalls.push(args ?? {});
      if (cmd === 'get_auth_status') return { api_key_configured: false };
      return undefined;
    };

    component.provider = 'anthropic';
    component.selectedTarget = 'anthropic';
    component.toggleExtraExpanded(component.extraProviders[0]);
    component.onExtraKeyInput(component.extraProviders[0], 'sk-or-v1-fresh');

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
      if (cmd === 'get_auth_status') return { api_key_configured: false };
      return undefined;
    };

    component.toggleExtraExpanded(component.extraProviders[0]);
    const extra = component.extraProviders[0];
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

  it('openrouter rows fetch the tool-capable catalog and render a dropdown', async () => {
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

    component.toggleExtraExpanded(component.extraProviders[0]);
    await flushMicrotasks();
    fixture.detectChanges();

    expect(discoverArgs).toEqual([{ provider: 'openrouter', baseUrl: '' }]);
    const select = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-extra-model-openrouter"]'
    ) as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.textContent).toContain('deepseek/deepseek-v3.2 (164k)');

    component.onExtraModelSelect(component.extraProviders[0], 'qwen/qwen3-coder');
    expect(component.extraProviders[0].model).toBe('qwen/qwen3-coder');
    expect(component.extraProviders[0].contextTokens).toBe(262144);
  });

  it('openrouter catalog failure keeps the free-text model input', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'discover_llm_models') throw new Error('empty');
      return undefined;
    };

    component.toggleExtraExpanded(component.extraProviders[0]);
    await flushMicrotasks();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-extra-model-openrouter"]'
    ) as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(component.extraProviders[0].models).toBeNull();
  });

  it('marks the saved model selected once the async catalog renders', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'discover_llm_models') {
        return {
          models: [
            { id: 'ai21/jamba-large-1.7', context_tokens: 256000 },
            { id: 'deepseek/deepseek-v4-flash', context_tokens: 1000000 },
          ],
        };
      }
      return undefined;
    };

    component.toggleExtraExpanded(component.extraProviders[0]);
    component.extraProviders[0].model = 'deepseek/deepseek-v4-flash';
    await flushMicrotasks();
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-extra-model-openrouter"]'
    ) as HTMLSelectElement;
    // Not the alphabetically-first catalog row — the persisted choice.
    expect(select.value).toBe('deepseek/deepseek-v4-flash');
  });

  it('a saved model missing from the catalog is preserved as an option', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'discover_llm_models') {
        return { models: [{ id: 'qwen/qwen3-coder', context_tokens: 262144 }] };
      }
      return undefined;
    };

    component.toggleExtraExpanded(component.extraProviders[0]);
    component.extraProviders[0].model = 'vendor/retired-model';
    await flushMicrotasks();
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-extra-model-openrouter"]'
    ) as HTMLSelectElement;
    expect(select.textContent).toContain('vendor/retired-model');
  });

  it('save persists the catalog context window for remote providers', async () => {
    let captured: Record<string, unknown> | null = null;
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'update_llm_config') captured = args?.['update'] as Record<string, unknown>;
      if (cmd === 'get_auth_status') return { api_key_configured: false };
      if (cmd === 'discover_llm_models') {
        return { models: [{ id: 'qwen/qwen3-coder', context_tokens: 262144 }] };
      }
      return undefined;
    };

    component.toggleExtraExpanded(component.extraProviders[0]);
    await flushMicrotasks();
    component.onExtraModelSelect(component.extraProviders[0], 'qwen/qwen3-coder');
    await component.saveConfig();

    const providers = captured!['providers'] as Array<Record<string, unknown>>;
    const or = providers.find((p) => p['id'] === 'openrouter')!;
    expect(or['context_tokens']).toBe(262144);
  });

  it('save rejects an active remote provider without a model', async () => {
    let invoked = false;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'update_llm_config') invoked = true;
      return undefined;
    };
    let emitted = '';
    component.errorOccurred.subscribe((msg: string) => (emitted = msg));

    component.toggleExtraExpanded(component.extraProviders[0]);
    component.selectExtraProvider(component.extraProviders[0]);
    await component.saveConfig();

    expect(invoked).toBe(false);
    expect(emitted).toContain('requires a model name');
  });

  it('save hot-reloads the proxy when the active selection is unchanged', async () => {
    const calls: string[] = [];
    mockTauri.invokeHandler = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'get_auth_status') return { api_key_configured: false };
      return undefined;
    };
    const projectState = TestBed.inject(ProjectStateService);
    const restartSpy = vi.spyOn(projectState, 'requestRestart');
    // The active project comes from the input signal (not projectState).
    fixture.componentRef.setInput('activeProject', 'proj');

    // Anthropic card active, default model — same as the loaded snapshot.
    component.provider = 'anthropic';
    component.selectedTarget = 'anthropic';
    component['loadedActiveKey'] = 'anthropic|';
    await component.saveConfig();

    expect(calls).toContain('restart_llm_proxy');
    expect(restartSpy).not.toHaveBeenCalled();

    // Changing the model flips to the full restart.
    calls.length = 0;
    component.model = 'claude-opus-4-8';
    await component.saveConfig();
    expect(calls).not.toContain('restart_llm_proxy');
    expect(restartSpy).toHaveBeenCalled();
  });

  // ── Anthropic auth, absorbed from the former Authentication section ─────

  it('loads auth status and renders the connected pills', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') {
        return { api_key_configured: false, oauth_authenticated: true };
      }
      return undefined;
    };
    fixture.componentRef.setInput('activeProject', 'proj');
    fixture.detectChanges();
    await flushMicrotasks();
    fixture.detectChanges();

    expect(component.oauthAuthenticated).toBe(true);
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
        return { api_key_configured: true, oauth_authenticated: false };
      }
      return undefined;
    };
    fixture.componentRef.setInput('activeProject', 'proj');
    component.anthropicApiKeyInput = 'sk-ant-test';

    await component.saveAnthropicApiKey();
    expect(calls.some(([c, a]) => c === 'save_api_key' && a?.['apiKey'] === 'sk-ant-test')).toBe(
      true
    );
    expect(component.anthropicApiKeyInput).toBe('');
    expect(component.apiKeyConfigured).toBe(true);

    await component.deleteAnthropicApiKey();
    expect(calls.some(([c]) => c === 'delete_api_key')).toBe(true);
  });

  it('refreshes auth status when the oauth terminal completes', async () => {
    let statusCalls = 0;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') {
        statusCalls += 1;
        return { api_key_configured: false, oauth_authenticated: true };
      }
      return undefined;
    };
    fixture.componentRef.setInput('activeProject', 'proj');

    await component.onOAuthDone(true);
    expect(statusCalls).toBeGreaterThan(0);
    expect(component.oauthAuthenticated).toBe(true);
  });

  it('renders the not-configured pill when neither auth method is set up', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') {
        return { api_key_configured: false, oauth_authenticated: false };
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
    component.anthropicApiKeyInput = 'sk-ant-test';

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
    component.anthropicApiKeyInput = 'sk-ant-test';

    await component.saveAnthropicApiKey();
    expect(errors).toContain('keychain locked');

    await component.deleteAnthropicApiKey();
    expect(errors).toContain('delete failed');
  });
});
