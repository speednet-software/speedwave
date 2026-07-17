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
    } as AnthropicModel,
    {
      id: 'claude-opus-4-1',
      family: 'Opus 4.1',
      context_tokens: 200_000,
      latest: false,
      premium: true,
      selectable: false,
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

  it('shows the normalized badge (no entry-id prefix) from the active provider summary', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    const badge = fixture.debugElement.query(By.css('[data-testid="composer-model-badge"]'));
    expect(badge.nativeElement.textContent).toContain('claude-sonnet-5');
    expect(badge.nativeElement.textContent).not.toContain('anthropic/claude-sonnet-5');
  });

  it('shows a loader while the catalog is fetching, then only selectable options plus their [1m] variants', async () => {
    let resolveList!: (v: AnthropicModel[]) => void;
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
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
    // 1M-capable selectable entry expands to two options: bare and [1m].
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

  it('shows error+retry on a fetch failure and recovers on retry', async () => {
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
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
});
