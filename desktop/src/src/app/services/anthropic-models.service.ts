import { Injectable, inject } from '@angular/core';
import { TauriService } from './tauri.service';
import { LoggerService } from './logger.service';
import { AnthropicModel, DEFAULT_CONTEXT_TOKENS } from '../models/llm';
import { setPricingCatalog, type PricedAnthropicModel } from '../chat/pricing';

/**
 * Frontend cache of the SSOT Anthropic model catalog served by the Rust
 * backend (`list_anthropic_models` Tauri command, sourced from
 * `speedwave_runtime::defaults::ANTHROPIC_MODELS`).
 *
 * The list never changes within a session, so we fetch it once and reuse the
 * cached promise — every call to `list()` returns the same in-memory array,
 * and `contextTokensFor()` is synchronous after the first call settles.
 *
 * On a transient backend failure the cache is left `null` (not `[]`) so the
 * next call retries — caching an empty list would permanently empty the model
 * dropdown and cost meter after one flaky invoke.
 */
@Injectable({ providedIn: 'root' })
export class AnthropicModelsService {
  private readonly tauri = inject(TauriService);
  private readonly logger = inject(LoggerService);
  private cache: AnthropicModel[] | null = null;
  private inflight: Promise<AnthropicModel[]> | null = null;

  /**
   * Returns the model catalog. Fetches from the backend on first call;
   * subsequent successful calls reuse the cached result. On failure (browser
   * dev mode, transient IPC error) returns an empty list WITHOUT caching it,
   * so a later call retries rather than being stuck with an empty catalog.
   */
  async list(): Promise<AnthropicModel[]> {
    if (this.cache) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const result = await this.tauri.invoke<AnthropicModel[]>('list_anthropic_models');
        if (Array.isArray(result)) {
          this.cache = result;
          // Feed the cost meter's pricing index from the same SSOT payload —
          // no model rates are hard-coded in the frontend.
          setPricingCatalog(result as unknown as PricedAnthropicModel[]);
          return result;
        }
        // Non-array payload is a contract violation — log and retry next call
        // rather than poisoning the cache with a bad value.
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
   * Context-window lookup for a given model id. Returns `null` when the
   * catalog hasn't loaded yet or the id isn't recognised — callers decide
   * whether to fall back to {@link DEFAULT_CONTEXT_TOKENS}.
   * @param modelId - exact API id or alias (e.g. `claude-opus-4-7`,
   *   `opus-4.7`). Aliases without `claude-` prefix are tried with the
   *   prefix to match Claude Code's short form in session metadata.
   */
  contextTokensFor(modelId: string | null | undefined): number | null {
    if (!this.cache || !modelId) return null;
    const trimmed = modelId.trim();
    if (!trimmed) return null;
    const direct = this.cache.find((m) => m.id === trimmed);
    if (direct) return direct.context_tokens;
    // Claude Code's session metadata sometimes carries the short form
    // (`opus-4.7` instead of `claude-opus-4-7`). Try both shapes before
    // giving up.
    const candidate = trimmed.startsWith('claude-')
      ? trimmed
      : `claude-${trimmed.replace('.', '-')}`;
    const fuzzy = this.cache.find((m) => m.id === candidate);
    return fuzzy?.context_tokens ?? null;
  }

  /**
   * Synchronous variant of {@link contextTokensFor} that always returns a
   * usable number — falls back to {@link DEFAULT_CONTEXT_TOKENS} when the
   * model is unknown or the catalog hasn't loaded yet. Convenient for
   * computed signals that need a concrete value every render.
   * @param modelId - Same id as accepted by {@link contextTokensFor}.
   */
  contextTokensOrDefault(modelId: string | null | undefined): number {
    return this.contextTokensFor(modelId) ?? DEFAULT_CONTEXT_TOKENS;
  }

  /**
   * The model id the Settings free-text placeholder should hint at for the
   * Anthropic provider: the latest non-Opus entry (a Sonnet, the everyday
   * balanced default) so we don't nudge users toward the costly Opus tier.
   * Falls back to the first `latest` entry, then the first entry. Returns
   * `null` while the catalog is loading (or empty) so the caller renders a
   * blank placeholder rather than a stale hard-coded string.
   */
  latestNonOpusModelId(): string | null {
    if (!this.cache || this.cache.length === 0) return null;
    const latest = this.cache.filter((m) => m.latest);
    const nonOpus = latest.find((m) => !m.id.startsWith('claude-opus-'));
    return (nonOpus ?? latest[0] ?? this.cache[0]).id;
  }

  /** Test-only hook to reset cached state between specs. */
  resetForTesting(): void {
    this.cache = null;
    this.inflight = null;
  }
}
