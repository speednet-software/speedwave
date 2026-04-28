/**
 * Frontend mirror of `speedwave_runtime::defaults::AnthropicModelInfo`,
 * returned by the `list_anthropic_models` Tauri command. Backend is the SSOT
 * — bumping a model means editing one const in `defaults.rs`.
 */
export interface AnthropicModel {
  /** API alias passed to Claude Code via `ANTHROPIC_MODEL` (e.g. `claude-opus-4-7`). */
  id: string;
  /** Display label for dropdowns and labels (e.g. `"Opus 4.7"`). */
  family: string;
  /** Context window in tokens. `1_000_000` for 1M-context families. */
  context_tokens: number;
  /** Whether this entry belongs to the "Latest" optgroup; `false` for legacy snapshots. */
  latest: boolean;
}

/**
 * Default fallback context window. Used only when a chat session reports a
 * model the SSOT doesn't yet know about (e.g. running an old snapshot id
 * still accepted by the API). Aligns with the smallest supported window so
 * the percentage bar errs on the side of "your context is fuller than it
 * looks" rather than the other way round.
 */
export const DEFAULT_CONTEXT_TOKENS = 200_000;

/**
 * Frontend mirror of the Rust `DiscoveredModel` DTO returned by
 * `discover_llm_models` (Tauri command). Discovery talks to the local
 * provider's own API (Ollama `/api/tags` + `/api/show`, LM Studio
 * `/api/v0/models`, llama.cpp `/v1/models`) and surfaces the context
 * window directly from the server when it advertises one; otherwise
 * `context_tokens` stays `undefined` and the chat fallback chain takes
 * over.
 */
export interface DiscoveredModel {
  /** Model id as advertised by the local server (e.g. `llama3.3`, `qwen2.5-coder`). */
  id: string;
  /** Context window in tokens; absent when the provider didn't expose one. */
  context_tokens?: number;
}

/**
 * Frontend mirror of the Rust `LlmConfigResponse` returned by the
 * `get_llm_config` Tauri command (`desktop/src-tauri/src/types.rs`). Fields
 * come from `claude.llm` (`speedwave_runtime::config::LlmConfig`) plus the
 * computed `default_base_url`. One-way: backend → frontend; the Rust struct
 * does not derive `Deserialize`.
 *
 * Keep in sync with `LlmConfig` in `crates/speedwave-runtime/src/config.rs`.
 */
export interface LlmConfigResponse {
  provider: string | null;
  model: string | null;
  base_url: string | null;
  default_base_url: string | null;
  /**
   * Persisted context window for the active model (in tokens). For Anthropic
   * the frontend sets this from the SSOT catalog; for local providers it
   * comes from the discovery probe (Ollama `/api/show`, LM Studio
   * `/api/v0/models`, llama.cpp `/v1/models`). The chat footer falls back
   * to this value when the stream-level `context_window_size` is missing.
   */
  context_tokens?: number | null;
}

/**
 * Format a context-token count as a short human label (`200k`, `1M`).
 * @param tokens - Token count from `AnthropicModel.context_tokens`.
 */
export function formatContextLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${tokens}`;
}
