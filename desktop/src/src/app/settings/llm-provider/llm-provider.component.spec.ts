import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LlmProviderComponent } from './llm-provider.component';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { MockTauriService } from '../../testing/mock-tauri.service';

const DEFAULT_BASE_URLS: Record<string, string> = {
  ollama: 'http://host.docker.internal:11434',
  lmstudio: 'http://host.docker.internal:1234',
  llamacpp: 'http://host.docker.internal:8080',
};

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

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    setupMockTauri(mockTauri);

    await TestBed.configureTestingModule({
      imports: [LlmProviderComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

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

  it('loads config on init', async () => {
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

    expect(component.provider).toBe('ollama');
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

  it('emits providerChange when provider selection changes', async () => {
    const spy = vi.fn();
    component.providerChange.subscribe(spy);

    component.provider = 'ollama';
    await component.onProviderChange();

    expect(spy).toHaveBeenCalledWith('ollama');
  });

  it('returns correct model placeholder for each provider', () => {
    component.provider = 'anthropic';
    expect(component.modelPlaceholder()).toBe('claude-sonnet-4-6');

    component.provider = 'ollama';
    expect(component.modelPlaceholder()).toBe('llama3.3');

    component.provider = 'lmstudio';
    expect(component.modelPlaceholder()).toBe('qwen2.5-coder');

    component.provider = 'llamacpp';
    expect(component.modelPlaceholder()).toBe('deepseek-r1');
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

    expect(invokedArgs['provider']).toBe('ollama');
    expect(invokedArgs['model']).toBe('llama3.3');
    expect(invokedArgs['baseUrl']).toBe('http://localhost:11434');
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

    await component.saveConfig();

    expect(spy).toHaveBeenCalledWith('ollama');
  });

  it('requests container restart on successful save', async () => {
    const projectState = TestBed.inject(ProjectStateService);
    projectState.needsRestart = false;
    component.provider = 'ollama';

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

    expect(invokedArgs['model']).toBeNull();
    expect(invokedArgs['baseUrl']).toBeNull();
    expect(invokedArgs['apiKeyEnv']).toBeUndefined();
  });

  it('renders provider select', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector('[data-testid="settings-llm-provider"]');
    expect(select).not.toBeNull();
    expect(select.tagName).toBe('SELECT');
  });

  it('hides model and base URL fields for anthropic provider', async () => {
    component.provider = 'anthropic';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const modelInput = fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]');
    expect(modelInput).toBeNull();

    const baseUrlInput = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-base-url"]'
    );
    expect(baseUrlInput).toBeNull();
  });

  it('shows model and base URL fields for ollama provider', async () => {
    component.provider = 'ollama';
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
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const baseUrlInput = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-base-url"]'
    );
    expect(baseUrlInput).not.toBeNull();
  });

  it('shows model and base URL fields for llamacpp provider', async () => {
    component.provider = 'llamacpp';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const baseUrlInput = fixture.nativeElement.querySelector(
      '[data-testid="settings-llm-base-url"]'
    );
    expect(baseUrlInput).not.toBeNull();
  });

  it('uses default_base_url from backend as placeholder', async () => {
    component.provider = 'ollama';
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
    expect(btn.textContent.trim()).toContain('Save');
  });

  // ── Model discovery (ADR-041) ────────────────────────────────────────

  function setupDiscoveryMock(
    mockTauri: MockTauriService,
    opts: {
      provider?: string;
      baseUrl?: string;
      defaultBaseUrl?: string;
      model?: string;
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
        case 'update_llm_config':
          return undefined;
        case 'discover_llm_models':
          discoverCalls.push(args);
          if (opts.discover) {
            return opts.discover(args);
          }
          return [];
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
    await component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]');
    expect(select).not.toBeNull();
    expect(select.tagName).toBe('SELECT');
    const opts = Array.from(select.querySelectorAll('option')).map((o: Element) =>
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
    await component.ngOnInit();
    await fixture.whenStable();
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
        return ['model-from-second'];
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
      expect(component.discoveryState.models).toEqual(['model-from-second']);
      expect(component.discoveryState.url).toBe('http://b.invalid');
    }
  });

  it('onProviderChange_clears_stale_models', async () => {
    setupDiscoveryMock(mockTauri, {
      provider: 'ollama',
      discover: async () => ['m'],
    });
    await component.ngOnInit();
    await fixture.whenStable();
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
    await component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.model).toBe('legacy');
    const select = fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]');
    expect(select).not.toBeNull();
    expect(select.tagName).toBe('SELECT');
    const opts = Array.from(select.querySelectorAll('option')).map((o: Element) =>
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

    expect(invokedArgs['baseUrl']).toBe('http://host.docker.internal:11434');
    expect(invokedArgs['baseUrl']).not.toBeNull();
    expect(invokedArgs['baseUrl']).not.toBe('');
  });
});
