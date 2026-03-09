/** Describes a single credential/configuration field for an integration. */
export interface AuthField {
  key: string;
  label: string;
  field_type: string;
  placeholder: string;
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
