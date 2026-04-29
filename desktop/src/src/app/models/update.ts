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
 *
 * - `up_to_date` — feed reachable, no newer version.
 * - `update_available` — newer version published; payload merges the
 *   `UpdateInfo` fields inline.
 * - `managed_externally` — install is owned by a system package manager
 *   (`apt` / `dnf` / `pacman`); no network call was made. The UI must NOT
 *   render the auto-update banner for this case.
 */
export type UpdateCheckOutcome =
  | { kind: 'up_to_date' }
  | ({ kind: 'update_available' } & UpdateInfo)
  | { kind: 'managed_externally'; manager: string };

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
