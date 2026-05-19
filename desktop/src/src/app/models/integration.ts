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
   * configured. Currently only SharePoint sets this — when `grantedScopes`
   * is a strict subset of the required scopes (typically after migration),
   * the UI shows a "Re-authorize" banner. Undefined = no action required.
   */
  oauth_action_required?: string;
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

/** Information returned when starting the Device Code Flow. */
export interface DeviceCodeInfo {
  user_code: string;
  verification_uri: string;
  expires_in: number;
  request_id: string;
}

/** Progress event emitted by the OAuth polling task. */
export interface OAuthProgressEvent {
  status: 'polling' | 'success' | 'error' | 'cancelled' | 'expired';
  message: string;
  request_id: string;
}

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
