/** Metadata for an available application update from GitHub Releases. */
export interface UpdateInfo {
  version: string;
  body: string | null;
  date: string | null;
  is_critical: boolean;
}

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

/** Startup reconcile status for applying a newly installed bundle. */
export interface BundleReconcileStatus {
  phase: string;
  in_progress: boolean;
  last_error: string | null;
  pending_running_projects: string[];
  applied_bundle_id: string | null;
}
