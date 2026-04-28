import { Injectable, inject } from '@angular/core';
import { TauriService } from './tauri.service';
import { AnthropicModel, DEFAULT_CONTEXT_TOKENS } from '../models/llm';

/**
 * Frontend cache of the SSOT Anthropic model catalog served by the Rust
 * backend (`list_anthropic_models` Tauri command, sourced from
 * `speedwave_runtime::defaults::ANTHROPIC_MODELS`).
 *
 * The list never changes within a session, so we fetch it once and reuse the
 * cached promise — every call to `list()` returns the same in-memory array,
 * and `contextTokensFor()` is synchronous after the first call settles.
 */
@Injectable({ providedIn: 'root' })
export class AnthropicModelsService {
  private readonly tauri = inject(TauriService);
  private cache: AnthropicModel[] | null = null;
  private inflight: Promise<AnthropicModel[]> | null = null;

  /**
   * Returns the model catalog. Fetches from the backend on first call;
   * subsequent calls reuse the cached result. Returns an empty list when
   * running outside Tauri (browser dev mode) so consumers can fall back to
   * sensible defaults rather than crash.
   */
  async list(): Promise<AnthropicModel[]> {
    if (this.cache) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const result = await this.tauri.invoke<AnthropicModel[]>('list_anthropic_models');
        this.cache = Array.isArray(result) ? result : [];
      } catch {
        this.cache = [];
      } finally {
        this.inflight = null;
      }
      return this.cache ?? [];
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

  /** Test-only hook to reset cached state between specs. */
  resetForTesting(): void {
    this.cache = null;
    this.inflight = null;
  }
}
