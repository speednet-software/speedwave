import { Injectable, inject } from '@angular/core';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import { AnthropicModel, DEFAULT_CONTEXT_TOKENS } from '../models/llm';

/**
 * Frontend cache of the SSOT Anthropic model catalog served by the Rust
 * backend (`list_anthropic_models`, from `defaults::ANTHROPIC_MODELS`).
 */
@Injectable({ providedIn: 'root' })
export class AnthropicModelsService {
  private readonly tauri = inject(TauriService);
  private readonly logger = inject(LoggerService);
  private cache: AnthropicModel[] | null = null;
  private inflight: Promise<AnthropicModel[]> | null = null;

  /**
   * Returns the model catalog, caching the first successful fetch. On failure
   * returns an empty list WITHOUT caching, so a later call retries.
   */
  async list(): Promise<AnthropicModel[]> {
    if (this.cache) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const result = await this.tauri.invoke<AnthropicModel[]>('list_anthropic_models');
        if (Array.isArray(result)) {
          this.cache = result;
          return result;
        }
        // Non-array payload is a contract violation; not caching.
        this.logger.warn(
          `list_anthropic_models returned a non-array payload (${typeof result}); not caching`
        );
        return [];
      } catch (e: unknown) {
        // Do NOT cache on failure — leave `cache` null so the next call retries.
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`list_anthropic_models failed: ${msg}`);
        return [];
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /**
   * Context-window lookup for a given model id (exact API id or alias, e.g. `claude-opus-4-7` /
   * `opus-4.7`). Returns `null` when the catalog hasn't loaded or the id isn't recognised.
   * @param modelId - Exact API id or alias.
   */
  contextTokensFor(modelId: string | null | undefined): number | null {
    if (!this.cache || !modelId) return null;
    const trimmed = modelId.trim();
    if (!trimmed) return null;
    const direct = this.cache.find((m) => m.id === trimmed);
    if (direct) return direct.context_tokens;
    // Session metadata may carry the short form (`opus-4.7`); try prefixed too.
    const candidate = trimmed.startsWith('claude-')
      ? trimmed
      : `claude-${trimmed.replace('.', '-')}`;
    const fuzzy = this.cache.find((m) => m.id === candidate);
    return fuzzy?.context_tokens ?? null;
  }

  /**
   * Synchronous variant of {@link contextTokensFor}, always returning a usable number — falls back
   * to {@link DEFAULT_CONTEXT_TOKENS} when unknown/not-yet-loaded (for computed signals).
   * @param modelId - Same id as accepted by {@link contextTokensFor}.
   */
  contextTokensOrDefault(modelId: string | null | undefined): number {
    return this.contextTokensFor(modelId) ?? DEFAULT_CONTEXT_TOKENS;
  }

  /**
   * The Settings placeholder hint: the latest non-`premium` entry, falling back
   * to the first `latest` then the first entry. `null` while loading or empty.
   */
  latestEverydayModelId(): string | null {
    if (!this.cache || this.cache.length === 0) return null;
    const latest = this.cache.filter((m) => m.latest);
    const everyday = latest.find((m) => !m.premium);
    return (everyday ?? latest[0] ?? this.cache[0]).id;
  }

  /** Test-only hook to reset cached state between specs. */
  resetForTesting(): void {
    this.cache = null;
    this.inflight = null;
  }
}
