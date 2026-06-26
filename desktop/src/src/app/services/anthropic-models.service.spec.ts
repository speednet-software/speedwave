import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AnthropicModelsService } from './anthropic-models.service';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { DEFAULT_CONTEXT_TOKENS, type AnthropicModel } from '../models/llm';

const FIXTURE: AnthropicModel[] = [
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
];

// Payload carries pricing fields the `AnthropicModel` type omits (cast on assignment); rates off-catalog.
const PRICED_FIXTURE = FIXTURE.map((m) => ({
  ...m,
  pricing: { input: 9, cachedInput: 0.9, cacheWrite: 11.25, output: 45 },
  pricing_1m:
    m.context_tokens >= 1_000_000
      ? { input: 9, cachedInput: 0.9, cacheWrite: 11.25, output: 45 }
      : null,
})) as unknown as AnthropicModel[];

describe('AnthropicModelsService', () => {
  let service: AnthropicModelsService;
  let mockTauri: MockTauriService;
  let invokeCount: number;
  let logger: {
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    invokeCount = 0;
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_anthropic_models') {
        invokeCount++;
        return PRICED_FIXTURE;
      }
      return undefined;
    };
    logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        AnthropicModelsService,
        { provide: TauriService, useValue: mockTauri },
        { provide: LoggerService, useValue: logger },
      ],
    });
    service = TestBed.inject(AnthropicModelsService);
  });

  describe('list()', () => {
    it('fetches the catalog from the backend on first call', async () => {
      const list = await service.list();
      expect(list).toEqual(PRICED_FIXTURE);
      expect(invokeCount).toBe(1);
    });

    it('returns the cached catalog on subsequent calls without a second invoke', async () => {
      await service.list();
      await service.list();
      await service.list();
      expect(invokeCount).toBe(1);
    });

    it('deduplicates concurrent in-flight fetches', async () => {
      const [a, b, c] = await Promise.all([service.list(), service.list(), service.list()]);
      expect(a).toEqual(PRICED_FIXTURE);
      expect(b).toEqual(PRICED_FIXTURE);
      expect(c).toEqual(PRICED_FIXTURE);
      // Only one backend invoke despite three concurrent callers.
      expect(invokeCount).toBe(1);
    });

    it('returns an empty list when the backend rejects (browser dev mode / IPC error)', async () => {
      mockTauri.invokeHandler = async () => {
        throw new Error('Tauri unavailable');
      };
      service.resetForTesting();
      const list = await service.list();
      expect(list).toEqual([]);
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    it('does NOT cache on failure — the next call retries the backend', async () => {
      // Regression: a transient failure must not cache `[]`; cache stays null.
      let calls = 0;
      mockTauri.invokeHandler = async () => {
        calls++;
        if (calls === 1) throw new Error('transient IPC failure');
        return PRICED_FIXTURE;
      };
      service.resetForTesting();

      const first = await service.list();
      expect(first).toEqual([]); // failure → empty, not cached

      const second = await service.list();
      expect(second).toEqual(PRICED_FIXTURE); // retried and succeeded
      expect(calls).toBe(2);
    });

    it('returns an empty list and warns when the backend returns a non-array payload', async () => {
      mockTauri.invokeHandler = async () => 'not-an-array' as unknown;
      service.resetForTesting();
      const list = await service.list();
      expect(list).toEqual([]);
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    it('does NOT cache a non-array payload — the next call retries', async () => {
      let calls = 0;
      mockTauri.invokeHandler = async () => {
        calls++;
        return calls === 1 ? ('garbage' as unknown) : PRICED_FIXTURE;
      };
      service.resetForTesting();
      expect(await service.list()).toEqual([]);
      expect(await service.list()).toEqual(PRICED_FIXTURE);
      expect(calls).toBe(2);
    });
  });

  describe('latestEverydayModelId()', () => {
    it('returns null before the catalog has loaded', () => {
      expect(service.latestEverydayModelId()).toBeNull();
    });

    it('returns the latest non-premium (Sonnet) model id once loaded', async () => {
      await service.list();
      expect(service.latestEverydayModelId()).toBe('claude-sonnet-4-6');
    });

    it('falls back to the first latest entry when every latest model is premium', async () => {
      const opusOnly = [
        { id: 'claude-opus-4-8', family: 'Opus 4.8', context_tokens: 1_000_000, latest: true },
        { id: 'claude-opus-4-7', family: 'Opus 4.7', context_tokens: 1_000_000, latest: false },
      ] as unknown as AnthropicModel[];
      mockTauri.invokeHandler = async () => opusOnly;
      service.resetForTesting();
      await service.list();
      expect(service.latestEverydayModelId()).toBe('claude-opus-4-8');
    });

    it('skips Fable (premium tier) when picking the everyday placeholder', async () => {
      // Fable 5 leads the catalog but is premium — placeholder must pick Sonnet.
      const withFable = [
        { id: 'claude-fable-5', family: 'Fable 5', context_tokens: 1_000_000, latest: true },
        { id: 'claude-opus-4-8', family: 'Opus 4.8', context_tokens: 1_000_000, latest: true },
        { id: 'claude-sonnet-4-6', family: 'Sonnet 4.6', context_tokens: 1_000_000, latest: true },
      ] as unknown as AnthropicModel[];
      mockTauri.invokeHandler = async () => withFable;
      service.resetForTesting();
      await service.list();
      expect(service.latestEverydayModelId()).toBe('claude-sonnet-4-6');
    });
  });

  describe('contextTokensFor()', () => {
    it('returns null before the catalog has loaded', () => {
      expect(service.contextTokensFor('claude-opus-4-7')).toBeNull();
    });

    it('returns the exact context window for a known full id', async () => {
      await service.list();
      expect(service.contextTokensFor('claude-opus-4-8')).toBe(1_000_000);
      expect(service.contextTokensFor('claude-opus-4-7')).toBe(1_000_000);
      expect(service.contextTokensFor('claude-haiku-4-5')).toBe(200_000);
    });

    it('resolves the short alias Claude Code emits in session metadata', async () => {
      // Alias `opus-4.7`: `.` becomes `-`, `claude-` re-prepended.
      await service.list();
      expect(service.contextTokensFor('opus-4.7')).toBe(1_000_000);
      expect(service.contextTokensFor('haiku-4.5')).toBe(200_000);
    });

    it('returns null for an unrecognised id', async () => {
      await service.list();
      expect(service.contextTokensFor('claude-unknown-9-9')).toBeNull();
    });

    it('returns null for null / undefined / empty / whitespace-only input', async () => {
      await service.list();
      expect(service.contextTokensFor(null)).toBeNull();
      expect(service.contextTokensFor(undefined)).toBeNull();
      expect(service.contextTokensFor('')).toBeNull();
      expect(service.contextTokensFor('   ')).toBeNull();
    });

    it('trims surrounding whitespace before lookup', async () => {
      await service.list();
      expect(service.contextTokensFor('  claude-opus-4-7  ')).toBe(1_000_000);
    });
  });

  describe('contextTokensOrDefault()', () => {
    it('falls back to DEFAULT_CONTEXT_TOKENS when the model is unknown', async () => {
      await service.list();
      expect(service.contextTokensOrDefault('claude-unknown-9-9')).toBe(DEFAULT_CONTEXT_TOKENS);
    });

    it('falls back to DEFAULT_CONTEXT_TOKENS before the catalog has loaded', () => {
      expect(service.contextTokensOrDefault('claude-opus-4-7')).toBe(DEFAULT_CONTEXT_TOKENS);
    });

    it('returns the exact context window when the model is recognised', async () => {
      await service.list();
      expect(service.contextTokensOrDefault('claude-haiku-4-5')).toBe(200_000);
    });
  });

  describe('resetForTesting()', () => {
    it('clears the cache so the next list() re-fetches', async () => {
      await service.list();
      service.resetForTesting();
      await service.list();
      expect(invokeCount).toBe(2);
    });
  });
});
