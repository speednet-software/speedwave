import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ModelPickerService } from './model-picker.service';
import { AnthropicModelsService } from './anthropic-models.service';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { makeMockLogger } from '../testing/mock-logger';
import type { AnthropicModel } from '../models/llm';
import type { ModelPicker } from '../models/model-picker';

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
  {
    id: 'claude-haiku-4-5',
    family: 'Haiku 4.5',
    context_tokens: 200_000,
    latest: true,
    premium: false,
    effort_levels: [],
    default_effort: null,
  },
];

const PICKER: ModelPicker = {
  effort_order: ['low', 'medium', 'high', 'xhigh', 'max'],
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
      id: 'claude-haiku-4-5',
      wire_id: 'claude-haiku-4-5',
      is_default: false,
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

describe('ModelPickerService', () => {
  let mockTauri: MockTauriService;
  let logger: ReturnType<typeof makeMockLogger>;
  let service: ModelPickerService;
  let pickerCalls: Array<Record<string, unknown> | undefined>;
  let pickerResult: () => Promise<ModelPicker | null>;

  beforeEach(() => {
    mockTauri = new MockTauriService();
    logger = makeMockLogger();
    pickerCalls = [];
    pickerResult = async () => PICKER;
    mockTauri.invokeHandler = async (cmd, args) => {
      if (cmd === 'list_anthropic_models') return CATALOG;
      if (cmd === 'list_model_picker') {
        pickerCalls.push(args);
        return pickerResult();
      }
      return undefined;
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: logger },
      ],
    });
    service = TestBed.inject(ModelPickerService);
  });

  it('has no rows before the first fetch', () => {
    expect(service.picker('acme')).toBeNull();
    expect(service.rowFor('acme', 'claude-opus-5')).toBeNull();
  });

  it('fetches and keeps the rows per project', async () => {
    expect(await service.refresh('acme')).toEqual(PICKER);

    expect(pickerCalls).toEqual([{ project: 'acme' }]);
    expect(service.picker('acme')).toEqual(PICKER);
    expect(service.picker('other')).toBeNull();
  });

  it('keeps the previous rows when a later fetch fails', async () => {
    await service.refresh('acme');
    pickerResult = async () => {
      throw new Error('the model picker rows exist for Anthropic providers only');
    };

    expect(await service.refresh('acme')).toEqual(PICKER);

    expect(service.picker('acme')).toEqual(PICKER);
    expect(logger.warn).toHaveBeenCalledWith(
      'list_model_picker failed: the model picker rows exist for Anthropic providers only'
    );
  });

  it('keeps the last known rows while the session has not reported its models', async () => {
    await service.refresh('acme');
    pickerResult = async () => null;

    expect(await service.refresh('acme')).toEqual(PICKER);

    expect(pickerCalls).toEqual([{ project: 'acme' }, { project: 'acme' }]);
    expect(service.picker('acme')).toEqual(PICKER);
    expect(service.rowFor('acme', 'default')?.id).toBe('claude-opus-5');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('has no rows while nothing is known and the session has not reported its models', async () => {
    pickerResult = async () => null;

    expect(await service.refresh('acme')).toBeNull();

    expect(service.picker('acme')).toBeNull();
    expect(service.rowFor('acme', 'default')).toBeNull();
    expect(service.label('default', 'acme')).toBe('default');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('replaces the held rows once the session reports its models again', async () => {
    pickerResult = async () => null;
    await service.refresh('acme');
    pickerResult = async () => PICKER;

    expect(await service.refresh('acme')).toEqual(PICKER);

    expect(service.picker('acme')).toEqual(PICKER);
  });

  it('finds the row of every spelling of a model id', async () => {
    await service.refresh('acme');

    for (const id of ['claude-opus-5', 'claude-opus-5[1m]', 'claude-opus-5-20260101[1m]']) {
      expect(service.rowFor('acme', id)?.id).toBe('claude-opus-5');
    }
    expect(service.rowFor('acme', 'claude-sonnet-5')).toBeNull();
  });

  it('maps the default alias to the default row', async () => {
    await service.refresh('acme');

    expect(service.rowFor('acme', 'default')?.id).toBe('claude-opus-5');
  });

  describe('label()', () => {
    beforeEach(async () => {
      await TestBed.inject(AnthropicModelsService).list();
    });

    it('names a catalog model by its family, whatever the spelling', () => {
      for (const id of ['claude-opus-5', 'claude-opus-5[1m]', 'claude-opus-5[1m][1m]']) {
        expect(service.label(id, 'acme')).toBe('Opus 5');
      }
      expect(service.label('claude-haiku-4-5-20251001', null)).toBe('Haiku 4.5');
    });

    it('names a model the catalog lacks by the cleaned name Claude Code lists', async () => {
      await service.refresh('acme');

      expect(service.label('claude-nova-1[1m]', 'acme')).toBe('Nova 1');
    });

    it('prettifies an unknown Claude id without the prefix, date and 1M suffix', () => {
      expect(service.label('claude-opus-9-2[1m]', 'acme')).toBe('opus-9.2');
      expect(service.label('claude-nova-1-20270101', null)).toBe('nova-1');
    });

    it('keeps aliases and proxy-routed ids verbatim, minus the 1M suffix', () => {
      expect(service.label('opus[1m]', 'acme')).toBe('opus');
      expect(service.label('local/qwen3-2-5', 'acme')).toBe('local/qwen3-2-5');
      expect(service.label('openrouter/anthropic/claude-sonnet-5', null)).toBe(
        'openrouter/anthropic/claude-sonnet-5'
      );
    });

    it('shows the default alias as the account default once the rows are known', async () => {
      expect(service.label('default', 'acme')).toBe('default');
      expect(service.label('default', null)).toBe('default');

      await service.refresh('acme');

      expect(service.label('default', 'acme')).toBe('Opus 5');
    });

    it('returns an empty label for an empty id', () => {
      expect(service.label('', 'acme')).toBe('');
    });

    it('never produces a 1M marker', async () => {
      await service.refresh('acme');
      for (const id of [
        'claude-opus-5[1m]',
        'claude-nova-1[1m]',
        'claude-zeta-3[1m]',
        'opus[1m]',
        'sonnet[1m][1m]',
      ]) {
        expect(service.label(id, 'acme')).not.toMatch(/\[1m\]|\(1M\)/i);
      }
    });
  });
});
