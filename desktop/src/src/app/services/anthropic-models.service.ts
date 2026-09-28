import { Injectable, inject, signal } from '@angular/core';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import { AnthropicModel } from '../models/llm';
import { canonicalModelId } from '../models/model-picker';

/**
 * Frontend cache of the SSOT Anthropic model catalog served by the Rust
 * backend (`list_anthropic_models`, from `defaults::ANTHROPIC_MODELS`).
 */
@Injectable({ providedIn: 'root' })
export class AnthropicModelsService {
  private readonly tauri = inject(TauriService);
  private readonly logger = inject(LoggerService);
  private readonly catalog = signal<AnthropicModel[] | null>(null);
  private inflight: Promise<AnthropicModel[]> | null = null;

  private get cache(): AnthropicModel[] | null {
    return this.catalog();
  }

  private set cache(value: AnthropicModel[] | null) {
    this.catalog.set(value);
  }

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
        this.logger.warn(
          `list_anthropic_models returned a non-array payload (${typeof result}); not caching`
        );
        return [];
      } catch (e: unknown) {
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
   * Catalog entry a wire, pinned or observed model id stands for (signal read).
   * @param modelId - Any spelling of the id: bare, 1M-suffixed or snapshot-dated.
   */
  entryFor(modelId: string | null | undefined): AnthropicModel | null {
    if (!this.cache || !modelId) return null;
    const id = canonicalModelId(modelId);
    return this.cache.find((m) => m.id === id) ?? null;
  }

  /**
   * Catalog family display label (e.g. "Opus 4.8") for a model id (signal read).
   * @param modelId - Any spelling of the id: bare, 1M-suffixed or snapshot-dated.
   * @returns Label or `null` when the id is not in the catalog.
   */
  familyLabelFor(modelId: string | null | undefined): string | null {
    return this.entryFor(modelId)?.family ?? null;
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

  /**
   * Narrow write-through for the composer's model selector: mutates exactly
   * one provider's model under the config lock (`set_provider_model`), never
   * the full-form settings save. Rejected server-side for Anthropic entries.
   * @param projectId - Project this write applies to.
   * @param providerId - `LlmProviderEntry.id` to update.
   * @param model - New model id (wire-shaped per the id triad).
   * @param contextTokens - The model's context window from discovery, or null when unknown.
   */
  async setProviderModel(
    projectId: string,
    providerId: string,
    model: string,
    contextTokens: number | null
  ): Promise<void> {
    await this.tauri.invoke<void>('set_provider_model', {
      projectId,
      providerId,
      model,
      contextTokens,
    });
  }
}
