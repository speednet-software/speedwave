import { Injectable, inject, signal } from '@angular/core';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import type { DiscoverResult, DiscoveredModel } from '../models/llm';

/** Models held for a provider after a refresh, and whether this probe produced them. */
export interface DiscoveryRefresh {
  /** The models now held for the provider. */
  models: DiscoveredModel[];
  /** `true` when this probe fetched them, `false` when they are the last known list. */
  fresh: boolean;
}

function cacheKey(provider: string, baseUrl: string): string {
  return `${provider}|${baseUrl}`;
}

/**
 * Last known good discovery result per `provider|base_url`, held outside the composer's
 * model selector so a failed probe falls back to it instead of an empty list.
 */
@Injectable({ providedIn: 'root' })
export class DiscoveredModelsService {
  private readonly tauri = inject(TauriService);
  private readonly log = inject(LoggerService);
  private readonly held = signal<ReadonlyMap<string, DiscoveredModel[]>>(new Map());

  /**
   * Models last discovered for a provider (signal read), or `null` when none ever were.
   * @param provider - Discovery provider name, `openrouter` or `local`.
   * @param baseUrl - Probed base URL, empty for OpenRouter.
   */
  cached(provider: string, baseUrl: string): DiscoveredModel[] | null {
    return this.held().get(cacheKey(provider, baseUrl)) ?? null;
  }

  /**
   * Re-probes the provider, keeping the last known models when the probe fails.
   * @param provider - Discovery provider name, `openrouter` or `local`.
   * @param baseUrl - Base URL to probe, empty for OpenRouter.
   * @returns The models held afterwards, or `null` when the probe failed with none held.
   */
  async refresh(provider: string, baseUrl: string): Promise<DiscoveryRefresh | null> {
    try {
      const res = await this.tauri.invoke<DiscoverResult>('discover_llm_models', {
        args: { provider, baseUrl, apiKey: undefined },
      });
      const models = res?.models ?? [];
      const next = new Map(this.held());
      next.set(cacheKey(provider, baseUrl), models);
      this.held.set(next);
      return { models, fresh: true };
    } catch (e: unknown) {
      this.log.warn(`discover_llm_models failed: ${e instanceof Error ? e.message : String(e)}`);
      const kept = this.cached(provider, baseUrl);
      return kept?.length ? { models: kept, fresh: false } : null;
    }
  }
}
