/** Describes a single credential/configuration field for an integration. */
export interface AuthField {
  key: string;
  label: string;
  field_type: string;
  placeholder: string;
  oauth_flow: boolean;
  optional: boolean;
  /** Optional help text rendered under the input. */
  hint?: string;
}

/** Status and configuration details for a container-based MCP integration. */
export interface IntegrationStatusEntry {
  service: string;
  enabled: boolean;
  configured: boolean;
  display_name: string;
  description: string;
  auth_fields: AuthField[];
  current_values: Record<string, string>;
  mappings?: Record<string, unknown>;
  badge?: string;
  /** Re-authorize reason for OAuth-refresh services; undefined = no action. */
  oauth_action_required?: string;
  /** "Connected to <workspace>" hint (Slack: teamName · authedUserId). */
  oauth_identity?: string;
  /** IdP brand name for OAuth button copy, from the Rust descriptor SSOT. */
  oauth_provider_label?: string;
}

/** Status and configuration details for a native OS integration. */
export interface OsIntegrationStatusEntry {
  service: string;
  enabled: boolean;
  display_name: string;
  description: string;
}

/** Response from the `get_integrations` Tauri command. */
export interface IntegrationsResponse {
  services: IntegrationStatusEntry[];
  os: OsIntegrationStatusEntry[];
}

/** Result of starting a loopback (authorization_code) flow — Slack, plugins. */
export interface LoopbackFlowStart {
  request_id: string;
}

/** Information returned when starting the Device Code Flow. */
export interface DeviceCodeInfo {
  user_code: string;
  verification_uri: string;
  expires_in: number;
  request_id: string;
}

/**
 * OAuth flow progress event (Rust SSOT: `ProgressStatus` in
 * `desktop/src-tauri/src/oauth_flow.rs`; `starting`/`polling` are UI-only).
 */
export interface OAuthProgressEvent {
  status:
    | 'starting'
    | 'awaiting_redirect'
    | 'exchanging'
    | 'polling'
    | 'success'
    | 'error'
    | 'cancelled'
    | 'expired';
  message: string;
  request_id: string;
}

/** OAuth flow status union for compiler-checked comparisons. */
export type OAuthFlowStatus = OAuthProgressEvent['status'];

/**
 * OS integration TCC validation result (mirrors `OsIntegrationValidation` in
 * `desktop/src-tauri/src/integrations_cmd.rs`).
 */
export interface OsIntegrationValidation {
  service: string;
  previous_enabled: boolean;
  new_enabled: boolean;
  reason: string;
}
