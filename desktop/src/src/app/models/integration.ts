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
  badge?: string;
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
 * Phase of a `worker_image_build_status` event. Mirrors
 * `ALL_WORKER_IMAGE_BUILD_PHASES` in `integrations_cmd.rs`.
 */
export type WorkerImageBuildPhase = 'image_started' | 'image_done' | 'all_done' | 'failed';

/**
 * Payload of the `worker_image_build_status` event emitted while building
 * worker images on demand during an integration enable.
 */
export interface WorkerImageBuildProgress {
  phase: WorkerImageBuildPhase;
  image_name: string;
  estimated_seconds: number;
  current: number;
  total: number;
  message: string;
  error?: string;
}

/** Entry from `list_worker_image_build_estimates` — image name + estimate. */
export interface WorkerImageBuildEstimate {
  image_name: string;
  estimated_seconds: number;
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
