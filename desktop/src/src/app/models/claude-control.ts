/** One row of Claude Code's `initialize` model list. Mirror of Rust `control_channel::ModelRow`. */
export interface ClaudeModelRow {
  value: string;
  resolved_model: string | null;
  display_name: string;
  description: string;
  supports_effort: boolean;
  supported_effort_levels: string[];
}

/** Account facts Claude Code reports at `initialize`. Mirror of Rust `control_channel::AccountInfo`. */
export interface ClaudeAccountInfo {
  subscription_type: string | null;
  api_provider: string | null;
}

/** Parsed `initialize` response of the live chat session. Mirror of Rust `control_channel::SessionInfo`. */
export interface ClaudeSessionInfo {
  models: ClaudeModelRow[];
  account: ClaudeAccountInfo;
}

/** Availability of the session info. Mirror of Rust `control_channel::SessionInfoState`. */
export type ClaudeSessionInfoState =
  { state: 'unavailable' } | { state: 'pending' } | { state: 'ready'; info: ClaudeSessionInfo };

/** What became of a model pick sent to the live session. Mirror of Rust `control_channel::ModelSwitchOutcome`. */
export type ModelSwitchOutcome =
  { outcome: 'confirmed' } | { outcome: 'unconfirmed' } | { outcome: 'refused'; reason: string };

/** Tauri event the backend emits when a switch it sends on its own (the soft-impose) did not apply. */
export const CLAUDE_MODEL_SWITCH_FAILED_EVENT = 'chat_model_switch_failed';

/** Payload of the model-switch failure event. Mirror of Rust `control_channel::ModelSwitchFailedEvent`. */
export interface ClaudeModelSwitchFailedEvent {
  project: string;
  model: string;
  reason: string;
}

/** Tauri event the backend emits when a session's info state changes. */
export const CLAUDE_SESSION_INFO_EVENT = 'chat_session_info';

/** Payload of the session-info event. Mirror of Rust `control_channel::SessionInfoEvent`. */
export interface ClaudeSessionInfoEvent {
  project: string;
  status: ClaudeSessionInfoState;
}

/** One plan usage window of `get_usage`. Mirror of Rust `control_channel::RateWindow`. */
export interface ClaudeRateWindow {
  utilization: number | null;
  resets_at: string | null;
}

/** A per-model weekly window of `get_usage`. Mirror of Rust `control_channel::ModelScopedWindow`. */
export interface ClaudeModelScopedWindow {
  display_name: string;
  utilization: number | null;
  resets_at: string | null;
}

/** Extra-usage credits state of `get_usage`. Mirror of Rust `control_channel::ExtraUsage`. */
export interface ClaudeExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
  currency: string | null;
}

/** Typed plan windows of `get_usage`. Mirror of Rust `control_channel::RateLimits`. */
export interface ClaudeRateLimits {
  five_hour: ClaudeRateWindow | null;
  seven_day: ClaudeRateWindow | null;
  seven_day_opus: ClaudeRateWindow | null;
  seven_day_sonnet: ClaudeRateWindow | null;
  model_scoped: ClaudeModelScopedWindow[];
  extra_usage: ClaudeExtraUsage | null;
}

/** Typed `get_usage` response. Mirror of Rust `control_channel::PlanUsage`. */
export interface ClaudePlanUsage {
  subscription_type: string | null;
  rate_limits_available: boolean;
  rate_limits: ClaudeRateLimits | null;
}

/**
 * One `get_context_usage` category to draw, as the backend picks it (`drawn_categories_only`).
 * Mirror of Rust `control_channel::ContextCategory`.
 */
export interface ClaudeContextCategory {
  name: string;
  tokens: number;
}

/** Typed `get_context_usage` response. Mirror of Rust `control_channel::ContextUsage`. */
export interface ClaudeContextUsage {
  model: string;
  total_tokens: number;
  max_tokens: number;
  percentage: number;
  categories: ClaudeContextCategory[];
}
