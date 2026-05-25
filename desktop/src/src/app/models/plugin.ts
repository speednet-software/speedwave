/** Describes a single credential/configuration field for a plugin. */
export interface PluginAuthField {
  key: string;
  label: string;
  field_type: string;
  placeholder: string;
  is_secret: boolean;
  required: boolean;
}

/**
 * Outcome of `runtime::plugin::list_for_ui` for a single plugin.
 * `'verified'` is the only state that allows the user to enable the
 * plugin or save credentials; every other state surfaces in
 * `verification_error` so users can see what went wrong and how to
 * recover (the remove button stays available regardless).
 *
 * Mirrors the `VerificationStatus` enum in
 * `crates/speedwave-runtime/src/plugin.rs`, which derives
 * `#[serde(rename_all = "snake_case")]` — the literals here must
 * stay in sync with that derive.
 */
export type PluginVerificationStatus =
  | 'verified'
  | 'missing_signature'
  | 'invalid_signature'
  | 'dir_slug_mismatch'
  | 'manifest_invalid';

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
  /** Verdict from the runtime audit. `'verified'` means usable. */
  verification_status: PluginVerificationStatus;
  /** Diagnostic when `verification_status !== 'verified'`. */
  verification_error?: string;
  /** True when the manifest declares `host_bridge`. */
  has_host_bridge: boolean;
}

/** Snapshot returned by the `plugin_bridge_get_status` Tauri command. */
export interface PluginBridgeStatus {
  slug: string;
  running: boolean;
  port?: number;
  paired?: boolean;
  display_name?: string;
}

/** Credentials returned by `plugin_bridge_get_credentials`. */
export interface PluginBridgeCredentials {
  slug: string;
  url: string;
  token: string;
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
