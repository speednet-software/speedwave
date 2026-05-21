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
 * Result of a `provider="local"` discovery probe. Pairs the model list with
 * a chat-endpoint sanity flag — the UI shows a warning when the server has
 * `/v1/models` but does NOT implement `/v1/messages` (Anthropic Messages).
 * `messages_endpoint_ok === undefined` means "could not determine" (timeout
 * or transport error); treat as "unknown", not "failure".
 */
export interface DiscoverResult {
  models: DiscoveredModel[];
  messages_endpoint_ok?: boolean;
}

/** Local-provider names treated as "Local" in the UI (`isLocalProvider`). */
export const LOCAL_PROVIDERS: ReadonlyArray<string> = ['ollama', 'lmstudio', 'llamacpp', 'local'];

/**
 * Legacy local-provider names auto-migrated to `local` on Save. Derived
 * from {@link LOCAL_PROVIDERS} so a future rename of the canonical name
 * stays consistent without touching two arrays.
 */
export const LEGACY_LOCAL_PROVIDERS: ReadonlyArray<string> = LOCAL_PROVIDERS.filter(
  (p) => p !== 'local'
);

/**
 * Mirror of `speedwave_runtime::config::is_local_provider`. Frontend uses
 * this to: (a) render the unified "Local" radio card for legacy configs,
 * (b) decide whether the honest context fallback applies (no `DEFAULT_CONTEXT_TOKENS`
 * fallback for local providers — ADR-041 "never guess").
 * @param provider - Provider id from `get_llm_config().provider` (may be null).
 */
export function isLocalProvider(provider: string | null | undefined): boolean {
  return !!provider && LOCAL_PROVIDERS.includes(provider);
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
   * comes from the discovery probe. The chat footer falls back to this
   * value when the stream-level `context_window_size` is missing.
   */
  context_tokens?: number | null;
  /** True when an api_key file exists for this project. */
  has_api_key?: boolean;
  /** True when a custom_headers file exists for this project. */
  has_custom_headers?: boolean;
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
