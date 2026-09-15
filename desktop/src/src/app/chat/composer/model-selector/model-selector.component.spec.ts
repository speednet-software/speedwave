import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ModelSelectorComponent } from './model-selector.component';
import { TauriService } from '../../../services/tauri.service';
import type { ActiveProviderSummary, AnthropicModel } from '../../../models/llm';

describe('ActiveProviderSummary', () => {
  it('shape matches the Rust mirror fields, including base_url', () => {
    const sample: ActiveProviderSummary = {
      provider_id: 'my-ollama',
      kind: 'local',
      model: 'my-ollama/llama3.3',
      base_url: 'http://host.docker.internal:11434',
    };
    expect(sample.base_url).toBe('http://host.docker.internal:11434');
  });
});

describe('ModelSelectorComponent', () => {
  let fixture: ComponentFixture<ModelSelectorComponent>;
  let tauriInvoke: ReturnType<typeof vi.fn>;

  const anthropicCatalog: AnthropicModel[] = [
    {
      id: 'claude-sonnet-5',
      family: 'Sonnet 5',
      context_tokens: 1_000_000,
      latest: true,
      premium: false,
      selectable: true,
      has_1m: true,
      effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      default_effort: 'high',
    } as AnthropicModel,
    {
      id: 'claude-opus-4-1',
      family: 'Opus 4.1',
      context_tokens: 200_000,
      latest: false,
      premium: true,
      selectable: false,
      has_1m: false,
      effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      default_effort: 'high',
    } as AnthropicModel,
  ];

  const summary: ActiveProviderSummary = {
    provider_id: 'anthropic',
    kind: 'anthropic_oauth',
    model: 'claude-sonnet-5',
    base_url: null,
  };

  beforeEach(async () => {
    tauriInvoke = vi.fn(async (cmd: string) => {
      if (cmd === 'get_active_provider_summary') return summary;
      if (cmd === 'list_anthropic_models') return anthropicCatalog;
      if (cmd === 'get_effort_pin') return 'high';
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    await TestBed.configureTestingModule({
      imports: [ModelSelectorComponent],
      providers: [{ provide: TauriService, useValue: { invoke: tauriInvoke } }],
    }).compileComponents();
    fixture = TestBed.createComponent(ModelSelectorComponent);
    fixture.componentRef.setInput('projectId', 'proj-1');
    fixture.componentRef.setInput('streaming', false);
    fixture.detectChanges();
  });

  it('shows the normalized badge as the catalog family label (no entry-id prefix)', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    const badge = fixture.debugElement.query(By.css('[data-testid="composer-model-badge"]'));
    expect(badge.nativeElement.textContent).toContain('Sonnet 5');
    expect(badge.nativeElement.textContent).not.toContain('claude-sonnet-5');
    expect(badge.nativeElement.textContent).not.toContain('anthropic/claude-sonnet-5');
  });

  it('strips only the exact entry-id prefix on the badge, never a coincidental first segment', async () => {
    const orSummary: ActiveProviderSummary = {
      provider_id: 'openrouter',
      kind: 'open_router',
      model: 'openrouter/anthropic/claude-sonnet-5',
      base_url: null,
    };
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(orSummary);
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-or');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const badge = fixture.debugElement.query(By.css('[data-testid="composer-model-badge"]'));
    expect(badge.nativeElement.textContent).toContain('anthropic/claude-sonnet-5');
    expect(badge.nativeElement.textContent).not.toContain('openrouter/');
  });

  it('shows a loader while the catalog is fetching, then only selectable options plus their [1m] variants', async () => {
    let resolveList!: (v: AnthropicModel[]) => void;
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'get_effort_pin') return Promise.resolve('high');
      if (cmd === 'list_anthropic_models')
        return new Promise((r) => {
          resolveList = r;
        });
      return Promise.reject(new Error('unexpected'));
    });
    fixture.detectChanges();
    await fixture.componentInstance.openCombobox();
    fixture.detectChanges();
    expect(
      fixture.debugElement.query(By.css('[data-testid="model-selector-loading"]'))
    ).toBeTruthy();
    resolveList(anthropicCatalog);
    await fixture.componentInstance.whenOptionsSettled();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      fixture.debugElement.query(By.css('[data-testid="model-selector-loading"]'))
    ).toBeFalsy();
    expect(
      fixture.debugElement.query(By.css('[data-testid="model-selector-option-claude-sonnet-5"]'))
    ).toBeTruthy();
    expect(
      fixture.debugElement.query(
        By.css('[data-testid="model-selector-option-claude-sonnet-5[1m]"]')
      )
    ).toBeTruthy();
    expect(
      fixture.debugElement.query(By.css('[data-testid="model-selector-option-claude-opus-4-1"]'))
    ).toBeFalsy();
  });

  it('offers the [1m] alias by has_1m, not context_tokens', async () => {
    const catalogWithFable: AnthropicModel[] = [
      {
        id: 'claude-fable-5',
        family: 'Fable 5',
        context_tokens: 200_000,
        latest: true,
        premium: true,
        selectable: true,
        has_1m: true,
        effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        default_effort: 'high',
      },
      {
        id: 'claude-haiku-4-5',
        family: 'Haiku 4.5',
        context_tokens: 200_000,
        latest: true,
        premium: false,
        selectable: true,
        has_1m: false,
        effort_levels: [],
        default_effort: null,
      },
    ];
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'get_effort_pin') return Promise.resolve('high');
      if (cmd === 'list_anthropic_models') return Promise.resolve(catalogWithFable);
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    expect(
      fixture.debugElement.query(By.css('[data-testid="model-selector-option-claude-fable-5[1m]"]'))
    ).toBeTruthy();
    expect(
      fixture.debugElement.query(
        By.css('[data-testid="model-selector-option-claude-haiku-4-5[1m]"]')
      )
    ).toBeFalsy();
  });

  it('shows error+retry on a fetch failure and recovers on retry', async () => {
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'get_effort_pin') return Promise.resolve('high');
      if (cmd === 'list_anthropic_models') return Promise.reject(new Error('boom'));
      return Promise.reject(new Error('unexpected'));
    });
    await fixture.componentInstance.openCombobox();
    await fixture.whenStable();
    fixture.detectChanges();
    const error = fixture.debugElement.query(By.css('[data-testid="model-selector-error"]'));
    expect(error).toBeTruthy();

    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'get_effort_pin') return Promise.resolve('high');
      if (cmd === 'list_anthropic_models') return Promise.resolve(anthropicCatalog);
      return Promise.reject(new Error('unexpected'));
    });
    error.query(By.css('[data-testid="model-selector-retry"]')).nativeElement.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('[data-testid="model-selector-error"]'))).toBeFalsy();
    expect(
      fixture.debugElement.query(By.css('[data-testid="model-selector-option-claude-sonnet-5"]'))
    ).toBeTruthy();
  });

  it('search filters the option list by id and family', async () => {
    await fixture.componentInstance.openCombobox();
    await fixture.whenStable();
    fixture.detectChanges();
    const search = fixture.debugElement.query(By.css('[data-testid="model-selector-search"]'));
    search.nativeElement.value = 'sonnet';
    search.nativeElement.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(
      fixture.debugElement.query(By.css('[data-testid="model-selector-option-claude-sonnet-5"]'))
    ).toBeTruthy();
    expect(
      fixture.debugElement.query(By.css('[data-testid="model-selector-option-claude-opus-4-1"]'))
    ).toBeFalsy();
  });

  it('is disabled with a lock tooltip while streaming', () => {
    fixture.componentRef.setInput('streaming', true);
    fixture.detectChanges();
    const badge = fixture.debugElement.query(By.css('[data-testid="composer-model-badge"]'));
    expect(badge.nativeElement.disabled).toBe(true);
  });

  it('local discovery uses the summary base_url, never the provider_id, as the URL', async () => {
    const localSummary: ActiveProviderSummary = {
      provider_id: 'my-ollama',
      kind: 'local',
      model: 'my-ollama/llama3.3',
      base_url: 'http://host.docker.internal:11434',
    };
    tauriInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(localSummary);
      if (cmd === 'discover_llm_models') return Promise.resolve({ models: [] });
      return Promise.reject(new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-local');
    fixture.detectChanges();
    await fixture.whenStable();
    await fixture.componentInstance.openCombobox();
    await fixture.whenStable();
    const call = tauriInvoke.mock.calls.find(([cmd]) => cmd === 'discover_llm_models');
    expect(call?.[1]).toMatchObject({ args: { baseUrl: 'http://host.docker.internal:11434' } });
  });

  it('shows a discovery error when the local summary carries no base_url', async () => {
    const localSummaryNoUrl: ActiveProviderSummary = {
      provider_id: 'my-ollama',
      kind: 'local',
      model: 'my-ollama/llama3.3',
      base_url: null,
    };
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(localSummaryNoUrl);
      return Promise.reject(new Error('discover_llm_models must not be called without a base_url'));
    });
    fixture.componentRef.setInput('projectId', 'proj-local-2');
    fixture.detectChanges();
    await fixture.whenStable();
    await fixture.componentInstance.openCombobox();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('[data-testid="model-selector-error"]'))).toBeTruthy();
  });

  it('open_router and local branches produce identically-shaped options from the same discover result', async () => {
    const discovered = { models: [{ id: 'model-a', context_tokens: 4096 }] };
    const expectedOptions = [{ id: 'model-a', label: 'model-a', contextTokens: 4096 }];

    const orSummary: ActiveProviderSummary = {
      provider_id: 'openrouter',
      kind: 'open_router',
      model: 'openrouter/model-a',
      base_url: null,
    };
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(orSummary);
      if (cmd === 'discover_llm_models') return Promise.resolve(discovered);
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-or-shape');
    fixture.detectChanges();
    await fixture.whenStable();
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    expect(fixture.componentInstance['options']()).toEqual(expectedOptions);

    const localSummary: ActiveProviderSummary = {
      provider_id: 'my-ollama',
      kind: 'local',
      model: 'my-ollama/model-a',
      base_url: 'http://host.docker.internal:11434',
    };
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(localSummary);
      if (cmd === 'discover_llm_models') return Promise.resolve(discovered);
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-local-shape');
    fixture.detectChanges();
    await fixture.whenStable();
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    expect(fixture.componentInstance['options']()).toEqual(expectedOptions);
  });

  it('reuses cached discovery results on a second open, but re-probes on a provider/base_url change', async () => {
    const localSummary: ActiveProviderSummary = {
      provider_id: 'my-ollama',
      kind: 'local',
      model: 'my-ollama/llama3.3',
      base_url: 'http://host.docker.internal:11434',
    };
    let discoverCalls = 0;
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(localSummary);
      if (cmd === 'discover_llm_models') {
        discoverCalls++;
        return Promise.resolve({ models: [{ id: 'llama3.3', context_tokens: 8192 }] });
      }
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-cache');
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    expect(discoverCalls).toBe(1);

    fixture.componentInstance.open.set(false);
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    expect(discoverCalls).toBe(1);

    const otherLocalSummary: ActiveProviderSummary = {
      ...localSummary,
      base_url: 'http://host.docker.internal:22222',
    };
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(otherLocalSummary);
      if (cmd === 'discover_llm_models') {
        discoverCalls++;
        return Promise.resolve({ models: [{ id: 'llama3.3', context_tokens: 8192 }] });
      }
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-cache-2');
    fixture.detectChanges();
    await fixture.whenStable();
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    expect(discoverCalls).toBe(2);

    await fixture.componentInstance.fetchOptions(true);
    expect(discoverCalls).toBe(3);
  });

  it('emits exactly one modelSelected event carrying catalogId, wireId, providerId and kind', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    const events: Array<{ catalogId: string; wireId: string; providerId: string; kind: string }> =
      [];
    fixture.componentInstance.modelSelected.subscribe((e) => events.push(e));

    await fixture.componentInstance.openCombobox();
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.componentInstance.select({
      id: 'claude-opus-4-1',
      label: 'Opus 4.1',
      contextTokens: 200000,
    });

    expect(events).toEqual([
      {
        catalogId: 'claude-opus-4-1',
        wireId: 'claude-opus-4-1',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
      },
    ]);
  });

  it('renders the effort segment only for anthropic provider kinds', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('[data-testid="effort-segment"]'))).toBeTruthy();
  });

  it('hides the effort segment for non-anthropic provider kinds', async () => {
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary')
        return Promise.resolve({
          provider_id: 'openrouter',
          kind: 'open_router',
          model: 'some-model',
          base_url: null,
        });
      if (cmd === 'list_anthropic_models') return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-non-anthropic');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('[data-testid="effort-segment"]'))).toBeFalsy();
  });

  it('shows the current pin, capitalized, on the segment', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    const segment = fixture.debugElement.query(By.css('[data-testid="effort-segment"]'));
    expect(segment.nativeElement.textContent.trim()).toBe('High');
  });

  it('opening the popover renders the slider with the segment pin as the active stop', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.debugElement.query(By.css('[data-testid="effort-segment"]')).nativeElement.click();
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('[data-testid="effort-popover"]'))).toBeTruthy();
    const slider = fixture.debugElement.query(By.css('[data-testid="effort-slider"]'));
    expect(slider.nativeElement.getAttribute('aria-valuetext')).toBe('High');
  });

  it('a stop click emits effortSelected, updates the pill, and closes the popover', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.effortSelected.subscribe((l: string) => emitted.push(l));

    fixture.debugElement.query(By.css('[data-testid="effort-segment"]')).nativeElement.click();
    fixture.detectChanges();
    fixture.debugElement.query(By.css('[data-testid="effort-stop-low"]')).nativeElement.click();
    fixture.detectChanges();

    expect(emitted).toEqual(['low']);
    expect(tauriInvoke).not.toHaveBeenCalledWith('set_effort_pin', expect.anything());
    expect(fixture.debugElement.query(By.css('[data-testid="effort-popover"]'))).toBeFalsy();
    const segment = fixture.debugElement.query(By.css('[data-testid="effort-segment"]'));
    expect(segment.nativeElement.textContent.trim()).toBe('Low');
  });

  it('a pick during a streaming turn still emits (the chat layer queues the wire send)', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.componentRef.setInput('streaming', true);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.effortSelected.subscribe((l: string) => emitted.push(l));

    const segment = fixture.debugElement.query(By.css('[data-testid="effort-segment"]'))
      .nativeElement as HTMLButtonElement;
    expect(segment.disabled).toBeFalsy();
    segment.click();
    fixture.detectChanges();
    fixture.debugElement.query(By.css('[data-testid="effort-stop-low"]')).nativeElement.click();
    fixture.detectChanges();
    expect(emitted).toEqual(['low']);
    expect(tauriInvoke).not.toHaveBeenCalledWith('set_effort_pin', expect.anything());
  });

  it('no help icon in the popover; Faster and Smarter labels are present', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.debugElement.query(By.css('[data-testid="effort-segment"]')).nativeElement.click();
    fixture.detectChanges();
    const popover = fixture.debugElement.query(By.css('[data-testid="effort-popover"]'))
      .nativeElement as HTMLElement;
    expect(popover.textContent).toContain('Faster');
    expect(popover.textContent).toContain('Smarter');
    expect(popover.querySelector('[aria-label="Help"]')).toBeFalsy();
  });

  it('Escape closes the effort popover', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.debugElement.query(By.css('[data-testid="effort-segment"]')).nativeElement.click();
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('[data-testid="effort-popover"]'))).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('[data-testid="effort-popover"]'))).toBeFalsy();
  });

  it('a failed write-through resyncs the pin from the backend instead of trusting the optimistic pick', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.debugElement.query(By.css('[data-testid="effort-segment"]')).nativeElement.click();
    fixture.detectChanges();
    fixture.debugElement.query(By.css('[data-testid="effort-stop-low"]')).nativeElement.click();
    fixture.detectChanges();
    expect(
      fixture.debugElement.query(By.css('[data-testid="effort-segment"]')).nativeElement.textContent
    ).toContain('Low');

    tauriInvoke.mockClear();
    fixture.componentRef.setInput('modelError', 'locked config');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(tauriInvoke).toHaveBeenCalledWith('get_effort_pin', { projectId: 'proj-1' });
    expect(
      fixture.debugElement.query(By.css('[data-testid="effort-segment"]')).nativeElement.textContent
    ).toContain('High');
  });

  it('closes the combobox on a backdrop click and on Escape', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    const badge = () =>
      fixture.debugElement.query(By.css('[data-testid="composer-model-badge"]')).nativeElement;
    const search = () =>
      fixture.nativeElement.querySelector('[data-testid="model-selector-search"]');

    badge().click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(search()).toBeTruthy();
    (
      fixture.nativeElement.querySelector('[data-testid="model-selector-backdrop"]') as HTMLElement
    ).click();
    fixture.detectChanges();
    expect(search()).toBeFalsy();

    badge().click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(search()).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(search()).toBeFalsy();
  });

  it('re-fetches the effort pin when a new session starts', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    const getEffortPinCalls = () =>
      tauriInvoke.mock.calls.filter(([cmd]) => cmd === 'get_effort_pin').length;
    const callsBefore = getEffortPinCalls();
    fixture.componentRef.setInput('sessionModel', 'claude-sonnet-5');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getEffortPinCalls()).toBeGreaterThan(callsBefore);
  });

  it('does not reload the effort pin on a no-op sessionModel update (same value re-set)', async () => {
    fixture.componentRef.setInput('sessionModel', 'claude-sonnet-5');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const getEffortPinCalls = () =>
      tauriInvoke.mock.calls.filter(([cmd]) => cmd === 'get_effort_pin').length;
    const callsBefore = getEffortPinCalls();

    fixture.componentRef.setInput('sessionModel', 'claude-sonnet-5');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(getEffortPinCalls()).toBe(callsBefore);
  });

  it('drops a stale effort-state resolution when the project switched while it was in flight', async () => {
    let resolvePinA!: (v: string | null) => void;
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'list_anthropic_models') return Promise.resolve(anthropicCatalog);
      if (cmd === 'get_effort_pin')
        return new Promise((r) => {
          resolvePinA = r;
        });
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-effort-a');
    fixture.detectChanges();
    await fixture.whenStable();

    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'list_anthropic_models') return Promise.resolve(anthropicCatalog);
      if (cmd === 'get_effort_pin') return Promise.resolve('medium');
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-effort-b');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    resolvePinA('xhigh');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance['currentEffortPin']()).toBe('medium');
  });

  it('drops a stale summary resolution when the project switched while it was in flight', async () => {
    let resolveA!: (v: ActiveProviderSummary) => void;
    const summaryB: ActiveProviderSummary = {
      provider_id: 'openrouter',
      kind: 'open_router',
      model: 'openrouter/some-model',
      base_url: null,
    };
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary')
        return new Promise((r) => {
          resolveA = r;
        });
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-a');
    fixture.detectChanges();
    await fixture.whenStable();

    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summaryB);
      if (cmd === 'list_anthropic_models') return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-b');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    resolveA({
      provider_id: 'anthropic',
      kind: 'anthropic_oauth',
      model: 'claude-sonnet-5',
      base_url: null,
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance['summary']()).toEqual(summaryB);
  });

  it('reloads a stale non-null summary from a previous project before fetching options', async () => {
    const summaryB: ActiveProviderSummary = {
      provider_id: 'openrouter',
      kind: 'open_router',
      model: 'openrouter/some-model',
      base_url: null,
    };
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance['summary']()).toEqual(summary);

    tauriInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summaryB);
      if (cmd === 'discover_llm_models') return Promise.resolve({ models: [] });
      return Promise.reject(new Error(`unexpected: ${cmd} ${JSON.stringify(args)}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-b');
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance['summary']()).toEqual(summaryB);
    const call = tauriInvoke.mock.calls.find(([cmd]) => cmd === 'discover_llm_models');
    expect(call).toBeTruthy();
  });

  it('surfaces a model-selection write-through error next to the badge, then clears it', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('[data-testid="model-selection-error"]'))).toBeFalsy();

    fixture.componentRef.setInput('modelError', 'locked config');
    fixture.detectChanges();
    const err = fixture.debugElement.query(By.css('[data-testid="model-selection-error"]'));
    expect(err).toBeTruthy();
    expect(err.nativeElement.textContent).toContain('locked config');

    fixture.componentRef.setInput('modelError', '');
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('[data-testid="model-selection-error"]'))).toBeFalsy();
  });
});
describe('ModelSelectorComponent badge fallback (anthropic carries no config model)', () => {
  let fixture: ComponentFixture<ModelSelectorComponent>;
  let tauriInvoke: ReturnType<typeof vi.fn>;

  const configlessSummary: ActiveProviderSummary = {
    provider_id: 'anthropic',
    kind: 'anthropic_oauth',
    model: null,
    base_url: null,
  };

  const catalog: AnthropicModel[] = [
    {
      id: 'claude-fable-5',
      family: 'Fable 5',
      context_tokens: 200_000,
      latest: true,
      premium: false,
      selectable: true,
      has_1m: true,
      effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      default_effort: 'high',
    } as AnthropicModel,
  ];

  let modelHint: string | null = null;

  beforeEach(async () => {
    modelHint = null;
    tauriInvoke = vi.fn(async (cmd: string) => {
      if (cmd === 'get_active_provider_summary') return configlessSummary;
      if (cmd === 'list_anthropic_models') return catalog;
      if (cmd === 'get_effort_pin') return null;
      if (cmd === 'get_model_hint') return modelHint;
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    await TestBed.configureTestingModule({
      imports: [ModelSelectorComponent],
      providers: [{ provide: TauriService, useValue: { invoke: tauriInvoke } }],
    }).compileComponents();
    fixture = TestBed.createComponent(ModelSelectorComponent);
    fixture.componentRef.setInput('projectId', 'proj-1');
    fixture.componentRef.setInput('streaming', false);
    fixture.detectChanges();
  });

  function badgeText(): string {
    return (
      fixture.debugElement.query(By.css('[data-testid="composer-model-badge"]')).nativeElement
        .textContent ?? ''
    ).trim();
  }

  it('shows the live session model, as its catalog family label, when the config carries none', async () => {
    fixture.componentRef.setInput('sessionModel', 'claude-fable-5');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(badgeText()).toBe('Fable 5');
  });

  it('shows "default" only when neither a session, a pin, nor history knows the model', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    expect(badgeText()).toBe('default');
  });

  it('shows the CC settings-pin/last-transcript hint before any session, as the family label', async () => {
    modelHint = 'claude-fable-5[1m]';
    fixture.componentRef.setInput('projectId', 'proj-2');
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(badgeText()).toBe('Fable 5 [1m]');
  });

  it('shows an id the catalog does not know verbatim (SPEED-540 demo: fable[1m] -> claude-fable-5-1[1m])', async () => {
    modelHint = 'claude-fable-5-1[1m]';
    fixture.componentRef.setInput('projectId', 'proj-2');
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(badgeText()).toBe('claude-fable-5-1[1m]');
  });

  it('shows an unrecognized pin value verbatim, never "default"', async () => {
    modelHint = 'some-mystery-value';
    fixture.componentRef.setInput('projectId', 'proj-2');
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(badgeText()).toBe('some-mystery-value');
  });

  it('prefers the live session model over the stored config model (wire switch truth)', async () => {
    tauriInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_active_provider_summary')
        return {
          provider_id: 'openrouter',
          kind: 'open_router',
          model: 'x-ai/grok-4.3',
          base_url: null,
        };
      if (cmd === 'list_anthropic_models') return catalog;
      if (cmd === 'get_effort_pin') return null;
      if (cmd === 'get_model_hint') return modelHint;
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    fixture.componentRef.setInput('projectId', 'proj-2');
    fixture.componentRef.setInput('sessionModel', 'openrouter/ai21/jamba-large-1.7');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(badgeText()).toBe('ai21/jamba-large-1.7');
  });

  it('prefers the live session model over the pre-session hint', async () => {
    modelHint = 'claude-fable-5[1m]';
    fixture.componentRef.setInput('projectId', 'proj-2');
    fixture.componentRef.setInput('sessionModel', 'claude-opus-4-8');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(badgeText()).toBe('claude-opus-4-8');
  });

  it('drops a session-scoped pick when a new conversation starts, falling back to the hint', async () => {
    modelHint = 'claude-opus-4-8';
    fixture.componentRef.setInput('sessionModel', 'claude-opus-4-8');
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.debugElement
      .query(By.css('[data-testid="composer-model-badge"]'))
      .nativeElement.click();
    await fixture.whenStable();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    fixture.debugElement
      .query(By.css('[data-testid="model-selector-option-claude-fable-5"]'))
      .nativeElement.click();
    fixture.detectChanges();
    expect(badgeText()).toBe('Fable 5');

    fixture.componentRef.setInput('sessionModel', '');
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(badgeText()).toBe('claude-opus-4-8');
  });

  it('shows the picked catalog id, as its family label, optimistically after a live anthropic selection', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.debugElement
      .query(By.css('[data-testid="composer-model-badge"]'))
      .nativeElement.click();
    await fixture.whenStable();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    const option = fixture.debugElement.query(
      By.css('[data-testid="model-selector-option-claude-fable-5"]')
    );
    expect(option).toBeTruthy();
    option.nativeElement.click();
    fixture.detectChanges();
    expect(badgeText()).toBe('Fable 5');
  });
});
describe('ModelSelectorComponent effort slider — per-model stop restriction', () => {
  let fixture: ComponentFixture<ModelSelectorComponent>;
  let tauriInvoke: ReturnType<typeof vi.fn>;

  const catalog: AnthropicModel[] = [
    {
      id: 'claude-sonnet-5',
      family: 'Sonnet 5',
      context_tokens: 1_000_000,
      latest: true,
      premium: false,
      selectable: true,
      has_1m: true,
      effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      default_effort: 'high',
    } as AnthropicModel,
    {
      id: 'claude-sonnet-4-6',
      family: 'Sonnet 4.6',
      context_tokens: 1_000_000,
      latest: false,
      premium: false,
      selectable: false,
      has_1m: true,
      effort_levels: ['low', 'medium', 'high', 'max'],
      default_effort: 'high',
    } as AnthropicModel,
    {
      id: 'claude-opus-4-7',
      family: 'Opus 4.7',
      context_tokens: 1_000_000,
      latest: false,
      premium: true,
      selectable: false,
      has_1m: true,
      effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      default_effort: 'xhigh',
    } as AnthropicModel,
    {
      id: 'claude-haiku-4-5',
      family: 'Haiku 4.5',
      context_tokens: 200_000,
      latest: true,
      premium: false,
      selectable: true,
      has_1m: false,
      effort_levels: [],
      default_effort: null,
    } as AnthropicModel,
  ];

  function setSummaryAndPin(
    fixt: ComponentFixture<ModelSelectorComponent>,
    invoke: ReturnType<typeof vi.fn>,
    model: string,
    pin: string | null
  ): void {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary')
        return Promise.resolve({
          provider_id: 'anthropic',
          kind: 'anthropic_oauth',
          model,
          base_url: null,
        });
      if (cmd === 'list_anthropic_models') return Promise.resolve(catalog);
      if (cmd === 'get_effort_pin') return Promise.resolve(pin);
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
  }

  async function flush(fixt: ComponentFixture<ModelSelectorComponent>): Promise<void> {
    await fixt.whenStable();
    fixt.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixt.detectChanges();
  }

  async function openPopover(fixt: ComponentFixture<ModelSelectorComponent>): Promise<void> {
    await flush(fixt);
    fixt.debugElement.query(By.css('[data-testid="effort-segment"]')).nativeElement.click();
    fixt.detectChanges();
  }

  beforeEach(async () => {
    tauriInvoke = vi.fn();
    await TestBed.configureTestingModule({
      imports: [ModelSelectorComponent],
      providers: [{ provide: TauriService, useValue: { invoke: tauriInvoke } }],
    }).compileComponents();
    fixture = TestBed.createComponent(ModelSelectorComponent);
    fixture.componentRef.setInput('streaming', false);
  });

  it('renders only the stops the active model supports: no xhigh on Sonnet 4.6', async () => {
    setSummaryAndPin(fixture, tauriInvoke, 'claude-sonnet-4-6', 'high');
    fixture.componentRef.setInput('projectId', 'proj-sonnet-4-6');
    fixture.detectChanges();
    await openPopover(fixture);

    for (const level of ['low', 'medium', 'high', 'max']) {
      expect(
        fixture.debugElement.query(By.css(`[data-testid="effort-stop-${level}"]`))
      ).toBeTruthy();
    }
    expect(fixture.debugElement.query(By.css('[data-testid="effort-stop-xhigh"]'))).toBeFalsy();
  });

  it('hides the effort segment entirely for a model without effort support (Haiku 4.5)', async () => {
    setSummaryAndPin(fixture, tauriInvoke, 'claude-haiku-4-5', null);
    fixture.componentRef.setInput('projectId', 'proj-haiku');
    fixture.detectChanges();
    await flush(fixture);
    expect(fixture.debugElement.query(By.css('[data-testid="effort-segment"]'))).toBeFalsy();
  });

  it('no pin: pill and popover header show Default, handle at the catalog default (xhigh on Opus 4.7), dimmed', async () => {
    setSummaryAndPin(fixture, tauriInvoke, 'claude-opus-4-7', null);
    fixture.componentRef.setInput('projectId', 'proj-opus-4-7');
    await flush(fixture);
    const segment = fixture.debugElement.query(By.css('[data-testid="effort-segment"]'));
    expect(segment.nativeElement.textContent.trim()).toBe('Default');

    await openPopover(fixture);
    const header = fixture.debugElement.query(By.css('[data-testid="effort-popover-header"]'));
    expect(header.nativeElement.textContent).toContain('Effort Default');
    const slider = fixture.debugElement.query(By.css('[data-testid="effort-slider"]'));
    expect(slider.nativeElement.getAttribute('aria-valuetext')).toBe('Xhigh');
    expect(slider.nativeElement.className).toContain('opacity-40');
  });

  it('a pin unsupported by the active model shows the highest supported stop below it; the pin itself is left untouched', async () => {
    setSummaryAndPin(fixture, tauriInvoke, 'claude-sonnet-4-6', 'xhigh');
    fixture.componentRef.setInput('projectId', 'proj-clamp');
    await flush(fixture);
    const segment = fixture.debugElement.query(By.css('[data-testid="effort-segment"]'));
    expect(segment.nativeElement.textContent.trim()).toBe('High');

    await openPopover(fixture);
    const slider = fixture.debugElement.query(By.css('[data-testid="effort-slider"]'));
    expect(slider.nativeElement.getAttribute('aria-valuetext')).toBe('High');
    expect(tauriInvoke).not.toHaveBeenCalledWith('set_effort_pin', expect.anything());
  });

  it('arrow keys move the tentative stop; Enter commits it', async () => {
    setSummaryAndPin(fixture, tauriInvoke, 'claude-sonnet-5', 'medium');
    fixture.componentRef.setInput('projectId', 'proj-arrows');
    fixture.detectChanges();
    await openPopover(fixture);

    const emitted: string[] = [];
    fixture.componentInstance.effortSelected.subscribe((l: string) => emitted.push(l));
    const slider = fixture.debugElement.query(By.css('[data-testid="effort-slider"]'))
      .nativeElement as HTMLElement;

    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    fixture.detectChanges();
    expect(slider.getAttribute('aria-valuetext')).toBe('High');
    expect(emitted).toEqual([]);

    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(emitted).toEqual(['high']);
  });

  it('Escape closes the popover without applying a tentative arrow move', async () => {
    setSummaryAndPin(fixture, tauriInvoke, 'claude-sonnet-5', 'medium');
    fixture.componentRef.setInput('projectId', 'proj-escape');
    fixture.detectChanges();
    await openPopover(fixture);

    const emitted: string[] = [];
    fixture.componentInstance.effortSelected.subscribe((l: string) => emitted.push(l));
    const slider = fixture.debugElement.query(By.css('[data-testid="effort-slider"]'))
      .nativeElement as HTMLElement;
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    fixture.detectChanges();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('[data-testid="effort-popover"]'))).toBeFalsy();
    expect(emitted).toEqual([]);
    fixture.debugElement.query(By.css('[data-testid="effort-segment"]')).nativeElement.click();
    fixture.detectChanges();
    const reopened = fixture.debugElement.query(By.css('[data-testid="effort-slider"]'));
    expect(reopened.nativeElement.getAttribute('aria-valuetext')).toBe('Medium');
  });

  it('the slider exposes role=slider with a textual value for the current model', async () => {
    setSummaryAndPin(fixture, tauriInvoke, 'claude-sonnet-5', 'high');
    fixture.componentRef.setInput('projectId', 'proj-aria');
    fixture.detectChanges();
    await openPopover(fixture);

    const slider = fixture.debugElement.query(
      By.css('[data-testid="effort-slider"]')
    ).nativeElement;
    expect(slider.getAttribute('role')).toBe('slider');
    expect(slider.getAttribute('aria-valuetext')).toBe('High');
    expect(slider.getAttribute('aria-valuemin')).toBe('0');
    expect(slider.getAttribute('aria-valuemax')).toBe('4');
  });

  it('resolves a doubled [1m] wire suffix to its catalog entry for the label and effort default', async () => {
    setSummaryAndPin(fixture, tauriInvoke, 'claude-sonnet-5', null);
    fixture.componentRef.setInput('projectId', 'proj-double-1m');
    fixture.componentRef.setInput('sessionModel', 'claude-opus-4-7[1m][1m]');
    await flush(fixture);

    expect(
      fixture.debugElement.query(By.css('[data-testid="composer-model-badge"]')).nativeElement
        .textContent
    ).toContain('Opus 4.7 [1m]');
    await openPopover(fixture);
    const slider = fixture.debugElement.query(By.css('[data-testid="effort-slider"]'));
    expect(slider.nativeElement.getAttribute('aria-valuetext')).toBe('Xhigh');
  });

  it('shows the model and effort segments side by side in the pill', async () => {
    setSummaryAndPin(fixture, tauriInvoke, 'claude-sonnet-5', 'high');
    fixture.componentRef.setInput('projectId', 'proj-pill');
    await flush(fixture);

    expect(
      fixture.debugElement.query(By.css('[data-testid="composer-model-badge"]')).nativeElement
        .textContent
    ).toContain('Sonnet 5');
    expect(
      fixture.debugElement.query(By.css('[data-testid="effort-segment"]')).nativeElement.textContent
    ).toContain('High');
  });
});
