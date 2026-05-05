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

/**
 * Phase strings emitted by the `plugin_install_status` event.
 *
 * Mirror of `ALL_PLUGIN_INSTALL_PHASES` in
 * `crates/speedwave-runtime/src/plugin.rs`. Adding/removing/renaming a phase
 * here requires the same change there (no codegen — small, rarely-changing
 * list).
 */
export const PLUGIN_INSTALL_PHASES = [
  'verifying',
  'extracting',
  'building',
  'done',
  'failed',
  'done_with_pending_build',
] as const;

/** Discriminated union of phase strings emitted by `plugin_install_status`. */
export type PluginInstallPhase = (typeof PLUGIN_INSTALL_PHASES)[number];

/** Streaming progress event for the `plugin_install_status` Tauri event. */
export interface PluginInstallProgress {
  phase: PluginInstallPhase;
  message: string;
  /** Sanitized error message; populated only when `phase === 'failed'`. */
  error?: string;
}

/**
 * Lightweight manifest summary returned by `peek_plugin_manifest`.
 * Used by the install overlay to know whether the `building` step will run.
 */
export interface PluginManifestSummary {
  slug: string;
  name: string;
  has_service_id: boolean;
}
