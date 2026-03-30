/** Describes a single credential/configuration field for an integration. */
export interface AuthField {
  key: string;
  label: string;
  field_type: string;
  placeholder: string;
  oauth_flow: boolean;
  optional: boolean;
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
