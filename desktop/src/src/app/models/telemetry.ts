/**
 * Frontend mirror of the telemetry Tauri DTOs in `desktop/src-tauri/src/types.rs`
 * (`TelemetryConfigResponse`, `TelemetryConfigUpdate`, `TelemetryLocks`). Backend
 * is the SSOT; the UI never hardcodes an `OTEL_*` key — it toggles read-only from
 * `locks.<field>`. Keep field names snake_case to match the wire.
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
 * Mirror of Rust `TelemetryConfigUpdate` (`update_telemetry_config`). Every field
 * optional; omit to leave unchanged. `headers` is tri-state: omit = keep,
 * `null` = clear, string = replace. MDM-locked fields are ignored server-side.
 */
export interface TelemetryConfigUpdate {
  enabled?: boolean;
  endpoint?: string;
  protocol?: OtlpProtocol;
  export_metrics?: boolean;
  export_logs?: boolean;
  headers?: string | null;
  resource_attributes?: string;
  include_account_uuid?: boolean;
  log_user_prompts?: boolean;
  log_assistant_responses?: boolean;
  log_tool_details?: boolean;
  log_raw_api_bodies?: boolean;
  metric_export_interval_ms?: number;
  logs_export_interval_ms?: number;
}
