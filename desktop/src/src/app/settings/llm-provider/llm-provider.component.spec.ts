import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LlmProviderComponent } from './llm-provider.component';
import { TauriService } from '../../services/tauri.service';
import { MockTauriService } from '../../testing/mock-tauri.service';

function setupMockTauri(mockTauri: MockTauriService): void {
  mockTauri.invokeHandler = async (cmd: string) => {
    switch (cmd) {
      case 'get_llm_config':
        return { provider: 'anthropic', model: null, base_url: null, api_key_env: null };
      case 'update_llm_config':
        return undefined;
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
    expect(component.apiKeyEnv).toBe('');
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
            api_key_env: null,
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
  });

  it('emits providerChange on load', async () => {
    const spy = vi.fn();
    component.providerChange.subscribe(spy);

    component.ngOnInit();
    await fixture.whenStable();

    expect(spy).toHaveBeenCalledWith('anthropic');
  });

  it('emits providerChange when provider selection changes', () => {
    const spy = vi.fn();
    component.providerChange.subscribe(spy);

    component.provider = 'ollama';
    component.onProviderChange();

    expect(spy).toHaveBeenCalledWith('ollama');
  });

  it('returns correct model placeholder for each provider', () => {
    component.provider = 'anthropic';
    expect(component.modelPlaceholder()).toBe('claude-sonnet-4-6');

    component.provider = 'ollama';
    expect(component.modelPlaceholder()).toBe('llama3.3');

    component.provider = 'external';
    expect(component.modelPlaceholder()).toBe('gpt-4o');
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
    component.provider = 'external';

    await component.saveConfig();

    expect(spy).toHaveBeenCalledWith('external');
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
    component.apiKeyEnv = '';

    await component.saveConfig();

    expect(invokedArgs['model']).toBeNull();
    expect(invokedArgs['baseUrl']).toBeNull();
    expect(invokedArgs['apiKeyEnv']).toBeNull();
  });

  it('renders provider select', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();

    const select = fixture.nativeElement.querySelector('[data-testid="settings-llm-provider"]');
    expect(select).not.toBeNull();
    expect(select.tagName).toBe('SELECT');
  });

  it('renders model input', async () => {
    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('[data-testid="settings-llm-model"]');
    expect(input).not.toBeNull();
  });

  it('shows base URL field for ollama provider', async () => {
    component.provider = 'ollama';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('[data-testid="settings-llm-base-url"]');
    expect(input).not.toBeNull();
  });

  it('shows base URL field for external provider', async () => {
    component.provider = 'external';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('[data-testid="settings-llm-base-url"]');
    expect(input).not.toBeNull();
  });

  it('hides base URL field for anthropic provider', () => {
    component.provider = 'anthropic';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('[data-testid="settings-llm-base-url"]');
    expect(input).toBeNull();
  });

  it('shows API key env field only for external provider', () => {
    component.provider = 'external';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('[data-testid="settings-llm-api-key-env"]');
    expect(input).not.toBeNull();
  });

  it('hides API key env field for non-external providers', () => {
    component.provider = 'anthropic';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    let input = fixture.nativeElement.querySelector('[data-testid="settings-llm-api-key-env"]');
    expect(input).toBeNull();

    component.provider = 'ollama';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();

    input = fixture.nativeElement.querySelector('[data-testid="settings-llm-api-key-env"]');
    expect(input).toBeNull();
  });

  it('renders save button', () => {
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="settings-llm-save"]');
    expect(btn).not.toBeNull();
    expect(btn.textContent.trim()).toContain('Save');
  });
});
