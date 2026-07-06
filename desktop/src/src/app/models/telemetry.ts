/**
 * Frontend mirror of the telemetry DTOs in `desktop/src-tauri/src/types.rs`
 * (backend is SSOT; snake_case matches the wire). See ADR-076.
 */

/** OTLP transport protocol; wire strings match Rust `OtlpProtocol` serde. */
export type OtlpProtocol = 'grpc' | 'http/protobuf' | 'http/json';

/** Per-field MDM lock flags — mirror of Rust `TelemetryLocks`. */
export interface TelemetryLocks {
  enabled: boolean;
  endpoint: boolean;
  protocol: boolean;
  export_metrics: boolean;
  export_logs: boolean;
  headers: boolean;
  resource_attributes: boolean;
  include_account_uuid: boolean;
  log_user_prompts: boolean;
  log_assistant_responses: boolean;
  log_tool_details: boolean;
  log_raw_api_bodies: boolean;
  metric_export_interval_ms: boolean;
  logs_export_interval_ms: boolean;
}

/** Mirror of Rust `TelemetryConfigResponse` (`get_telemetry_config`). */
export interface TelemetryConfigResponse {
  enabled: boolean;
  endpoint: string | null;
  protocol: OtlpProtocol;
  export_metrics: boolean;
  export_logs: boolean;
  /** True when a headers secret is set — the value itself never crosses IPC. */
  has_headers: boolean;
  resource_attributes: string | null;
  include_account_uuid: boolean;
  log_user_prompts: boolean;
  log_assistant_responses: boolean;
  log_tool_details: boolean;
  log_raw_api_bodies: boolean;
  metric_export_interval_ms: number | null;
  logs_export_interval_ms: number | null;
  locks: TelemetryLocks;
  any_locked: boolean;
  kill_switch: boolean;
}

/**
 * Mirror of Rust `TelemetryConfigUpdate`; every field optional (omit = unchanged).
 * `headers`/`endpoint`/`resource_attributes`/interval fields are tri-state:
 * omit = keep, `null` = clear, value = set.
 */
export interface TelemetryConfigUpdate {
  enabled?: boolean;
  endpoint?: string | null;
  protocol?: OtlpProtocol;
  export_metrics?: boolean;
  export_logs?: boolean;
  headers?: string | null;
  resource_attributes?: string | null;
  include_account_uuid?: boolean;
  log_user_prompts?: boolean;
  log_assistant_responses?: boolean;
  log_tool_details?: boolean;
  log_raw_api_bodies?: boolean;
  metric_export_interval_ms?: number | null;
  logs_export_interval_ms?: number | null;
}
