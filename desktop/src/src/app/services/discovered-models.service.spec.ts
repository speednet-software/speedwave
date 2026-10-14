import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DiscoveredModelsService } from './discovered-models.service';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { makeMockLogger } from '../testing/mock-logger';
import type { DiscoverResult } from '../models/llm';

const OPENROUTER_MODELS = [{ id: 'openai/o4-mini' }, { id: 'anthropic/claude-sonnet-5' }];

describe('DiscoveredModelsService', () => {
  let mockTauri: MockTauriService;
  let logger: ReturnType<typeof makeMockLogger>;
  let service: DiscoveredModelsService;
  let discoverCalls: Array<Record<string, unknown> | undefined>;
  let discoverResult: () => Promise<DiscoverResult>;

  beforeEach(() => {
    mockTauri = new MockTauriService();
    logger = makeMockLogger();
    discoverCalls = [];
    discoverResult = async () => ({ models: OPENROUTER_MODELS });
    mockTauri.invokeHandler = async (cmd, args) => {
      if (cmd === 'discover_llm_models') {
        discoverCalls.push(args);
        return discoverResult();
      }
      return undefined;
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: logger },
      ],
    });
    service = TestBed.inject(DiscoveredModelsService);
  });

  it('holds nothing before the first probe', () => {
    expect(service.cached('openrouter', '')).toBeNull();
  });

  it('probes with the provider arguments and keeps what it discovered', async () => {
    expect(await service.refresh('openrouter', '')).toEqual({
      models: OPENROUTER_MODELS,
      fresh: true,
    });

    expect(discoverCalls).toEqual([
      { args: { provider: 'openrouter', baseUrl: '', apiKey: undefined } },
    ]);
    expect(service.cached('openrouter', '')).toEqual(OPENROUTER_MODELS);
  });

  it('keeps one list per provider and base url', async () => {
    await service.refresh('openrouter', '');
    discoverResult = async () => ({ models: [{ id: 'llama3.3', context_tokens: 8192 }] });
    await service.refresh('local', 'http://host.docker.internal:11434');

    expect(service.cached('openrouter', '')).toEqual(OPENROUTER_MODELS);
    expect(service.cached('local', 'http://host.docker.internal:11434')).toEqual([
      { id: 'llama3.3', context_tokens: 8192 },
    ]);
    expect(service.cached('local', 'http://host.docker.internal:22222')).toBeNull();
  });

  it('returns the last known list, not marked fresh, when a later probe fails', async () => {
    await service.refresh('openrouter', '');
    discoverResult = async () => {
      throw new Error('Failed to read models response chunk: operation timed out');
    };

    expect(await service.refresh('openrouter', '')).toEqual({
      models: OPENROUTER_MODELS,
      fresh: false,
    });

    expect(service.cached('openrouter', '')).toEqual(OPENROUTER_MODELS);
    expect(logger.warn).toHaveBeenCalledWith(
      'discover_llm_models failed: Failed to read models response chunk: operation timed out'
    );
  });

  it('reports nothing held when the first probe of a provider fails', async () => {
    await service.refresh('openrouter', '');
    discoverResult = async () => {
      throw new Error('boom');
    };

    expect(await service.refresh('local', 'http://host.docker.internal:11434')).toBeNull();
    expect(service.cached('local', 'http://host.docker.internal:11434')).toBeNull();
  });

  it('treats an empty result as nothing worth falling back to', async () => {
    discoverResult = async () => ({ models: [] });
    expect(await service.refresh('openrouter', '')).toEqual({ models: [], fresh: true });

    discoverResult = async () => {
      throw new Error('boom');
    };
    expect(await service.refresh('openrouter', '')).toBeNull();
  });

  it('reads a payload without a models array as an empty list', async () => {
    discoverResult = async () => undefined as unknown as DiscoverResult;

    expect(await service.refresh('openrouter', '')).toEqual({ models: [], fresh: true });
  });
});
