/**
 * Frontend mirror of `speedwave_runtime::defaults::AnthropicModelInfo`,
 * returned by the `list_anthropic_models` Tauri command. Backend is the SSOT.
 */
export interface AnthropicModel {
  /** API alias passed to Claude Code via `ANTHROPIC_MODEL` (e.g. `claude-opus-4-7`). */
  id: string;
  /** Display label for dropdowns and labels (e.g. `"Opus 4.7"`). */
  family: string;
  /**
   * Context window in tokens. `1_000_000` for 1M-context families, except
   * `claude-fable-5`: its bare id reports a 200k session window despite
   * shipping a priced `[1m]` alias.
   */
  context_tokens: number;
  /** Whether this entry belongs to the "Latest" optgroup; `false` for legacy snapshots. */
  latest: boolean;
  /** Premium tier (Opus/Fable) — skipped by the everyday-model placeholder hint. */
  premium: boolean;
  /** Offered by the composer selector; `false` for legacy entries kept for pricing history. */
  selectable: boolean;
}

/** Default fallback context window for a model the SSOT doesn't know. */
export const DEFAULT_CONTEXT_TOKENS = 200_000;

/**
 * Frontend mirror of the Rust `DiscoveredModel` DTO returned by
 * `discover_llm_models` (Tauri command).
 */
export interface DiscoveredModel {
  /** Model id as advertised by the local server (e.g. `llama3.3`, `qwen2.5-coder`). */
  id: string;
  /** Context window in tokens; absent when the provider didn't expose one. */
  context_tokens?: number;
}

/** Result of a `provider="local"` discovery probe. */
export interface DiscoverResult {
  models: DiscoveredModel[];
  messages_endpoint_ok?: boolean;
}

/** Fixed provider cards in the Settings section (ADR-073): anthropic + local. */
export type ProviderCardId = 'anthropic' | 'local';

/** Ids of the permanent remote provider rows rendered under the cards. */
export type ExtraProviderId = 'openrouter';

/** Radio target of the provider section: a card or a remote row. */
export type ProviderTarget = ProviderCardId | ExtraProviderId;

/** Legacy local-provider ids still accepted from persisted configs. */
export type LegacyLocalProviderId = 'ollama' | 'lmstudio' | 'llamacpp';

/** Value domain of the flat `provider` field: targets + unmigrated legacy ids. */
export type FlatProviderId = ProviderTarget | LegacyLocalProviderId;

/** Local-provider names treated as "Local" in the UI (`isLocalProvider`). */
export const LOCAL_PROVIDERS: ReadonlyArray<string> = ['ollama', 'lmstudio', 'llamacpp', 'local'];

/** Legacy local-provider names auto-migrated to `local` on Save. */
export const LEGACY_LOCAL_PROVIDERS: ReadonlyArray<string> = LOCAL_PROVIDERS.filter(
  (p) => p !== 'local'
);

/**
 * Mirror of `speedwave_runtime::config::is_local_provider`.
 * @param provider - Provider id from `get_llm_config().provider` (may be null).
 */
export function isLocalProvider(provider: string | null | undefined): boolean {
  return !!provider && LOCAL_PROVIDERS.includes(provider);
}

/**
 * Mirror of Rust `LlmConfigResponse` (`get_llm_config` Tauri command).
 * Keep in sync with `LlmConfig` in `crates/speedwave-runtime/src/config.rs`.
 */
export interface LlmConfigResponse {
  provider: string | null;
  model: string | null;
  base_url: string | null;
  default_base_url: string | null;
  /** Persisted context window for the active model (in tokens). */
  context_tokens?: number | null;
  /** True when an api_key file exists for this project. */
  has_api_key?: boolean;
  /** True when a custom_headers file exists for this project. */
  has_custom_headers?: boolean;
  /** v2 provider list (ADR-073); absent on never-migrated legacy configs. */
  providers?: LlmProviderEntry[];
  /** v2 active provider+model selection (ADR-073). */
  active?: LlmActive | null;
  /** ADR-073 kill-switch; absent = enabled. */
  proxy_enabled?: boolean | null;
}

