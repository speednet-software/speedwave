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
  /**
   * Reason the integration needs the user's attention even though it is
   * configured (OAuth-refresh services: SharePoint, Slack) — granted scopes
   * are a strict subset of the required set, the state is stale, or the
   * Slack refresh token aged out. The UI shows a "Re-authorize" banner.
   * Undefined = no action required.
   */
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
 * Progress event emitted by an OAuth flow. The host emits
 * awaiting_redirect/exchanging/success/error/cancelled/expired (Rust SSOT:
 * `ProgressStatus` in `desktop/src-tauri/src/oauth_flow.rs`, test-pinned);
 * `starting` and `polling` are frontend-local UI states never sent by the
 * host. `message` carries the redirect URI on `awaiting_redirect`, otherwise
 * a human-readable detail.
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

/**
 * OAuth flow status — use this for component state/inputs so status string
 *  comparisons stay compiler-checked against the union above.
 */
export type OAuthFlowStatus = OAuthProgressEvent['status'];

/**
 * Result of validating one OS integration against macOS TCC at startup.
 * Returned by `validate_os_integrations_on_startup` for each integration that
 * was previously `enabled=true` in config but whose live TCC state denies the
 * permission. The frontend renders a notice so users know the toggle was
 * auto-flipped to OFF and what to do next (re-click to trigger the prompt).
 *
 * Mirrors `OsIntegrationValidation` in `desktop/src-tauri/src/integrations_cmd.rs`.
 */
export interface OsIntegrationValidation {
  service: string;
  previous_enabled: boolean;
  new_enabled: boolean;
  reason: string;
}
