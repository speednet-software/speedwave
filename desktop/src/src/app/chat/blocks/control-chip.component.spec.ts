import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ControlChipComponent } from './control-chip.component';
import { AnthropicModelsService } from '../../services/anthropic-models.service';
import { ModelPickerService } from '../../services/model-picker.service';
import { ProjectStateService } from '../../services/project-state.service';
import { TauriService } from '../../services/tauri.service';
import { MockTauriService } from '../../testing/mock-tauri.service';
import type { AnthropicModel } from '../../models/llm';
import type { ModelPicker } from '../../models/model-picker';

const CATALOG: AnthropicModel[] = [
  {
    id: 'claude-opus-5',
    family: 'Opus 5',
    context_tokens: 1_000_000,
    latest: true,
    premium: true,
    effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    default_effort: 'high',
  },
];

const PICKER: ModelPicker = {
  rows: [
    {
      id: 'claude-opus-5',
      wire_id: 'claude-opus-5[1m]',
      is_default: true,
      display_name: null,
      description: null,
      requires_usage_credits: false,
      effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      default_effort: 'high',
    },
    {
      id: 'claude-nova-1',
      wire_id: 'claude-nova-1[1m]',
      is_default: false,
      display_name: 'Nova 1',
      description: null,
      requires_usage_credits: false,
      effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      default_effort: 'high',
    },
  ],
};

describe('ControlChipComponent', () => {
  let fixture: ComponentFixture<ControlChipComponent>;
  let mockTauri: MockTauriService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_anthropic_models') return CATALOG;
      if (cmd === 'list_model_picker') return PICKER;
      return undefined;
    };
    await TestBed.configureTestingModule({
      imports: [ControlChipComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(ControlChipComponent);
  });

  function chipText(command: string, argument: string): string {
    fixture.componentRef.setInput('command', command);
    fixture.componentRef.setInput('argument', argument);
    fixture.detectChanges();
    const chip = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="control-chip"]'
    );
    return chip?.textContent?.trim() ?? '';
  }

  it('renders the model command with the catalog family name', async () => {
    await TestBed.inject(AnthropicModelsService).list();

    expect(chipText('model', 'claude-opus-5')).toBe('model -> Opus 5');
  });

  it('renders a 1M wire id and the bare id of one model identically', async () => {
    await TestBed.inject(AnthropicModelsService).list();

    expect(chipText('model', 'claude-opus-5[1m]')).toBe('model -> Opus 5');
    expect(chipText('model', 'claude-opus-5')).toBe('model -> Opus 5');
  });

  it('never shows the 1M suffix, even for an id the catalog does not know', () => {
    expect(chipText('model', 'claude-opus-9[1m]')).toBe('model -> opus-9');
    expect(chipText('model', 'opus[1m]')).toBe('model -> opus');
  });

  it('names a model the catalog lacks the way Claude Code lists it', async () => {
    TestBed.inject(ProjectStateService).activeProject.set('acme');
    await TestBed.inject(ModelPickerService).refresh('acme');

    expect(chipText('model', 'claude-nova-1[1m]')).toBe('model -> Nova 1');
  });

  it('resolves the default alias to the account default once the rows are known', async () => {
    expect(chipText('model', 'default')).toBe('model -> default');

    TestBed.inject(ProjectStateService).activeProject.set('acme');
    await TestBed.inject(AnthropicModelsService).list();
    await TestBed.inject(ModelPickerService).refresh('acme');
    fixture.detectChanges();

    expect(chipText('model', 'default')).toBe('model -> Opus 5');
  });

  it('keeps a proxy-routed model id verbatim', () => {
    expect(chipText('model', 'local/qwen3-2-5')).toBe('model -> local/qwen3-2-5');
  });

  it('renders the effort command as "effort -> <argument>"', () => {
    expect(chipText('effort', 'high')).toBe('effort -> high');
  });

  it('exposes the command as a data attribute for styling/testing hooks', () => {
    chipText('model', 'claude-opus-4-8');

    const chip = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="control-chip"]'
    );
    expect(chip?.getAttribute('data-command')).toBe('model');
  });
});
