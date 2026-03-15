/** Describes a single credential/configuration field for a plugin. */
export interface PluginAuthField {
  key: string;
  label: string;
  field_type: string;
  placeholder: string;
  is_secret: boolean;
}

/** Status and configuration details for an installed plugin. */
export interface PluginStatusEntry {
  slug: string;
  name: string;
  service_id: string | null;
  version: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  auth_fields: PluginAuthField[];
  current_values: Record<string, string>;
  token_mount: string;
  settings_schema: JsonSchema | null;
  requires_integrations: string[];
}

/** A single property within a JSON Schema. */
export interface JsonSchemaProperty {
  type: string;
  enum?: string[];
  default?: unknown;
  description?: string;
}

/** A JSON Schema object definition used for plugin settings. */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
}

/** Response from the `get_plugins` Tauri command. */
export interface PluginsResponse {
  plugins: PluginStatusEntry[];
}
