/** Metadata for an available application update from GitHub Releases. */
export interface UpdateInfo {
  version: string;
  body: string | null;
  date: string | null;
  is_critical: boolean;
}

/**
 * Tagged result of `check_for_update`. Mirrors the Rust enum
 * `updater::UpdateCheckOutcome` (serde tag = "kind", snake_case).
 */
export type UpdateCheckOutcome =
  | { kind: 'up_to_date' }
  | ({ kind: 'update_available' } & UpdateInfo);

/** User-configurable auto-update check preferences. */
export interface UpdateSettings {
  auto_check: boolean;
  check_interval_hours: number;
}

/** A configured project entry from ~/.speedwave/config.json. */
export interface ProjectEntry {
  name: string;
  dir: string;
}

/** Response from the list_projects Tauri command. */
export interface ProjectList {
  projects: ProjectEntry[];
  active_project: string | null;
}

/** Result of a container update operation (rebuild + recreate). */
export interface ContainerUpdateResult {
  success: boolean;
  images_rebuilt: number;
  containers_recreated: number;
  error: string | null;
}

/** Reconcile phase names — must match Rust BundleReconcilePhase serde(rename_all = "snake_case"). */
export type BundleReconcilePhase =
  | 'pending'
  | 'resources_synced'
  | 'images_built'
  | 'projects_restored'
  | 'done';

/** Startup reconcile status for applying a newly installed bundle. */
export interface BundleReconcileStatus {
  phase: BundleReconcilePhase;
  in_progress: boolean;
  last_error: string | null;
  pending_running_projects: string[];
  applied_bundle_id: string | null;
}

/**
 * Payload emitted with the `project_switch_failed` Tauri event.
 * Extends the basic error with optional CloudStorage failure context
 * so the frontend can route to the CloudStorage remediation modal.
 */
export interface ProjectSwitchFailedPayload {
  /** The project name that was active before the failed switch (may be null). */
  project: string | null;
  /** Full error message (may be user-readable or prefix-encoded). */
  error: string;
  /**
   * Structured error kind for frontend routing.
   * - `'cloudstorage_tcc_required'`: project directory is in CloudStorage with no TCC
   * - `undefined`: generic error, show normal error banner
   */
  error_kind?: 'cloudstorage_tcc_required';
  /** CloudStorage provider display name (e.g. "OneDrive") when error_kind is set. */
  provider?: string;
  /** Absolute path to the project directory that triggered the TCC failure. */
  project_dir?: string;
}
