import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AnthropicModelsService } from './anthropic-models.service';
import { TauriService } from './tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';
import { DEFAULT_CONTEXT_TOKENS, type AnthropicModel } from '../models/llm';

const FIXTURE: AnthropicModel[] = [
  { id: 'claude-opus-4-7', family: 'Opus 4.7', context_tokens: 1_000_000, latest: true },
  { id: 'claude-sonnet-4-6', family: 'Sonnet 4.6', context_tokens: 1_000_000, latest: true },
  { id: 'claude-haiku-4-5', family: 'Haiku 4.5', context_tokens: 200_000, latest: true },
];

describe('AnthropicModelsService', () => {
  let service: AnthropicModelsService;
  let mockTauri: MockTauriService;
  let invokeCount: number;

  beforeEach(() => {
    invokeCount = 0;
    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'list_anthropic_models') {
        invokeCount++;
        return FIXTURE;
      }
      return undefined;
    };
    TestBed.configureTestingModule({
      providers: [AnthropicModelsService, { provide: TauriService, useValue: mockTauri }],
    });
    service = TestBed.inject(AnthropicModelsService);
  });

  describe('list()', () => {
    it('fetches the catalog from the backend on first call', async () => {
      const list = await service.list();
      expect(list).toEqual(FIXTURE);
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
      expect(a).toEqual(FIXTURE);
      expect(b).toEqual(FIXTURE);
      expect(c).toEqual(FIXTURE);
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
    });

    it('returns an empty list when the backend returns a non-array payload', async () => {
      mockTauri.invokeHandler = async () => 'not-an-array' as unknown;
      service.resetForTesting();
      const list = await service.list();
      expect(list).toEqual([]);
    });
  });

  describe('contextTokensFor()', () => {
    it('returns null before the catalog has loaded', () => {
      // Pre-list() — cache empty by design so consumers can fall back without
      // forcing a synchronous fetch.
      expect(service.contextTokensFor('claude-opus-4-7')).toBeNull();
    });

    it('returns the exact context window for a known full id', async () => {
      await service.list();
      expect(service.contextTokensFor('claude-opus-4-7')).toBe(1_000_000);
      expect(service.contextTokensFor('claude-haiku-4-5')).toBe(200_000);
    });

    it('resolves the short alias Claude Code emits in session metadata', async () => {
      // Claude Code sometimes reports `opus-4.7` instead of `claude-opus-4-7`
      // in the modelUsage chunk — the alias path replaces `.` with `-` and
      // re-prepends `claude-`.
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
