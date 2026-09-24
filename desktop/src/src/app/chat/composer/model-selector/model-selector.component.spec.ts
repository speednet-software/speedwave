import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ModelSelectorComponent, type ModelSelection } from './model-selector.component';
import { TauriService } from '../../../services/tauri.service';
import { ClaudeControlService } from '../../../services/claude-control.service';
import type { ActiveProviderSummary, AnthropicModel } from '../../../models/llm';
import type { ModelPicker, ModelPickerRow } from '../../../models/model-picker';

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('ActiveProviderSummary', () => {
  it('shape matches the Rust mirror fields, including base_url', () => {
    const sample: ActiveProviderSummary = {
      provider_id: 'my-ollama',
      kind: 'local',
      model: 'my-ollama/llama3.3',
      base_url: 'http://host.docker.internal:11434',
      effort_levels: EFFORT_LEVELS,
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
      effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      default_effort: 'high',
    } as AnthropicModel,
    {
      id: 'claude-opus-4-1',
      family: 'Opus 4.1',
      context_tokens: 200_000,
      latest: false,
      premium: true,
      effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      default_effort: 'high',
    } as AnthropicModel,
  ];

  const summary: ActiveProviderSummary = {
    provider_id: 'anthropic',
    kind: 'anthropic_oauth',
    model: 'claude-sonnet-5',
    base_url: null,
    effort_levels: EFFORT_LEVELS,
  };

  const picker: ModelPicker = {
    rows: [
      {
        id: 'claude-sonnet-5',
        wire_id: 'claude-sonnet-5[1m]',
        is_default: true,
        display_name: null,
        description: 'Sonnet 5 · Efficient for routine tasks',
        requires_usage_credits: false,
        effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        default_effort: 'high',
      },
      {
        id: 'claude-opus-4-1',
        wire_id: 'claude-opus-4-1',
        is_default: false,
        display_name: null,
        description: 'Opus 4.1 · Best for complex tasks',
        requires_usage_credits: false,
        effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        default_effort: 'high',
      },
    ],
  };

  beforeEach(async () => {
    tauriInvoke = vi.fn(async (cmd: string) => {
      if (cmd === 'get_active_provider_summary') return summary;
      if (cmd === 'list_anthropic_models') return anthropicCatalog;
      if (cmd === 'get_effort_pin') return 'high';
      if (cmd === 'get_chat_session_info') return { state: 'unavailable' };
      if (cmd === 'list_model_picker') return picker;
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

  function optionIds(): string[] {
    return fixture.debugElement
      .queryAll(By.css('[data-testid^="model-selector-option-"]'))
      .map((o) =>
        (o.nativeElement.getAttribute('data-testid') as string).replace(
          'model-selector-option-',
          ''
        )
      );
  }

  function mockWithPickerRows(rows: () => ModelPicker | null): void {
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'get_effort_pin') return Promise.resolve('high');
      if (cmd === 'list_anthropic_models') return Promise.resolve(anthropicCatalog);
      if (cmd === 'get_chat_session_info') return Promise.resolve({ state: 'unavailable' });
      if (cmd === 'list_model_picker') return Promise.resolve(rows());
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
  }

  async function settle(): Promise<void> {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }

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
      effort_levels: EFFORT_LEVELS,
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

  it('shows the picked model on the badge optimistically after a routed selection', async () => {
    const orSummary: ActiveProviderSummary = {
      provider_id: 'openrouter',
      kind: 'open_router',
      model: 'openai/o4-mini',
      base_url: null,
      effort_levels: EFFORT_LEVELS,
    };
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(orSummary);
      if (cmd === 'discover_llm_models')
        return Promise.resolve({ models: [{ id: 'meta-llama/llama-3.1-70b-instruct' }] });
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-or-pick');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const badge = fixture.debugElement.query(By.css('[data-testid="composer-model-badge"]'));
    expect(badge.nativeElement.textContent).toContain('openai/o4-mini');

    badge.nativeElement.click();
    await fixture.whenStable();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    fixture.debugElement
      .query(By.css('[data-testid="model-selector-option-meta-llama/llama-3.1-70b-instruct"]'))
      .nativeElement.click();
    fixture.detectChanges();
    expect(badge.nativeElement.textContent).toContain('meta-llama/llama-3.1-70b-instruct');
    expect(badge.nativeElement.textContent).not.toContain('openai/o4-mini');
  });

  it('keeps the active-mark slot at a fixed width so every row label starts at the same edge', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.debugElement
      .query(By.css('[data-testid="composer-model-badge"]'))
      .nativeElement.click();
    await fixture.whenStable();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    const rows = fixture.debugElement.queryAll(By.css('[data-testid^="model-selector-option-"]'));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      const slot = row.query(By.css('span[aria-hidden="true"]'));
      expect(slot).toBeTruthy();
      expect(slot.nativeElement.className).toContain('shrink-0');
    }
  });

  it('shows a loader while the rows are fetching, then exactly one row per model', async () => {
    let resolveRows!: (v: ModelPicker) => void;
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'get_effort_pin') return Promise.resolve('high');
      if (cmd === 'list_anthropic_models') return Promise.resolve(anthropicCatalog);
      if (cmd === 'list_model_picker')
        return new Promise((r) => {
          resolveRows = r;
        });
      return Promise.reject(new Error('unexpected'));
    });
    fixture.detectChanges();
    await fixture.componentInstance.openCombobox();
    fixture.detectChanges();
    expect(
      fixture.debugElement.query(By.css('[data-testid="model-selector-loading"]'))
    ).toBeTruthy();
    resolveRows(picker);
    await fixture.componentInstance.whenOptionsSettled();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      fixture.debugElement.query(By.css('[data-testid="model-selector-loading"]'))
    ).toBeFalsy();
    expect(optionIds()).toEqual(['claude-sonnet-5', 'claude-opus-4-1']);
  });

  it('never renders a 1M marker in a row, whatever wire id the row carries', async () => {
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    const rows = fixture.debugElement.queryAll(By.css('[data-testid^="model-selector-option-"]'));
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.nativeElement.textContent).not.toMatch(/\[1m\]|\(1M\)/i);
      expect(row.nativeElement.getAttribute('data-testid')).not.toContain('[1m]');
    }
    expect(rows[0].nativeElement.textContent).toContain('Sonnet 5');
  });

  it('names a row the catalog lacks the way Claude Code lists it', async () => {
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'get_effort_pin') return Promise.resolve('high');
      if (cmd === 'list_anthropic_models') return Promise.resolve(anthropicCatalog);
      if (cmd === 'list_model_picker')
        return Promise.resolve({
          rows: [
            {
              id: 'claude-nova-1',
              wire_id: 'claude-nova-1[1m]',
              is_default: false,
              display_name: 'Nova 1',
              description: 'Nova 1 · Experimental model',
              requires_usage_credits: false,
              effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
              default_effort: 'high',
            },
          ],
        });
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    const row = fixture.debugElement.query(
      By.css('[data-testid="model-selector-option-claude-nova-1"]')
    );
    expect(row.nativeElement.textContent).toContain('Nova 1');
  });

  it('says the model list is unavailable, with Retry, until the session reports its models', async () => {
    fixture.componentRef.setInput('projectId', 'proj-fresh');
    mockWithPickerRows(() => null);
    fixture.detectChanges();

    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();

    expect(optionIds()).toEqual([]);
    const error = fixture.debugElement.query(By.css('[data-testid="model-selector-error"]'));
    expect(error.nativeElement.textContent).toContain('Model list unavailable.');
    expect(error.query(By.css('[data-testid="model-selector-retry"]'))).toBeTruthy();
    expect(
      fixture.debugElement.query(By.css('[data-testid="model-selector-loading"]'))
    ).toBeFalsy();
  });

  it('keeps the last known rows, badge included, while the session respawns', async () => {
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    expect(optionIds()).toEqual(['claude-sonnet-5', 'claude-opus-4-1']);
    fixture.componentInstance.open.set(false);
    fixture.detectChanges();

    mockWithPickerRows(() => null);
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();

    expect(optionIds()).toEqual(['claude-sonnet-5', 'claude-opus-4-1']);
    expect(fixture.debugElement.query(By.css('[data-testid="model-selector-error"]'))).toBeFalsy();
    expect(
      fixture.debugElement
        .query(By.css('[data-testid="model-selector-option-claude-sonnet-5"]'))
        .query(By.css('[data-testid="model-selector-default-badge"]'))
    ).toBeTruthy();
  });

  it('Retry renders the rows once the session reports them', async () => {
    fixture.componentRef.setInput('projectId', 'proj-fresh');
    let reported: ModelPicker | null = null;
    mockWithPickerRows(() => reported);
    fixture.detectChanges();
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    expect(optionIds()).toEqual([]);

    reported = picker;
    fixture.debugElement
      .query(By.css('[data-testid="model-selector-retry"]'))
      .nativeElement.click();
    await settle();

    expect(optionIds()).toEqual(['claude-sonnet-5', 'claude-opus-4-1']);
    expect(fixture.debugElement.query(By.css('[data-testid="model-selector-error"]'))).toBeFalsy();
  });

  function mockSessionLifecycle(
    state: () => unknown,
    rows: () => ModelPicker | null
  ): ReturnType<typeof vi.fn> {
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'get_effort_pin') return Promise.resolve('high');
      if (cmd === 'list_anthropic_models') return Promise.resolve(anthropicCatalog);
      if (cmd === 'get_chat_session_info') return Promise.resolve(state());
      if (cmd === 'list_model_picker') return Promise.resolve(rows());
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    return tauriInvoke;
  }

  async function reportSessionInfo(project: string): Promise<void> {
    await TestBed.inject(ClaudeControlService).refreshSessionInfo(project);
    fixture.detectChanges();
    await fixture.whenStable();
    await settle();
  }

  const opusOnly: ModelPicker = { ...picker, rows: [picker.rows[1]] };

  const errorRow = () => fixture.debugElement.query(By.css('[data-testid="model-selector-error"]'));
  const loadingRow = () =>
    fixture.debugElement.query(By.css('[data-testid="model-selector-loading"]'));

  it('fills a list opened before the session started once the session reports its models', async () => {
    let state: unknown = { state: 'unavailable' };
    let reported: ModelPicker | null = null;
    mockSessionLifecycle(
      () => state,
      () => reported
    );
    fixture.componentRef.setInput('projectId', 'proj-late');
    fixture.detectChanges();
    await settle();
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    expect(errorRow().nativeElement.textContent).toContain('Model list unavailable.');

    state = { state: 'pending' };
    await reportSessionInfo('proj-late');
    expect(loadingRow()).toBeTruthy();
    expect(errorRow()).toBeFalsy();

    reported = picker;
    state = { state: 'ready', info: { models: [], account: {} } };
    await reportSessionInfo('proj-late');

    expect(fixture.componentInstance.open()).toBe(true);
    expect(optionIds()).toEqual(['claude-sonnet-5', 'claude-opus-4-1']);
    expect(errorRow()).toBeFalsy();
    expect(loadingRow()).toBeFalsy();
  });

  it('keeps an open list on its held rows while the session respawns, then shows the new rows', async () => {
    let state: unknown = { state: 'ready', info: { models: [], account: {} } };
    let reported: ModelPicker | null = picker;
    mockSessionLifecycle(
      () => state,
      () => reported
    );
    fixture.componentRef.setInput('projectId', 'proj-respawn');
    fixture.detectChanges();
    await settle();
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    expect(optionIds()).toEqual(['claude-sonnet-5', 'claude-opus-4-1']);

    reported = null;
    state = { state: 'pending' };
    await reportSessionInfo('proj-respawn');
    expect(optionIds()).toEqual(['claude-sonnet-5', 'claude-opus-4-1']);
    expect(loadingRow()).toBeFalsy();

    reported = opusOnly;
    state = { state: 'ready', info: { models: [], account: {} } };
    await reportSessionInfo('proj-respawn');

    expect(optionIds()).toEqual(['claude-opus-4-1']);
    expect(errorRow()).toBeFalsy();
  });

  it('lets only the latest fetch decide the list when an older one resolves last', async () => {
    const pending: Array<(rows: ModelPicker | null) => void> = [];
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'get_effort_pin') return Promise.resolve('high');
      if (cmd === 'list_anthropic_models') return Promise.resolve(anthropicCatalog);
      if (cmd === 'get_chat_session_info') return Promise.resolve({ state: 'unavailable' });
      if (cmd === 'list_model_picker')
        return new Promise((resolve) => {
          pending.push(resolve);
        });
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-race');
    fixture.detectChanges();
    await settle();
    pending.splice(0).forEach((resolve) => resolve(null));
    await settle();

    await fixture.componentInstance.openCombobox();
    const older = fixture.componentInstance.whenOptionsSettled();
    await settle();
    const newer = fixture.componentInstance.fetchOptions();
    await settle();
    expect(pending.length).toBe(2);

    pending[0](null);
    await older;
    await settle();
    expect(errorRow()).toBeFalsy();
    expect(loadingRow()).toBeTruthy();

    pending[1](picker);
    await newer;
    await settle();

    expect(optionIds()).toEqual(['claude-sonnet-5', 'claude-opus-4-1']);
    expect(errorRow()).toBeFalsy();
    expect(loadingRow()).toBeFalsy();
  });

  it('offers Retry in a pending list and leaves the loader when the session is gone', async () => {
    let state: unknown = { state: 'unavailable' };
    mockSessionLifecycle(
      () => state,
      () => null
    );
    fixture.componentRef.setInput('projectId', 'proj-stuck');
    fixture.detectChanges();
    await settle();
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    state = { state: 'pending' };
    await reportSessionInfo('proj-stuck');
    const retry = loadingRow().query(By.css('[data-testid="model-selector-retry"]'));
    expect(retry).toBeTruthy();

    state = { state: 'unavailable' };
    retry.nativeElement.click();
    await settle();
    await fixture.componentInstance.whenOptionsSettled();
    await settle();

    expect(loadingRow()).toBeFalsy();
    expect(errorRow().nativeElement.textContent).toContain('Model list unavailable.');
  });

  it('shows the rows of the project it belongs to after a project switch with the list open', async () => {
    tauriInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'get_effort_pin') return Promise.resolve('high');
      if (cmd === 'list_anthropic_models') return Promise.resolve(anthropicCatalog);
      if (cmd === 'get_chat_session_info')
        return Promise.resolve({ state: 'ready', info: { models: [], account: {} } });
      if (cmd === 'list_model_picker')
        return Promise.resolve(
          (args as { project: string }).project === 'proj-b' ? opusOnly : picker
        );
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-a');
    fixture.detectChanges();
    await settle();
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    expect(optionIds()).toEqual(['claude-sonnet-5', 'claude-opus-4-1']);

    await TestBed.inject(ClaudeControlService).refreshSessionInfo('proj-b');
    fixture.componentRef.setInput('projectId', 'proj-b');
    fixture.detectChanges();
    await settle();
    await settle();

    expect(fixture.componentInstance.open()).toBe(true);
    expect(optionIds()).toEqual(['claude-opus-4-1']);
  });

  it('marks the active model with a check mark and the plan default with a badge', async () => {
    await fixture.whenStable();
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    const sonnet = fixture.debugElement.query(
      By.css('[data-testid="model-selector-option-claude-sonnet-5"]')
    );
    const opus = fixture.debugElement.query(
      By.css('[data-testid="model-selector-option-claude-opus-4-1"]')
    );
    expect(sonnet.query(By.css('[data-testid="model-selector-active-mark"]'))).toBeTruthy();
    expect(sonnet.nativeElement.getAttribute('aria-current')).toBe('true');
    expect(sonnet.query(By.css('[data-testid="model-selector-default-badge"]'))).toBeTruthy();
    expect(opus.query(By.css('[data-testid="model-selector-active-mark"]'))).toBeFalsy();
    expect(opus.nativeElement.getAttribute('aria-current')).toBeNull();
    expect(opus.query(By.css('[data-testid="model-selector-default-badge"]'))).toBeFalsy();
  });

  it('keeps the check mark on the row of a 1M session model', async () => {
    fixture.componentRef.setInput('sessionModel', 'claude-opus-4-1[1m]');
    await fixture.whenStable();
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    const marks = fixture.debugElement.queryAll(
      By.css('[data-testid="model-selector-active-mark"]')
    );
    expect(marks.length).toBe(1);
    expect(
      fixture.debugElement
        .query(By.css('[data-testid="model-selector-option-claude-opus-4-1"]'))
        .query(By.css('[data-testid="model-selector-active-mark"]'))
    ).toBeTruthy();
  });

  it('emits the row wire id, and flags the default row, on a click', async () => {
    const events: ModelSelection[] = [];
    fixture.componentInstance.modelSelected.subscribe((e) => events.push(e));
    await fixture.whenStable();
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();

    fixture.debugElement
      .query(By.css('[data-testid="model-selector-option-claude-sonnet-5"]'))
      .nativeElement.click();

    expect(events).toEqual([
      {
        catalogId: 'claude-sonnet-5',
        wireId: 'claude-sonnet-5[1m]',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: true,
        contextTokens: null,
      },
    ]);
  });

  it('shows Claude Codes usage-credit warning and model description', async () => {
    const paidPicker: ModelPicker = {
      ...picker,
      rows: [
        {
          ...picker.rows[1],
          description: 'Opus 4.1 · Requires usage credits for this account',
          requires_usage_credits: true,
        },
      ],
    };
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'get_effort_pin') return Promise.resolve('high');
      if (cmd === 'list_anthropic_models') return Promise.resolve(anthropicCatalog);
      if (cmd === 'list_model_picker') return Promise.resolve(paidPicker);
      if (cmd === 'get_chat_session_info') return Promise.resolve({ state: 'unavailable' });
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });

    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();

    const row = fixture.debugElement.query(
      By.css('[data-testid="model-selector-option-claude-opus-4-1"]')
    );
    expect(row.query(By.css('[data-testid="model-selector-usage-credits-badge"]'))).toBeTruthy();
    expect(
      row.query(By.css('[data-testid="model-selector-description-claude-opus-4-1"]')).nativeElement
        .textContent
    ).toContain('Requires usage credits');
  });

  it('requires explicit confirmation before selecting a usage-credit model', async () => {
    await fixture.whenStable();
    const events: ModelSelection[] = [];
    fixture.componentInstance.modelSelected.subscribe((event) => events.push(event));
    fixture.componentInstance.open.set(true);
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
    const paid = {
      id: 'claude-opus-4-1',
      label: 'Opus 4.1',
      wireId: 'claude-opus-4-1',
      isDefault: false,
      contextTokens: 200_000,
      description: 'Requires usage credits',
      requiresUsageCredits: true,
    };

    fixture.componentInstance.select(paid);
    expect(events).toEqual([]);
    expect(fixture.componentInstance.open()).toBe(true);

    confirmSpy.mockReturnValue(true);
    fixture.componentInstance.select(paid);
    expect(events).toHaveLength(1);
    expect(fixture.componentInstance.open()).toBe(false);
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(confirmSpy.mock.calls[0][0]).toContain('without another prompt');
    confirmSpy.mockRestore();
  });

  it('is disabled while Claude Code has not answered initialize yet, and re-reads the rows once it has', async () => {
    let sessionInfo: unknown = { state: 'pending' };
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'get_effort_pin') return Promise.resolve('high');
      if (cmd === 'list_anthropic_models') return Promise.resolve(anthropicCatalog);
      if (cmd === 'get_chat_session_info') return Promise.resolve(sessionInfo);
      if (cmd === 'list_model_picker') return Promise.resolve(picker);
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-pending');
    fixture.detectChanges();
    await settle();

    const badge = fixture.debugElement.query(By.css('[data-testid="composer-model-badge"]'));
    expect(badge.nativeElement.disabled).toBe(true);
    expect(badge.nativeElement.getAttribute('title')).toBe('Loading models...');
    const rowFetches = (): number =>
      tauriInvoke.mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'list_model_picker' && (args as { project: string }).project === 'proj-pending'
      ).length;
    const fetchesWhilePending = rowFetches();

    sessionInfo = { state: 'ready', info: { models: [], account: {} } };
    await TestBed.inject(ClaudeControlService).refreshSessionInfo('proj-pending');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(badge.nativeElement.disabled).toBe(false);
    expect(badge.nativeElement.getAttribute('title')).toBe('Change model');
    expect(rowFetches()).toBe(fetchesWhilePending + 1);
  });

  it('shows error+retry on a fetch failure and recovers on retry', async () => {
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'get_effort_pin') return Promise.resolve('high');
      if (cmd === 'list_anthropic_models') return Promise.resolve(anthropicCatalog);
      if (cmd === 'list_model_picker') return Promise.reject(new Error('boom'));
      return Promise.reject(new Error('unexpected'));
    });
    fixture.componentRef.setInput('projectId', 'proj-failing');
    fixture.detectChanges();
    await fixture.whenStable();
    await fixture.componentInstance.openCombobox();
    await fixture.whenStable();
    fixture.detectChanges();
    const error = fixture.debugElement.query(By.css('[data-testid="model-selector-error"]'));
    expect(error).toBeTruthy();

    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(summary);
      if (cmd === 'get_effort_pin') return Promise.resolve('high');
      if (cmd === 'list_anthropic_models') return Promise.resolve(anthropicCatalog);
      if (cmd === 'list_model_picker') return Promise.resolve(picker);
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
      effort_levels: EFFORT_LEVELS,
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
      effort_levels: EFFORT_LEVELS,
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
    const expectedOptions = [
      {
        id: 'model-a',
        label: 'model-a',
        wireId: 'model-a',
        isDefault: false,
        contextTokens: 4096,
        description: null,
        requiresUsageCredits: false,
      },
    ];

    const orSummary: ActiveProviderSummary = {
      provider_id: 'openrouter',
      kind: 'open_router',
      model: 'openrouter/model-a',
      base_url: null,
      effort_levels: EFFORT_LEVELS,
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
      effort_levels: EFFORT_LEVELS,
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

  it('a routed row click carries the discovered window of that row, or null without one', async () => {
    const localSummary: ActiveProviderSummary = {
      provider_id: 'my-litellm',
      kind: 'local',
      model: 'my-litellm/gemma-4-26b-a4b',
      base_url: 'https://litellm.example',
      effort_levels: EFFORT_LEVELS,
    };
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(localSummary);
      if (cmd === 'discover_llm_models') {
        return Promise.resolve({
          models: [
            { id: 'gemma-4-26b-a4b', context_tokens: 262_144 },
            { id: 'qwen3-coder-30b', context_tokens: null },
          ],
        });
      }
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-window');
    fixture.detectChanges();
    await fixture.whenStable();
    const events: ModelSelection[] = [];
    fixture.componentInstance.modelSelected.subscribe((e) => events.push(e));

    for (const id of ['gemma-4-26b-a4b', 'qwen3-coder-30b']) {
      await fixture.componentInstance.openCombobox();
      await fixture.componentInstance.whenOptionsSettled();
      fixture.detectChanges();
      fixture.debugElement
        .query(By.css(`[data-testid="model-selector-option-${id}"]`))
        .nativeElement.click();
    }

    expect(events.map((e) => [e.catalogId, e.providerId, e.contextTokens])).toEqual([
      ['gemma-4-26b-a4b', 'my-litellm', 262_144],
      ['qwen3-coder-30b', 'my-litellm', null],
    ]);
  });

  it('reuses cached discovery results on a second open, but re-probes on a provider/base_url change', async () => {
    const localSummary: ActiveProviderSummary = {
      provider_id: 'my-ollama',
      kind: 'local',
      model: 'my-ollama/llama3.3',
      base_url: 'http://host.docker.internal:11434',
      effort_levels: EFFORT_LEVELS,
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
      effort_levels: EFFORT_LEVELS,
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

  it('shows the last discovered routed list, marked as not refreshed, when a new selector instance cannot reach the provider', async () => {
    const orSummary: ActiveProviderSummary = {
      provider_id: 'openrouter',
      kind: 'open_router',
      model: 'openai/o4-mini',
      base_url: null,
      effort_levels: EFFORT_LEVELS,
    };
    let reachable = true;
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(orSummary);
      if (cmd === 'discover_llm_models') {
        return reachable
          ? Promise.resolve({
              models: [{ id: 'openai/o4-mini' }, { id: 'meta-llama/llama-3.1-70b-instruct' }],
            })
          : Promise.reject(new Error('Failed to read models response chunk: operation timed out'));
      }
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-or-held');
    fixture.detectChanges();
    await fixture.whenStable();
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();
    expect(
      fixture.debugElement.queryAll(By.css('[data-testid^="model-selector-option-"]')).length
    ).toBe(2);

    fixture.destroy();
    reachable = false;
    const revived = TestBed.createComponent(ModelSelectorComponent);
    revived.componentRef.setInput('projectId', 'proj-or-held');
    revived.detectChanges();
    await revived.whenStable();
    await revived.componentInstance.openCombobox();
    await revived.componentInstance.whenOptionsSettled();
    revived.detectChanges();

    expect(revived.debugElement.query(By.css('[data-testid="model-selector-error"]'))).toBeFalsy();
    expect(
      revived.debugElement.queryAll(By.css('[data-testid^="model-selector-option-"]')).length
    ).toBe(2);
    expect(revived.debugElement.query(By.css('[data-testid="model-selector-stale"]'))).toBeTruthy();
  });

  it('drops the not-refreshed marker once a retry reaches the provider again', async () => {
    const orSummary: ActiveProviderSummary = {
      provider_id: 'openrouter',
      kind: 'open_router',
      model: 'openai/o4-mini',
      base_url: null,
      effort_levels: EFFORT_LEVELS,
    };
    let reachable = true;
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(orSummary);
      if (cmd === 'discover_llm_models') {
        return reachable
          ? Promise.resolve({ models: [{ id: 'openai/o4-mini' }] })
          : Promise.reject(new Error('Failed to read models response chunk: operation timed out'));
      }
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-or-retry');
    fixture.detectChanges();
    await fixture.whenStable();
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();

    reachable = false;
    await fixture.componentInstance.fetchOptions(true);
    fixture.detectChanges();
    const stale = fixture.debugElement.query(By.css('[data-testid="model-selector-stale"]'));
    expect(stale).toBeTruthy();
    expect(
      fixture.debugElement.query(By.css('[data-testid="model-selector-option-openai/o4-mini"]'))
    ).toBeTruthy();

    reachable = true;
    stale.query(By.css('[data-testid="model-selector-retry"]')).nativeElement.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('[data-testid="model-selector-stale"]'))).toBeFalsy();
    expect(
      fixture.debugElement.query(By.css('[data-testid="model-selector-option-openai/o4-mini"]'))
    ).toBeTruthy();
  });

  it('shows the failure message with no list when a routed provider was never reached', async () => {
    const orSummary: ActiveProviderSummary = {
      provider_id: 'openrouter',
      kind: 'open_router',
      model: 'openai/o4-mini',
      base_url: null,
      effort_levels: EFFORT_LEVELS,
    };
    tauriInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary') return Promise.resolve(orSummary);
      if (cmd === 'discover_llm_models')
        return Promise.reject(
          new Error('Failed to read models response chunk: operation timed out')
        );
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
    fixture.componentRef.setInput('projectId', 'proj-or-never');
    fixture.detectChanges();
    await fixture.whenStable();
    await fixture.componentInstance.openCombobox();
    await fixture.componentInstance.whenOptionsSettled();
    fixture.detectChanges();

    const error = fixture.debugElement.query(By.css('[data-testid="model-selector-error"]'));
    expect(error.nativeElement.textContent).toContain('Failed to load models.');
    expect(error.query(By.css('[data-testid="model-selector-retry"]'))).toBeTruthy();
    expect(fixture.debugElement.query(By.css('[data-testid="model-selector-stale"]'))).toBeFalsy();
    expect(
      fixture.debugElement.queryAll(By.css('[data-testid^="model-selector-option-"]')).length
    ).toBe(0);
  });

  it('emits exactly one modelSelected event carrying catalogId, wireId, providerId, kind and the row window', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    const events: ModelSelection[] = [];
    fixture.componentInstance.modelSelected.subscribe((e) => events.push(e));

    await fixture.componentInstance.openCombobox();
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.componentInstance.select({
      id: 'claude-opus-4-1',
      label: 'Opus 4.1',
      wireId: 'claude-opus-4-1',
      isDefault: false,
      contextTokens: 200000,
      description: null,
      requiresUsageCredits: false,
    });

    expect(events).toEqual([
      {
        catalogId: 'claude-opus-4-1',
        wireId: 'claude-opus-4-1',
        providerId: 'anthropic',
        kind: 'anthropic_oauth',
        isDefault: false,
        contextTokens: 200000,
      },
    ]);
  });

  it('renders the effort segment for an anthropic provider kind', async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('[data-testid="effort-segment"]'))).toBeTruthy();
  });

  describe('routed provider kinds', () => {
    const invoked: string[] = [];

    async function openRoutedEffortPopover(
      kind: 'open_router' | 'local',
      pin: string | null
    ): Promise<void> {
      invoked.length = 0;
      tauriInvoke.mockImplementation((cmd: string) => {
        invoked.push(cmd);
        if (cmd === 'get_active_provider_summary')
          return Promise.resolve({
            provider_id: kind === 'local' ? 'local' : 'openrouter',
            kind,
            model: 'some-model',
            base_url: kind === 'local' ? 'http://host.docker.internal:4000' : null,
            effort_levels: EFFORT_LEVELS,
          });
        if (cmd === 'get_effort_pin') return Promise.resolve(pin);
        return Promise.reject(new Error(`unexpected: ${cmd}`));
      });
      fixture.componentRef.setInput('projectId', `proj-${kind}`);
      fixture.detectChanges();
      await settle();
      fixture.debugElement.query(By.css('[data-testid="effort-segment"]')).nativeElement.click();
      fixture.detectChanges();
    }

    function stops(): string[] {
      return fixture.debugElement
        .queryAll(By.css('[data-testid^="effort-stop-"]'))
        .map((el) =>
          (el.nativeElement.getAttribute('data-testid') as string).replace('effort-stop-', '')
        );
    }

    function expectHandleWithoutPosition(): void {
      const handle = fixture.debugElement.query(By.css('[data-testid="effort-slider"]'))
        .nativeElement as HTMLElement;
      expect(handle.className).toContain('opacity-0');
      expect(handle.getAttribute('aria-valuetext')).toBe('Default');
      expect(handle.getAttribute('aria-valuenow')).toBeNull();
    }

    for (const kind of ['open_router', 'local'] as const) {
      it(`${kind}: offers every effort level from the summary, in order, and reads its pin`, async () => {
        await openRoutedEffortPopover(kind, null);

        expect(stops()).toEqual(EFFORT_LEVELS);
        expect(invoked).toContain('get_effort_pin');
      });
    }

    it('shows the pin on the segment and as the active stop', async () => {
      await openRoutedEffortPopover('local', 'xhigh');

      const segment = fixture.debugElement.query(By.css('[data-testid="effort-segment"]'));
      expect(segment.nativeElement.textContent.trim()).toBe('Xhigh');
      const slider = fixture.debugElement.query(By.css('[data-testid="effort-slider"]'));
      expect(slider.nativeElement.getAttribute('aria-valuetext')).toBe('Xhigh');
    });

    it('without a pin shows Default and no handle, since the level Claude Code uses is its own', async () => {
      await openRoutedEffortPopover('open_router', null);

      const segment = fixture.debugElement.query(By.css('[data-testid="effort-segment"]'));
      expect(segment.nativeElement.textContent.trim()).toBe('Default');
      expectHandleWithoutPosition();
    });

    it('a stop click emits effortSelected with the routed pick', async () => {
      await openRoutedEffortPopover('open_router', null);
      const emitted: string[] = [];
      fixture.componentInstance.effortSelected.subscribe((l: string) => emitted.push(l));

      fixture.debugElement.query(By.css('[data-testid="effort-stop-max"]')).nativeElement.click();
      fixture.detectChanges();

      expect(emitted).toEqual(['max']);
      const segment = fixture.debugElement.query(By.css('[data-testid="effort-segment"]'));
      expect(segment.nativeElement.textContent.trim()).toBe('Max');
    });

    it('never borrows the Anthropic catalog default for a routed model named like a Claude id', async () => {
      await settle();
      tauriInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_active_provider_summary')
          return Promise.resolve({
            provider_id: 'local',
            kind: 'local',
            model: 'local/claude-sonnet-5',
            base_url: 'http://host.docker.internal:4000',
            effort_levels: EFFORT_LEVELS,
          });
        if (cmd === 'get_effort_pin') return Promise.resolve(null);
        return Promise.reject(new Error(`unexpected: ${cmd}`));
      });
      fixture.componentRef.setInput('projectId', 'proj-local-claude-alias');
      fixture.detectChanges();
      await settle();
      fixture.debugElement.query(By.css('[data-testid="effort-segment"]')).nativeElement.click();
      fixture.detectChanges();

      expect(stops()).toEqual(EFFORT_LEVELS);
      expectHandleWithoutPosition();
    });
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
      effort_levels: EFFORT_LEVELS,
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
      effort_levels: EFFORT_LEVELS,
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
      effort_levels: EFFORT_LEVELS,
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
    effort_levels: EFFORT_LEVELS,
  };

  const catalog: AnthropicModel[] = [
    {
      id: 'claude-fable-5',
      family: 'Fable 5',
      context_tokens: 200_000,
      latest: true,
      premium: false,
      effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      default_effort: 'high',
    } as AnthropicModel,
  ];

  let modelHint: string | null = null;
  let pickerRows: ModelPicker;

  beforeEach(async () => {
    modelHint = null;
    pickerRows = {
      rows: [
        {
          id: 'claude-fable-5',
          wire_id: 'claude-fable-5[1m]',
          is_default: false,
          display_name: null,
          description: null,
          requires_usage_credits: false,
          effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
          default_effort: 'high',
        },
      ],
    };
    tauriInvoke = vi.fn(async (cmd: string) => {
      if (cmd === 'get_active_provider_summary') return configlessSummary;
      if (cmd === 'list_anthropic_models') return catalog;
      if (cmd === 'get_effort_pin') return null;
      if (cmd === 'get_model_hint') return modelHint;
      if (cmd === 'get_chat_session_info') return { state: 'unavailable' };
      if (cmd === 'list_model_picker') return pickerRows;
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
    expect(badgeText()).toBe('Fable 5');
  });

  it('shows a Claude id the catalog does not know without the prefix and the 1M suffix', async () => {
    modelHint = 'claude-fable-5-1[1m]';
    fixture.componentRef.setInput('projectId', 'proj-2');
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(badgeText()).toBe('fable-5.1');
  });

  it('shows the plan default by name once Claude Code reports the default row', async () => {
    pickerRows = {
      rows: [
        {
          id: 'claude-fable-5',
          wire_id: 'claude-fable-5[1m]',
          is_default: true,
          display_name: null,
          description: null,
          requires_usage_credits: false,
          effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
          default_effort: 'high',
        },
      ],
    };
    fixture.componentRef.setInput('projectId', 'proj-2');
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(badgeText()).toBe('Fable 5');
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
          effort_levels: EFFORT_LEVELS,
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
    expect(badgeText()).toBe('opus-4.8');
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
    expect(badgeText()).toBe('opus-4.8');
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
      effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      default_effort: 'high',
    } as AnthropicModel,
    {
      id: 'claude-sonnet-4-6',
      family: 'Sonnet 4.6',
      context_tokens: 1_000_000,
      latest: false,
      premium: false,
      effort_levels: ['low', 'medium', 'high', 'max'],
      default_effort: 'high',
    } as AnthropicModel,
    {
      id: 'claude-opus-4-7',
      family: 'Opus 4.7',
      context_tokens: 1_000_000,
      latest: false,
      premium: true,
      effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      default_effort: 'xhigh',
    } as AnthropicModel,
    {
      id: 'claude-haiku-4-5',
      family: 'Haiku 4.5',
      context_tokens: 200_000,
      latest: true,
      premium: false,
      effort_levels: [],
      default_effort: null,
    } as AnthropicModel,
  ];

  function rowsFromCatalog(): ModelPickerRow[] {
    return catalog.map((m) => ({
      id: m.id,
      wire_id: m.id,
      is_default: false,
      display_name: null,
      description: null,
      requires_usage_credits: false,
      effort_levels: m.effort_levels,
      default_effort: m.default_effort,
    }));
  }

  function setSummaryAndPin(
    fixt: ComponentFixture<ModelSelectorComponent>,
    invoke: ReturnType<typeof vi.fn>,
    model: string,
    pin: string | null,
    rows: ModelPickerRow[] | null = rowsFromCatalog()
  ): void {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_active_provider_summary')
        return Promise.resolve({
          provider_id: 'anthropic',
          kind: 'anthropic_oauth',
          model,
          base_url: null,
          effort_levels: EFFORT_LEVELS,
        });
      if (cmd === 'list_anthropic_models') return Promise.resolve(catalog);
      if (cmd === 'get_effort_pin') return Promise.resolve(pin);
      if (cmd === 'list_model_picker' && rows) return Promise.resolve({ rows });
      return Promise.reject(new Error(`unexpected: ${cmd}`));
    });
  }

  function renderedStops(fixt: ComponentFixture<ModelSelectorComponent>): string[] {
    return fixt.debugElement
      .queryAll(By.css('[data-testid^="effort-stop-"]'))
      .map((s) => s.nativeElement.getAttribute('data-testid').replace('effort-stop-', ''));
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

  it('shows exactly the stops Claude Code reports for the model, even where the catalog lists more', async () => {
    const rows = rowsFromCatalog().map((r) =>
      r.id === 'claude-sonnet-5' ? { ...r, effort_levels: ['low', 'medium', 'high'] } : r
    );
    setSummaryAndPin(fixture, tauriInvoke, 'claude-sonnet-5', 'medium', rows);
    fixture.componentRef.setInput('projectId', 'proj-reported-stops');
    fixture.detectChanges();
    await openPopover(fixture);

    expect(renderedStops(fixture)).toEqual(['low', 'medium', 'high']);
  });

  it('hides the effort control for a model Claude Code lists without effort support, whatever the catalog says', async () => {
    const rows = rowsFromCatalog().map((r) =>
      r.id === 'claude-sonnet-5' ? { ...r, effort_levels: [], default_effort: null } : r
    );
    setSummaryAndPin(fixture, tauriInvoke, 'claude-sonnet-5', 'high', rows);
    fixture.componentRef.setInput('projectId', 'proj-no-effort-row');
    fixture.detectChanges();
    await flush(fixture);

    expect(fixture.debugElement.query(By.css('[data-testid="effort-segment"]'))).toBeFalsy();
  });

  it('shows the catalog stops of a legacy row', async () => {
    setSummaryAndPin(fixture, tauriInvoke, 'claude-sonnet-4-6', null);
    fixture.componentRef.setInput('projectId', 'proj-legacy-row');
    fixture.detectChanges();
    await openPopover(fixture);

    expect(renderedStops(fixture)).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('falls back to the catalog stops when the picker rows are unavailable', async () => {
    setSummaryAndPin(fixture, tauriInvoke, 'claude-sonnet-4-6', 'high', null);
    fixture.componentRef.setInput('projectId', 'proj-no-rows');
    fixture.detectChanges();
    await openPopover(fixture);

    expect(renderedStops(fixture)).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('shows the model default for an unsupported pin while the slider order is unknown', async () => {
    setSummaryAndPin(fixture, tauriInvoke, 'claude-sonnet-4-6', 'xhigh', null);
    fixture.componentRef.setInput('projectId', 'proj-no-order');
    await flush(fixture);

    const segment = fixture.debugElement.query(By.css('[data-testid="effort-segment"]'));
    expect(segment.nativeElement.textContent.trim()).toBe('High');
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

  it('resolves a doubled 1M wire suffix to its catalog entry for the label and effort default', async () => {
    setSummaryAndPin(fixture, tauriInvoke, 'claude-sonnet-5', null);
    fixture.componentRef.setInput('projectId', 'proj-double-1m');
    fixture.componentRef.setInput('sessionModel', 'claude-opus-4-7[1m][1m]');
    await flush(fixture);

    expect(
      fixture.debugElement.query(By.css('[data-testid="composer-model-badge"]')).nativeElement
        .textContent
    ).toBe(' Opus 4.7 ');
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