/**
 * Provider kind discriminator (ADR-073). Mirror of Rust `LlmProviderKind`;
 * drift guarded by `llm_provider_kind_matches_ts_union`.
 */
export type LlmProviderKind = 'anthropic_oauth' | 'anthropic_api_key' | 'local' | 'open_router';

/**
 * One configured LLM provider (ADR-073 v2). Mirror of Rust `LlmProviderEntry`;
 * key VALUES never reach the frontend, only `has_api_key`.
 */
export interface LlmProviderEntry {
  /** Slug id (`^[a-z][a-z0-9-]{0,63}$`); becomes file/env names backend-side. */
  id: string;
  kind: LlmProviderKind;
  base_url?: string | null;
  /** Last model used with this provider — restored on re-activation. */
  model?: string | null;
  has_api_key?: boolean;
  context_tokens?: number | null;
  has_custom_headers?: boolean;
}

/** Active provider+model selection (ADR-073). Mirror of Rust `LlmActive`. */
export interface LlmActive {
  provider_id: string;
  model?: string | null;
}

/**
 * Mirror of Rust `containers_cmd::ActiveProviderSummary` (`get_active_provider_summary`).
 * Used by the composer badge/combobox: `base_url` is required for local-provider
 * discovery (never pass `provider_id` as a URL).
 */
export interface ActiveProviderSummary {
  provider_id: string;
  kind: LlmProviderKind;
  model: string | null;
  base_url: string | null;
}

/**
 * One aggregate bucket of the usage dashboard. Mirror of the Rust
 * `speedwave_runtime::usage::UsageBucket` returned by `get_llm_usage`.
 */
export interface UsageBucket {
  requests: number;
  failures: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read: number;
  cache_write: number;
  /** Summed cost over priced requests; `null` when none priced (never 0). */
  cost_usd: number | null;
  /** Throughput numerator: completion tokens from successful timed records. */
  throughput_completion_tokens: number;
  /** Throughput denominator: decode-phase ms (latency − ttft) of timed records. */
  decode_latency_ms_sum: number;
}

/** Usage dashboard payload from `get_llm_usage` (ADR-073). */
export interface UsageSummary {
  /** `YYYY-MM-DD` → model → bucket (sorted by the backend's BTreeMap). */
  days: Record<string, Record<string, UsageBucket>>;
  /** `YYYY-MM-DD` → requests per local hour (24 entries) — heatmap input. */
  hours: Record<string, number[]>;
  totals: UsageBucket;
  /** Unparseable JSONL lines skipped by the aggregator (crash-truncated tails). */
  skipped_lines: number;
}

/**
 * Cost provenance wire strings — mirror of Rust `usage_cost::CostSource`
 * (snake_case serde). Kept in sync by `cost_source_ts_union_matches_rust`.
 */
export type CostSourceKind =
  | 'catalog'
  | 'subscription'
  | 'free'
  | 'actual'
  | 'unknown'
  | 'deferred'
  | 'failed';

/**
 * Cost source that won't change on re-enrichment (mirror of Rust `CostSource::is_terminal`);
 * `'deferred'` and `''` are non-terminal.
 * @param src - cost provenance string from the sidecar
 */
export function isTerminalCostSource(src: CostSourceKind | ''): boolean {
  return src !== 'deferred' && src !== '';
}

/**
 * Final usage for one response from `get_usage_for_response` — the proxy SSOT
 * used to reconcile the chat footer. Mirror of Rust `usage::ResponseUsage`.
 */
export interface ResponseUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cache_read: number;
  cache_write: number;
  /** `null` when unpriced (subscription/unknown). */
  cost_usd: number | null;
  /** Provenance; `''` when no sidecar entry yet. */
  cost_source: CostSourceKind | '';
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
