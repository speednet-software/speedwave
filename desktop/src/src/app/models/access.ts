/** The agent access settings of one project. */
export interface AccessSettingsView {
  read_only: boolean;
  read_only_locked: boolean;
}

/** Access mode of an integration's tools. */
export type AccessMode = 'full' | 'read_only';

/** The access mode of one integration and the project-wide mode above it. */
export interface IntegrationAccessView {
  mode: AccessMode;
  global_read_only: boolean;
  global_locked: boolean;
}
