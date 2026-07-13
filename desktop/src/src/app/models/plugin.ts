/**
 * Allowed `auth_fields[].field_type` values. Mirrors `ALLOWED_AUTH_FIELD_TYPES` in
 * `crates/speedwave-runtime/src/plugin.rs`; kept in sync by the Rust test `allowed_auth_field_types_match_ts_union`.
 */
export type PluginAuthFieldType = 'text' | 'password' | 'textarea';

/** Allowed `token_mount` wire values returned by the backend. */
export type PluginTokenMount = 'ro' | 'rw';

/** Describes a single credential/configuration field for a plugin. */
export interface PluginAuthField {
  key: string;
  label: string;
  field_type: PluginAuthFieldType;
  placeholder: string;
  is_secret: boolean;
  required: boolean;
  /** Optional help text shown under the field label. Absent when the manifest omits it. */
  description?: string;
  /**
   * Optional regex format constraint. Mirrors the Rust `AuthFieldValidation`
   * (`plugin.rs`). `pattern` is anchored (full-match); `message` shown on mismatch.
   */
  validation?: PluginAuthFieldValidation;
  /**
   * Marks an OAuth credential filled by the host-driven Authorize flow.
   * Mirrors Rust `AuthFieldDef.oauth_flow`.
   */
  oauth_flow?: boolean;
}

/** Regex constraint for a {@link PluginAuthField} value. */
export interface PluginAuthFieldValidation {
  pattern: string;
  message?: string;
}

/**
 * Maximum byte length of a single plugin credential value.
 * Mirrors `MAX_CREDENTIAL_BYTES` in `desktop/src-tauri/src/types.rs`.
 */
export const MAX_PLUGIN_CREDENTIAL_BYTES = 4096;

/**
 * Payload emitted by `PluginCredentialsFormComponent` on submit.
 * Only non-empty (post-trim) fields appear in `credentials`.
 */
export interface PluginSaveCredentialsEvent {
  credentials: Record<string, string>;
}

/**
 * Verification outcome for a plugin; `'verified'` is the only usable state. Mirrors `VerificationStatus`
 * in `crates/speedwave-runtime/src/plugin.rs` (`#[serde(rename_all = "snake_case")]`).
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
  /** Optional long-form Markdown setup/usage guide from the manifest. */
  instructions?: string;
  /** Markdown release notes from the plugin's `CHANGELOG.md`; absent when the package ships none. */
  changelog?: string;
  enabled: boolean;
  configured: boolean;
  auth_fields: PluginAuthField[];
  current_values: Record<string, string>;
  /**
   * Keys of `auth_fields` that have a non-empty value stored on disk.
   * Metadata-only — secret contents are never exposed.
   */
  configured_fields: string[];
  token_mount: PluginTokenMount;
  settings_schema: JsonSchema | null;
  requires_integrations: string[];
  /** Verdict from the runtime audit. `'verified'` means usable. */
  verification_status: PluginVerificationStatus;
  /** Diagnostic when `verification_status !== 'verified'`. */
  verification_error?: string;
  /** True when the manifest declares `host_bridge`. */
  has_host_bridge: boolean;
  /** Access-token expiry (ISO-8601) when OAuth-authorized; absent otherwise. */
  oauth_expires_at?: string;
}

/** Snapshot returned by the `plugin_bridge_get_status` Tauri command. */
export type PluginBridgeStatus =
  | { slug: string; running: false }
  | {
      slug: string;
      running: true;
      port: number;
      paired: boolean;
      partner_connected: boolean;
      display_name: string;
    };

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
 * Mirror of `ALL_PLUGIN_INSTALL_PHASES` in `crates/speedwave-runtime/src/plugin.rs`.
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
